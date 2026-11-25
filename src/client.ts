/**
 * The hand-written runtime. Generated modules are plain `Operation` literals
 * with no imports, so an application bundles this runtime and only the
 * operations it imports.
 */
import { formatOfMediaType } from './media.ts';
import { ACCOUNT_OR_ZONE, afterAccountOrZone } from './routes.ts';

/** Where a paginated operation keeps its items, and how it picks the next page. */
export type Pagination =
	| ({
			kind: 'page';
			/** The array's key in `result`, dotted for one further down; `result` itself is the array when absent. */
			items?: string;
			/**
			 * Cursors that page the list instead, each when the request sets its `param`, even to
			 * an empty string, as the API refuses a page number beside one. `next` is as for a
			 * cursor list. One can go back, as DNS records' `prev_cursor` does.
			 */
			cursors?: readonly ({ param: string; next: string } & Excludes)[];
			/**
			 * Whether an `offset` the request sets wins over the page number, as the spec says
			 * of a few lists, so that the offset moves on instead.
			 */
			offsetWins?: true;
	  } & Excludes)
	| ({
			kind: 'offset';
			items?: string;
	  } & Excludes)
	| ({
			kind: 'cursor';
			items?: string;
			/** The query parameter that takes the cursor. */
			param: string;
			/** The dotted path of the next cursor in `result_info`. */
			next: string;
	  } & Excludes);

/** What the API refuses beside the parameter a list moves on: `page`, `offset` or its cursor. */
interface Excludes {
	/** Parameters that `paginate` won't take with it, as it would send them beside the next one. */
	excludes?: readonly string[];
}

/** What an operation sends and how its response is read. `Req` and `Res` are type-only. */
export interface Operation<Req = unknown, Res = unknown> {
	method: string;
	/** The path, with each path parameter as `{name}`. */
	route: string;
	/**
	 * Whether the route starts with `/{account_or_zone}/{account_or_zone_id}`, which the
	 * request's `account_id` or `zone_id` fills, as `AccountOrZone` says.
	 */
	accountOrZone?: true;
	/** The path parameters whose value is a path of its own, so its slashes aren't encoded. */
	slashes?: readonly string[];
	/** The query parameters, by wire name. A name with `<placeholders>` matches any request field it fits. */
	query?: readonly string[];
	/** The query parameters whose arrays are joined with commas. */
	joined?: readonly string[];
	/** The header parameters, by wire name. */
	headers?: readonly string[];
	/** How the request's `body` field is sent. No body when absent. */
	body?: 'json' | 'form' | 'raw';
	/** The media type of a `json` or `raw` body, when not `application/json`. */
	contentType?: string;
	/** Whether the JSON response is the Cloudflare envelope; true when absent. */
	envelope?: false;
	/**
	 * How the response is read: enveloped JSON when absent, and by its content type when
	 * `auto`. A `stream`, such as server-sent events, is the body, unread. A list is the
	 * formats of an operation with no JSON, read by the content type, and as the first
	 * when it names none of them, JSON included.
	 */
	response?: 'none' | 'text' | 'bytes' | 'stream' | 'auto' | readonly ('text' | 'bytes' | 'stream')[];
	/** The `Accept` header, when not `application/json`. */
	accept?: string;
	/** Whether a request with `dry_run: true` only validates, and its result is then `null`. */
	dryRun?: true;
	readonly __req?: (request: Req) => void;
	readonly __res?: () => Res;
}

/**
 * An operation that a request with `dry_run: true` only validates. `Res` includes the dry run's
 * `null`, so it holds wherever the operation is an `Operation`, and `send` leaves the `null` out
 * of a request that makes the change.
 */
export interface DryRunOperation<Req = unknown, Res = unknown> extends Operation<Req, Res> {
	dryRun: true;
}

/** An operation that `page` and `paginate` accept. */
export interface PagedOperation<Req = unknown, Res = unknown, Item = unknown> extends Operation<Req, Res> {
	page: Pagination;
	readonly __item?: () => Item;
}

/** The item type of a result that is itself the array. */
export type RootItem<Res> = Res extends readonly (infer Item)[] ? Item : never;

/**
 * The account or the zone that an operation under `/{account_or_zone}/{account_or_zone_id}`
 * runs against: `account_id` sends it to `/accounts/{account_id}`, and `zone_id` to `/zones/{zone_id}`.
 */
