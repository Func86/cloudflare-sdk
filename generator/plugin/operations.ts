/**
 * Reads what the output needs from Forge's methods: where each field is sent, the
 * Cloudflare envelope, and how a list pages.
 */
import type { Field, Method, Type } from '@cloudflare/forge/plugin';
import type { Pagination } from '../../src/client.ts';
import { formatOfMediaType } from '../../src/media.ts';
import { afterAccountOrZone } from '../../src/routes.ts';
import { DRY_RUNS, PAGINATION_OVERRIDES } from '../patches.ts';
import { EXCLUSIVE_BODY, LITERAL_SLASHES } from '../spec.ts';

/**
 * Headers the runtime or fetch sets, which a request field must not override. A declared
 * `Accept` or `Content-Type` is kept: it chooses a format, or the type of an R2 object.
 */
const RUNTIME_HEADERS = new Set(['authorization', 'content-length']);
/**
 * What an `offset` of a list paged by number says when it wins over the page number, as those of
 * the mTLS and origin TLS certificate lists do. Others, such as client certificates', say only
 * "Offset the results.", so `paginate` moves their page number on.
 */
const OFFSET_WINS = /takes precedence over page/i;
/** Query parameters that take a cursor, and where each kind's next cursor may be in `result_info`. */
const CURSOR_PARAMS: Readonly<Record<string, readonly string[]>> = {
	cursor: ['cursor', 'cursors.after', 'next_cursor'],
	page_token: ['next_page_token'],
	after: ['cursors.after', 'cursor'],
};

export interface Param {
	name: string;
	in: 'path' | 'query' | 'header';
	required: boolean;
	description: string;
	type: Type | undefined;
}

export interface ResolvedBody {
	kind: 'json' | 'form' | 'raw';
	contentType?: string;
	/** Whether a JSON body can also be sent as a form, which is then a `FormData`. */
	formAlternative: boolean;
	/** Whether the body is one of its alternatives only, so each excludes the fields only the others have. */
	exclusive: boolean;
	required: boolean;
	description: string;
	type: Type | undefined;
}

export interface ResolvedResponse {
	kind: 'envelope' | 'json' | 'text' | 'bytes' | 'stream' | 'none';
	/** What `send` returns: the envelope's `result`, or the whole JSON body. */
	types: Type[];
	/** The fields the envelope declares for `result_info`. */
	resultInfo: Map<string, Field>;
	/** The other formats, for an operation that can answer in JSON and others, or in several others. */
	alternatives: ('text' | 'bytes' | 'stream')[];
	/** Whether an operation that answers in JSON can also answer with no content. */
	noContent: boolean;
	/** The JSON media types it declares, such as `application/scim+json`. */
	jsonTypes: string[];
}

export interface ResolvedOperation {
	/** The group path and method, as `workers.deployments.list`. */
	id: string;
	name: string;
	method: string;
	route: string;
	slashes: string[];
	summary: string;
	description: string;
	availability: string | undefined;
	deprecated: string | undefined;
	permissions: string[];
	/**
	 * Whether the route starts with `/{account_or_zone}/{account_or_zone_id}`, which the
	 * runtime fills from `account_id` or `zone_id`. `params` leaves the pair out.
	 */
	accountOrZone: boolean;
	/** Whether a request with `dry_run: true` only validates, and its result is then `null`. */
	dryRun: boolean;
	params: Param[];
	joined: string[];
	body: ResolvedBody | undefined;
	response: ResolvedResponse;
	page: Pagination | undefined;
}

/** What needs a person's attention, by reason. */
export type Report = Record<string, string[]>;

function isNull(type: Type): boolean {
	return type.kind === 'scalar' && type.scalar === 'null';
}

/** Follows models, and removes `null` from a union that is otherwise one type. */
function strip(type: Type): Type {
	if (type.kind === 'model') {
		return strip(type.model.type);
	}
	if (type.kind === 'union') {
		const members = type.members.filter((member) => !isNull(member));
		if (members.length === 1) {
			return strip(members[0]!);
		}
	}
	return type;
}

export interface Alternatives {
	/** At least two, none of them `null`. */
	members: Type[];
	/** Whether `null` is an alternative too. */
	nullable: boolean;
	/** Whether the union is a `oneOf`, which Forge marks `exclusive`, rather than an `anyOf`. */
	exclusive: boolean;
}

