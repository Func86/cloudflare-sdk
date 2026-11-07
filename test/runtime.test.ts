import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import {
	type AccountOrZone,
	ApiConnectionError,
	ApiError,
	createClient,
	type Operation,
	type PagedOperation,
} from '../src/client.ts';
import { formatOfMediaType } from '../src/media.ts';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A client whose requests go to `handler`, and the URLs it was called with. */
function mock(handler: Handler, options: Parameters<typeof createClient>[0] = {}) {
	const calls: { url: URL; init: RequestInit }[] = [];
	const client = createClient({
		token: 't',
		...options,
		fetch: (async (input: string, init: RequestInit) => {
			const url = new URL(input);
			calls.push({ url, init });
			return handler(url, init);
		}) as typeof fetch,
	});
	return { client, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

function envelope(result: unknown, resultInfo?: unknown): Response {
	return json({
		success: true,
		errors: [],
		messages: [],
		result,
		...(resultInfo === undefined ? {} : { result_info: resultInfo }),
	});
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) {
		out.push(item);
	}
	return out;
}

const keyed: PagedOperation<{ page?: number; per_page?: number }, { things: number[] }, number> = {
	method: 'GET',
	route: '/things',
	query: ['page', 'per_page'],
	page: { kind: 'page', items: 'things' },
};
const rooted: PagedOperation<{ page?: number; per_page?: number }, number[], number> = {
	method: 'GET',
	route: '/things',
	query: ['page', 'per_page'],
	page: { kind: 'page' },
};

test('reads a page from the array the operation names, as #2805 needs', async () => {
	const pages: Record<string, unknown> = {
		'1': { deployments: ['a'] },
		'2': { deployments: ['b'] },
	};
	const operation: PagedOperation<{ per_page: number }, { deployments: string[] }, string> = {
		method: 'GET',
		route: '/deployments',
		query: ['page', 'per_page'],
		page: { kind: 'page', items: 'deployments' },
	};
	const { client, calls } = mock((url) => {
		const page = Number(url.searchParams.get('page') ?? 1);
		return envelope(pages[String(page)], { page, per_page: 1, count: 1, total_count: 2, total_pages: 2 });
	});
	assert.deepEqual(await collect(client.paginate(operation, { per_page: 1 })), ['a', 'b']);
	// total_pages says page 2 is the last, so no trailing request.
	assert.equal(calls.length, 2);
});

test('page returns the items, the whole result and the result info', async () => {
	const { client } = mock(() => envelope({ things: [1], other: 'x' }, { page: 1, total_pages: 1 }));
	const page = await client.page(keyed);
	assert.deepEqual(page.items, [1]);
	assert.deepEqual(page.result, { things: [1], other: 'x' });
	assert.equal(page.resultInfo?.total_pages, 1);
});

test('a short page ends the list only when the API states the page size, as it may cap the one asked for', async () => {
	// Five items, two a page whatever was asked for.
	const capped = (url: URL): number[] => {
		const page = Number(url.searchParams.get('page') ?? 1);
		return [1, 2, 3, 4, 5].slice((page - 1) * 2, page * 2);
	};
	// No result_info, as images and load balancer search send.
	const unstated = mock((url) => envelope({ things: capped(url) }));
	assert.deepEqual(await collect(unstated.client.paginate(keyed, { per_page: 100 })), [1, 2, 3, 4, 5]);
	assert.equal(unstated.calls.length, 4);
	// A total with no page size counts what was seen.
	const counted = mock((url) => envelope({ things: capped(url) }, { total_count: 5 }));
	assert.deepEqual(await collect(counted.client.paginate(keyed, { per_page: 100 })), [1, 2, 3, 4, 5]);
	assert.equal(counted.calls.length, 3);
	const stated = mock(() => envelope({ things: [1] }, { per_page: 2 }));
	assert.deepEqual(await collect(stated.client.paginate(keyed, { per_page: 2 })), [1]);
	assert.equal(stated.calls.length, 1);
});

test('pages alike are real data when result_info counts the pages', async () => {
	const { client, calls } = mock(() => envelope([7], { per_page: 1, total_pages: 3 }));
	assert.deepEqual(await collect(client.paginate(rooted, { per_page: 1 })), [7, 7, 7]);
	assert.equal(calls.length, 3);
});

test('stops on an empty page when neither result_info nor per_page says how long a page is', async () => {
	const { client, calls } = mock((url) => envelope(url.searchParams.get('page') === '2' ? [] : [1, 2]));
	assert.deepEqual(await collect(client.paginate(rooted)), [1, 2]);
	assert.equal(calls.length, 2);
});

test('stops at total_count when total_pages is absent, as 63 list operations declare', async () => {
	const { client, calls } = mock(() => envelope([1, 2], { per_page: 2, total_count: 2 }));
	assert.deepEqual(await collect(client.paginate(rooted)), [1, 2]);
	assert.equal(calls.length, 1);
});

test('treats a null list as empty, as abuse-reports sends one', async () => {
	const { client, calls } = mock(() => envelope({ things: null }, { page: 1, total_pages: 0 }));
	assert.deepEqual(await collect(client.paginate(keyed)), []);
	assert.deepEqual((await client.page(keyed)).items, []);
	assert.equal(calls.length, 2);
});

test('does not loop forever on an endpoint that ignores the page parameter', async () => {
	const { client, calls } = mock(() => envelope([1, 2]));
	assert.deepEqual(await collect(client.paginate(rooted)), [1, 2]);
	assert.equal(calls.length, 2);
});

test('follows a cursor in result_info until there is none', async () => {
	const operation: PagedOperation<{ cursor?: string }, number[], number> = {
		method: 'GET',
		route: '/things',
		query: ['cursor'],
		page: { kind: 'cursor', param: 'cursor', next: 'cursors.after' },
	};
	const { client, calls } = mock((url) =>
		url.searchParams.get('cursor') === 'c2' ? envelope([2], {}) : envelope([1], { cursors: { after: 'c2' } }),
	);
	assert.deepEqual(await collect(client.paginate(operation)), [1, 2]);
	assert.equal(calls[1]?.url.searchParams.get('cursor'), 'c2');
});

const cursored: PagedOperation<{ cursor?: string }, number[], number> = {
	method: 'GET',
	route: '/things',
	query: ['cursor'],
	page: { kind: 'cursor', param: 'cursor', next: 'cursor' },
};

test('a cursor carries on past an empty page, as KV and R2 send', async () => {
	const pages: Record<string, [number[], string?]> = { start: [[1], 'c1'], c1: [[], 'c2'], c2: [[], 'c3'], c3: [[2]] };
	const { client, calls } = mock((url) => {
		const [items, cursor] = pages[url.searchParams.get('cursor') ?? 'start']!;
		return envelope(items, cursor === undefined ? {} : { cursor });
	});
	assert.deepEqual(await collect(client.paginate(cursored)), [1, 2]);
	assert.equal(calls.length, 4);
});

test('a cursor list ends only when the cursor does, even on a page that repeats', async () => {
	const { client, calls } = mock((url) => (url.searchParams.get('cursor') === 'c2' ? envelope([1], { cursor: '' }) : envelope([1], { cursor: 'c2' })));
	assert.deepEqual(await collect(client.paginate(cursored)), [1, 1]);
	assert.equal(calls.length, 2);
});

test('does not loop forever on an endpoint that repeats its cursor', async () => {
	const { client, calls } = mock(() => envelope([], { cursor: 'same' }));
	assert.deepEqual(await collect(client.paginate(cursored)), []);
	assert.equal(calls.length, 2);
});

test('a page given as a string starts there and carries on', async () => {
	const operation: PagedOperation<{ page?: string; per_page?: number }, number[], number> = {
		method: 'GET',
		route: '/things',
		query: ['page', 'per_page'],
		page: { kind: 'page' },
	};
	const { client, calls } = mock((url) => envelope([Number(url.searchParams.get('page'))], { total_pages: 7 }));
	assert.deepEqual(await collect(client.paginate(operation, { page: '5' })), [5, 6, 7]);
	assert.deepEqual(
		calls.map((call) => call.url.searchParams.get('page')),
		['5', '6', '7'],
	);
	const everything = mock(() => envelope([1, 2, 3], { total_pages: 7 }));
	assert.deepEqual(await collect(everything.client.paginate(operation, { page: 'all' })), [1, 2, 3]);
	assert.equal(everything.calls.length, 1);
});

test('advances an offset by the items it has seen, to an empty page or the total', async () => {
	const operation: PagedOperation<{ limit: number; offset?: number }, number[], number> = {
		method: 'GET',
		route: '/things',
		query: ['limit', 'offset'],
		page: { kind: 'offset' },
	};
	// Two a page, though more were asked for.
	const respond = (url: URL, info?: unknown): Response => {
		const offset = Number(url.searchParams.get('offset') ?? 0);
		return envelope([1, 2, 3].slice(offset, offset + 2), info);
	};
	const { client, calls } = mock((url) => respond(url));
	assert.deepEqual(await collect(client.paginate(operation, { limit: 10 })), [1, 2, 3]);
	assert.equal(calls.length, 3);
	const counted = mock((url) => respond(url, { total_count: 3 }));
	assert.deepEqual(await collect(counted.client.paginate(operation, { limit: 10 })), [1, 2, 3]);
	assert.equal(counted.calls.length, 2);
});

test('send unwraps the envelope and leaves a bare response alone', async () => {
	const wrapped: Operation<object, number> = { method: 'GET', route: '/a' };
	const bare: Operation<object, { data: number }> = { method: 'GET', route: '/a', envelope: false };
	assert.equal(await mock(() => envelope(1)).client.send(wrapped), 1);
	assert.deepEqual(await mock(() => json({ data: 1 })).client.send(bare), { data: 1 });
});

test('send returns no result for an envelope that leaves it out, as page does', async () => {
	const operation: Operation<object, number[]> = { method: 'DELETE', route: '/a' };
	assert.equal(await mock(() => json({ success: true, errors: [], messages: [] })).client.send(operation), undefined);
});

test('a success whose body should be JSON and is not is a failure that keeps the text', async () => {
	for (const text of ['<html>captive portal</html>', '{"success":true,"result":[1']) {
		const { client } = mock(() => new Response(text, { headers: { 'content-type': 'text/html' } }));
		await assert.rejects(client.send({ method: 'GET', route: '/a' }), (error: unknown) => {
			assert.ok(error instanceof ApiError);
			assert.equal(error.status, 200);
			assert.equal(error.body, text);
			assert.match(error.message, /failed with 200: the body isn't JSON$/);
			return true;
		});
	}
});

test('a failure in the envelope is a failure, whatever format the operation answers in', async () => {
	const failed = JSON.stringify({ success: false, errors: [{ code: 7003, message: 'nope' }] });
	const typed = (type: string) => ({ headers: { 'content-type': type } });
	for (const response of ['none', 'bytes', 'text'] as const) {
		const operation: Operation = { method: 'DELETE', route: '/a', response };
		await assert.rejects(mock(() => new Response(failed, typed('application/json'))).client.send(operation), { name: 'ApiError', status: 200 }, response);
	}
	// A body of an operation that declares none is read whatever it says it is.
	await assert.rejects(mock(() => new Response(failed, typed('text/plain'))).client.send({ method: 'DELETE', route: '/a', response: 'none' }), ApiError);
	// Text or bytes in another format aren't read as JSON, and a file only like the envelope is the file.
	const text: Operation<object, string> = { method: 'GET', route: '/a', response: 'text' };
	assert.equal(await mock(() => new Response(failed, typed('text/plain'))).client.send(text), failed);
	const file = '{"success":false}';
	const bytes: Operation<object, Uint8Array> = { method: 'GET', route: '/a', response: 'bytes' };
	assert.deepEqual(await mock(() => new Response(file, typed('application/json'))).client.send(bytes), new TextEncoder().encode(file));
});

test('a failure carries the status and the errors of the envelope', async () => {
	const operation: Operation = { method: 'GET', route: '/a/{id}' };
	const { client } = mock(() => json({ success: false, errors: [{ code: 10000, message: 'nope' }], messages: [] }, 403));
	await assert.rejects(client.send(operation, { id: 'x' }), (error: unknown) => {
		assert.ok(error instanceof ApiError);
		assert.equal(error.status, 403);
		assert.equal(error.errors[0]?.code, 10000);
		assert.match(error.message, /10000: nope/);
		return true;
	});
});

test('a 200 whose envelope says success: false is a failure', async () => {
	const { client } = mock(() => json({ success: false, errors: [{ message: 'nope' }], result: null }));
	await assert.rejects(client.send({ method: 'GET', route: '/a' }), ApiError);
});

async function failureOf(body: unknown): Promise<ApiError> {
	const { client } = mock(() => json(body, 400));
	const error: unknown = await client.send({ method: 'GET', route: '/a' }).catch((caught: unknown) => caught);
	assert.ok(error instanceof ApiError);
	return error;
}

test('string errors and messages are kept, as logs and Builds declare them', async () => {
	const error = await failureOf({ success: false, errors: ['Invalid query'], messages: ['Try again'] });
	assert.deepEqual(error.errors, [{ message: 'Invalid query' }]);
	assert.deepEqual(error.messages, [{ message: 'Try again' }]);
	assert.match(error.message, /failed with 400: Invalid query$/);
});

test('an entry with no message still says what the server said', async () => {
	const coded = await failureOf({ success: false, errors: [{ code: 1, detail: 'why' }] });
	assert.equal(coded.errors[0]?.message, '{"code":1,"detail":"why"}');
	assert.equal(coded.errors[0]?.['detail'], 'why');
	assert.doesNotMatch(coded.message, /undefined/);
	assert.match(coded.message, /why/);
	const usual = await failureOf({ success: false, errors: [{ code: 'not_found', message: 'Gone' }] });
	assert.match(usual.message, /failed with 400: not_found: Gone$/);
});

test('a lone errors object is a list of one, and an empty one is nothing', async () => {
	const lone = await failureOf({ success: false, errors: { code: 1, message: 'Lone' } });
	assert.deepEqual(lone.errors, [{ code: 1, message: 'Lone' }]);
	const empty = await failureOf({ success: false, errors: {}, messages: {} });
	assert.deepEqual(empty.errors, []);
	assert.deepEqual(empty.messages, []);
	assert.match(empty.message, /failed with 400$/);
	const blanks = await failureOf({ success: false, errors: [null, '', {}], messages: null });
	assert.deepEqual(blanks.errors, []);
});

test('a failure outside the envelope is read from where it is', async () => {
	// As GET /builds/builds/not-a-uuid answered, 2026-11-07.
	const zod = await failureOf({ success: false, error: { issues: [{ message: 'Invalid uuid' }], name: 'ZodError' } });
	assert.match(zod.message, /Invalid uuid/);
	assert.equal(zod.errors[0]?.['name'], 'ZodError');
	assert.equal((await failureOf({ error: 'singular' })).errors[0]?.message, 'singular');
	assert.equal((await failureOf({ message: 'only a message' })).errors[0]?.message, 'only a message');
	assert.equal((await failureOf({ msg: 'abuse reports say msg' })).errors[0]?.message, 'abuse reports say msg');
	// The envelope's own list comes first.
	assert.deepEqual((await failureOf({ errors: [{ message: 'first' }], error: 'second' })).errors, [{ message: 'first' }]);
});

test('a failure with a body that is not JSON keeps the text', async () => {
	const { client } = mock(() => new Response('<html>bad gateway</html>', { status: 502 }));
	await assert.rejects(client.send({ method: 'GET', route: '/a' }), (error: unknown) => {
		assert.ok(error instanceof ApiError);
		assert.equal(error.body, '<html>bad gateway</html>');
		return true;
	});
});

test('no response at all is a connection error, but an abort stays an abort', async () => {
	const failing = mock(() => {
		throw new TypeError('fetch failed');
	});
	await assert.rejects(failing.client.send({ method: 'GET', route: '/a' }), ApiConnectionError);
	const controller = new AbortController();
	const aborted = mock(() => {
		controller.abort();
		throw controller.signal.reason;
	});
	await assert.rejects(aborted.client.send({ method: 'GET', route: '/a' }, {}, { signal: controller.signal }), {
		name: 'AbortError',
	});
});

test('a response that breaks off while being read is a connection error, but an abort stays an abort', async () => {
	const connectionError = (cause: RegExp) => (error: unknown) => {
		assert.ok(error instanceof ApiConnectionError);
		assert.match(String(error.cause), cause);
		return true;
	};
	const broken = mock(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"succ'));
						controller.error(new TypeError('terminated'));
					},
				}),
			),
	);
	await assert.rejects(broken.client.send({ method: 'GET', route: '/a' }), connectionError(/terminated/));
	// Headers, then nothing. fetch errors the body when its signal aborts.
	const stalled: Handler = (_, init) =>
		new Response(
			new ReadableStream({
				start(controller) {
					init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
				},
			}),
		);
	await assert.rejects(mock(stalled, { timeoutMs: 20 }).client.send({ method: 'GET', route: '/a' }), connectionError(/TimeoutError/));
	const controller = new AbortController();
	const sent = mock(stalled).client.send({ method: 'GET', route: '/a' }, {}, { signal: controller.signal });
	controller.abort();
	await assert.rejects(sent, { name: 'AbortError' });
});

