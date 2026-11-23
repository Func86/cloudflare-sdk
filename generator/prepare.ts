/**
 * Prepares the document for Forge, as cf does: what a plugin can't decide, because
 * Forge has already dropped it or doesn't expose it by the time a plugin runs.
 */
import type { Pagination } from '../src/client.ts';
import {
	applyPatches,
	COMMA_LISTS,
	DRY_RUNS,
	EXCLUDED_IGNORED,
	OPERATION_RENAMES,
	type OperationRename,
	PAGINATION_OVERRIDES,
	REQUEST_VARIANTS,
	UNNAMED_OPERATIONS,
} from './patches.ts';
import { LITERAL_SLASHES, type OpenApiDocument, SCOPED_PERMISSIONS, type Schema, Spec } from './spec.ts';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
const SDK_AUDIENCE = 'sdk';
/** Where the document keeps schemas, other than in its paths. */
const SCHEMA_SECTIONS = ['schemas', 'requestBodies', 'responses', 'parameters', 'headers'] as const;

export interface Prepared {
	/** The operations left out, by reason. */
	skipped: Record<string, number>;
	/** How many properties `normalizeFlags` changed, by flag. */
	flags: { readOnly: number; writeOnly: number; nullable: number };
	/** How many `required` names `restateRequired` moved to where Forge reads them. */
	restatedRequired: number;
}

function isDeprecated(operation: Schema): boolean {
	return operation['deprecated'] === true || operation['x-fern-availability'] === 'deprecated';
}

/**
 * Whether an operation answers with a status that normally has a body, without
 * describing any. Nothing can be generated for it, and the runtime would discard
 * the body, so the only way to a real type is to capture a response.
 */
function lacksResponseSchema(spec: Spec, operation: Schema): boolean {
	const success = Object.entries<Schema>(operation['responses'] ?? {}).filter(([status]) => status.startsWith('2'));
	return (
		success.some(([status]) => status !== '204') &&
		success.every(([, response]) => Object.keys(spec.deref(response)['content'] ?? {}).length === 0)
	);
}

/**
 * Whether an operation is served from somewhere other than the document's servers, as
 * K2's data plane is. Its literal would send it to the API's base URL.
 */
function servedElsewhere(doc: OpenApiDocument, pathItem: Schema, operation: Schema): boolean {
	const servers: unknown = operation['servers'] ?? pathItem['servers'];
	const base = new Set(((doc['servers'] ?? []) as Schema[]).map((server) => server['url']));
	return Array.isArray(servers) && servers.length > 0 && !servers.some((server: Schema) => base.has(server['url']));
}

/**
 * Forge's own keys for what the Fern keys beside them say, which the document has carried
 * since November 2026. `forge normalize` keeps one over its Fern key, so it would undo a
 * rename or showing a hidden operation.
 */
const NATIVE_KEYS = {
	'x-forge-group-name': 'x-fern-sdk-group-name',
	'x-forge-method-name': 'x-fern-sdk-method-name',
	'x-forge-skip': 'x-fern-ignore',
	'x-forge-availability': 'x-fern-availability',
} as const;

/**
 * Moves Forge's own keys for an operation's name, hiding and availability onto the Fern
 * keys, which this module reads and writes, and Forge reads when they're alone. Stops
 * generation where the two say different things, as which one is meant needs a look.
 */
