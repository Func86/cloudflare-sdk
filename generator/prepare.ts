/**
 * Prepares the document for Forge, as cf does: what a plugin can't decide, because
 * Forge has already dropped it or doesn't expose it by the time a plugin runs.
 */
import type { Pagination } from '../src/client.ts';
import { applyPatches, EXCLUDED_IGNORED, OPERATION_RENAMES, type OperationRename, PAGINATION_OVERRIDES } from './patches.ts';
import { LITERAL_SLASHES, type OpenApiDocument, type Schema, Spec } from './spec.ts';

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
 * Decides which operations Forge sees. One marked `x-fern-ignore` is generated
 * unless it's deprecated or listed in `exclusions`; one for other audiences isn't.
 * Nor is one served from another host, or one that doesn't describe its response,
 * until a spec patch or Cloudflare does, apart from a DELETE, whose caller doesn't
 * depend on the body, and a HEAD, which has none. Returns how many were left out, by reason.
 */
export function selectOperations(
	doc: OpenApiDocument,
	exclusions: Readonly<Record<string, string>> = EXCLUDED_IGNORED,
	renames: Readonly<Record<string, OperationRename>> = OPERATION_RENAMES,
): Record<string, number> {
	const skipped: Record<string, number> = {};
	const skip = (reason: string): void => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};
	const applied = new Set<string>();
	const spec = new Spec(doc);
	for (const [route, pathItem] of Object.entries<Schema>(doc.paths)) {
		for (const verb of HTTP_METHODS) {
			const operation: Schema | undefined = pathItem[verb];
			if (!operation) {
				continue;
			}
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
				const key = `${verb.toUpperCase()} ${route}`;
				if (key in exclusions) {
					applied.add(key);
					skip('excluded');
					continue;
				}
				delete operation['x-fern-ignore'];
				const rename = renames[key];
				if (rename) {
					applied.add(key);
					operation['x-fern-sdk-method-name'] = rename.method;
					if (rename.group !== undefined) {
						operation['x-fern-sdk-group-name'] = rename.group;
					}
				}
			}
			if (servedElsewhere(doc, pathItem, operation)) {
				delete pathItem[verb];
				skip('other server');
				continue;
			}
			if (verb !== 'delete' && verb !== 'head' && lacksResponseSchema(spec, operation)) {
				delete pathItem[verb];
				skip('no response schema');
			}
		}
	}
	const stale = [...Object.keys(exclusions), ...Object.keys(renames)].filter((key) => !applied.has(key));
	if (stale.length > 0) {
		throw new Error(`These no longer match a hidden operation, so check them and remove them: ${stale.join(', ')}`);
	}
	return skipped;
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
 * It stops being required: sending too little gets a clear error from the API, and a
 * wrong response type doesn't.
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
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(walk);
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
		const properties: Schema | undefined = schema['properties'];
		if (typeof properties === 'object' && properties !== null) {
			for (const [name, property] of Object.entries<Schema>(properties)) {
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
			if (Array.isArray(schema['required'])) {
				schema['required'] = (schema['required'] as string[]).filter((name) => {
					const property: Schema | undefined = properties[name];
					const writeOnly = property?.['writeOnly'] === true || spec.deref(property)['writeOnly'] === true;
					if (writeOnly) {
						counts.writeOnly += 1;
					}
					return !writeOnly;
				});
			}
		}
		for (const value of Object.values(schema)) {
			walk(value);
		}
	};
	walkSchemas(doc, walk);
	return counts;
}

/**
 * Restates `required` where Forge reads it. Forge applies a `required` only to the
 * properties beside it, so `allOf: [{ $ref }, { required: [a] }]`, or a `required`
 * next to the `allOf`, leaves `a` optional. A branch that declares those properties
 * and requires them keeps the spec's meaning. A `required` beside a `oneOf` or
 * `anyOf` applies to each of its object branches, so each gets such a branch. Run it
 * after `normalizeFlags`, so a copied property keeps its flags.
 */
export function restateRequired(doc: OpenApiDocument): number {
	const spec = new Spec(doc);
	let count = 0;
	const writable = (properties: Record<string, Schema>) => (name: string): boolean =>
		properties[name]?.['writeOnly'] !== true && spec.deref(properties[name])['writeOnly'] !== true;
	const requiring = (properties: Record<string, Schema>, names: string[]): Schema => ({
		type: 'object',
		properties: Object.fromEntries(names.map((name) => [name, properties[name] ?? {}])),
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
			const names = new Set<string>(schema['required'] ?? []);
			for (const branch of schema['allOf'] as Schema[]) {
				// A referenced base can require what only the schemas built on it declare.
				const target = spec.deref(branch);
				for (const name of (target['required'] ?? []) as string[]) {
					if (!target['properties']?.[name]) {
						names.add(name);
					}
				}
			}
			const flat = spec.flatProperties(schema);
			const restated = [...names].filter(writable(flat));
			if (restated.length > 0) {
				count += restated.length;
				(schema['allOf'] as Schema[]).push(requiring(flat, restated));
			}
		} else if (Array.isArray(schema['required'])) {
			const key = Array.isArray(schema['oneOf']) ? 'oneOf' : Array.isArray(schema['anyOf']) ? 'anyOf' : undefined;
			// Names beside their properties are already read.
			const names = (schema['required'] as string[]).filter((name) => !schema['properties']?.[name]);
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

export function prepare(doc: OpenApiDocument): Prepared {
	applyPatches(doc);
	const skipped = selectOperations(doc);
	checkPaginationOverrides(doc);
	markLiteralSlashes(doc);
	const flags = normalizeFlags(doc);
	return { skipped, flags, restatedRequired: restateRequired(doc) };
}