test('path parameters are encoded, and a missing one fails before any request', async () => {
	const operation: Operation<{ id: string }> = { method: 'GET', route: '/a/{id}/b' };
	const { client, calls } = mock(() => envelope(null));
	await client.send(operation, { id: 'x/y z' });
	assert.equal(calls[0]?.url.pathname, '/client/v4/a/x%2Fy%20z/b');
	await assert.rejects(client.send(operation, { id: '' }), TypeError);
	assert.equal(calls.length, 1);
});

test('a path parameter that is a path keeps its slashes, and only that one', async () => {
	const operation: Operation<{ bucket: string; key: string }> = {
		method: 'GET',
		route: '/buckets/{bucket}/objects/{key}',
		slashes: ['key'],
	};
	const { client, calls } = mock(() => envelope(null));
	await client.send(operation, { bucket: 'a/b', key: 'dir/a b?.txt' });
	assert.equal(calls[0]?.url.pathname, '/client/v4/buckets/a%2Fb/objects/dir/a%20b%3F.txt');
});

test('an account-or-zone operation runs against the account or the zone the request names', async () => {
	const operation: Operation<AccountOrZone & { id: string; page?: number }> = {
		method: 'GET',
		route: '/{account_or_zone}/{account_or_zone_id}/things/{id}',
		accountOrZone: true,
		query: ['page'],
	};
	const { client, calls } = mock(() => envelope(null));
	await client.send(operation, { account_id: 'a/b', id: 'x', page: 2 });
	await client.send(operation, { zone_id: 'z', id: 'x' });
	const bare: Operation<AccountOrZone> = { method: 'GET', route: '/{account_or_zone}/{account_or_zone_id}', accountOrZone: true };
	await client.send(bare, { zone_id: 'z' });
	// Without types: null is absent, as for any other field.
	const untyped = operation as Operation;
	await client.send(untyped, { account_id: 'a', zone_id: null, id: 'x' });
	assert.deepEqual(
		calls.map(({ url }) => url.pathname + url.search),
		['/client/v4/accounts/a%2Fb/things/x?page=2', '/client/v4/zones/z/things/x', '/client/v4/zones/z', '/client/v4/accounts/a/things/x'],
	);
	// Neither, both, or an ID that can't be a segment fails before any request, naming the route it would take.
	const route = '/{account_or_zone}/{account_or_zone_id}/things/{id}';
	await assert.rejects(client.send(untyped, { id: 'x' }), { message: `GET ${route}: give account_id or zone_id` });
	await assert.rejects(client.send(untyped, { account_id: null, id: 'x' }), { message: `GET ${route}: give account_id or zone_id` });
	await assert.rejects(client.send(untyped, { account_id: 'a', zone_id: 'z', id: 'x' }), { message: `GET ${route}: give account_id or zone_id, not both` });
	await assert.rejects(client.send(untyped, { account_id: '', id: 'x' }), { message: 'GET /accounts/{account_id}/things/{id}: account_id is required' });
	await assert.rejects(client.send(untyped, { zone_id: '..', id: 'x' }), { message: 'GET /zones/{zone_id}/things/{id}: zone_id can\'t have a "." or ".." segment' });
	assert.equal(calls.length, 4);
});