export function foldNativeKeys(doc: OpenApiDocument): void {
	const conflicts: string[] = [];
	for (const [route, pathItem] of Object.entries<Schema>(doc.paths)) {
		for (const verb of HTTP_METHODS) {
			const operation: Schema | undefined = pathItem[verb];
			if (!operation) {
				continue;
			}
			for (const [native, fern] of Object.entries(NATIVE_KEYS)) {
				if (!(native in operation)) {
					continue;
				}
				// `x-fern-ignore: false` and no `x-fern-ignore` say the same, as `a.b` and `['a', 'b']` do of a group.
				const same =
					!(fern in operation) ||
					(fern === 'x-fern-ignore'
						? (operation[native] === true) === (operation[fern] === true)
						: fern === 'x-fern-sdk-group-name'
							? JSON.stringify(groupSegments(operation[native])) === JSON.stringify(groupSegments(operation[fern]))
							: JSON.stringify(operation[native]) === JSON.stringify(operation[fern]));
				if (!same) {
					conflicts.push(`${verb.toUpperCase()} ${route} ${native}`);
					continue;
				}
				if (operation[native] !== false) {
					operation[fern] = operation[native];
				}
				delete operation[native];
			}
		}
	}
	if (conflicts.length > 0) {
		throw new Error(`These Forge keys say something else than their Fern keys, so check which one is meant: ${conflicts.join(', ')}`);
	}
}

/**
 * A group name's segments: `a.b` has two, as `['a', 'b']` does, but `['a.b']` has one, and
 * `''` has none, as `[]` and no name, or one that is neither, do.
 */
function groupSegments(group: unknown): string[] {
	if (Array.isArray(group)) {
		return group.map(String);
	}
	return typeof group === 'string' && group !== '' ? group.split('.') : [];
}

/** The route of an operation that takes the account or the zone, after its scope. */
const ACCOUNT_OR_ZONE = /^\/\{account_or_zone\}\/\{account_or_zone_id\}(?=\/|$)/;
/** The route of an operation on one account or one zone, after its scope. */
const ONE_SCOPE = /^\/(?:accounts|zones)\/\{[^}]+\}(?=\/|$)/;

/** An operation of the document, by its route and verb. */
type OperationAt = { route: string; verb: (typeof HTTP_METHODS)[number] };

/** `VERB /rest`, the route after its scope with the parameter names left out, which copies share. */
function afterScope(verb: string, route: string, scope: RegExp): string {
	return `${verb} ${route.replace(scope, '').replaceAll(/\{[^}]+\}/g, '{}')}`;
}

/**
 * The operations of the routes that take the account or the zone, by `VERB /rest` with
 * the parameter names left out, which their copies on one account or one zone share. One
 * on another host has no copies on the API's.
 */
function accountOrZoneOperations(doc: OpenApiDocument): Map<string, OperationAt> {
	const operations = new Map<string, OperationAt>();
	for (const [route, pathItem] of Object.entries<Schema>(doc.paths)) {
		if (ACCOUNT_OR_ZONE.test(route)) {
			for (const verb of HTTP_METHODS) {
				if (pathItem[verb] && !servedElsewhere(doc, pathItem, pathItem[verb])) {
					operations.set(afterScope(verb, route, ACCOUNT_OR_ZONE), { route, verb });
				}
			}
		}
	}
	return operations;
}

/** An operation's name as the spec spells it, `group.method`. */
function nameOf(operation: Schema): string {
	const group: unknown = operation['x-fern-sdk-group-name'];
	return `${(Array.isArray(group) ? group : [group]).join('.')}.${String(operation['x-fern-sdk-method-name'])}`;
}

/** A name as `group.method`, where the group can have several parts, as in `logpush.jobs.list`. */
const OPERATION_NAME = /^[^.\s]+(\.[^.\s]+)+$/;

/**
 * Decides which operations Forge sees. One marked `x-fern-ignore` is generated
 * unless it's deprecated, listed in `exclusions`, or a copy, on one account or one zone,
 * of an operation that takes either, which stops generation if that one isn't generated;
 * one for other audiences isn't. A generated operation that takes either lists its copies'
 * token permissions, whether they're left out as copies or as deprecated.
 * Nor is one served from another host, or one that doesn't describe its response,
 * until a spec patch or Cloudflare does, apart from a DELETE, whose caller doesn't
 * depend on the body, and a HEAD, which has none. One with no group or method name
 * stays out only when listed in `unnamed`, and otherwise stops generation, as Forge
 * would name it by its `operationId` outside any group, which has no import path.
 * Then `renames` apply to what is left, whether an operation is hidden or not. Forge
 * stops when two operations take one name, however either is spelled or through an
 * alias, so a rename can't take another operation's name. Returns how many were left
 * out, by reason.
 */