export type AccountOrZone =
	| {
			/** The account to run against. */
			account_id: string;
			zone_id?: never;
	  }
	| {
			/** The zone to run against. */
			zone_id: string;
			account_id?: never;
	  };

/** The item type of a result that keeps its array under `Key`, which is dotted for one further down. */
export type ItemOf<Res, Key extends string> = Key extends `${infer Head}.${infer Rest}`
	? Res extends { [K in Head]?: infer Inner }
		? ItemOf<NonNullable<Inner>, Rest>
		: never
	: Res extends { [K in Key]?: infer List }
		? NonNullable<List> extends readonly (infer Item)[]
			? Item
			: never
		: never;

export interface ClientOptions {
	/** The API token or OAuth access token, sent as a bearer token. */
	token?: string;
	baseUrl?: string;
	/** Headers sent with every request, such as `api-version`. */
	headers?: HeadersInit;
	/**
	 * Aborts each attempt, including reading its response, after this long. A stream, such
	 * as server-sent events, is only timed until it's returned, and `signal` ends it.
	 * No timeout when absent. It doesn't bound the waits between retries: to bound a whole
	 * call, give the call a `signal`, such as `AbortSignal.timeout(10_000)`.
	 */
	timeoutMs?: number;
	/**
	 * How many times to retry a GET, HEAD, PUT or DELETE after a 429 or 5XX, unless its
	 * body is a stream, which can only be read once. 0 by default. A retry waits as long as
	 * `Retry-After` says, up to 60 s, and `0` retries at once; when it says longer, the
	 * failure is thrown at once, with the header. Without it, or with a date that has
	 * passed, the wait doubles from 0.5 s, up to 8 s.
	 */
	maxRetries?: number;
	/**
	 * Called as a plain function. A method that needs its object, as a service binding's
	 * does, fails with "Illegal invocation", so wrap it:
	 * `(input, init) => env.API.fetch(input, init)`.
	 */
	fetch?: typeof fetch;
}

export interface RequestOptions {
	signal?: AbortSignal;
	/** Headers that replace any others, including the client's and the request's header fields. */
	headers?: HeadersInit;
	/** Called with the response before its body is read. */
	onResponse?: (response: Response) => void;
	timeoutMs?: number;
	maxRetries?: number;
}

/** A message of the Cloudflare envelope. */
export interface ApiMessage {
	code?: number | string;
	/**
	 * The text the server sent. An entry without it, such as Builds' `{ issues, name: 'ZodError' }`,
	 * has none, and `ApiError`'s own message shows that entry as JSON.
	 */
	message?: string;
	/** A page about this message. */
	documentation_url?: string;
	/**
	 * What the message is about, such as `{ pointer: '/rules/0/action' }` for a field of the
	 * request body, or `{ parameter: 'per_page' }` for a parameter.
	 */
	source?: { pointer?: string; [key: string]: unknown };
	[key: string]: unknown;
}

/** The pagination metadata of the Cloudflare envelope. */
export interface ResultInfo {
	page?: number;
	per_page?: number;
	count?: number;
	total_count?: number;
	total_pages?: number;
	cursor?: string;
	[key: string]: unknown;
}

/** One page of a paginated operation. */
export interface Page<Res, Item> {
	/** The array the operation's pagination points at; empty when it is `null`. */
	items: Item[];
	/** The whole `result`, including any fields next to the items. */
	result: Res;
	/** Absent when the API sends none, as several list endpoints do. */
	resultInfo: ResultInfo | undefined;
}

/**
 * A failed request: a non-2XX status, a 2XX whose envelope says `success: false`, or a
 * 2XX whose body should be JSON and isn't, such as a proxy's HTML page.
 */
export class ApiError extends Error {
	override readonly name = 'ApiError';
	readonly status: number;
	readonly errors: readonly ApiMessage[];
	readonly messages: readonly ApiMessage[];
	readonly headers: Headers;
	/** The parsed JSON body, or the text of a body that isn't JSON. */
	readonly body: unknown;

