/**
 * Checks on the real generated output, for the operations whose behaviour was
 * verified against the live API or that regressed before.
 * Run `npm run generate` first.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient, type Operation, type PagedOperation } from '../src/client.ts';

interface Entry {
	id: string;
	method: string;
	route: string;
	response: string;
	alternatives?: string[];
	body?: string;
	page?: { kind: string; items?: string; param?: string; next?: string };
	aliasOf?: string;
}

const manifest = JSON.parse(readFileSync('generated/_meta/operations.json', 'utf8')) as Entry[];
const byId = new Map(manifest.map((entry) => [entry.id, entry]));

function pageOf(id: string): Entry['page'] {
	const entry = byId.get(id);
	assert.ok(entry, `${id} is not generated`);
	return entry.page;
}

test('each paginated operation names the array the API really sends', () => {
	// The official SDK reads `result.items` for all of these but the last; the
	// first three were confirmed against the live API.
	assert.deepEqual(pageOf('workers.deployments.list'), { kind: 'page', items: 'deployments' });
	assert.deepEqual(pageOf('load-balancers.searches.list'), { kind: 'page', items: 'resources' });
	assert.deepEqual(pageOf('abuse-reports.list'), { kind: 'page', items: 'reports' });
	assert.deepEqual(pageOf('workers.legacy.scripts.versions.list'), { kind: 'page', items: 'items' });
});

test('a result that is the array itself has no items key', () => {
	assert.deepEqual(pageOf('accounts.list'), { kind: 'page' });
	assert.deepEqual(pageOf('zones.list'), { kind: 'page' });
});

test('page parameters alone do not make an operation paginated', () => {
	assert.equal(pageOf('turnstile.widgets.create'), undefined);
});

test('pagination in a union result and in a union envelope is found', () => {
	assert.deepEqual(pageOf('rules.lists.items.list'), { kind: 'cursor', param: 'cursor', next: 'cursors.after' });
	assert.deepEqual(pageOf('user.memberships.list'), { kind: 'page' });
});

test('x-fern-pagination is read where the spec states it', () => {
	assert.deepEqual(pageOf('containers.applications.list'), {
		kind: 'cursor',
		param: 'page_token',
		next: 'next_page_token',
	});
});

test('operations the official SDK lacks or mishandles are generated', () => {
	for (const id of [
		'builds.versions.get',
		'builds.triggers.list',
		'accounts.entitlements.get',
		'zero-trust.access.service-tokens.create',
	]) {
		assert.ok(byId.has(id), `${id} is not generated`);
	}
	// Worker uploads are multipart, which Forge's built-in TypeScript target skips.
	assert.equal(byId.get('workers.legacy.scripts.update')?.body, 'form');
});

test('an operation marked x-fern-ignore is generated unless there is a reason not to', () => {
	const routes = new Set(manifest.map((entry) => `${entry.method} ${entry.route}`));
	// Libreflare creates stores with this one.
	assert.equal(byId.get('secrets-store.stores.create')?.method, 'POST');
	assert.ok(routes.has('GET /accounts/{account_id}/ai-gateway/billing/credit-balance'));
	// Legacy, but its description says it has no direct replacement.
	assert.ok(routes.has('POST /accounts/{account_id}/cloudforce-one/events/{event_id}/raw/{raw_id}'));
	// Deprecated.
	assert.equal(byId.has('images.v1.list'), false);
	// Replaced, as their descriptions or their v2 routes say.
	assert.equal(routes.has('GET /accounts/{account_id}/cloudforce-one/requests/quota'), false);
	assert.equal(routes.has('PUT /zones/{zone_id}/subscriptions'), false);
	// Only open to one pilot account.
	assert.equal(routes.has('GET /accounts/{account_id}/email/domains'), false);
	// For Terraform alone.
	assert.equal(routes.has('POST /accounts/{account_id}/dlp/entries/predefined'), false);
});

test('a hidden operation is renamed when it would collide, and the visible one keeps its name', () => {
	assert.equal(
		byId.get('email-security.investigate.moveOne')?.route,
		'/accounts/{account_id}/email-security/investigate/{investigate_id}/move',
	);
	assert.equal(byId.get('email-security.investigate.move')?.route, '/accounts/{account_id}/email-security/investigate/move');
	assert.ok(byId.has('cloudforce-one.requests.types.list'));
});

test('an operation that does not describe its response is left out, apart from a DELETE', () => {
	const routes = new Set(manifest.map((entry) => `${entry.method} ${entry.route}`));
	assert.equal(routes.has('GET /accounts/{account_id}/cloudforce-one/v2/priority-intelligence'), false);
	assert.equal(routes.has('GET /accounts/{account_id}/cni/interconnects/{icon}/loa'), false);
	const remove = manifest.find((entry) => entry.method === 'DELETE' && entry.route === '/accounts/{account_id}/stream/{identifier}');
	assert.equal(remove?.response, 'none');
});

test('an operation served from another host is left out, as its literal would go to the API', () => {
	// K2's data plane is at https://{stream_id}.k2.cloudflarestorage.com.
	assert.equal(manifest.some((entry) => entry.id.startsWith('k2.data.')), false);
	assert.ok(manifest.some((entry) => entry.id.startsWith('k2.')));
});

test('a method named with a reserved word is exported under that name alone', async () => {
	const group = (await import('../generated/workers/deployments/index.js')) as Record<string, unknown>;
	assert.ok('delete' in group);
	assert.equal('delete_' in group, false);
	const declarations = readFileSync('generated/workers/deployments/index.d.ts', 'utf8');
	assert.doesNotMatch(declarations, /export declare const delete_/);
});

test('JSON of another media type is asked for by that type', async () => {
	const { list } = (await import('../generated/scim/users/index.js')) as unknown as { list: Operation<Record<string, unknown>, unknown> };
	assert.equal(list.accept, 'application/scim+json');
	const { cf, accepts } = client(() => Response.json({ Resources: [] }, { headers: { 'content-type': 'application/scim+json' } }));
	assert.deepEqual(await cf.send(list, { account_id: 'a' }), { Resources: [] });
	assert.deepEqual(accepts, ['application/scim+json']);
});

test('a declared Accept or Content-Type is a field of the request', async () => {
	const { put } = (await import('../generated/r2/objects/index.js')) as unknown as { put: Operation<Record<string, unknown>, unknown> };
	const types: (string | null)[] = [];
	const cf = createClient({
		token: 't',
		fetch: (async (_: string, init: RequestInit) => {
			types.push(new Headers(init.headers).get('content-type'));
			return Response.json({ success: true, errors: [], result: {} });
		}) as typeof fetch,
	});
	const object = { account_id: 'a', bucket_name: 'b', object_key: 'index.html', body: new Blob(['<p>']) };
	await cf.send(put, { ...object, 'Content-Type': 'text/html' });
	await cf.send(put, object);
	assert.equal(types[0], 'text/html');
	assert.equal(types[1], put.contentType);
	const { export: exported } = (await import('../generated/cloudforce-one/stakeout/collections/index.js')) as unknown as {
		export: Operation<Record<string, unknown>, unknown>;
	};
	// Its literal asks for any format, and the request picks one.
	const ndjson = client(() => new Response('{"a":1}\n', { headers: { 'content-type': 'application/x-ndjson' } }));
	await ndjson.cf.send(exported, { account_id: 'a', collection_id: 'c', accept: 'application/x-ndjson' });
	assert.deepEqual(ndjson.accepts, ['application/x-ndjson']);
});

test('an alias takes the place of the name it renames, as it does in cf', () => {
	assert.ok(byId.has('o11y.agents.traces.list'));
	assert.equal(byId.has('observability.agents.traces.list'), false);
});

test('JSON with no schema is still unwrapped from the envelope', () => {
	const entry = manifest.find((candidate) => candidate.route === '/accounts/{account_id}/logs/retrieve');
	assert.equal(entry?.response, 'envelope');
});

test('every id is unique and every route starts at the root', () => {
	assert.equal(byId.size, manifest.length);
	for (const entry of manifest) {
		assert.match(entry.route, /^\//, entry.id);
	}
});

test('a generated script module imports nothing but its own subgroups', () => {
	const walk = (directory: string): string[] =>
		readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory() ? walk(path) : entry.name === 'index.js' ? [path] : [];
		});
	const scripts = walk('generated');
	assert.ok(scripts.length > 1000);
	for (const script of scripts) {
		const source = readFileSync(script, 'utf8');
		assert.doesNotMatch(source, /^\s*import\b/m, script);
		for (const [, target] of source.matchAll(/^export \* as \S+ from "([^"]+)";$/gm)) {
			assert.match(target!, /^\.\/[^/]+\/index\.js$/, script);
		}
	}
});

test('Images metadata filters are sent as the parameters they name', async () => {
	const { list } = (await import('../generated/images/index.js')) as unknown as { list: Operation<Record<string, unknown>, unknown> };
	const { cf, urls } = client(() => Response.json({ success: true, errors: [], result: { images: [] } }));
	await cf.send(list, { account_id: 'a', 'meta.status[eq]': 'active', 'meta.priority[gte:number]': 1 });
	assert.equal(new URL(urls[0]!).search, '?meta.status%5Beq%5D=active&meta.priority%5Bgte%3Anumber%5D=1');
});

test('server-sent events are a stream, which a caller asks for', async () => {
	assert.deepEqual(byId.get('queues.metrics.get')?.alternatives, ['stream']);
	const { get } = (await import('../generated/queues/metrics/index.js')) as unknown as { get: Operation<Record<string, unknown>, unknown> };
	// JSON unless the call asks.
	assert.equal(get.accept, undefined);
	const { cf } = client(() => new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
	const stream = await cf.send(get, { account_id: 'a', queue_id: 'q' }, { headers: { accept: 'text/event-stream' } });
	assert.ok(stream instanceof ReadableStream);
});

test('an operation that also answers in another format says so, and one that serves files does not', () => {
	assert.deepEqual(byId.get('browser-run.quick-action.screenshot')?.alternatives, ['bytes', 'text']);
	assert.deepEqual(byId.get('workflows.instances.step.get')?.alternatives, ['bytes']);
	assert.deepEqual(byId.get('security-insights.partners.shadow-hosts.list')?.alternatives, ['text']);
	assert.equal(byId.get('zones.list')?.alternatives, undefined);
	// Its JSON and text media types are what a file can be, so it's always bytes.
	assert.equal(byId.get('artifacts.namespaces.repos.raw.get')?.response, 'bytes');
	assert.equal(byId.get('artifacts.namespaces.repos.raw.get')?.alternatives, undefined);
});

/** A client for a real operation, with the requests it sends. */
function client(respond: () => Response) {
	const urls: string[] = [];
	const accepts: (string | null)[] = [];
	return {
		urls,
		accepts,
		cf: createClient({
			token: 't',
			fetch: (async (input: string, init: RequestInit) => {
				urls.push(input);
				accepts.push(new Headers(init.headers).get('accept'));
				return respond();
			}) as typeof fetch,
		}),
	};
}