/** The alternatives of a union, through models and a `null` beside the union. */
export function alternativesOf(type: Type, nullable = false): Alternatives | undefined {
	if (type.kind === 'model') {
		return alternativesOf(type.model.type, nullable);
	}
	if (type.kind !== 'union') {
		return undefined;
	}
	const members = type.members.filter((member) => !isNull(member));
	const withNull = nullable || members.length < type.members.length;
	if (members.length === 1) {
		return alternativesOf(members[0]!, withNull);
	}
	return { members, nullable: withNull, exclusive: type.exclusive };
}

function isUnknown(type: Type): boolean {
	return type.kind === 'scalar' && type.scalar === 'unknown';
}

/**
 * Whether a type says nothing usable about a value: unknown, an object with no fields,
 * an array of such, or the envelope bases' `result` of any object, array or string.
 */
function isOpaque(type: Type, depth = 0): boolean {
	const resolved = strip(type);
	if (depth > 16) {
		return true;
	}
	switch (resolved.kind) {
		case 'scalar':
			return resolved.scalar === 'unknown';
		case 'object':
			return resolved.fields.length === 0 && (resolved.extra === undefined || isOpaque(resolved.extra, depth + 1));
		case 'array':
			return isOpaque(resolved.elem, depth + 1);
		case 'union': {
			const members = resolved.members.filter((member) => !isNull(member)).map(strip);
			return (
				members.some((member) => member.kind !== 'scalar' && isOpaque(member, depth + 1)) &&
				members.every((member) => member.kind === 'scalar' || isOpaque(member, depth + 1))
			);
		}
		default:
			return false;
	}
}

/** Whether two types are the same, as the spec often declares `result` again with the same model. */
function sameType(a: Type, b: Type, depth = 0): boolean {
	if (a.kind !== b.kind || depth > 16) {
		return false;
	}
	switch (a.kind) {
		case 'model':
			return a.model.schemaName === (b as typeof a).model.schemaName;
		case 'scalar':
			return a.scalar === (b as typeof a).scalar;
		case 'enum':
			return JSON.stringify(a.values) === JSON.stringify((b as typeof a).values);
		case 'array':
			return sameType(a.elem, (b as typeof a).elem, depth + 1);
		case 'object': {
			const other = b as typeof a;
			return (
				a.fields.length === other.fields.length &&
				a.fields.every((field, index) => {
					const match = other.fields[index]!;
					return field.wireName === match.wireName && field.required === match.required && sameType(field.type, match.type, depth + 1);
				})
			);
		}
		case 'union':
		case 'intersection': {
			const other = b as typeof a;
			return a.members.length === other.members.length && a.members.every((member, index) => sameType(member, other.members[index]!, depth + 1));
		}
		default:
			return false;
	}
}

/** Two declarations of a type as one: two lists are a list of both items, and two objects are both. */
function mergeTypes(earlier: Type, later: Type): Type {
	if (sameType(earlier, later)) {
		return later;
	}
	const a = strip(earlier);
	const b = strip(later);
	if (a.kind === 'array' && b.kind === 'array') {
		return { kind: 'array', elem: mergeTypes(a.elem, b.elem) } as Type;
	}
	const objectLike = (type: Type): boolean => type.kind === 'object' || type.kind === 'intersection';
	if (objectLike(a) && objectLike(b)) {
		return { kind: 'intersection', members: [earlier, later] } as unknown as Type;
	}
	return later;
}

/** The names of the fields a type can have, through models, intersections and unions. */
export function fieldNames(type: Type, into = new Set<string>(), depth = 0): Set<string> {
	const resolved = strip(type);
	if (depth > 16) {
		return into;
	}
	if (resolved.kind === 'intersection' || resolved.kind === 'union') {
		for (const member of resolved.members) {
			fieldNames(member, into, depth + 1);
		}
	} else if (resolved.kind === 'object') {
		for (const field of resolved.fields) {
			into.add(field.wireName);
		}
	}
	return into;
}

/**
 * The fields a composed type ends up with. When members declare a field more than once,
 * as envelopes do `result`, a generic declaration never replaces a concrete one, and two
 * concrete ones combine: a base can declare `{ continuation_token }` and the operation
 * `{ images }`. Otherwise the later one wins.
 */