	/**
	 * A test can give `response` as its status and any headers alone, and leave out `method` and
	 * `path`, which its message then names as far as it can, such as `A POST request`.
	 */
	constructor(
		response: { readonly status: number; readonly headers?: Headers },
		body: unknown,
		method?: string,
		path?: string,
		problem?: string,
	) {
		const envelope = isRecord(body) ? body : {};
		const listed = entriesOf(envelope['errors']);
		// Some failures aren't in the envelope, such as a validation error under `error`.
		const entries = listed.length > 0 ? listed : entriesOf(envelope['error'] ?? envelope['message'] ?? envelope['msg']);
		const errors = entries.map(messageOf);
		// The text is the entry as sent, as `errors` leaves out its fields of another type.
		const detail =
			problem ??
			entries
				.map((entry, index) => {
					const code = errors[index]?.code;
					return code === undefined ? textOf(entry) : `${code}: ${textOf(entry)}`;
				})
				.join('; ');
		const request =
			method && path ? `${method} ${path}` : method ? `A ${method} request` : path ? `A request to ${path}` : 'A request';
		super(`${request} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
		this.status = response.status;
		this.errors = errors;
		this.messages = entriesOf(envelope['messages']).map(messageOf);
		this.headers = response.headers ?? new Headers();
		this.body = body;
	}
}

/**
 * A request that got no response, or lost it while reading it, such as to a timeout or a
 * reset connection. One the caller aborted throws the abort instead.
 */
export class ApiConnectionError extends Error {
	override readonly name = 'ApiConnectionError';

	constructor(method: string, path: string, cause: unknown) {
		super(`${method} ${path} got no complete response`, { cause });
	}
}

/** `never`, which rejects the overload, when `Req` has a required field. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `{}` is the request with no fields.
type WhenOptional<Req> = {} extends Req ? unknown : never;

/**
 * Each method has an overload for a request that can be left out. The request
 * is a parameter of its own rather than part of a conditional rest tuple, which
 * would turn off the excess property check and let a mistyped optional
 * parameter compile, and then be dropped.
 */
export interface Client {
	/** Sends a dry run, which only validates, so its `result` is `null`. */
	send<Req, Res>(
		operation: DryRunOperation<Req, Res>,
		request: NoInfer<Req> & { dry_run: true },
		options?: RequestOptions,
	): Promise<null>;
	/**
	 * Sends a request that makes the change, whose `result` is never `null`. A `dry_run` that
	 * may be `true`, such as an optional one or a `boolean`, falls to the next overloads, which
	 * keep the `null`.
	 */
	send<Req, Res>(
		operation: DryRunOperation<Req, Res>,
		request: NoInfer<Req> & { dry_run?: false },
		options?: RequestOptions,
	): Promise<Exclude<Res, null>>;
	/** Sends a request and returns the envelope's `result`, or the bare response of an operation without one. */
	send<Req, Res>(
		operation: Operation<Req, Res> & WhenOptional<Req>,
		request?: NoInfer<Req>,
		options?: RequestOptions,
	): Promise<Res>;
	send<Req, Res>(operation: Operation<Req, Res>, request: NoInfer<Req>, options?: RequestOptions): Promise<Res>;
	/** Sends one page of a paginated operation. */
	page<Req, Res, Item>(
		operation: PagedOperation<Req, Res, Item> & WhenOptional<Req>,
		request?: NoInfer<Req>,
		options?: RequestOptions,
	): Promise<Page<Res, Item>>;
	page<Req, Res, Item>(
		operation: PagedOperation<Req, Res, Item>,
		request: NoInfer<Req>,
		options?: RequestOptions,
	): Promise<Page<Res, Item>>;
	/**
	 * Iterates every item of every page, without a trailing request when the last page is
	 * known. Throws a `TypeError` on a response that isn't a page, such as one in CSV.
	 */
	paginate<Req, Res, Item>(
		operation: PagedOperation<Req, Res, Item> & WhenOptional<Req>,
		request?: NoInfer<Req>,
		options?: RequestOptions,
	): AsyncIterable<Item>;
	paginate<Req, Res, Item>(
		operation: PagedOperation<Req, Res, Item>,
		request: NoInfer<Req>,
		options?: RequestOptions,
	): AsyncIterable<Item>;
}

export type Fields = Record<string, unknown>;

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

function isRecord(value: unknown): value is Fields {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The entries of `errors` or `messages`, so that what the server said is never lost. Beside
 * the usual list of objects, the API declares strings, objects with no `message`, and a lone
 * object rather than a list.
 */
function entriesOf(value: unknown): unknown[] {
	const said = (entry: unknown): boolean =>
		entry !== undefined && entry !== null && entry !== '' && !(isRecord(entry) && Object.keys(entry).length === 0);
	return (Array.isArray(value) ? value : [value]).filter(said);
}

/** An entry as text for the error's own message: the server's message, or the entry as sent, as JSON. */
function textOf(entry: unknown): string {
	if (typeof entry === 'string') {
		return entry;
	}
	const message = isRecord(entry) ? entry['message'] : undefined;
	return typeof message === 'string' ? message : JSON.stringify(entry);
}

/**
 * An entry as an `ApiMessage`, leaving out a field it declares that the entry has in another
 * type, such as a `documentation_url` of `null`, and keeping the rest. `ApiError.body` still
 * has it as sent. An entry that is neither text nor an object, which none declares, is its JSON.
 */
function messageOf(entry: unknown): ApiMessage {
	if (typeof entry === 'string') {
		return { message: entry };
	}
	if (!isRecord(entry)) {
		return { message: JSON.stringify(entry) };
	}
	const typed: Fields = { ...entry };
	const { code, message, documentation_url: url, source } = entry;
	if (typeof message !== 'string') {
		delete typed['message'];
	}
	if (typeof code !== 'number' && typeof code !== 'string') {
		delete typed['code'];
	}
	if (typeof url !== 'string') {
		delete typed['documentation_url'];
	}
	if (!isRecord(source)) {
		delete typed['source'];
	} else {
		const { pointer, ...others } = source;
		if (pointer !== undefined && typeof pointer !== 'string') {
			typed['source'] = others;
		}
	}
	return typed;
}

/** A value as text for a URL or a header: an object as JSON, rather than `[object Object]`. */
function toParam(value: unknown): string {
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- objects are JSON, so this is a primitive.
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The route, with an account-or-zone prefix replaced by the account's or the zone's. */
function routeOf(operation: Operation, request: Fields): string {
	const { method, route } = operation;
	if (!operation.accountOrZone) {
		return route;
	}
	const rest = afterAccountOrZone(route);
	if (rest === undefined) {
		throw new TypeError(`${method} ${route}: an account-or-zone route starts with ${ACCOUNT_OR_ZONE}`);
	}
	const given = (name: string): boolean => request[name] !== undefined && request[name] !== null;
	const account = given('account_id');
	if (account === given('zone_id')) {
		throw new TypeError(`${method} ${route}: give account_id or zone_id${account ? ', not both' : ''}`);
	}
	return (account ? '/accounts/{account_id}' : '/zones/{zone_id}') + rest;
}

/** The route filled from the request, with each value encoded. */
function pathOf(operation: Operation, route: string, request: Fields): string {
	return route.replace(/\{([^}]+)\}/g, (_, name: string) => {
		const value = request[name];
		// An empty segment would address a different endpoint.
		if (value === undefined || value === null || value === '') {
			throw new TypeError(`${operation.method} ${route}: ${name} is required`);
		}
		const segments = operation.slashes?.includes(name) ? toParam(value).split('/') : [toParam(value)];
		// Encoding leaves dots alone, and URL parsing would resolve these against the
		// route: a value could reach another endpoint with the same token and method.
		if (segments.some((segment) => segment === '.' || segment === '..')) {
			throw new TypeError(`${operation.method} ${route}: ${name} can't have a "." or ".." segment`);
		}
		return segments.map((segment) => encodeURIComponent(segment)).join('/');
	});
}

