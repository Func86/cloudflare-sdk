/**
 * Compares captured response shapes with what the spec declares, because the
 * generated types are only as accurate as the spec.
 *
 *     node generator/conformance.ts CAPTURES.json [--spec PATH]
 *
 * Run it after generating: it finds each operation in `generated/_meta/operations.json`,
 * and then reads the raw document, whose schemas say more than Forge's model.
 *
 * A capture holds keys and JSON types, never values:
 *     [{ "id": "workers.deployments.list", "shape": ":object deployments:array deployments[]:object ..." }]
 *
 * It reports, against the patched spec:
 * - mismatch: a value of a type the spec doesn't allow. The types are wrong.
 * - missing: a required field that never appeared. The types are wrong, though
 *   this can't tell for fields of a union, so those aren't checked.
 * - undeclared: a field the spec doesn't mention. The types are incomplete.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { applyPatches } from './patches.ts';
import { normalizeFlags } from './prepare.ts';
import { type OpenApiDocument, type Schema, Spec } from './spec.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { spec: { type: 'string' } },
});
const specPath = values.spec ?? process.env['OPENAPI_BUNDLE'];
if (positionals[0] === undefined || specPath === undefined) {
	throw new Error('usage: conformance.ts CAPTURES.json --spec PATH');
}

const doc = JSON.parse(readFileSync(specPath, 'utf8')) as OpenApiDocument;
applyPatches(doc);
// As the types read them: a `writeOnly` field isn't required in what the API sends.
normalizeFlags(doc);
const spec = new Spec(doc);
const manifest = JSON.parse(readFileSync('generated/_meta/operations.json', 'utf8')) as {
	id: string;
	method: string;
	route: string;
}[];
const byId = new Map(manifest.map((entry) => [entry.id, entry]));

/** Whether a schema says what type its value is. One with only a description, a flag or a composition doesn't. */
function constrains(node: Schema): boolean {
	return ['type', 'properties', 'items', 'enum', 'additionalProperties'].some((key) => key in node);
}

function isScalar(node: Schema): boolean {
	return ['string', 'number', 'integer', 'boolean'].includes(node['type']) && !node['enum'];
}

function isUnknown(node: Schema): boolean {
	return !constrains(node) && !node['allOf'] && !node['oneOf'] && !node['anyOf'];
}

/** Every declaration of a property through `allOf`, in order. `Spec.flatProperties` keeps only the last. */
function declarations(schema: Schema | undefined, name: string, depth = 0): Schema[] {
	const node = spec.deref(schema);
	if (depth > 16) {
		return [];
	}
	const own = node['properties']?.[name] as Schema | undefined;
	const inherited = ((node['allOf'] ?? []) as Schema[]).flatMap((branch) => declarations(branch, name, depth + 1));
	return own ? [...inherited, own] : inherited;
}

/** Follows references, and a union that is one type besides `null`, as the plugin's `strip` does. */
function strip(schema: Schema | undefined): Schema {
	const node = spec.deref(schema);
	const members = ((node['oneOf'] ?? node['anyOf'] ?? []) as Schema[]).filter((member) => spec.deref(member)['type'] !== 'null');
	return members.length === 1 && !constrains(node) ? strip(members[0]) : node;
}

/**
 * The plugin's `isOpaque` on a schema: unknown, an object with no fields, an array of such,
 * or the envelope bases' `result` of any object, array or string.
 */
function isOpaque(schema: Schema | undefined, depth = 0): boolean {
	const node = strip(schema);
	if (depth > 16) {
		return true;
	}
	const union = (node['oneOf'] ?? node['anyOf']) as Schema[] | undefined;
	if (node['allOf'] || node['enum'] || isScalar(node)) {
		return false;
	} else if (union) {
		const members = union.map(strip).filter((member) => member['type'] !== 'null');
		return (
			members.some((member) => !isScalar(member) && isOpaque(member, depth + 1)) &&
			members.every((member) => isScalar(member) || isOpaque(member, depth + 1))
		);
	} else if (node['type'] === 'array' || node['items']) {
		return isOpaque(node['items'], depth + 1);
	}
	const extra = node['additionalProperties'];
	return Object.keys(node['properties'] ?? {}).length === 0 && (extra === undefined || extra === true || isOpaque(extra, depth + 1));
}

/** The plugin's `mergeTypes`: two arrays are an array of both items, two objects both, and otherwise the later wins. */
function merge(earlier: Schema, later: Schema): Schema {
	const a = strip(earlier);
	const b = strip(later);
	const objectLike = (node: Schema): boolean => node['type'] === 'object' || 'properties' in node || 'allOf' in node;
	if (a['type'] === 'array' && b['type'] === 'array') {
		return { type: 'array', items: merge(a['items'] ?? {}, b['items'] ?? {}) };
	}
	return objectLike(a) && objectLike(b) ? { allOf: [earlier, later] } : later;
}

/**
 * A property as the types have it, from every declaration through `allOf`. This repeats the
 * plugin's `flatFields` on the raw schemas, which say more than Forge's model: a generic
 * declaration never replaces a concrete one, and two concrete ones merge. Images' base
 * declares `result` as `{ continuation_token }` and the operation as `{ images }`, and a
 * Rules list's items aren't replaced by the base's generic array.
 */