export function selectOperations(
	doc: OpenApiDocument,
	exclusions: Readonly<Record<string, string>> = EXCLUDED_IGNORED,
	renames: Readonly<Record<string, OperationRename>> = OPERATION_RENAMES,
	unnamed: Readonly<Record<string, string>> = UNNAMED_OPERATIONS,
): Record<string, number> {
	const malformed = Object.entries(renames).filter(([, { from, to }]) => !OPERATION_NAME.test(from) || !OPERATION_NAME.test(to));
	if (malformed.length > 0) {
		throw new Error(`These renames don't name a group and a method, as group.method: ${malformed.map(([key]) => key).join(', ')}`);
	}
	const skipped: Record<string, number> = {};
	const skip = (reason: string): void => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};
	const applied = new Set<string>();
	const renamed = new Set<string>();
	const leftUnnamed = new Set<string>();
	const unlisted: string[] = [];
	const copies: { key: string; either: OperationAt }[] = [];
	const spec = new Spec(doc);
	const accountOrZone = accountOrZoneOperations(doc);
	// Before any copy is left out.
	const copiedPermissions = permissionsOfCopies(doc, accountOrZone);
	for (const [route, pathItem] of Object.entries<Schema>(doc.paths)) {
		for (const verb of HTTP_METHODS) {
			const operation: Schema | undefined = pathItem[verb];
			if (!operation) {
				continue;
			}
			const key = `${verb.toUpperCase()} ${route}`;
			const audiences = operation['x-fern-audiences'];
			if (Array.isArray(audiences) && !audiences.includes(SDK_AUDIENCE)) {
				delete pathItem[verb];
				skip('other audience');
				continue;
			}
			if (operation['x-fern-ignore'] === true) {
				if (isDeprecated(operation)) {
					skip('deprecated');
					continue;
				}
				if (key in exclusions) {
					applied.add(key);
					skip('excluded');
					continue;
				}
				// One on another host is another route, which isn't a copy.
				const either =
					ONE_SCOPE.test(route) && !servedElsewhere(doc, pathItem, operation)
						? accountOrZone.get(afterScope(verb, route, ONE_SCOPE))
						: undefined;
				if (either) {
					copies.push({ key, either });
					skip('account or zone');
					continue;
				}
				delete operation['x-fern-ignore'];
			}
			if (servedElsewhere(doc, pathItem, operation)) {
				delete pathItem[verb];
				skip('other server');
				continue;
			}
			if (verb !== 'delete' && verb !== 'head' && lacksResponseSchema(spec, operation)) {
				delete pathItem[verb];
				skip('no response schema');
				continue;
			}
			if (groupSegments(operation['x-fern-sdk-group-name']).length === 0 || !operation['x-fern-sdk-method-name']) {
				if (key in unnamed) {
					leftUnnamed.add(key);
				} else {
					unlisted.push(key);
				}
				delete pathItem[verb];
				skip('no name');
				continue;
			}
			const rename = renames[key];
			if (rename) {
				const name = nameOf(operation);
				if (name !== rename.from) {
					throw new Error(
						`The spec now names ${key} ${name}, not ${rename.from}, so check whether its rename is still needed, and update or remove it.`,
					);
				}
				renamed.add(key);
				const dot = rename.to.lastIndexOf('.');
				operation['x-fern-sdk-group-name'] = rename.to.slice(0, dot);
				operation['x-fern-sdk-method-name'] = rename.to.slice(dot + 1);
			}
		}
	}
	const uncovered = copies.filter(({ either }) => {
		const operation: Schema | undefined = doc.paths[either.route]?.[either.verb];
		return operation === undefined || operation['x-fern-ignore'] === true;
	});
	if (uncovered.length > 0) {
		throw new Error(
			`These copies, on one account or one zone, are left out for the operation that takes either, but that one isn't generated, so check whether each should be: ${uncovered.map(({ key }) => key).join(', ')}`,
		);
	}
	givePermissionsOfCopies(doc, copiedPermissions);
	if (unlisted.length > 0) {
		throw new Error(
			`These have no group or method name, so Forge would name them by their operationId outside any group. List each in UNNAMED_OPERATIONS with a reason: ${unlisted.join(', ')}`,
		);
	}
	throwIfUnmatched(
		unnamed,
		leftUnnamed,
		'These are no longer left out for having no name, as the spec names or removes them, or another rule leaves them out first.',
	);
	throwIfUnmatched(
		exclusions,
		applied,
		'These are no longer left out as hidden, as the spec shows or removes them, or another rule leaves them out first.',
	);
	throwIfUnmatched(renames, renamed, 'These renames no longer match a generated operation.');
	return skipped;
}