export function flatFields(type: Type | undefined, into = new Map<string, Field>(), depth = 0): Map<string, Field> {
	if (type === undefined || depth > 16) {
		return into;
	}
	const resolved = strip(type);
	if (resolved.kind === 'intersection') {
		for (const member of resolved.members) {
			flatFields(member, into, depth + 1);
		}
	} else if (resolved.kind === 'object') {
		for (const field of resolved.fields) {
			const earlier = into.get(field.wireName);
			if (earlier === undefined || (isOpaque(earlier.type) && !isUnknown(field.type))) {
				into.set(field.wireName, field);
			} else if (!isOpaque(field.type)) {
				into.set(field.wireName, {
					...field,
					required: earlier.required || field.required,
					description: field.description || earlier.description,
					type: mergeTypes(earlier.type, field.type),
				});
			}
		}
	}
	return into;
}

function resolveParams(method: Method): { params: Param[]; joined: string[] } {
	const byName = new Map<string, Field>();
	const joined: string[] = [];
	const query: Param[] = [];
	const collect = (type: Type | undefined): void => {
		if (type?.kind === 'intersection') {
			type.members.forEach(collect);
		} else if (type?.kind === 'object') {
			for (const field of type.fields) {
				const location = method.location(field);
				if (location?.in === 'path') {
					byName.set(field.wireName, field);
				} else if (location?.in === 'query') {
					query.push({
						name: field.wireName,
						in: 'query',
						required: field.required,
						description: field.description,
						type: field.type,
					});
					if (!location.exploded) {
						joined.push(field.wireName);
					}
				}
			}
		}
	};
	collect(method.request);
	// The template decides the order of the path parameters.
	const params: Param[] = [...method.path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => {
		const field = byName.get(name!);
		return {
			name: name!,
			in: 'path',
			required: true,
			description: field?.description ?? '',
			type: field?.type,
		};
	});
	const taken = new Set(params.map((param) => param.name));
	// A query parameter that repeats a path parameter takes the same field.
	for (const param of query) {
		if (!taken.has(param.name)) {
			taken.add(param.name);
			params.push(param);
		}
	}
	for (const field of method.headers?.fields ?? []) {
		if (!RUNTIME_HEADERS.has(field.wireName.toLowerCase()) && !taken.has(field.wireName)) {
			taken.add(field.wireName);
			params.push({
				name: field.wireName,
				in: 'header',
				required: field.required,
				description: field.description,
				type: field.type,
			});
		}
	}
	return { params, joined };
}

/**
 * Whether the route runs against an account or a zone. The runtime fills its
 * `/{account_or_zone}/{account_or_zone_id}` prefix from `account_id` or `zone_id`,
 * so this throws for a pair it couldn't fill that way.
 */
export function readAccountOrZone(key: string, route: string, params: readonly Param[]): boolean {
	const rest = afterAccountOrZone(route);
	if (/\{account_or_zone(?:_id)?\}/.test(rest ?? route)) {
		throw new Error(`${key}: the runtime fills {account_or_zone} and {account_or_zone_id} only as the route's first two segments`);
	}
	if (rest === undefined) {
		return false;
	}
	const selector = params.find((param) => param.name === 'account_or_zone')?.type;
	const target = selector === undefined ? undefined : strip(selector);
	const values = target?.kind === 'enum' ? target.values.map(String).sort() : [];
	if (values.join() !== 'accounts,zones') {
		throw new Error(`${key}: {account_or_zone} should take accounts or zones, which the runtime picks by account_id or zone_id`);
	}
	const clash = params.find((param) => param.name === 'account_id' || param.name === 'zone_id');
	if (clash) {
		throw new Error(`${key}: the ${clash.in} parameter ${clash.name} would take the place of the route's account or zone`);
	}
	return true;
}