test('a failure of an account-or-zone operation names the account or the zone it went to', async () => {
	const operation: PagedOperation<AccountOrZone & { id: string }, unknown, unknown> = {
		method: 'GET',
		route: '/{account_or_zone}/{account_or_zone_id}/things/{id}',
		accountOrZone: true,
		response: 'auto',
		page: { kind: 'page' },
	};
	const zone = { zone_id: 'z', id: 'x' };
	const account = { account_id: 'a', id: 'x' };
	const denied = mock(() => json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403));
	await assert.rejects(denied.client.send(operation, zone), {
		name: 'ApiError',
		message: 'GET /zones/{zone_id}/things/{id} failed with 403: 10000: Authentication error',
	});
	const unreachable = mock(() => {
		throw new TypeError('fetch failed');
	});
	await assert.rejects(unreachable.client.send(operation, account), {
		name: 'ApiConnectionError',
		message: 'GET /accounts/{account_id}/things/{id} got no complete response',
	});
	const broken = mock(() => new Response(new ReadableStream({ pull: (controller) => controller.error(new Error('reset')) })));
	await assert.rejects(broken.client.send(operation, zone), {
		name: 'ApiConnectionError',
		message: 'GET /zones/{zone_id}/things/{id} got no complete response',
	});
	const csv = mock(() => new Response('a,b\n', { headers: { 'content-type': 'text/csv' } }));
	await assert.rejects(collect(csv.client.paginate(operation, account)), {
		name: 'TypeError',
		message: "GET /accounts/{account_id}/things/{id}: this response isn't a page, so read it with send",
	});
});