/** The token permissions the copies of an operation that takes the account or the zone list, by scope. */
type CopiedPermissions = { at: OperationAt; account: Set<string>; zone: Set<string> };

/**
 * The token permissions of the copies, on one account or one zone, of each operation that
 * takes either, by its `VERB /route`. Every copy counts, deprecated too, as the operation
 * still reaches its route: both copies of the Access application policies are. One
 * served from another host is another route, so it doesn't.
 */
function permissionsOfCopies(doc: OpenApiDocument, accountOrZone: ReadonlyMap<string, OperationAt>): Map<string, CopiedPermissions> {
	const copied = new Map<string, CopiedPermissions>();
	for (const [route, pathItem] of Object.entries<Schema>(doc.paths)) {
		if (!ONE_SCOPE.test(route)) {
			continue;
		}
		for (const verb of HTTP_METHODS) {
			const copy: Schema | undefined = pathItem[verb];
			const names: unknown = copy?.['x-api-token-group'];
			const either = accountOrZone.get(afterScope(verb, route, ONE_SCOPE));
			if (copy === undefined || either === undefined || !Array.isArray(names) || names.length === 0 || servedElsewhere(doc, pathItem, copy)) {
				continue;
			}
			const key = `${either.verb.toUpperCase()} ${either.route}`;
			const scopes = copied.get(key) ?? { at: either, account: new Set<string>(), zone: new Set<string>() };
			copied.set(key, scopes);
			for (const name of names as string[]) {
				scopes[route.startsWith('/accounts/') ? 'account' : 'zone'].add(name);
			}
		}
	}
	return copied;
}

/**
 * Gives each generated operation that takes the account or the zone its copies' token
 * permissions, which the spec lists, and lists for few of those that take either, and then
 * as its account copy's. They're kept apart where an account and a zone take different
 * ones, such as "Account Custom Pages Write" and "Custom Pages Write". One whose copies
 * list none keeps its own, and one whose own list names what no copy does stops
 * generation, as which scope that is for needs a look.
 */
function givePermissionsOfCopies(doc: OpenApiDocument, copied: ReadonlyMap<string, CopiedPermissions>): void {
	const generated = [...copied].flatMap(([key, { at, account, zone }]) => {
		const operation: Schema | undefined = doc.paths[at.route]?.[at.verb];
		return operation === undefined || operation['x-fern-ignore'] === true ? [] : [{ key, operation, account, zone }];
	});
	const unlisted = generated.flatMap(({ key, operation, account, zone }) => {
		const own: unknown = operation['x-api-token-group'];
		const lacking = (Array.isArray(own) ? (own as string[]) : []).filter((name) => !account.has(name) && !zone.has(name));
		return lacking.length > 0 ? [`${key} (${lacking.join(', ')})`] : [];
	});
	if (unlisted.length > 0) {
		throw new Error(
			`These list token permissions that none of their copies on one account or one zone do, so check which scope each is for: ${unlisted.join(', ')}`,
		);
	}
	for (const { operation, account, zone } of generated) {
		if (account.size === zone.size && [...account].every((name) => zone.has(name))) {
			operation['x-api-token-group'] = [...account];
			continue;
		}
		delete operation['x-api-token-group'];
		operation[SCOPED_PERMISSIONS] = Object.fromEntries(
			Object.entries({ account, zone })
				.filter(([, names]) => names.size > 0)
				.map(([scope, names]) => [scope, [...names]]),
		);
	}
}

