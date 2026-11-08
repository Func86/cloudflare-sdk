import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiConnectionError, ApiError, type DryRunOperation, type Operation, type PagedOperation } from '../src/client.ts';
import { createMockClient, withResultInfo } from '../src/testing.ts';

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) {
		out.push(item);
	}
	return out;
}

const get: Operation<{ account_id: string; id: string }, { id: string; name: string }> = {
	method: 'GET',
	route: '/accounts/{account_id}/things/{id}',
};
const scoped: Operation<{ account_id?: string; zone_id?: string }, string[]> = {
	method: 'GET',
	route: '/{account_or_zone}/{account_or_zone_id}/things',
	accountOrZone: true,
};
const paged: PagedOperation<{ page?: number; per_page?: number }, { things: number[] }, number> = {
	method: 'GET',
	route: '/things',
	query: ['page', 'per_page'],
	page: { kind: 'page', items: 'things' },
};
const offsets: PagedOperation<{ offset?: number }, number[], number> = {
	method: 'GET',
	route: '/offsets',
	query: ['offset'],
	page: { kind: 'offset' },
};
const cursors: PagedOperation<{ cursor?: string }, number[], number> = {
	method: 'GET',
	route: '/cursors',
	query: ['cursor'],
	page: { kind: 'cursor', param: 'cursor', next: 'cursor' },
};
// As rulesets.list reads its next cursor.
const nested: PagedOperation<{ cursor?: string }, number[], number> = {
	method: 'GET',
	route: '/nested',
	query: ['cursor'],
	page: { kind: 'cursor', param: 'cursor', next: 'cursors.after' },
};
const bytes: Operation<object, Uint8Array> = { method: 'GET', route: '/file', response: 'bytes' };
const text: Operation<object, string> = { method: 'GET', route: '/text', response: 'text' };
const auto: Operation<object, string | { a: number }> = { method: 'GET', route: '/auto', response: 'auto' };
const bare: Operation<object, { data: number[] }> = { method: 'GET', route: '/bare', envelope: false };
const post: Operation<{ body: object }, number> = { method: 'POST', route: '/posts', body: 'json' };

test('a handler answers its operation with a copy of the request', async () => {
	const requests: Record<string, unknown>[] = [];
	const client = createMockClient().on(get, (request) => {
		requests.push(request);
		return { id: request.id, name: 'n' };
	});
	const request = { account_id: 'a', id: 'x' };
	assert.deepEqual(await client.send(get, request), { id: 'x', name: 'n' });
	// The caller changing its request later doesn't change what the handler was given, nor the reverse.
	request.id = 'changed';
	assert.deepEqual(requests, [{ account_id: 'a', id: 'x' }]);
	const [recorded] = requests;
	assert.ok(recorded);
	recorded['account_id'] = 'edited';
	assert.equal(request.account_id, 'a');
	// A later handler replaces it.
	client.on(get, async () => ({ id: 'y', name: 'later' }));
	assert.equal((await client.send(get, { account_id: 'a', id: 'x' })).name, 'later');
});

test('an operation with no handler fails, naming it', async () => {
	await assert.rejects(createMockClient().send(get, { account_id: 'a', id: 'x' }), {
		message: 'No handler answers GET /accounts/{account_id}/things/{id}',
	});
	await assert.rejects(collect(createMockClient().paginate(paged)), /No handler answers GET \/things/);
	// A call already cancelled is sent nowhere, so it rejects with its reason, as fetch does.
	const reason = new Error('cancelled');
	await assert.rejects(createMockClient().send(get, { account_id: 'a', id: 'x' }, { signal: AbortSignal.abort(reason) }), (error) => error === reason);
	// As a copy of an operation isn't the operation.
	const copied = createMockClient().on({ ...get }, () => ({ id: 'x', name: 'n' }));
	await assert.rejects(copied.send(get, { account_id: 'a', id: 'x' }), {
		message: /^No handler answers GET \/accounts\/\{account_id\}\/things\/\{id\}\. One answers another object with its method and route/,
	});
});

test('a request is checked as the client checks it, before the handler sees it', async () => {
	let called = false;
	const client = createMockClient()
		.on(scoped, () => {
			called = true;
			return [];
		})
		.on(get, () => ({ id: '', name: '' }))
		.on(post, () => {
			called = true;
			return 1;
		});
	await assert.rejects(client.send(scoped, { account_id: 'a', zone_id: 'z' }), TypeError);
	await assert.rejects(client.send(get, { account_id: 'a', id: '' }), { message: 'GET /accounts/{account_id}/things/{id}: id is required' });
	// A body JSON can't carry, and a header no request can send.
	await assert.rejects(client.send(post, { body: { n: 1n } }), TypeError);
	await assert.rejects(client.send(post, { body: {} }, { headers: { 'x-bad': 'a\nb' } }), TypeError);
	assert.equal(called, false);
	// Whether or not a handler answers the operation.
	await assert.rejects(createMockClient().send(scoped, {}), { name: 'TypeError', message: /give account_id or zone_id/ });
});