test('only an operation marked as one is filled from account_id or zone_id', async () => {
	const { client, calls } = mock(() => envelope(null));
	// A hand-written operation, or a double, fills the pair from its own fields.
	const plain: Operation = { method: 'GET', route: '/{account_or_zone}/{account_or_zone_id}/things' };
	await client.send(plain, { account_or_zone: 'zones', account_or_zone_id: 'z' });
	assert.equal(calls[0]?.url.pathname, '/client/v4/zones/z/things');
	// A mark on a route without the whole prefix is a mistake.
	for (const route of ['/{account_or_zone}s/{id}', '/accounts/{account_or_zone}/{account_or_zone_id}']) {
		const marked: Operation = { method: 'GET', route, accountOrZone: true };
		await assert.rejects(client.send(marked, { zone_id: 'z', id: 'x' }), /an account-or-zone route starts with/);
	}
	assert.equal(calls.length, 1);
});

test('a value that would climb out of its route fails before any request', async () => {
	const plain: Operation<{ id: string }> = { method: 'DELETE', route: '/a/{id}/b' };
	const pathLike: Operation<{ key: string }> = { method: 'DELETE', route: '/objects/{key}', slashes: ['key'] };
	const { client, calls } = mock(() => envelope(null));
	for (const id of ['..', '.']) {
		await assert.rejects(client.send(plain, { id }), TypeError, id);
	}
	for (const key of ['..', '../../workers/scripts/prod', 'a/../../b', 'a/./b', 'a/..']) {
		await assert.rejects(client.send(pathLike, { key }), TypeError, key);
	}
	assert.equal(calls.length, 0);
	// Dots that URL parsing leaves alone are ordinary names.
	await client.send(plain, { id: '...' });
	await client.send(plain, { id: '../x' });
	await client.send(pathLike, { key: 'a/..b/c.' });
	assert.deepEqual(
		calls.map((call) => call.url.pathname),
		['/client/v4/a/.../b', '/client/v4/a/..%2Fx/b', '/client/v4/objects/a/..b/c.'],
	);
});