/** Stops generation when a listed entry matched nothing, as what it was listed for has gone. */
function throwIfUnmatched(list: Readonly<Record<string, unknown>>, matched: ReadonlySet<string>, problem: string): void {
	const unmatched = Object.keys(list).filter((key) => !matched.has(key));
	if (unmatched.length > 0) {
		throw new Error(`${problem} Check them and remove them: ${unmatched.join(', ')}`);
	}
}

/**
 * Passes on which path parameters keep their slashes, because Forge's model has no
 * `allowReserved`. It's declared on values that are paths rather than one segment.
 */
export function markLiteralSlashes(doc: OpenApiDocument): void {
	const spec = new Spec(doc);
	for (const pathItem of Object.values<Schema>(doc.paths)) {
		for (const verb of HTTP_METHODS) {
			const operation: Schema | undefined = pathItem[verb];
			if (!operation) {
				continue;
			}
			const names = [...(pathItem['parameters'] ?? []), ...(operation['parameters'] ?? [])]
				.map((parameter: Schema) => spec.deref(parameter))
				.filter((parameter: Schema) => parameter['in'] === 'path' && parameter['allowReserved'] === true)
				.map((parameter: Schema) => parameter['name'] as string);
			if (names.length > 0) {
				operation[LITERAL_SLASHES] = names;
			}
		}
	}
}

/** Walks every schema of the document, wherever it's declared. */
function walkSchemas(doc: OpenApiDocument, walk: (node: unknown) => void): void {
	for (const section of SCHEMA_SECTIONS) {
		walk(doc.components[section]);
	}
	walk(doc.paths);
}

/** Whether a schema allows `null`, itself or through an `allOf` branch. */
function isNullable(spec: Spec, schema: Schema | undefined, depth = 0): boolean {
	const resolved = spec.deref(schema);
	return (
		resolved['nullable'] === true ||
		(depth < 16 && Array.isArray(resolved['allOf']) && resolved['allOf'].some((branch: Schema) => isNullable(spec, branch, depth + 1)))
	);
}

/** Keys that give a schema a type, which a branch with only a description or a flag lacks. */
const TYPE_KEYS = ['type', 'properties', 'items', 'enum', 'allOf', 'oneOf', 'anyOf', 'additionalProperties'];

/**
 * Whether one branch of an `allOf` allows `null` and Forge's intersection of the branches
 * doesn't, because a branch with a type doesn't allow it. A branch with no type, such as
 * `{ nullable: true }`, is left out of the intersection.
 */
function losesNull(spec: Spec, branches: readonly Schema[]): boolean {
	const typed = branches.filter((branch) => TYPE_KEYS.some((key) => key in spec.deref(branch)));
	const nullable = (branch: Schema): boolean => isNullable(spec, branch);
	return branches.some(nullable) && !typed.every(nullable);
}

/**
 * Moves what Forge's model can't see onto the properties it reads.
 *
 * Forge reads `readOnly` from a property itself, so one that gets it from the schema
 * it refers to would stay required in a request. The flag is copied onto the property.
 *
 * Forge's model has no `writeOnly`, so such a field can't be left out of what the API
 * sends, and a response type would promise a password or a secret that never arrives.
 * It stops being required, by its schema, by any `allOf`, `oneOf` or `anyOf` branch of it,
 * and by a schema whose `allOf` declares it, as Hyperdrive's full connection options do:
 * sending too little gets a clear error from the API, and a wrong response type doesn't.
 *
 * Forge drops `nullable` from an `allOf` branch, as in `allOf: [{ $ref }, { nullable: true }]`,
 * and intersects it away when only one branch allows `null`. OpenAPI 3.0 reads that the
 * same way, strictly, but the spec means the value can be `null`, as a Pages project with
 * no deployment has. The `allOf` is made nullable, wherever it is: a property, an item, a
 * map's values or an inline schema. A named schema that would become nullable as a whole
 * stops generation instead, because every use of it would change.
 */