test('a screenshot comes back byte for byte', async () => {
	const { screenshot } = (await import('../generated/browser-run/quick-action/index.js')) as unknown as {
		screenshot: Operation<Record<string, unknown>, unknown>;
	};
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);
	const { cf, accepts } = client(() => new Response(png, { headers: { 'content-type': 'image/png' } }));
	assert.deepEqual(await cf.send(screenshot, { account_id: 'a', body: { url: 'https://example.com' } }), png);
	assert.deepEqual(accepts, ['*/*']);
});

test('a result beside other data is part of a bare response, and a lone result is still an envelope', async () => {
	assert.equal(byId.get('url-scanner.scans.create')?.response, 'json');
	assert.equal(byId.get('abuse-reports.create')?.response, 'json');
	assert.equal(byId.get('dns.records.delete')?.response, 'envelope');
	const { create } = (await import('../generated/url-scanner/scans/index.js')) as unknown as {
		create: Operation<Record<string, unknown>, unknown>;
	};
	const scan = { uuid: 'u', api: 'https://api/u', result: 'https://radar/u', url: 'https://example.com/', visibility: 'public', message: 'ok' };
	const { cf } = client(() => Response.json(scan));
	assert.deepEqual(await cf.send(create, { account_id: 'a', body: { url: 'https://example.com' } }), scan);
});