function resolveBody(method: Method): ResolvedBody | undefined {
	const { body } = method;
	if (!body || body.contents.length === 0) {
		return undefined;
	}
	const form = body.contents.find((content) => content.mediaType === 'multipart/form-data');
	const exclusive = method.extension(EXCLUSIVE_BODY) === true;
	// The mark says more than `oneOf` does, which a value with fields of two members can still
	// match, but never less.
	if (exclusive && (body.json === undefined || alternativesOf(body.json.type)?.exclusive !== true)) {
		throw new Error(`${method.httpMethod} ${method.path}: ${EXCLUSIVE_BODY} marks a body that isn't a JSON oneOf`);
	}
	const common = { required: body.required, description: body.description, formAlternative: false, exclusive };
	if (body.json) {
		return {
			...common,
			kind: 'json',
			...(body.json.mediaType === 'application/json' ? {} : { contentType: body.json.mediaType }),
			formAlternative: form !== undefined,
			type: body.json.type,
		};
	}
	if (form) {
		return { ...common, kind: 'form', type: form.type };
	}
	return { ...common, kind: 'raw', contentType: body.contents[0]!.mediaType, type: undefined };
}

/**
 * Whether fields with a `result` are the Cloudflare envelope: they say how the call went, or
 * hold nothing but the result, as some operations declare it. A `result` beside other data is
 * part of it: URL Scanner's report URL beside the scan's `uuid`, or an abuse report's
 * `"success"` beside its `abuse_rand`.
 */
function declaresEnvelope(fields: ReadonlyMap<string, Field>): boolean {
	return (
		['success', 'errors', 'messages'].some((name) => fields.has(name)) ||
		[...fields.keys()].every((name) => name === 'result' || name === 'result_info')
	);
}

/**
 * Reads the Cloudflare envelope of a response type: undefined when it has none.
 * Some operations declare it as a union, of a success with a `result` and an
 * empty or error shape without one, which aren't results. A bare branch is a
 * result, and comes last, because pagination reads the first.
 */
function readEnvelope(type: Type): { results: Type[]; info: Map<string, Field> } | undefined {
	const resolved = strip(type);
	const info = new Map<string, Field>();
	// JSON with no schema says nothing, and the runtime unwraps a `result` it finds.
	if (isUnknown(resolved)) {
		return { results: [resolved], info };
	}
	const branches = resolved.kind === 'union' ? resolved.members : [resolved];
	const results: Type[] = [];
	const bare: Type[] = [];
	for (const branch of branches) {
		const fields = flatFields(branch);
		const result = fields.get('result');
		if (result && declaresEnvelope(fields)) {
			results.push(result.type);
			flatFields(fields.get('result_info')?.type, info);
		} else if (fields.size > 0 && !fields.has('errors') && !fields.has('success')) {
			bare.push(branch);
		}
	}
	return results.length > 0 ? { results: [...results, ...bare], info } : undefined;
}

/** How a body in a media type other than JSON is read, by the rule the runtime reads responses with. */
function formatOf(mediaType: string): 'text' | 'bytes' | 'stream' {
	const format = formatOfMediaType(mediaType);
	if (format === 'json') {
		// The runtime would parse it, where its type says text or bytes.
		throw new Error(`Forge doesn't read ${mediaType} as JSON, but the runtime would`);
	}
	return format;
}

function resolveResponse(method: Method): ResolvedResponse {
	const none = new Map<string, Field>();
	const contents = method.responses.flatMap((response) => response.contents);
	const json = method.responses.flatMap((response) => (response.json ? [response.json.type] : []));
	if (json.length > 0) {
		const shape = {
			alternatives: [...new Set(contents.filter((content) => !content.isJson).map((content) => formatOf(content.mediaType)))],
			noContent: method.responses.some((response) => response.contents.length === 0),
			jsonTypes: [...new Set(method.responses.flatMap((response) => (response.json ? [response.json.mediaType] : [])))],
		};
		const envelopes = json.map(readEnvelope);
		if (envelopes.every((envelope) => envelope !== undefined)) {
			const resultInfo = new Map<string, Field>();
			for (const envelope of envelopes) {
				for (const [name, field] of envelope.info) {
					resultInfo.set(name, field);
				}
			}
			return { kind: 'envelope', types: envelopes.flatMap((envelope) => envelope.results), resultInfo, ...shape };
		}
		return { kind: 'json', types: json, resultInfo: none, ...shape };
	}
	// Several formats, such as a feed's XML and text, are read by the one the response is in.
	const [kind = 'none', ...alternatives] = new Set(contents.map((content) => formatOf(content.mediaType)));
	return { kind, types: [], resultInfo: none, alternatives, noContent: false, jsonTypes: [] };
}