export function normalizeFlags(doc: OpenApiDocument): { readOnly: number; writeOnly: number; nullable: number } {
	const spec = new Spec(doc);
	const counts = { readOnly: 0, writeOnly: 0, nullable: 0 };
	const whole = Object.entries(doc.components.schemas)
		.filter(([, schema]) => Array.isArray(schema['allOf']) && schema['nullable'] !== true && losesNull(spec, schema['allOf']))
		.map(([name]) => name);
	if (whole.length > 0) {
		throw new Error(
			`These schemas would become nullable as a whole, and so would every use of them: ${whole.join(', ')}. Check each, and patch its branch as for api-shield_operation, or add a way to accept it if it really can be null.`,
		);
	}
	const isWriteOnly = (property: Schema | undefined): boolean =>
		property?.['writeOnly'] === true || spec.deref(property)['writeOnly'] === true;
	// `inherited` holds the `writeOnly` names of the schemas a branch is in, as Realtime's
	// storage configuration requires its `secret` in a branch that declares it again without the flag.
	const walk = (node: unknown, inherited: ReadonlySet<string> = new Set()): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				walk(item, inherited);
			}
			return;
		}
		if (typeof node !== 'object' || node === null) {
			return;
		}
		const schema = node as Schema;
		if (Array.isArray(schema['allOf']) && schema['nullable'] !== true && losesNull(spec, schema['allOf'])) {
			schema['nullable'] = true;
			counts.nullable += 1;
		}
		const writeOnly = new Set(inherited);
		// Forge reads a `required` beside an `allOf` for what its branches declare.
		for (const branch of Array.isArray(schema['allOf']) ? (schema['allOf'] as Schema[]) : []) {
			for (const [name, property] of Object.entries(spec.flatProperties(branch))) {
				if (isWriteOnly(property)) {
					writeOnly.add(name);
				}
			}
		}
		const properties: Schema | undefined = schema['properties'];
		if (typeof properties === 'object' && properties !== null) {
			for (const [name, property] of Object.entries<Schema>(properties)) {
				if (isWriteOnly(property)) {
					writeOnly.add(name);
				}
				const target = spec.deref(property);
				if (property?.['$ref'] !== undefined && property['readOnly'] !== true && target['readOnly'] === true) {
					// OpenAPI 3.0 ignores what sits beside a `$ref`, and so does Forge. The wrapper
					// is what Forge documents the field with, as it did the referenced schema.
					const { description, deprecated } = target;
					properties[name] = {
						allOf: [property],
						readOnly: true,
						...(description === undefined ? {} : { description }),
						...(deprecated === undefined ? {} : { deprecated }),
					};
					counts.readOnly += 1;
				}
			}
		}
		if (Array.isArray(schema['required'])) {
			schema['required'] = (schema['required'] as string[]).filter((name) => {
				if (writeOnly.has(name)) {
					counts.writeOnly += 1;
				}
				return !writeOnly.has(name);
			});
		}
		for (const [key, value] of Object.entries(schema)) {
			walk(value, key === 'allOf' || key === 'oneOf' || key === 'anyOf' ? writeOnly : undefined);
		}
	};
	walkSchemas(doc, walk);
	return counts;
}

/**
 * Restates `required` where Forge doesn't read it. Forge applies a `required` to the
 * properties beside it, and one beside an `allOf` to the properties its branches
 * declare, so `allOf: [{ $ref }, { required: [a] }]` leaves `a` optional, as does a
 * `required` beside the `allOf` for an `a` that only an `anyOf` in a branch declares.
 * A branch that declares those properties and requires them keeps the spec's meaning.
 * A `required` beside a `oneOf` or `anyOf` applies to each of its object branches, so
 * each gets such a branch. Run it after `normalizeFlags`, so a copied property keeps
 * its flags.
 */