test('an operation with several formats and no JSON reads each response by its content type', async () => {
	const { getRaw } = (await import('../generated/cloudforce-one/threat-signals/feeds/index.js')) as unknown as {
		getRaw: Operation<Record<string, unknown>, unknown>;
	};
	assert.deepEqual(getRaw.response, ['bytes', 'text']);
	assert.equal(getRaw.accept, '*/*');
	const request = { account_id: 'a', feed_id: 1 };
	const text = client(() => new Response('1.2.3.4\n', { headers: { 'content-type': 'text/plain' } }));
	assert.equal(await text.cf.send(getRaw, request), '1.2.3.4\n');
	const xml = client(() => new Response('<feed/>', { headers: { 'content-type': 'application/xml' } }));
	assert.deepEqual(await xml.cf.send(getRaw, request), new TextEncoder().encode('<feed/>'));
	// With no content type, it's read as XML is, and not as JSON, which it never declares.
	const bare = client(() => new Response(new TextEncoder().encode('1.2.3.4\n')));
	assert.deepEqual(await bare.cf.send(getRaw, request), new TextEncoder().encode('1.2.3.4\n'));
});

test('a binary operation asks for any format, and JSON with a text alternative stays JSON', async () => {
	const accept = async (path: string, name: string): Promise<unknown> => {
		const group = (await import(`../generated/${path}/index.js`)) as Record<string, Operation>;
		return group[name]?.accept;
	};
	assert.equal(await accept('r2/objects', 'get'), '*/*');
	assert.equal(await accept('workers/legacy/scripts', 'get'), '*/*');
	assert.equal(await accept('security-insights/partners/shadow-hosts', 'list'), undefined);
	assert.equal(await accept('zones', 'list'), undefined);
});