test('an object query parameter is sent field by field, as OpenAPI defaults to', async () => {
	const operation: Operation<Record<string, unknown>> = { method: 'GET', route: '/a', query: ['range', 'other'] };
	const { client, calls } = mock(() => envelope(null));
	await client.send(operation, { range: { start: '2026-01-01', end: '2026-02-01', none: null }, other: 1 });
	assert.equal(calls[0]?.url.search, '?start=2026-01-01&end=2026-02-01&other=1');
});

test('a query parameter named as a template sends every request field it matches', async () => {
	const operation: Operation<Record<string, unknown>> = { method: 'GET', route: '/images', query: ['per_page', 'meta.<field>[<operator>]'] };
	const { client, calls } = mock(() => envelope(null));
	await client.send(operation, {
		per_page: 2,
		'meta.status[eq]': 'active',
		'meta.priority[gte:number]': 1,
		'meta.region[in]': 'us-east|eu-west',
		'meta.unfiltered': 'x',
		other: 'y',
	});
	assert.deepEqual([...(calls[0]?.url.searchParams ?? [])], [
		['per_page', '2'],
		['meta.status[eq]', 'active'],
		['meta.priority[gte:number]', '1'],
		['meta.region[in]', 'us-east|eu-west'],
	]);
});

test('query arrays repeat unless the operation joins them, and empty values are left out', async () => {
	const operation: Operation<Record<string, unknown>> = {
		method: 'GET',
		route: '/a',
		query: ['repeated', 'joined', 'absent', 'none', 'flag'],
		joined: ['joined'],
	};
	const { client, calls } = mock(() => envelope(null));
	await client.send(operation, { repeated: [1, 2], joined: ['a', 'b'], none: null, flag: false, ignored: 'x' });
	assert.equal(calls[0]?.url.search, '?repeated=1&repeated=2&joined=a%2Cb&flag=false');
});

test('a JSON body is sent with its media type, and only the body field is the body', async () => {
	const operation: Operation<{ id: string; body: unknown }> = {
		method: 'PATCH',
		route: '/a/{id}',
		body: 'json',
		contentType: 'application/merge-patch+json',
	};
	const { client, calls } = mock(() => envelope(null));
	await client.send(operation, { id: 'x', body: { a: 1 } });
	assert.equal(calls[0]?.init.body, '{"a":1}');
	assert.equal(new Headers(calls[0]?.init.headers).get('content-type'), 'application/merge-patch+json');
});

test('a form body takes a FormData or an object, and leaves the content type to fetch', async () => {
	const operation: Operation<{ body: unknown }> = { method: 'PUT', route: '/a', body: 'form' };
	const { client, calls } = mock(() => envelope(null));
	const file = new Blob(['code'], { type: 'application/javascript+module' });
	await client.send(operation, { body: { metadata: { main_module: 'w.js' }, files: [file, file], none: null } });
	const form = calls[0]?.init.body as FormData;
	assert.equal(form.get('metadata'), '{"main_module":"w.js"}');
	assert.equal(form.getAll('files').length, 2);
	assert.equal(form.has('none'), false);
	assert.equal(new Headers(calls[0]?.init.headers).has('content-type'), false);
	const own = new FormData();
	await client.send(operation, { body: own });
	assert.equal(calls[1]?.init.body, own);
});

test('a FormData is sent as a form, whatever format the operation mainly takes', async () => {
	const { client, calls } = mock(() => envelope(null));
	const form = new FormData();
	form.append('file', new Blob(['png']), 'mark.png');
	for (const body of ['json', 'raw'] as const) {
		const operation: Operation<{ body: unknown }> = { method: 'POST', route: '/a', body, contentType: 'application/x-test' };
		await client.send(operation, { body: form });
		assert.equal(calls.at(-1)?.init.body, form, body);
		// fetch adds it, with the boundary.
		assert.equal(new Headers(calls.at(-1)?.init.headers).has('content-type'), false, body);
	}
	await client.send({ method: 'POST', route: '/a', body: 'json' }, { body: { a: 1 } });
	assert.equal(calls.at(-1)?.init.body, '{"a":1}');
});

test('text, bytes and empty responses are read as the operation says', async () => {
	const text: Operation<object, string> = { method: 'GET', route: '/a', response: 'text' };
	const bytes: Operation<object, Uint8Array> = { method: 'GET', route: '/a', response: 'bytes' };
	const none: Operation<object, void> = { method: 'GET', route: '/a', response: 'none' };
	assert.equal(await mock(() => new Response('hello')).client.send(text), 'hello');
	assert.deepEqual(await mock(() => new Response(new Uint8Array([1, 2]))).client.send(bytes), new Uint8Array([1, 2]));
	assert.equal(await mock(() => new Response(null, { status: 204 })).client.send(none), undefined);
	await assert.rejects(mock(() => new Response('{}', { status: 500 })).client.send(text), ApiError);
});