/** Matches the names a template such as `meta.<field>[<operator>]` stands for. */
function templatePattern(template: string): RegExp {
	const parts = template.split(/<[^>]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	return new RegExp(`^${parts.join('.+')}$`);
}

function queryOf(operation: Operation, request: Fields): string {
	const query = new URLSearchParams();
	const add = (name: string, value: unknown): void => {
		if (value === undefined || value === null) {
			return;
		}
		if (isRecord(value)) {
			// OpenAPI's default for an object: each field is a parameter of its own.
			for (const [field, item] of Object.entries(value)) {
				if (item !== undefined && item !== null) {
					query.append(field, toParam(item));
				}
			}
		} else if (!Array.isArray(value)) {
			query.append(name, toParam(value));
		} else if (operation.joined?.includes(name)) {
			query.append(name, value.map(toParam).join(','));
		} else {
			for (const item of value) {
				query.append(name, toParam(item));
			}
		}
	};
	for (const name of operation.query ?? []) {
		if (name.includes('<')) {
			// A name with placeholders, such as Images' metadata filters, is each field it matches.
			const pattern = templatePattern(name);
			for (const [field, value] of Object.entries(request)) {
				if (pattern.test(field)) {
					add(field, value);
				}
			}
		} else {
			add(name, request[name]);
		}
	}
	const text = query.toString();
	return text === '' ? '' : `?${text}`;
}

function formOf(body: unknown): FormData {
	if (body instanceof FormData) {
		return body;
	}
	const form = new FormData();
	const append = (name: string, value: unknown): void => {
		if (value instanceof Blob) {
			form.append(name, value);
		} else if (Array.isArray(value)) {
			value.forEach((item) => append(name, item));
		} else if (value !== undefined && value !== null) {
			form.append(name, toParam(value));
		}
	};
	for (const [name, value] of Object.entries(body as Fields)) {
		append(name, value);
	}
	return form;
}

/** The longest `Retry-After` worth waiting for. Longer would outlive most callers, such as a Worker's request. */
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 8_000;

/** How long to wait before a retry, or undefined when the server asks for longer than is worth waiting. */
function retryDelayMs(response: Response, attempt: number): number | undefined {
	const header = response.headers.get('retry-after')?.trim() ?? '';
	// Seconds, where 0 asks for a retry at once, or an HTTP date. A date that has passed is
	// likelier a difference between the clocks, and asks for nothing, as no header does.
	const seconds = /^\d+(\.\d+)?$/.test(header);
	const asked = seconds ? Number(header) * 1000 : Date.parse(header) - Date.now();
	if (seconds || asked > 0) {
		return asked <= MAX_RETRY_AFTER_MS ? asked : undefined;
	}
	return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * A signal that aborts after `ms`, as `AbortSignal.timeout` does, but whose timer can be stopped,
 * and keeps Node running until then, as a request in flight does.
 */
function deadline(ms: number): { signal: AbortSignal; stop: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
	return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

/**
 * The signal that ends one attempt of a call: the caller's `signal`, or its timeout, whose
 * timer `stop` ends once the response is read.
 */
export function callSignal(
	call: RequestOptions | undefined,
	timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; stop: () => void } {
	const timer = timeoutMs === undefined ? undefined : deadline(timeoutMs);
	const signals = [call?.signal, timer?.signal].filter((signal) => signal !== undefined);
	return { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0], stop: () => timer?.stop() };
}

/**
 * What a call that broke off throws: the caller's abort as it is, as `fetch` throws it, and
 * anything else, such as its timeout, as a connection error.
 */
export function brokenOff(operation: Operation, route: string, call: RequestOptions | undefined, error: unknown): unknown {
	return call?.signal?.aborted ? error : new ApiConnectionError(operation.method, route, error);
}

/** Waits, unless the caller cancels first. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	// Both reject with the caller's abort reason, whatever it is, as fetch does.
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason, as fetch rejects.
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason, as fetch rejects.
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * How to read a response of an operation that can answer in several formats, by
 * what the response says it is. Undefined means JSON, which also keeps a response
 * with no content empty.
 */
function formatOf(response: Response): 'text' | 'bytes' | 'stream' | undefined {
	const type = response.headers.get('content-type') ?? '';
	const format = type === '' ? 'json' : formatOfMediaType(type);
	return format === 'json' ? undefined : format;
}

/** How an operation's response is read, where undefined is JSON. */
function formatFor(operation: Operation, response: Response): 'none' | 'text' | 'bytes' | 'stream' | undefined {
	const declared = operation.response;
	if (declared === 'auto') {
		return formatOf(response);
	}
	if (declared === undefined || typeof declared === 'string') {
		return declared;
	}
	// No JSON is declared, so a response in none of the formats, or with no content type, is read as the first.
	const format = formatOf(response);
	return format !== undefined && declared.includes(format) ? format : declared[0];
}

/** Whether a response says its body is JSON. */
function saysJson(response: Response): boolean {
	return formatOfMediaType(response.headers.get('content-type') ?? '') === 'json';
}

/** The value of a JSON text, or undefined when it isn't JSON, which `JSON.parse` never returns. */
function jsonOf(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Reads the value at a dotted path, such as `cursors.after`. */
function at(value: unknown, path: string): unknown {
	let current = value;
	for (const key of path.split('.')) {
		current = isRecord(current) ? current[key] : undefined;
	}
	return current;
}

/** The cursor `paginate` follows: a cursor list's, or the one a list paged by number takes that the request sets. */
function cursorOf(pagination: Pagination, request: Fields): ({ param: string; next: string } & Excludes) | undefined {
	if (pagination.kind === 'cursor') {
		return pagination;
	}
	if (pagination.kind === 'page') {
		return pagination.cursors?.find((cursor) => typeof request[cursor.param] === 'string');
	}
	return undefined;
}

/** Whether a JSON body is the Cloudflare envelope, which can leave out an empty `result`. */
function isEnvelope(body: unknown): body is Fields {
	return isRecord(body) && ('result' in body || 'success' in body);
}

/**
 * Whether an operation answers in the Cloudflare envelope, as one in JSON does unless it says not.
 */
export function inEnvelope(operation: Operation): boolean {
	return operation.envelope !== false && (operation.response === undefined || operation.response === 'auto');
}

/** Whether a body is text, bytes or a stream, as a response in a format other than JSON is read. */
export function isUnparsed(body: unknown): boolean {
	return typeof body === 'string' || body instanceof Uint8Array || body instanceof ReadableStream;
}

/**
 * Whether a page-number response says the page it just returned is the last. Only a page
 * size the API states counts: one that caps the size asked for would end the list early.
 */
function isLastPage(info: ResultInfo | undefined, page: number, count: number, seen: number): boolean {
	if (typeof info?.total_pages === 'number') {
		return page >= info.total_pages;
	}
	const perPage = info?.per_page;
	if (typeof info?.total_count === 'number') {
		// Counting what was seen undercounts from a later first page, which costs a request.
		return typeof perPage === 'number' ? page * perPage >= info.total_count : seen >= info.total_count;
	}
	return typeof perPage === 'number' && count < perPage;
}

/**
 * The request an operation sends, as `fetch` takes it, with its path and query as `target`, and
 * the route it takes, which errors name. It throws on a request that can't be sent, such as one
 * missing a path parameter, or whose body JSON can't carry.
 */
export function requestOf(
	operation: Operation,
	fields: Fields,
	call: RequestOptions | undefined,
	options: ClientOptions,
): { route: string; target: string; init: RequestInit } {
	const route = routeOf(operation, fields);
	const path = pathOf(operation, route, fields);
	// The more specific a header's source, the later it's set: the client, the operation,
	// the request's header fields, and then the call.
	const headers = new Headers(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` });
	const assign = (from: HeadersInit | undefined): void => new Headers(from).forEach((value, key) => headers.set(key, value));
	assign(options.headers);
	headers.set('accept', operation.accept ?? 'application/json');
	const init: RequestInit = { method: operation.method, headers };
	const body = fields['body'];
	if (operation.body !== undefined && body !== undefined) {
		// Three operations take a form beside JSON, and JSON can't carry a FormData.
		if (operation.body === 'form' || body instanceof FormData) {
			init.body = formOf(body);
		} else {
			headers.set('content-type', operation.contentType ?? 'application/json');
			init.body = operation.body === 'json' ? JSON.stringify(body) : (body as BodyInit);
		}
	}
	for (const name of operation.headers ?? []) {
		const value = fields[name];
		if (value !== undefined && value !== null) {
			headers.set(name, toParam(value));
		}
	}
	assign(call?.headers);
	if (init.body instanceof FormData) {
		// fetch sets it with the boundary, which no content type given here can have.
		headers.delete('content-type');
	}
	if (init.body instanceof ReadableStream) {
		// Node's fetch requires this for a stream, and the DOM's types don't declare it.
		(init as RequestInit & { duplex: 'half' }).duplex = 'half';
	}
	return { route, target: path + queryOf(operation, fields), init };
}

export function createClient(options: ClientOptions = {}): Client {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

	/**
	 * Sends a request, and returns its response with a function that stops its timeout, and
	 * the route it took, which errors name.
	 */
	async function request(
		operation: Operation,
		fields: Fields,
		call: RequestOptions | undefined,
	): Promise<{ response: Response; stopTimeout: () => void; route: string }> {
		const { route, target, init } = requestOf(operation, fields, call, options);
		const url = baseUrl + target;
		const send = options.fetch ?? fetch;
		const timeoutMs = call?.timeoutMs ?? options.timeoutMs;
		const streamed = init.body instanceof ReadableStream;
		const maxRetries = IDEMPOTENT.has(operation.method) && !streamed ? (call?.maxRetries ?? options.maxRetries ?? 0) : 0;
		for (let attempt = 0; ; attempt++) {
			const { signal, stop: stopTimeout } = callSignal(call, timeoutMs);
			if (signal !== undefined) {
				init.signal = signal;
			}
			let response: Response;
			try {
				response = await send(url, init);
			} catch (error) {
				stopTimeout();
				throw brokenOff(operation, route, call, error);
			}
			const wait = attempt < maxRetries && (response.status === 429 || response.status >= 500) ? retryDelayMs(response, attempt) : undefined;
			if (wait !== undefined) {
				stopTimeout();
				// A body that breaks off while being discarded doesn't matter.
				await response.body?.cancel().catch(() => undefined);
				await delay(wait, call?.signal);
				continue;
			}
			try {
				call?.onResponse?.(response);
			} catch (error) {
				stopTimeout();
				throw error;
			}
			return { response, stopTimeout, route };
		}
	}

	/** Reads a response's body, as a connection error when it breaks off, other than by the caller. */
	async function read<T>(
		operation: Operation,
		route: string,
		call: RequestOptions | undefined,
		reader: () => Promise<T>,
	): Promise<T> {
		try {
			return await reader();
		} catch (error) {
			throw brokenOff(operation, route, call, error);
		}
	}

	async function transport(operation: Operation, fields: Fields, call: RequestOptions | undefined): Promise<{ body: unknown }> {
		const { response, stopTimeout, route } = await request(operation, fields, call);
		try {
			return { body: await readBody(operation, route, response, call, stopTimeout) };
		} finally {
			stopTimeout();
		}
	}

	/** Reads a response as its operation says, under its timeout until `stopTimeout`. */
	async function readBody(
		operation: Operation,
		route: string,
		response: Response,
		call: RequestOptions | undefined,
		stopTimeout: () => void,
	): Promise<unknown> {
		const fail = (body: unknown, problem?: string): ApiError =>
			new ApiError(response, body, operation.method, route, problem);
		if (response.status < 200 || response.status > 299) {
			const text = await read(operation, route, call, () => response.text());
			throw fail(text === '' ? undefined : (jsonOf(text) ?? text));
		}
		const format = formatFor(operation, response);
		if (format === 'stream') {
			// It may never end, so the caller reads it as it arrives, and ends it with `signal`.
			// No body, as with a 204, is a stream that ends at once.
			stopTimeout();
			return response.body ?? new ReadableStream({ start: (controller) => controller.close() });
		}
		// A failure can come as the envelope whatever the operation's format, though only in
		// JSON. A file that only looks like one would also need a list of `errors`.
		const check = (text: string): void => {
			const body = jsonOf(text);
			if (isRecord(body) && body['success'] === false && Array.isArray(body['errors'])) {
				throw fail(body);
			}
		};
		if (format === 'bytes') {
			const bytes = new Uint8Array(await read(operation, route, call, () => response.arrayBuffer()));
			if (saysJson(response)) {
				check(new TextDecoder().decode(bytes));
			}
			return bytes;
		}
		const text = await read(operation, route, call, () => response.text());
		if (format === 'none' || format === 'text') {
			if (format === 'none' || saysJson(response)) {
				check(text);
			}
			return format === 'none' ? undefined : text;
		}
		if (text === '') {
			return undefined;
		}
		const body = jsonOf(text);
		if (body === undefined) {
			throw fail(text, "the body isn't JSON");
		}
		if (isRecord(body) && body['success'] === false) {
			throw fail(body);
		}
		return body;
	}

	return clientWith(transport);
}

/**
 * Sends an operation's request and reads its response's body, as the operation says: the parsed
 * JSON, text, bytes or a stream, or undefined for no content. It throws what the call throws.
 * `last` says the answer is the whole list, so `paginate` asks for no other page.
 */
export type Transport = (
	operation: Operation,
	fields: Fields,
	call: RequestOptions | undefined,
) => Promise<{ body: unknown; last?: boolean }>;

/**
 * A client whose requests `transport` answers: the API's, or a mock's for tests, which then
 * reads results and walks pages as the client does.
 */
export function clientWith(transport: Transport): Client {
	async function readPage(operation: PagedOperation, fields: Fields, call: RequestOptions | undefined) {
		const { body, last = false } = await transport(operation, fields, call);
		const enveloped = inEnvelope(operation) && isEnvelope(body);
		// Another format, or a bare branch of the JSON, is the result as it is, as for `send`.
		const result = enveloped ? body['result'] : body;
		const list = operation.page.items === undefined ? result : at(result, operation.page.items);
		const bareJson = operation.envelope === false && !isUnparsed(body);
		return {
			// No content is an empty page. The rest is what `paginate` can't read.
			paged: body === undefined || enveloped || bareJson,
			last,
			current: {
				// Some endpoints send `null` for an empty list, against their spec. A patch types each
				// one seen, as for abuse reports, so `send` returns what its type says.
				items: Array.isArray(list) ? (list as unknown[]) : [],
				result,
				resultInfo: enveloped && isRecord(body['result_info']) ? (body['result_info'] as ResultInfo) : undefined,
			},
		};
	}

	async function* items(operation: PagedOperation, request: Fields, call: RequestOptions | undefined) {
		const pagination = operation.page;
		const cursor = cursorOf(pagination, request);
		const byOffset =
			pagination.kind === 'offset' ||
			(pagination.kind === 'page' && pagination.offsetWins === true && typeof request['offset'] === 'number');
		// A later page would send what it moves on beside a parameter the API refuses with it.
		const moving = cursor ?? (pagination.kind === 'page' && byOffset ? undefined : pagination);
		// The query leaves out a null as it does an absent field, though it sends an empty string.
		const given = (name: string): boolean => request[name] !== undefined && request[name] !== null;
		const clash = moving?.excludes?.find(given);
		if (clash !== undefined) {
			const name = cursor?.param ?? (pagination.kind === 'cursor' ? pagination.param : pagination.kind);
			const where = `${operation.method} ${routeOf(operation, request)}`;
			// Then even the first request has the pair, and so would one page of it.
			if (given(name)) {
				throw new TypeError(`${where}: the API refuses ${name} beside ${clash}, so give one of them`);
			}
			throw new TypeError(
				`${where}: paginate moves ${name} on, which the API refuses beside ${clash}, so leave out ${clash}, or read one page with client.page`,
			);
		}
		let fields = request;
		// A few operations declare `page` as a string. Their "all" isn't a number, and has no next page.
		let number = Number(request['page'] ?? 1);
		let offset = typeof request['offset'] === 'number' ? request['offset'] : 0;
		let seen = 0;
		let previous: string | undefined;
		for (;;) {
			const { current, paged, last } = await readPage(operation, fields, call);
			// Stopping here would look like an empty list.
			if (!paged) {
				throw new TypeError(`${operation.method} ${routeOf(operation, fields)}: this response isn't a page, so read it with send`);
			}
			if (last) {
				yield* current.items;
				return;
			}
			if (cursor !== undefined) {
				// Only the cursor ends the list. An empty page can have more after it: KV
				// skips deleted keys, and R2 lists keys grouped by a delimiter elsewhere.
				yield* current.items;
				const next = at(current.resultInfo, cursor.next);
				if (typeof next !== 'string' || next === '' || next === fields[cursor.param]) {
					return;
				}
				fields = { ...fields, [cursor.param]: next };
				continue;
			}
			if (current.items.length === 0) {
				return;
			}
			const info = current.resultInfo;
			// A total ends the list, and two pages alike can be real data. Without one, an
			// endpoint that ignores the page parameter would repeat itself forever. A short
			// page doesn't end it either, as the API may cap the size asked for.
			const counted = typeof info?.total_count === 'number' || (!byOffset && typeof info?.total_pages === 'number');
			if (!counted) {
				const fingerprint = JSON.stringify(current.items);
				if (fingerprint === previous) {
					return;
				}
				previous = fingerprint;
			}
			yield* current.items;
			seen += current.items.length;
			if (byOffset) {
				offset += current.items.length;
				if (typeof info?.total_count === 'number' && offset >= info.total_count) {
					return;
				}
				fields = { ...fields, offset };
			} else {
				if (Number.isNaN(number) || isLastPage(info, number, current.items.length, seen)) {
					return;
				}
				number += 1;
				fields = { ...fields, page: number };
			}
		}
	}

	return {
		async send(operation: Operation, fields?: Fields, call?: RequestOptions) {
			const { body } = await transport(operation, fields ?? {}, call);
			// An envelope that leaves out `result` has none, as `page` reads it.
			return inEnvelope(operation) && isEnvelope(body) ? body['result'] : body;
		},
		async page(operation: PagedOperation, fields?: Fields, call?: RequestOptions) {
			return (await readPage(operation, fields ?? {}, call)).current;
		},
		paginate(operation: PagedOperation, fields?: Fields, call?: RequestOptions) {
			return items(operation, fields ?? {}, call);
		},
	} as Client;
}