test('an R2 key keeps its slashes, and a key that climbs out of its route never leaves', async () => {
	const objects = (await import('../generated/r2/objects/index.js')) as unknown as Record<string, Operation<Record<string, unknown>, unknown>>;
	for (const name of ['get', 'put', 'delete']) {
		assert.deepEqual(objects[name]?.slashes, ['object_key'], name);
	}
	const { cf, urls } = client(() => new Response(new Uint8Array([1])));
	const scope = { account_id: 'a', bucket_name: 'b' };
	await cf.send(objects['get']!, { ...scope, object_key: 'dir/my file.txt' });
	assert.equal(new URL(urls[0]!).pathname, '/client/v4/accounts/a/r2/buckets/b/objects/dir/my%20file.txt');
	await assert.rejects(cf.send(objects['delete']!, { ...scope, object_key: '../../../../workers/scripts/prod' }), TypeError);
	assert.equal(urls.length, 1);
});

test('a file path in an Artifacts repository keeps its slashes, and its ref does not', async () => {
	const { get } = (await import('../generated/artifacts/namespaces/repos/raw/index.js')) as unknown as { get: Operation };
	assert.deepEqual(get.slashes, ['path']);
});

test('intel.dns.list sends its date range as the parameters the API reads', async () => {
	const { list } = (await import('../generated/intel/dns/index.js')) as unknown as { list: Operation<Record<string, unknown>, unknown> };
	const { cf, urls } = client(() => Response.json({ success: true, errors: [], result: {} }));
	await cf.send(list, { account_id: 'a', start_end_params: { start: '2026-01-01', end: '2026-02-01' } });
	assert.equal(new URL(urls[0]!).search, '?start=2026-01-01&end=2026-02-01');
});

test('a watermark file goes up as a form, though the operation mainly takes JSON', async () => {
	const { create } = (await import('../generated/stream/watermarks/index.js')) as unknown as { create: Operation<Record<string, unknown>, unknown> };
	assert.equal(create.body, 'json');
	const bodies: unknown[] = [];
	const cf = createClient({
		token: 't',
		fetch: (async (_: string, init: RequestInit) => {
			bodies.push(init.body);
			return Response.json({ success: true, errors: [], result: {} });
		}) as typeof fetch,
	});
	const form = new FormData();
	form.append('file', new Blob(['png']), 'mark.png');
	await cf.send(create, { account_id: 'a', body: form });
	await cf.send(create, { account_id: 'a', body: { url: 'https://example.com/mark.png' } });
	assert.equal(bodies[0], form);
	assert.equal(bodies[1], '{"url":"https://example.com/mark.png"}');
});

test('ai.models.list in its other format is a result, and paginate says it is not a page', async () => {
	const { list } = (await import('../generated/ai/models/index.js')) as unknown as { list: PagedOperation<Record<string, unknown>, unknown, unknown> };
	// As the live API answers with format=openrouter, 2026-11-07.
	const bare = { data: [{ id: 'm1' }] };
	const { cf } = client(() => Response.json(bare));
	const request = { account_id: 'a', format: 'openrouter' };
	assert.deepEqual(await cf.send(list, request), bare);
	await assert.rejects(
		(async () => {
			for await (const _ of cf.paginate(list, request)) {
				// Nothing to read.
			}
		})(),
		{ name: 'TypeError', message: /isn't a page/ },
	);
	const wrapped = client(() => Response.json({ success: true, errors: [], result: [{ id: 'm2' }], result_info: { page: 1, total_pages: 1 } }));
	const items: unknown[] = [];
	for await (const item of wrapped.cf.paginate(list, { account_id: 'a' })) {
		items.push(item);
	}
	assert.deepEqual(items, [{ id: 'm2' }]);
});

test('a real operation paginates end to end, reproducing #2805 against its shape', async () => {
	const { list } = (await import('../generated/workers/deployments/index.js')) as unknown as {
		list: PagedOperation<Record<string, unknown>, unknown, { id: string }>;
	};
	const urls: string[] = [];
	const client = createClient({
		token: 't',
		fetch: (async (input: string) => {
			urls.push(input);
			const page = Number(new URL(input).searchParams.get('page') ?? 1);
			return new Response(
				JSON.stringify({
					success: true,
					errors: [],
					messages: [],
					result: { deployments: [{ id: `d${page}` }] },
					result_info: { page, per_page: 1, count: 1, total_count: 2, total_pages: 2 },
				}),
			);
		}) as typeof fetch,
	});
	const ids: string[] = [];
	for await (const deployment of client.paginate(list, { account_id: 'acc', script_name: 'w/x', per_page: 1 })) {
		ids.push(deployment.id);
	}
	assert.deepEqual(ids, ['d1', 'd2']);
	assert.equal(urls.length, 2);
	assert.equal(
		urls[0],
		'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/w%2Fx/deployments?per_page=1',
	);
});