test('an operation with several formats reads each response by its content type', async () => {
	const operation: Operation<object, unknown> = { method: 'GET', route: '/a', response: 'auto' };
	const respond = (body: BodyInit | null, type: string | undefined, status = 200): Response =>
		new Response(body, { status, ...(type === undefined ? {} : { headers: { 'content-type': type } }) });
	const send = (response: Response) => mock(() => response).client.send(operation);
	// Bytes that aren't valid UTF-8, which reading as text would corrupt.
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8]);
	assert.deepEqual(await send(respond(png, 'image/png')), png);
	assert.deepEqual(await send(respond(png, 'application/octet-stream')), png);
	assert.equal(await send(respond('a,b\n', 'text/csv; charset=utf-8')), 'a,b\n');
	assert.equal(await send(respond('{"a":1}\n{"a":2}\n', 'application/x-ndjson')), '{"a":1}\n{"a":2}\n');
	const wrapped = JSON.stringify({ success: true, errors: [], result: { a: 1 } });
	assert.deepEqual(await send(respond(wrapped, 'application/json; charset=utf-8')), { a: 1 });
	assert.deepEqual(await send(respond(wrapped, 'application/problem+json')), { a: 1 });
	assert.equal(await send(respond(null, undefined, 204)), undefined);
	await assert.rejects(send(respond('<html>bad gateway</html>', 'text/html', 502)), ApiError);
	const failed = JSON.stringify({ success: false, errors: [{ message: 'nope' }] });
	await assert.rejects(send(respond(failed, 'application/json')), ApiError);
	const bare: Operation<object, unknown> = { ...operation, envelope: false };
	assert.deepEqual(await mock(() => respond('{"data":1}', 'application/json')).client.send(bare), { data: 1 });
});

test('an operation with several formats and no JSON reads anything else as its first', async () => {
	const operation: Operation<object, unknown> = { method: 'GET', route: '/feed', response: ['bytes', 'text'] };
	const bytes = (text: string) => new TextEncoder().encode(text);
	// A body of bytes, unlike a string, comes with no content type of its own.
	const send = (body: string, type?: string) =>
		mock(() => new Response(bytes(body), type === undefined ? {} : { headers: { 'content-type': type } })).client.send(operation);
	assert.equal(await send('1.2.3.4\n', 'text/plain'), '1.2.3.4\n');
	assert.deepEqual(await send('<feed/>', 'application/xml'), bytes('<feed/>'));
	// Neither a missing content type nor JSON is a format it declares.
	assert.deepEqual(await send('1.2.3.4\n'), bytes('1.2.3.4\n'));
	assert.deepEqual(await send('{"a":1}', 'application/json'), bytes('{"a":1}'));
	// A failure in the envelope is still a failure.
	await assert.rejects(send(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), 'application/json'), ApiError);
});

test('one rule sorts media types, for the runtime and the generator alike, whatever their case', () => {
	const cases = [
		['application/json', 'json'],
		['Application/JSON; charset=utf-8', 'json'],
		['application/scim+json', 'json'],
		['application/x-ndjson', 'text'],
		['text/csv', 'text'],
		['Text/CSV', 'text'],
		['text/event-stream', 'stream'],
		['Text/Event-Stream; charset=utf-8', 'stream'],
		['image/png', 'bytes'],
		['application/octet-stream', 'bytes'],
		// Not a media type. The spec's two uses of it are patched to text/plain.
		['string', 'bytes'],
	] as const;
	for (const [type, format] of cases) {
		assert.equal(formatOfMediaType(type), format, type);
	}
});

test('server-sent events come back as the unread body, which outlives the timeout and ends with the signal', async () => {
	const operation: Operation<object, unknown> = { method: 'GET', route: '/metrics', response: 'auto' };
	const encoder = new TextEncoder();
	// Like fetch, the body errors when the request's signal aborts.
	const events: Handler = (_, init) =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('data: 1\n\n'));
					const later = setTimeout(() => {
						controller.enqueue(encoder.encode('data: 2\n\n'));
						controller.close();
					}, 60);
					init.signal?.addEventListener('abort', () => {
						clearTimeout(later);
						controller.error(init.signal?.reason);
					});
				},
			}),
			{ headers: { 'content-type': 'text/event-stream' } },
		);
	const stream = await mock(events, { timeoutMs: 20 }).client.send(operation);
	assert.ok(stream instanceof ReadableStream);
	assert.equal(await new Response(stream).text(), 'data: 1\n\ndata: 2\n\n');
	const controller = new AbortController();
	const ended = (await mock(events).client.send(operation, {}, { signal: controller.signal })) as ReadableStream<Uint8Array>;
	controller.abort();
	await assert.rejects(new Response(ended).text(), { name: 'AbortError' });
});

test('a stream with no body, as with a 204, is a stream that ends at once', async () => {
	const operation: Operation<object, unknown> = { method: 'GET', route: '/metrics', response: 'auto' };
	const empty = () => new Response(null, { status: 204, headers: { 'content-type': 'text/event-stream' } });
	const stream = await mock(empty).client.send(operation);
	assert.ok(stream instanceof ReadableStream);
	assert.equal(await new Response(stream).text(), '');
});

test('a page in a format other than JSON has its body as the result, and no items', async () => {
	const operation: PagedOperation<object, unknown, unknown> = {
		method: 'GET',
		route: '/a',
		response: 'auto',
		page: { kind: 'cursor', items: 'items', param: 'cursor', next: 'cursor' },
	};
	const { client } = mock(() => new Response('a,b\n', { headers: { 'content-type': 'text/csv' } }));
	const page = await client.page(operation);
	assert.equal(page.result, 'a,b\n');
	assert.deepEqual(page.items, []);
	assert.equal(page.resultInfo, undefined);
});