function property(schema: Schema | undefined, name: string): Schema | undefined {
	let current: Schema | undefined;
	for (const declared of declarations(schema, name)) {
		if (current === undefined || (isOpaque(current) && !isUnknown(strip(declared)))) {
			current = declared;
		} else if (!isOpaque(declared)) {
			current = merge(current, declared);
		}
	}
	return current;
}

/** What `send` returns for an operation: the envelope's `result`, or the whole JSON body. */
function resultSchemas(method: string, route: string): Schema[] {
	const operation: Schema | undefined = doc.paths[route]?.[method.toLowerCase()];
	const out: Schema[] = [];
	for (const [status, raw] of Object.entries<Schema>(operation?.['responses'] ?? {})) {
		if (!status.startsWith('2')) {
			continue;
		}
		const content: Record<string, Schema> = spec.deref(raw)['content'] ?? {};
		const schema = (content['application/json'] ?? Object.values(content)[0])?.['schema'] as Schema | undefined;
		if (schema) {
			const node = spec.deref(schema);
			const branches: Schema[] = node['oneOf'] ?? node['anyOf'] ?? [schema];
			// As the generator reads them: an envelope's `result`, or a bare success branch, such
			// as `ai.models.list`'s `{ data }`. A branch with `errors` or `success` is neither. A
			// `result` beside other data and no envelope fields is data, as URL Scanner's is.
			const results = branches.flatMap((branch) => {
				const properties = spec.flatProperties(branch);
				const names = Object.keys(properties);
				const enveloped =
					['success', 'errors', 'messages'].some((name) => name in properties) ||
					names.every((name) => name === 'result' || name === 'result_info');
				const result = enveloped ? property(branch, 'result') : undefined;
				if (result) {
					return [result];
				}
				const bare = Object.keys(properties).length > 0 && !('errors' in properties) && !('success' in properties);
				return bare ? [branch] : [];
			});
			out.push(...(results.length > 0 ? results : [schema]));
		}
	}
	return out;
}

/** One way a value can match a schema: all of these schemas at once, as the branches of an `allOf`. */
type Alternative = Schema[];

/** A cap for schemas with many nested unions, far above what the captured ones need. */
const MAX_ALTERNATIVES = 512;

/** Every way to match one option from each list. */
function product(lists: readonly Alternative[][]): Alternative[] {
	let out: Alternative[] = [[]];
	for (const options of lists) {
		out = out.flatMap((alternative) => options.map((option) => [...alternative, ...option])).slice(0, MAX_ALTERNATIVES);
	}
	return out;
}

/** The ways a value at a node can match: every `allOf` branch at once, and one branch of a `oneOf` or `anyOf`. */
function expand(schema: Schema | undefined, throughUnions: boolean, seen: ReadonlySet<Schema> = new Set()): Alternative[] {
	const node = spec.deref(schema);
	if (seen.has(node)) {
		// A cycle says nothing more.
		return [[]];
	}
	const inner = new Set(seen).add(node);
	const parts: Alternative[][] = [[[node]], ...((node['allOf'] ?? []) as Schema[]).map((branch) => expand(branch, throughUnions, inner))];
	const union = (node['oneOf'] ?? node['anyOf']) as Schema[] | undefined;
	if (throughUnions && union) {
		parts.push(union.flatMap((branch) => expand(branch, throughUnions, inner)));
	}
	return product(parts);
}

function child(alternatives: readonly Alternative[], token: string, throughUnions: boolean): { alternatives: Alternative[]; open: boolean } {
	const next: Alternative[] = [];
	let open = false;
	const follow = (schemas: Schema[]): void => {
		next.push(...product(schemas.map((schema) => expand(schema, throughUnions))));
	};
	for (const alternative of alternatives) {
		if (token === '[]') {
			const items = alternative.filter((node) => node['items']).map((node) => node['items'] as Schema);
			// An array with no `items` says nothing about them.
			if (items.length === 0) {
				open = true;
			} else {
				follow(items);
			}
			continue;
		}
		const declared = alternative.filter((node) => node['properties']?.[token]).map((node) => node['properties'][token] as Schema);
		const extra = alternative
			.map((node) => node['additionalProperties'])
			.filter((value): value is Schema => typeof value === 'object' && value !== null);
		if (declared.length > 0) {
			follow(declared);
		} else if (extra.length > 0) {
			follow(extra);
		} else if (alternative.some((node) => node['additionalProperties'] === true) || !alternative.some((node) => node['properties'])) {
			// Nothing here names the fields, so any field is allowed.
			open = true;
		}
	}
	return { alternatives: next, open };
}

function tokens(path: string): string[] {
	return path === '' ? [] : path.split('.').flatMap((part) => {
		const name = part.replace(/(\[\])+$/, '');
		const arrays = (part.length - name.length) / 2;
		return [...(name === '' ? [] : [name]), ...Array<string>(arrays).fill('[]')];
	});
}