/** Decides where a page keeps its items, or says why it can't. */
function locateItems(result: Type): { items?: string } | { problem: string } {
	const resolved = strip(result);
	if (resolved.kind === 'array') {
		return {};
	}
	if (resolved.kind === 'union') {
		// Bases often declare `result` as any object or array of objects. An
		// operation that pages over it can only be paging over the array.
		const members = resolved.members.filter((member) => !isNull(member)).map(strip);
		const isOpaqueObject = (member: Type): boolean => member.kind === 'object' && member.fields.length === 0;
		if (
			members.some((member) => member.kind === 'array') &&
			members.every((member) => member.kind === 'array' || isOpaqueObject(member))
		) {
			return {};
		}
		return { problem: 'result is a union of other shapes' };
	}
	const arrays = [...flatFields(resolved)]
		.filter(([, field]) => strip(field.type).kind === 'array')
		.map(([name]) => name);
	if (arrays.length === 1) {
		return { items: arrays[0]! };
	}
	return { problem: arrays.length === 0 ? 'result has no array' : `result has several arrays: ${arrays.join(', ')}` };
}

function declares(info: Map<string, Field>, path: string): boolean {
	const [head, ...rest] = path.split('.');
	const field = info.get(head!);
	if (field === undefined) {
		return false;
	}
	return rest.length === 0 || declares(flatFields(field.type), rest.join('.'));
}

/** The pagination an operation states with `x-fern-pagination`. */
function statedPagination(method: Method): Pagination | undefined {
	const stated = method.extension('x-fern-pagination') as Record<string, string> | undefined;
	const param = /^\$request\.(.+)$/.exec(stated?.['cursor'] ?? '')?.[1];
	const next = /^\$response\.result_info\.(.+)$/.exec(stated?.['next_cursor'] ?? '')?.[1];
	const items = /^\$response\.result(?:\.(.+))?$/.exec(stated?.['results'] ?? '');
	if (param === undefined || next === undefined || !items) {
		return undefined;
	}
	return { kind: 'cursor', ...(items[1] ? { items: items[1] } : {}), param, next };
}

/**
 * Stops generation when a pagination override no longer names an array of the result, as
 * the types read it: a base's generic `result` doesn't hide the operation's. Or when the
 * operation no longer takes the page number it pages by, or a cursor it names is no longer
 * a query parameter or in `result_info`. `prepare` checks the rest, that its operation is
 * generated and doesn't state its own pagination.
 */
export function checkOverride(key: string, override: Pagination, response: ResolvedResponse, query: ReadonlySet<string>): void {
	if (override.kind === 'page' && !query.has('page')) {
		throw new Error(`The pagination override for ${key} is stale, so check it and remove it: it has no page parameter`);
	}
	for (const cursor of override.kind === 'page' ? (override.cursors ?? []) : []) {
		if (!query.has(cursor.param) || !declares(response.resultInfo, cursor.next)) {
			throw new Error(
				`The pagination override for ${key} is stale, so check it and remove it: it has no ${cursor.param} parameter, or no result_info.${cursor.next}`,
			);
		}
	}
	const holds = (result: Type): boolean => {
		let list: Type | undefined = result;
		for (const name of override.items?.split('.') ?? []) {
			list = list === undefined ? undefined : flatFields(list).get(name)?.type;
		}
		return list !== undefined && strip(list).kind === 'array';
	};
	if (response.kind !== 'envelope' || !response.types.some(holds)) {
		const at = override.items === undefined ? 'result' : `result.${override.items}`;
		throw new Error(`The pagination override for ${key} is stale, so check it and remove it: it has no array at ${at}`);
	}
}

/**
 * The pagination of an operation, read from its parameters and response shape:
 * the spec states it for only a couple of operations. Only a GET is read this
 * way, because page parameters on anything else don't mean the response is a
 * page: creating a Turnstile widget takes them, and returns its domains.
 */