export function restateRequired(doc: OpenApiDocument): number {
	const spec = new Spec(doc);
	let count = 0;
	const own = (properties: Record<string, Schema>, name: string): Schema | undefined =>
		Object.hasOwn(properties, name) ? properties[name] : undefined;
	const writable = (properties: Record<string, Schema>) => (name: string): boolean =>
		own(properties, name)?.['writeOnly'] !== true && spec.deref(own(properties, name))['writeOnly'] !== true;
	const requiring = (properties: Record<string, Schema>, names: string[]): Schema => ({
		type: 'object',
		properties: Object.fromEntries(names.map((name) => [name, own(properties, name) ?? {}])),
		required: names,
	});
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (typeof node !== 'object' || node === null) {
			return;
		}
		const schema = node as Schema;
		if (Array.isArray(schema['allOf'])) {
			const flat = spec.flatProperties(schema);
			// Forge makes required what a `required` beside the `allOf` names, unless no branch
			// declares it as a property, as when an `anyOf` in a branch does.
			const names = new Set<string>(((schema['required'] ?? []) as string[]).filter((name) => !Object.hasOwn(flat, name)));
			for (const branch of schema['allOf'] as Schema[]) {
				// A branch can require what only the schemas built on it declare, as a referenced
				// base or `{ required: [a] }` does.
				const target = spec.deref(branch);
				const declared = spec.flatProperties(target);
				for (const name of (target['required'] ?? []) as string[]) {
					if (!Object.hasOwn(declared, name)) {
						names.add(name);
					}
				}
			}
			const restated = [...names].filter(writable(flat));
			if (restated.length > 0) {
				count += restated.length;
				(schema['allOf'] as Schema[]).push(requiring(flat, restated));
			}
		} else if (Array.isArray(schema['required'])) {
			const key = Array.isArray(schema['oneOf']) ? 'oneOf' : Array.isArray(schema['anyOf']) ? 'anyOf' : undefined;
			// Names beside their properties are already read.
			const names = (schema['required'] as string[]).filter((name) => !Object.hasOwn(schema['properties'] ?? {}, name));
			if (key !== undefined && names.length > 0) {
				schema[key] = (schema[key] as Schema[]).map((branch) => {
					const type = spec.deref(branch)['type'];
					if (type !== undefined && type !== 'object') {
						return branch;
					}
					const flat = spec.flatProperties(branch);
					const restated = names.filter(writable(flat));
					count += restated.length;
					return restated.length > 0 ? { allOf: [branch, requiring(flat, restated)] } : branch;
				});
			}
		}
		for (const value of Object.values(schema)) {
			walk(value);
		}
	};
	walkSchemas(doc, walk);
	return count;
}

/**
 * Stops generation when a pagination override has gone stale, as a spec patch does: its
 * operation isn't generated, or it now states its own pagination, which should win. Run it
 * after `selectOperations`. The plugin checks that the result still holds the array the
 * override names, with the rule the types are generated by.
 */
export function checkPaginationOverrides(
	doc: OpenApiDocument,
	overrides: Readonly<Record<string, Pagination>> = PAGINATION_OVERRIDES,
): void {
	const stale: string[] = [];
	for (const key of Object.keys(overrides)) {
		const [method = '', route = ''] = key.split(' ');
		const operation: Schema | undefined = doc.paths[route]?.[method.toLowerCase()];
		if (!operation || operation['x-fern-ignore'] === true) {
			stale.push(`${key} isn't generated`);
		} else if (operation['x-fern-pagination'] !== undefined) {
			stale.push(`${key} states its own pagination`);
		}
	}
	if (stale.length > 0) {
		throw new Error(`These pagination overrides are stale, so check them and remove them: ${stale.join('; ')}`);
	}
}

/**
 * Stops generation when an operation `DRY_RUNS` lists isn't generated. Run it after
 * `selectOperations`. The plugin checks the rest: its `dry_run` and its `null` result.
 */
export function checkDryRuns(doc: OpenApiDocument, keys: readonly string[] = DRY_RUNS): void {
	const stale = ungenerated(doc, keys);
	if (stale.length > 0) {
		throw new Error(`These dry runs aren't generated, so check them and remove them from DRY_RUNS: ${stale.join(', ')}`);
	}
}