test('a result given as it is is the whole list to paginate', async () => {
	for (const [operation, result] of [
		[paged, { things: [1, 2] }],
		[offsets, [1, 2]],
		[cursors, [1, 2]],
	] as const) {
		let calls = 0;
		const client = createMockClient().on(operation as Operation, () => {
			calls += 1;
			return result;
		});
		assert.deepEqual(await collect(client.paginate(operation as PagedOperation)), [1, 2], operation.route);
		assert.equal(calls, 1, operation.route);
	}
	// `page` gives no result_info the handler didn't.
	const page = await createMockClient().on(paged, () => ({ things: [1] })).page(paged);
	assert.deepEqual(page, { items: [1], result: { things: [1] }, resultInfo: undefined });
});

test('pages answered one by one are walked as the API would be, by page, offset or cursor', async () => {
	const asked: unknown[] = [];
	const byPage = createMockClient().on(paged, (request) => {
		asked.push(request);
		const page = request.page ?? 1;
		return withResultInfo({ things: page === 1 ? [1, 2] : [3] }, { page, total_pages: 2 });
	});
	assert.deepEqual(await collect(byPage.paginate(paged, { per_page: 2 })), [1, 2, 3]);
	assert.deepEqual(asked, [{ per_page: 2 }, { per_page: 2, page: 2 }]);

	const offsetsAsked: unknown[] = [];
	const byOffset = createMockClient().on(offsets, ({ offset = 0 }) => {
		offsetsAsked.push(offset);
		return withResultInfo([1, 2, 3].slice(offset, offset + 2), { total_count: 3 });
	});
	assert.deepEqual(await collect(byOffset.paginate(offsets)), [1, 2, 3]);
	assert.deepEqual(offsetsAsked, [0, 2]);

	for (const [operation, next] of [
		[cursors, { cursor: 'c2' }],
		[nested, { cursors: { after: 'c2' } }],
	] as const) {
		const cursorsAsked: unknown[] = [];
		const byCursor = createMockClient().on(operation, (request) => {
			cursorsAsked.push(request.cursor);
			return request.cursor === undefined ? withResultInfo([1], next) : withResultInfo([2], {});
		});
		assert.deepEqual(await collect(byCursor.paginate(operation)), [1, 2], operation.route);
		assert.deepEqual(cursorsAsked, [undefined, 'c2'], operation.route);
		assert.deepEqual((await byCursor.page(operation)).resultInfo, next);
	}
});

test('what a handler throws, the call throws as it is, in any format and with any status', async () => {
	const failures = [
		new ApiError({ status: 404 }, { success: false, errors: [{ code: 10003, message: 'not found' }] }),
		// A 2XX failure, with or without a failed envelope.
		new ApiError({ status: 200 }, undefined),
		new ApiError({ status: 200 }, { errors: [{ message: 'x' }] }),
		// A status no Response can carry, and a problem of its own.
		new ApiError({ status: 304 }, { success: false }),
		new ApiError({ status: 500 }, 'text', 'GET', '/r', 'custom problem'),
		new TypeError('not an API error'),
	];
	for (const failure of failures) {
		for (const operation of [scoped, auto, text, bytes, bare] as Operation[]) {
			const client = createMockClient().on(operation, () => {
				throw failure;
			});
			await assert.rejects(client.send(operation, { zone_id: 'z' }), (error: unknown) => error === failure, `${operation.route}: ${failure.message}`);
		}
	}
	await assert.rejects(createMockClient().on(get, () => Promise.reject(failures[0]!)).send(get, { account_id: 'a', id: 'x' }), (error) => error === failures[0]);
});

test('a call ends when its signal or timeout ends it, while its handler is pending', async () => {
	const pending = createMockClient()
		.on(get, () => new Promise<never>(() => undefined))
		.on(cursors, () => new Promise<never>(() => undefined));
	const request = { account_id: 'a', id: 'x' };
	const reason = new Error('cancelled');
	const controller = new AbortController();
	const cancelled = pending.send(get, request, { signal: controller.signal });
	controller.abort(reason);
	await assert.rejects(cancelled, (error) => error === reason);
	await assert.rejects(pending.send(get, request, { timeoutMs: 10 }), (error: unknown) => {
		assert.ok(error instanceof ApiConnectionError);
		assert.equal(error.message, 'GET /accounts/{account_id}/things/{id} got no complete response');
		assert.equal((error.cause as DOMException).name, 'TimeoutError');
		return true;
	});
	await assert.rejects(collect(pending.paginate(cursors, {}, { signal: AbortSignal.abort(reason) })), (error) => error === reason);
	// Cancelled by the handler itself, as by a user while the request is in flight, whether it answers or not.
	for (const answer of [() => new Promise<never>(() => undefined), () => ({ id: 'x', name: 'n' })]) {
		const inFlight = new AbortController();
		const client = createMockClient().on(get, () => {
			inFlight.abort(reason);
			return answer();
		});
		await assert.rejects(client.send(get, request, { signal: inFlight.signal }), (error) => error === reason);
	}
	// A call cancelled before it's sent doesn't reach the handler.
	let calls = 0;
	const watched = createMockClient().on(get, () => {
		calls += 1;
		return { id: 'x', name: 'n' };
	});
	await assert.rejects(watched.send(get, request, { signal: AbortSignal.abort(reason) }), (error) => error === reason);
	assert.equal(calls, 0);
	// A handler that answers in time is unaffected.
	assert.equal((await watched.send(get, request, { timeoutMs: 1000 })).name, 'n');
	assert.equal(calls, 1);
});