function resolvePagination(
	method: Method,
	key: string,
	params: readonly Param[],
	response: ResolvedResponse,
	report: Report,
): Pagination | undefined {
	const query = new Set(params.filter((param) => param.in === 'query').map((param) => param.name));
	const override = PAGINATION_OVERRIDES[key];
	if (override) {
		checkOverride(key, override, response, query);
		return override;
	}
	const stated = statedPagination(method);
	if (stated) {
		return stated;
	}
	if (method.httpMethod !== 'GET') {
		return undefined;
	}
	const cursorParam = Object.keys(CURSOR_PARAMS).find((name) => query.has(name));
	const paged = cursorParam !== undefined || query.has('page') || (query.has('limit') && query.has('offset'));
	if (!paged) {
		return undefined;
	}
	const note = (reason: string): undefined => {
		(report[reason] ??= []).push(key);
		return undefined;
	};
	if (response.kind !== 'envelope') {
		return note('paged parameters, but the response has no envelope');
	}
	const located = locateItems(response.types[0]!);
	if ('problem' in located) {
		return note(located.problem);
	}
	const items = located.items === undefined ? {} : { items: located.items };
	if (cursorParam !== undefined) {
		const next = CURSOR_PARAMS[cursorParam]!.find((path) => declares(response.resultInfo, path));
		if (next !== undefined) {
			return { kind: 'cursor', ...items, param: cursorParam, next };
		}
		if (!query.has('page') && !query.has('offset')) {
			return note('cursor parameter, but no next cursor in result_info');
		}
	}
	if (query.has('page')) {
		const offset = params.find((param) => param.in === 'query' && param.name === 'offset');
		const offsetWins = offset !== undefined && OFFSET_WINS.test(offset.description);
		return { kind: 'page', ...items, ...(offsetWins ? { offsetWins: true } : {}) };
	}
	return { kind: 'offset', ...items };
}

/**
 * Whether `DRY_RUNS` lists the operation, and stops generation when a listed one no longer
 * takes a boolean `dry_run`, or its result can't be `null`. `prepare` checks that each is generated.
 */
export function readDryRun(key: string, params: readonly Param[], response: ResolvedResponse): boolean {
	if (!DRY_RUNS.includes(key)) {
		return false;
	}
	const dryRun = params.find((param) => param.in === 'query' && param.name === 'dry_run');
	const flag = dryRun?.type === undefined ? undefined : strip(dryRun.type);
	const nullable = (type: Type): boolean => {
		const resolved = type.kind === 'model' ? type.model.type : type;
		return resolved.kind === 'union' && resolved.members.some(isNull);
	};
	if (flag?.kind !== 'scalar' || flag.scalar !== 'boolean' || response.kind !== 'envelope' || !response.types.some(nullable)) {
		throw new Error(`The dry run of ${key} is stale, so check it and remove it from DRY_RUNS: it has no boolean dry_run, or no null result`);
	}
	return true;
}

function deprecationOf(method: Method): string | undefined {
	if (!method.deprecated && method.availability !== 'deprecated') {
		return undefined;
	}
	const sunset = method.extension('x-forge-sunset');
	const message =
		method.extension('x-stainless-deprecation-message') ??
		(method.extension('x-cfDeprecation') as Record<string, unknown> | undefined)?.['description'];
	return [typeof message === 'string' ? message : '', typeof sunset === 'string' ? `Sunset: ${sunset}.` : '']
		.filter(Boolean)
		.join(' ');
}

export function resolveOperation(method: Method, report: Report): ResolvedOperation {
	const key = `${method.httpMethod} ${method.path}`;
	const resolved = resolveParams(method);
	const accountOrZone = readAccountOrZone(key, method.path, resolved.params);
	const params = accountOrZone
		? resolved.params.filter((param) => param.name !== 'account_or_zone' && param.name !== 'account_or_zone_id')
		: resolved.params;
	const response = resolveResponse(method);
	const permissions = method.extension('x-api-token-group');
	const slashes = method.extension(LITERAL_SLASHES);
	return {
		id: [...method.group.path.map((name) => name.kebab()), method.name.camel()].join('.'),
		name: method.name.camel(),
		method: method.httpMethod,
		route: method.path,
		slashes: Array.isArray(slashes) ? (slashes as string[]) : [],
		summary: method.summary,
		description: method.description,
		availability: method.availability,
		deprecated: deprecationOf(method),
		permissions: Array.isArray(permissions) ? (permissions as string[]) : [],
		accountOrZone,
		dryRun: readDryRun(key, params, response),
		params,
		joined: resolved.joined,
		body: resolveBody(method),
		response,
		page: resolvePagination(method, key, params, response, report),
	};
}