test('paginate refuses what is not a page, rather than looking like an empty list', async () => {
	const operation: PagedOperation<object, unknown, unknown> = { method: 'GET', route: '/a', response: 'auto', page: { kind: 'page' } };
	const refused = async (response: () => Response, message = /isn't a page/): Promise<void> => {
		await assert.rejects(collect(mock(response).client.paginate(operation)), { name: 'TypeError', message });
	};
	await refused(() => new Response('a,b\n', { headers: { 'content-type': 'text/csv' } }));
	await refused(() => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }));
	await refused(() => Response.json({ data: [{ id: 'm1' }] }));
});

test('page returns a bare branch of the JSON as its result, as send does', async () => {
	const operation: PagedOperation<object, unknown, unknown> = { method: 'GET', route: '/a', page: { kind: 'page' } };
	const { client } = mock(() => Response.json({ data: [1], result_info: { page: 1 } }));
	const page = await client.page(operation);
	assert.deepEqual(page.result, { data: [1], result_info: { page: 1 } });
	assert.deepEqual(page.items, []);
	assert.equal(page.resultInfo, undefined);
	assert.deepEqual(await client.send(operation), { data: [1], result_info: { page: 1 } });
});

test('an empty list stays an empty list, however the API says it', async () => {
	const operation: PagedOperation<object, unknown, unknown> = { method: 'GET', route: '/a', page: { kind: 'page' } };
	const items = (response: () => Response) => collect(mock(response).client.paginate(operation));
	assert.deepEqual(await items(() => json({ success: true, errors: [] })), []);
	assert.deepEqual(await items(() => json({ success: true, result: null })), []);
	assert.deepEqual(await items(() => json({ result: {} })), []);
	assert.deepEqual(await items(() => new Response(null, { status: 204 })), []);
});

test('a bare operation pages over its whole body', async () => {
	const operation: PagedOperation<object, unknown, number> = { method: 'GET', route: '/a', envelope: false, page: { kind: 'page' } };
	const { client, calls } = mock((url) => json(url.searchParams.get('page') === '2' ? [] : [1, 2]));
	assert.deepEqual(await collect(client.paginate(operation)), [1, 2]);
	assert.equal(calls.length, 2);
});

test('an operation can ask for any format, and a call can ask for a particular one', async () => {
	const { client, calls } = mock(() => envelope(null));
	const accepted = (index: number) => new Headers(calls[index]?.init.headers).get('accept');
	await client.send({ method: 'GET', route: '/a' });
	assert.equal(accepted(0), 'application/json');
	await client.send({ method: 'GET', route: '/a', accept: '*/*' });
	assert.equal(accepted(1), '*/*');
	await client.send({ method: 'GET', route: '/a', response: 'auto' }, {}, { headers: { accept: 'text/csv' } });
	assert.equal(accepted(2), 'text/csv');
});

test('the headers of a call replace those of the client, which replace the defaults', async () => {
	const operation: Operation<{ 'If-Match'?: string }> = { method: 'GET', route: '/a', headers: ['If-Match'] };
	const { client, calls } = mock(() => envelope(null), { headers: { 'api-version': '2026-11-07', 'x-a': 'client' } });
	await client.send(operation, { 'If-Match': 'etag' }, { headers: { 'x-a': 'call' } });
	const headers = new Headers(calls[0]?.init.headers);
	assert.equal(headers.get('authorization'), 'Bearer t');
	assert.equal(headers.get('api-version'), '2026-11-07');
	assert.equal(headers.get('x-a'), 'call');
	assert.equal(headers.get('if-match'), 'etag');
});

test('a request header field beats the client, a call beats both, and a form keeps its boundary', async () => {
	const operation: Operation<{ 'api-version'?: string; body?: unknown }> = {
		method: 'POST',
		route: '/a',
		headers: ['api-version'],
		body: 'json',
	};
	const { client, calls } = mock(() => envelope(null), {
		headers: { 'api-version': '2026-11-07', 'content-type': 'text/plain', accept: 'text/plain' },
	});
	const sent = (index: number) => new Headers(calls[index]?.init.headers);
	await client.send(operation, { 'api-version': '2020-01-01', body: {} });
	assert.equal(sent(0).get('api-version'), '2020-01-01');
	// What the operation sends and reads is its own.
	assert.equal(sent(0).get('content-type'), 'application/json');
	assert.equal(sent(0).get('accept'), 'application/json');
	await client.send(operation, { 'api-version': '2020-01-01' }, { headers: { 'api-version': '2021-01-01' } });
	assert.equal(sent(1).get('api-version'), '2021-01-01');
	await client.send(operation, { body: new FormData() }, { headers: { 'content-type': 'multipart/form-data' } });
	assert.equal(sent(2).has('content-type'), false);
});

test('a raw body takes a content type the request gives, and the declared one otherwise', async () => {
	const put: Operation<{ 'Content-Type'?: string; body: BodyInit }> = {
		method: 'PUT',
		route: '/a',
		headers: ['Content-Type'],
		body: 'raw',
		contentType: 'application/octet-stream',
	};
	const { client, calls } = mock(() => envelope(null));
	const html = new Blob(['<p>'], { type: 'text/html' });
	await client.send(put, { 'Content-Type': 'text/html', body: html });
	assert.equal(new Headers(calls[0]?.init.headers).get('content-type'), 'text/html');
	await client.send(put, { body: html });
	assert.equal(new Headers(calls[1]?.init.headers).get('content-type'), 'application/octet-stream');
});

test('retries only idempotent requests, and only when asked to', async () => {
	const responses = () => {
		let count = 0;
		return () => (count++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '0.001' } }) : envelope(1));
	};
	const get = mock(responses(), { maxRetries: 1 });
	assert.equal(await get.client.send({ method: 'GET', route: '/a' }), 1);
	assert.equal(get.calls.length, 2);
	const post = mock(responses(), { maxRetries: 1 });
	await assert.rejects(post.client.send({ method: 'POST', route: '/a' }), ApiError);
	assert.equal(post.calls.length, 1);
	const off = mock(responses());
	await assert.rejects(off.client.send({ method: 'GET', route: '/a' }), ApiError);
	assert.equal(off.calls.length, 1);
});