test('a handler runs as the call is made, as fetch is called, with or without a signal', async () => {
	let calls = 0;
	const client = createMockClient().on(get, () => {
		calls += 1;
		return { id: 'x', name: 'n' };
	});
	const request = { account_id: 'a', id: 'x' };
	const plain = client.send(get, request);
	assert.equal(calls, 1);
	const timed = client.send(get, request, { timeoutMs: 1000 });
	assert.equal(calls, 2);
	// Cancelled once made, the call rejects, and its request was still sent.
	const controller = new AbortController();
	const reason = new Error('cancelled');
	const cancelled = client.send(get, request, { signal: controller.signal });
	controller.abort(reason);
	assert.equal(calls, 3);
	await Promise.all([plain, timed, assert.rejects(cancelled, (error) => error === reason)]);
	// One that throws at once rejects the call.
	const failure = new Error('at once');
	const throwing = createMockClient().on(get, () => {
		throw failure;
	});
	await assert.rejects(throwing.send(get, request, { timeoutMs: 1000 }), (error) => error === failure);
});

test('a dry run of a ruleset write answers null, and only a dry run does', async () => {
	const write: DryRunOperation<{ dry_run?: boolean }, { id: string } | null> = { method: 'PUT', route: '/rulesets', dryRun: true };
	const client = createMockClient().on(write, ({ dry_run }) => (dry_run ? null : { id: 'r' }));
	assert.equal(await client.send(write, { dry_run: true }), null);
	assert.deepEqual(await client.send(write, {}), { id: 'r' });
	// The request as sent, though the caller changes it while the handler runs.
	const request = { dry_run: true };
	const sent = client.send(write, request);
	request.dry_run = false;
	assert.equal(await sent, null);
	const wrong = createMockClient().on(write, ({ dry_run }) => (dry_run ? { id: 'r' } : null));
	for (const request of [{ dry_run: true }, { dry_run: false }, {}]) {
		await assert.rejects(wrong.send(write, request), { name: 'TypeError', message: 'PUT /rulesets: a dry run answers null, and only a dry run does' });
	}
});

test('an answer in another format is the result as it is', async () => {
	const none: Operation<object, undefined> = { method: 'DELETE', route: '/thing', response: 'none' };
	// As a mock function, such as vitest's, can return a value for any operation.
	const loose = (() => ({ ok: true })) as unknown as () => undefined;
	const quoted: Operation<object, string> = { method: 'GET', route: '/quoted' };
	const client = createMockClient()
		.on(bytes, () => new Uint8Array([1, 2]))
		.on(text, () => 'plain')
		.on(none, loose)
		.on(bare, () => ({ data: [1] }))
		.on(quoted, () => 'in the envelope')
		.on(auto, () => ({ a: 1 }));
	assert.deepEqual(await client.send(bytes), new Uint8Array([1, 2]));
	assert.equal(await client.send(text), 'plain');
	assert.equal(await client.send(none), undefined);
	assert.deepEqual(await client.send(bare), { data: [1] });
	assert.equal(await client.send(quoted), 'in the envelope');
	assert.deepEqual(await client.send(auto), { a: 1 });
	// Text for an operation that can answer in it isn't a page, as the client reads a CSV response.
	const csv: PagedOperation<{ page?: number }, string | number[], number> = {
		method: 'GET',
		route: '/csv',
		response: 'auto',
		query: ['page'],
		page: { kind: 'page' },
	};
	const texts = createMockClient().on(csv, () => 'a,b\n1,2');
	assert.equal(await texts.send(csv), 'a,b\n1,2');
	await assert.rejects(collect(texts.paginate(csv)), { name: 'TypeError', message: "GET /csv: this response isn't a page, so read it with send" });
	assert.deepEqual(await collect(createMockClient().on(csv, () => [1, 2]).paginate(csv)), [1, 2]);
});

test('withResultInfo needs a result the operation answers in the envelope', async () => {
	for (const operation of [bare, text] as Operation[]) {
		const client = createMockClient().on(operation, () => withResultInfo({ data: [1] }, { page: 1 }));
		await assert.rejects(client.send(operation), { name: 'TypeError', message: /withResultInfo needs a result the operation answers in the envelope/ });
	}
	// Text for an operation that can answer in it has no envelope, so no result_info.
	const csv: PagedOperation<{ cursor?: string }, string | number[], number> = { ...cursors, response: 'auto' };
	const texts = createMockClient().on(csv, () => withResultInfo('a,b\n1,2', { cursor: 'n' }));
	await assert.rejects(collect(texts.paginate(csv)), { name: 'TypeError', message: /^GET \/cursors: withResultInfo needs a result/ });
});