/** A value's type, as a capture names it. */
function jsonType(value: unknown): string {
	return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Whether `observed` can be a value at a node: every typed schema of one alternative allows
 * it. `null` only needs one schema of it to, as `generator/prepare.ts` reads `nullable` in
 * an `allOf` branch.
 */
function allows(alternatives: readonly Alternative[], observed: string): boolean {
	return alternatives.some((alternative) => {
		const typed = alternative.filter(constrains);
		if (observed === 'null') {
			return (
				typed.length === 0 ||
				alternative.some((node) => node['nullable'] === true || node['type'] === 'null' || node['enum']?.includes(null))
			);
		}
		return typed.every((node) => {
			const type = node['type'];
			if (type === undefined) {
				// An enum with no type allows the types of its values, as the generated union does.
				if (Array.isArray(node['enum'])) {
					return (node['enum'] as unknown[]).some((value) => jsonType(value) === observed);
				}
				return node['properties'] ? observed === 'object' : node['items'] ? observed === 'array' : true;
			}
			return type === observed || (observed === 'number' && type === 'integer');
		});
	});
}

interface Finding {
	kind: 'mismatch' | 'missing' | 'undeclared';
	path: string;
	detail: string;
}

function check(id: string, shape: string): { checked: number; findings: Finding[] } | undefined {
	const entry = byId.get(id);
	const roots = entry ? resultSchemas(entry.method, entry.route) : [];
	if (roots.length === 0) {
		return undefined;
	}
	const observed = new Map<string, string[]>();
	for (const entry of shape.split(' ').filter(Boolean)) {
		const split = entry.lastIndexOf(':');
		observed.set(entry.slice(0, split), entry.slice(split + 1).split('|'));
	}
	const findings: Finding[] = [];
	let checked = 0;
	for (const [path, types] of observed) {
		let alternatives = roots.flatMap((root) => expand(root, true));
		let undeclaredAt: string | undefined;
		const parts = tokens(path);
		for (const token of parts) {
			const next = child(alternatives, token, true);
			alternatives = next.alternatives;
			if (alternatives.length === 0) {
				if (!next.open) {
					undeclaredAt = path;
				}
				break;
			}
		}
		checked += 1;
		if (undeclaredAt !== undefined) {
			findings.push({ kind: 'undeclared', path, detail: types.join('|') });
			continue;
		}
		if (alternatives.length === 0) {
			continue;
		}
		for (const type of types) {
			if (type !== 'bigmap' && !allows(alternatives, type)) {
				const nodes = alternatives.flat().filter((node) => constrains(node) || node['nullable'] === true);
				const typeOf = (node: Schema): string =>
					node['type'] ??
					(Array.isArray(node['enum']) ? `enum of ${[...new Set((node['enum'] as unknown[]).map(jsonType))].join('|')}` : 'untyped');
				const declared = [...new Set(nodes.map((node) => `${typeOf(node)}${node['nullable'] ? '|null' : ''}`))];
				findings.push({ kind: 'mismatch', path, detail: `got ${type}, declared ${declared.join(', ')}` });
			}
		}
		// Required fields, only where no union leaves the question open.
		if (types.includes('object') && !types.includes('bigmap')) {
			let strict = roots.length === 1 ? expand(roots[0], false) : [];
			for (const token of parts) {
				strict = child(strict, token, false).alternatives;
			}
			const only = strict.length === 1 ? strict[0]! : undefined;
			if (only && !only.some((node) => node['oneOf'] || node['anyOf'])) {
				for (const name of new Set(only.flatMap((node) => (node['required'] ?? []) as string[]))) {
					const field = path === '' ? name : `${path}.${name}`;
					if (!observed.has(field)) {
						findings.push({ kind: 'missing', path: field, detail: 'required, never sent' });
					}
				}
			}
		}
	}
	return { checked, findings };
}

const captures = JSON.parse(readFileSync(positionals[0], 'utf8')) as { id: string; shape?: string; note?: string }[];
const totals = { checked: 0, mismatch: 0, missing: 0, undeclared: 0 };
for (const capture of captures) {
	if (capture.shape === undefined) {
		console.log(`- ${capture.id}: not captured (${capture.note ?? 'no shape'})`);
		continue;
	}
	const result = check(capture.id, capture.shape);
	if (!result) {
		console.log(`- ${capture.id}: not generated, or has no schema`);
		continue;
	}
	totals.checked += result.checked;
	const count = (kind: Finding['kind']): number => result.findings.filter((finding) => finding.kind === kind).length;
	for (const kind of ['mismatch', 'missing', 'undeclared'] as const) {
		totals[kind] += count(kind);
	}
	console.log(
		`- ${capture.id}: ${result.checked} fields; ${count('mismatch')} mismatch, ${count('missing')} missing, ${count('undeclared')} undeclared`,
	);
	for (const finding of result.findings) {
		console.log(`    ${finding.kind} ${finding.path}: ${finding.detail}`);
	}
}
console.log(
	`\n${totals.checked} fields checked: ${totals.mismatch} mismatch, ${totals.missing} missing, ${totals.undeclared} undeclared`,
);