/**
 * Stops generation when an operation `REQUEST_VARIANTS` lists isn't generated. Run it after
 * `selectOperations`. The plugin checks the rest: the parameters and values each variant names.
 */
export function checkRequestVariants(doc: OpenApiDocument, keys: readonly string[] = Object.keys(REQUEST_VARIANTS)): void {
	const stale = ungenerated(doc, keys);
	if (stale.length > 0) {
		throw new Error(`These request variants aren't generated, so check them and remove them from REQUEST_VARIANTS: ${stale.join(', ')}`);
	}
}

/** The keys, as `METHOD /path`, of operations that aren't generated. */
function ungenerated(doc: OpenApiDocument, keys: readonly string[]): string[] {
	return keys.filter((key) => {
		const [method = '', route = ''] = key.split(' ');
		const operation: Schema | undefined = doc.paths[route]?.[method.toLowerCase()];
		return !operation || operation['x-fern-ignore'] === true;
	});
}

/** A description that says a string is a list joined with commas, in any of the spec's wordings. */
const COMMA_SEPARATED = /comma[- ]?(?:separated|delimited)|separated by commas?/i;

/**
 * Makes the query parameters `lists` names lists of strings, sent joined with commas, as
 * their descriptions say, whether the operation or its path item declares them. Stops
 * generation when one isn't a string described so, or its operation isn't generated. Run it
 * after `selectOperations`.
 */
export function joinCommaLists(doc: OpenApiDocument, lists: Readonly<Record<string, readonly string[]>> = COMMA_LISTS): void {
	const spec = new Spec(doc);
	const stale: string[] = [];
	for (const [key, names] of Object.entries(lists)) {
		const [method = '', route = ''] = key.split(' ');
		const pathItem: Schema | undefined = doc.paths[route];
		const operation: Schema | undefined = pathItem?.[method.toLowerCase()];
		const generated = operation !== undefined && operation['x-fern-ignore'] !== true;
		for (const name of names) {
			const named = (parameter: Schema): boolean => spec.deref(parameter)['name'] === name && spec.deref(parameter)['in'] === 'query';
			const own: Schema[] = generated ? (operation['parameters'] ?? []) : [];
			const index = own.findIndex(named);
			const declared = index === -1 ? ((generated ? (pathItem?.['parameters'] ?? []) : []) as Schema[]).find(named) : own[index];
			const parameter = declared === undefined ? undefined : spec.deref(declared);
			const schema = spec.deref(parameter?.['schema']);
			const descriptions = [parameter?.['description'], schema['description']].filter((text) => typeof text === 'string');
			if (
				parameter === undefined ||
				schema['type'] !== 'string' ||
				parameter['explode'] !== undefined ||
				!COMMA_SEPARATED.test(descriptions.join(' '))
			) {
				stale.push(`${key} ${name}`);
				continue;
			}
			const description = `${descriptions[0]!} The list is sent joined with commas.`;
			// A copy, as a referenced parameter can be shared, and the operation's own overrides
			// the path item's.
			const list = { ...parameter, schema: { type: 'array', items: { type: 'string' }, description }, explode: false };
			operation!['parameters'] = index === -1 ? [...own, list] : own.with(index, list);
		}
	}
	if (stale.length > 0) {
		throw new Error(
			`These aren't strings described as comma-separated lists, or their operations aren't generated: ${stale.join(', ')}. Check each, and remove one the spec now declares otherwise.`,
		);
	}
}

export function prepare(doc: OpenApiDocument): Prepared {
	foldNativeKeys(doc);
	applyPatches(doc);
	const skipped = selectOperations(doc);
	checkPaginationOverrides(doc);
	checkDryRuns(doc);
	checkRequestVariants(doc);
	joinCommaLists(doc);
	markLiteralSlashes(doc);
	const flags = normalizeFlags(doc);
	return { skipped, flags, restatedRequired: restateRequired(doc) };
}
