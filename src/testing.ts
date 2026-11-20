/**
 * A client for tests, imported from `@libreflare/cloudflare-sdk/testing`. It answers each
 * operation from a handler in place of the API. The request is checked as the client checks
 * it, and the answer is read and paged by the client's own logic. Nothing goes over HTTP, so
 * a call's `maxRetries` and `onResponse` do nothing, and its `headers` are only checked.
 */
import {
	brokenOff,
	callSignal,
	clientWith,
	inEnvelope,
	isUnparsed,
	requestOf,
	type Client,
	type Fields,
	type Operation,
	type RequestOptions,
	type ResultInfo,
	type Transport,
} from './client.ts';

/** A result with the `result_info` the API sends beside it, such as a page's. */
export class ResultWithInfo<Res> {
	readonly result: Res;
	readonly resultInfo: ResultInfo;
	// Only `withResultInfo` makes one, as the mock knows it by its class: an object with the
	// same fields, or a spread of one, isn't one, and a handler typed to return one can't give it.
	private declare readonly nominal: never;

	constructor(result: Res, resultInfo: ResultInfo) {
		this.result = result;
		this.resultInfo = resultInfo;
	}
}

/**
 * Answers with a result and its `result_info`, such as one page of several:
 * `withResultInfo(items, { page: 1, total_pages: 2 })`. A next cursor goes where the
 * operation's `page.next` says, such as `{ cursors: { after: 'c2' } }` for `rulesets.list`.
 * A list paged by number that takes cursors too, as `dns.records.list` does, reads one only
 * when the request sets it: `{ cursor: 'c2' }` for a request with `cursor`, where its
 * `page.cursors` say. Only a result in the Cloudflare envelope has a `result_info`, not text
 * or bytes.
 */
export function withResultInfo<Res>(result: Res, resultInfo: ResultInfo): ResultWithInfo<Res> {
	return new ResultWithInfo(result, resultInfo);
}

/** What a handler answers: the result, or a result with its `result_info`. */
export type MockAnswer<Res> = Res | ResultWithInfo<Res>;

/**
 * Answers one request: a copy of the caller's fields, with the `page`, `offset` or cursor
 * `paginate` asks for next, where a page after the first is a number. What it throws, such
 * as an `ApiError`, the call throws as it is. A ruleset write's dry run answers `null`, and
 * only a dry run does.
 */
export type MockHandler<Req, Res> = (request: Req) => MockAnswer<Res> | PromiseLike<MockAnswer<Res>>;

/** A client whose operations are answered by handlers. */
export interface MockClient extends Client {
	/**
	 * Answers `operation`, the object imported from its group, with `handler`, in place of any
	 * handler before. A result given as it is is the whole list to `paginate`.
	 */
	on<Req, Res>(operation: Operation<Req, Res>, handler: MockHandler<NoInfer<Req>, NoInfer<Res>>): this;
}

/** Creates a client that answers only the operations given to its `on`, and fails any other. */
export function createMockClient(): MockClient {
	const handlers = new Map<Operation, MockHandler<Fields, unknown>>();
	const transport: Transport = async (operation, fields, call) => {
		// As the client checks a request before it sends it, whether or not anything answers it. That
		// costs a body's JSON on each call, as it buys the client's errors.
		const { route } = requestOf(operation, fields, call, {});
		// A call already cancelled sends nothing, as `fetch` rejects at once.
		call?.signal?.throwIfAborted();
		const handler = handlers.get(operation);
		if (handler === undefined) {
			throw unanswered(operation, handlers.keys());
		}
		// As sent, though the caller can change its request while the handler runs.
		const dryRun = fields['dry_run'] === true;
		const value = await settle(operation, route, call, () => handler({ ...fields }));
		return bodyOf(operation, route, dryRun, value);
	};
	// A handler is stored for any operation, which the generic `on` can't be typed as.
	const on = (operation: Operation, handler: MockHandler<Fields, unknown>): MockClient => {
		handlers.set(operation, handler);
		return client;
	};
	const client: MockClient = { ...clientWith(transport), on: on as MockClient['on'] };
	return client;
}

/**
 * The error for an operation with no handler. It says when a handler answers another object
 * with the same route, such as a copy, as the handlers are keyed by the object.
 */
function unanswered(operation: Operation, answered: Iterable<Operation>): Error {
	const { method, route } = operation;
	const twin = [...answered].some((other) => other.method === method && other.route === route);
	return new Error(
		`No handler answers ${method} ${route}${twin ? '. One answers another object with its method and route, such as a copy, so give `on` the operation the code sends' : ''}`,
	);
}

/**
 * Runs a handler as the client sends a request: at once, and ended by the call's `signal` or
 * `timeoutMs`, whose timeout is a connection error.
 */
function settle(operation: Operation, route: string, call: RequestOptions | undefined, run: () => unknown): Promise<unknown> {
	const { signal: ended, stop } = callSignal(call, call?.timeoutMs);
	return new Promise((resolve, reject) => {
		const done = (): void => {
			stop();
			ended?.removeEventListener('abort', onAbort);
		};
		const onAbort = (): void => {
			done();
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the abort reason, as fetch rejects.
			reject(brokenOff(operation, route, call, ended?.reason));
		};
		// Before the handler runs, which can itself cancel the call.
		ended?.addEventListener('abort', onAbort, { once: true });
		// A handler that throws at once rejects, as one that returns a promise does.
		new Promise<unknown>((answer) => answer(run())).then(resolve, reject).finally(done);
	});
}

/**
 * The body the client reads for an answer, in the Cloudflare envelope where the operation has
 * one, and whether it's the last page: a result without its `result_info` is the whole list.
 */
function bodyOf(operation: Operation, route: string, dryRun: boolean, answer: unknown): { body: unknown; last: boolean } {
	const [result, info]: [unknown, ResultInfo | undefined] =
		answer instanceof ResultWithInfo ? [answer.result, answer.resultInfo] : [answer, undefined];
	if (operation.dryRun && dryRun !== (result === null)) {
		throw new TypeError(`${operation.method} ${route}: a dry run answers null, and only a dry run does`);
	}
	// An operation that can answer in another format reads text, bytes or a stream as that format.
	if (!inEnvelope(operation) || (operation.response === 'auto' && isUnparsed(result))) {
		if (info !== undefined) {
			throw new TypeError(`${operation.method} ${route}: withResultInfo needs a result the operation answers in the envelope`);
		}
		// The client reads no content, whatever a loosely typed handler gave.
		return { body: operation.response === 'none' ? undefined : result, last: true };
	}
	return { body: { success: true, errors: [], messages: [], result, ...(info === undefined ? {} : { result_info: info }) }, last: info === undefined };
}