test('a retry the server wants much later is left to the caller, with the header', async () => {
	const { client, calls } = mock(() => new Response('', { status: 429, headers: { 'retry-after': '300' } }), { maxRetries: 3 });
	const started = performance.now();
	await assert.rejects(client.send({ method: 'GET', route: '/a' }), (error: unknown) => {
		assert.ok(error instanceof ApiError);
		assert.equal(error.status, 429);
		assert.equal(error.headers.get('retry-after'), '300');
		return true;
	});
	assert.equal(calls.length, 1);
	assert.ok(performance.now() - started < 1000);
});

test('Retry-After can be a date, under the same limit', async () => {
	const at = (ms: number) => () => new Response('', { status: 503, headers: { 'retry-after': new Date(Date.now() + ms).toUTCString() } });
	const later = mock(at(120_000), { maxRetries: 2 });
	await assert.rejects(later.client.send({ method: 'GET', route: '/a' }), { name: 'ApiError', status: 503 });
	assert.equal(later.calls.length, 1);
	// A date that has passed asks for nothing, so the usual backoff applies.
	let count = 0;
	const passed = mock(() => (count++ === 0 ? at(-60_000)() : envelope(1)), { maxRetries: 1 });
	assert.equal(await passed.client.send({ method: 'GET', route: '/a' }), 1);
	assert.equal(passed.calls.length, 2);
});

test('Retry-After: 0 retries at once, rather than backing off', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let count = 0;
	const busyOnce = () => (count++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : envelope(1));
	const { client, calls } = mock(busyOnce, { maxRetries: 1 });
	const sent = client.send({ method: 'GET', route: '/a' });
	await new Promise((resolve) => setImmediate(resolve));
	// No time passes: the backoff would wait 0.5 s.
	t.mock.timers.tick(0);
	assert.equal(await sent, 1);
	assert.equal(calls.length, 2);
});

test('backing off without Retry-After waits 8 s at most', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { client, calls } = mock(() => new Response('', { status: 503 }), { maxRetries: 6 });
	const sent = client.send({ method: 'GET', route: '/a' }).catch((error: unknown) => error);
	// 0.5, 1, 2, 4, 8, and then 8 s again rather than 16.
	for (let retry = 0; retry < 6; retry++) {
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(8000);
	}
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 7);
	assert.ok((await sent) instanceof ApiError);
});

test('cancelling during a retry delay settles at once and stops retrying', async () => {
	const controller = new AbortController();
	// This timer would hold the test process open for a minute if it weren't cleared.
	const { client, calls } = mock(() => new Response('', { status: 429, headers: { 'retry-after': '60' } }), { maxRetries: 3 });
	const started = performance.now();
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(client.send({ method: 'GET', route: '/a' }, {}, { signal: controller.signal }), { name: 'AbortError' });
	assert.ok(performance.now() - started < 5000);
	assert.equal(calls.length, 1);
});

test('a signal that a retry delay outlives leaves nothing behind', async () => {
	const controller = new AbortController();
	const removed: string[] = [];
	const remove = controller.signal.removeEventListener.bind(controller.signal);
	controller.signal.removeEventListener = ((type: string, listener: EventListener) => {
		removed.push(type);
		remove(type, listener);
	}) as typeof controller.signal.removeEventListener;
	let count = 0;
	const { client } = mock(() => (count++ === 0 ? new Response('', { status: 503, headers: { 'retry-after': '0.001' } }) : envelope(1)), {
		maxRetries: 1,
	});
	assert.equal(await client.send({ method: 'GET', route: '/a' }, {}, { signal: controller.signal }), 1);
	assert.deepEqual(removed, ['abort']);
});

/** Runs a real HTTP server for a real `fetch`, which is what rejects a stream sent wrongly. */
async function withServer<T>(respond: (seen: number) => { status: number; headers?: Record<string, string> }, run: (baseUrl: string, received: string[]) => Promise<T>): Promise<T> {
	const received: string[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			received.push(Buffer.concat(chunks).toString());
			const { status, headers } = respond(received.length);
			response.writeHead(status, { 'content-type': 'application/json', ...headers });
			response.end(JSON.stringify({ success: status < 300, errors: [], messages: [], result: 'ok' }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const { port } = server.address() as AddressInfo;
		return await run(`http://127.0.0.1:${port}`, received);
	} finally {
		server.close();
	}
}

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

const upload: Operation<{ body: BodyInit }, string> = { method: 'PUT', route: '/a', body: 'raw', contentType: 'application/octet-stream' };

test('a raw body can be a stream', async () => {
	await withServer(
		() => ({ status: 200 }),
		async (baseUrl, received) => {
			assert.equal(await createClient({ baseUrl }).send(upload, { body: streamOf('hello') }), 'ok');
			assert.deepEqual(received, ['hello']);
		},
	);
});

test('a stream is not retried, as it can only be read once, though other bodies are', async () => {
	const busyOnce = (seen: number) => (seen === 1 ? { status: 503, headers: { 'retry-after': '0.001' } } : { status: 200 });
	await withServer(busyOnce, async (baseUrl, received) => {
		await assert.rejects(createClient({ baseUrl, maxRetries: 2 }).send(upload, { body: streamOf('hello') }), { name: 'ApiError', status: 503 });
		assert.equal(received.length, 1);
	});
	await withServer(busyOnce, async (baseUrl, received) => {
		assert.equal(await createClient({ baseUrl, maxRetries: 2 }).send(upload, { body: 'hello' }), 'ok');
		assert.deepEqual(received, ['hello', 'hello']);
	});
});
