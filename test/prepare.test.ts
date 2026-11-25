import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	checkDryRuns,
	checkPaginationOverrides,
	checkRequestVariants,
	foldNativeKeys,
	giveAliasesExtensions,
	joinCommaLists,
	markLiteralSlashes,
	normalizeFlags,
	restateRequired,
	selectOperations,
} from '../generator/prepare.ts';
import { byKey, SPEC_PATCHES } from '../generator/patches.ts';
import { LITERAL_SLASHES, type OpenApiDocument, SCOPED_PERMISSIONS, type Schema } from '../generator/spec.ts';

function document(paths: Record<string, Record<string, Schema>>): OpenApiDocument {
	return { paths, components: { schemas: {} } };
}

/** An operation the spec names, as every one that reaches Forge must be. */
const op = (extra: Schema = {}): Schema => ({ 'x-fern-sdk-group-name': 'g', 'x-fern-sdk-method-name': 'm', ...extra });
const hidden = (extra: Schema = {}): Schema => op({ 'x-fern-ignore': true, ...extra });

/** Selects with none of the real lists, apart from those given. */
function select(
	doc: OpenApiDocument,
	exclusions: Parameters<typeof selectOperations>[1] = {},
	renames: Parameters<typeof selectOperations>[2] = {},
	unnamed: Parameters<typeof selectOperations>[3] = {},
): Record<string, number> {
	return selectOperations(doc, exclusions, renames, unnamed);
}

test('a hidden operation is included unless it is deprecated or excluded', () => {
	const doc = document({
		'/kept': { get: hidden() },
		'/old': { get: hidden({ 'x-fern-availability': 'deprecated' }), post: hidden({ deprecated: true }) },
		'/excluded': { get: hidden() },
		'/visible': { get: op() },
	});
	const skipped = select(doc, { 'GET /excluded': 'A reason.' }, {});
	assert.deepEqual(skipped, { deprecated: 2, excluded: 1 });
	assert.equal(doc.paths['/kept']?.['get']?.['x-fern-ignore'], undefined);
	assert.equal(doc.paths['/old']?.['get']?.['x-fern-ignore'], true);
	assert.equal(doc.paths['/excluded']?.['get']?.['x-fern-ignore'], true);
});

test('a hidden copy, on one account or one zone, of an operation that takes either is left out', () => {
	const doc = document({
		'/{account_or_zone}/{account_or_zone_id}/things/{thing_id}': { get: op() },
		// Parameter names differ between the copies.
		'/accounts/{account_id}/things/{id}': { get: hidden(), put: hidden() },
		'/zones/{zone_id}/things/{thing_id}': { get: hidden() },
		'/zones/{zone_id}/things/{thing_id}/more': { get: hidden() },
		'/users/{user_id}/things/{thing_id}': { get: hidden() },
	});
	assert.deepEqual(select(doc), { 'account or zone': 2 });
	assert.equal(doc.paths['/accounts/{account_id}/things/{id}']?.['get']?.['x-fern-ignore'], true);
	assert.equal(doc.paths['/zones/{zone_id}/things/{thing_id}']?.['get']?.['x-fern-ignore'], true);
	// No route takes either for these, so they're shown as any hidden operation is.
	assert.equal(doc.paths['/accounts/{account_id}/things/{id}']?.['put']?.['x-fern-ignore'], undefined);
	assert.equal(doc.paths['/zones/{zone_id}/things/{thing_id}/more']?.['get']?.['x-fern-ignore'], undefined);
	assert.equal(doc.paths['/users/{user_id}/things/{thing_id}']?.['get']?.['x-fern-ignore'], undefined);
	// The copy is left out for the operation that takes either, so that one has to be generated.
	const uncovered = document({
		'/{account_or_zone}/{account_or_zone_id}/things': { get: hidden({ deprecated: true }) },
		'/accounts/{account_id}/things': { get: hidden() },
	});
	assert.throws(() => select(uncovered), /so check whether each should be: GET \/accounts\/\{account_id\}\/things$/);
	// A route on another host is no copy, so it needs none.
	const hosted = document({
		'/{account_or_zone}/{account_or_zone_id}/things': { get: hidden({ deprecated: true }) },
		'/accounts/{account_id}/things': { get: hidden({ servers: [{ url: 'https://data.example.com' }] }) },
	});
	assert.deepEqual(select(hosted), { deprecated: 1, 'other server': 1 });
	// Nor is a route on the API's host a copy of one on another host, so it's shown as any hidden one is.
	const foreign = document({
		'/{account_or_zone}/{account_or_zone_id}/things': { get: op({ servers: [{ url: 'https://data.example.com' }] }) },
		'/accounts/{account_id}/things': { get: hidden() },
	});
	assert.deepEqual(select(foreign), { 'other server': 1 });
	assert.equal(foreign.paths['/accounts/{account_id}/things']?.['get']?.['x-fern-ignore'], undefined);
});

test("an operation that takes either lists its copies' token permissions, for an account and a zone apart where they differ", () => {
	const groups = (...names: string[]): Schema => ({ 'x-api-token-group': names });
	const doc = document({
		'/{account_or_zone}/{account_or_zone_id}/apart': { get: op() },
		'/accounts/{account_id}/apart': { get: hidden(groups('Account Things Read', 'Things Admin')) },
		'/zones/{zone_id}/apart': { get: hidden(groups('Things Read', 'Things Admin', 'Things Read')) },
		// As entitlements, whose own list is its account copy's.
		'/{account_or_zone}/{account_or_zone_id}/own': { get: op(groups('Account Read')) },
		'/accounts/{account_id}/own': { get: hidden(groups('Account Read')) },
		'/zones/{zone_id}/own': { get: hidden(groups('Zone Read')) },
		'/{account_or_zone}/{account_or_zone_id}/same': { get: op() },
		'/accounts/{account_id}/same': { get: hidden(groups('Logs Write')) },
		'/zones/{zone_id}/same': { get: hidden(groups('Logs Write')) },
		'/{account_or_zone}/{account_or_zone_id}/usage': { get: op(groups('Stream Read')) },
		'/accounts/{account_id}/usage': { get: hidden() },
		// A deprecated copy's route is still reached through the operation that takes either.
		'/{account_or_zone}/{account_or_zone_id}/deprecated': { get: op() },
		'/accounts/{account_id}/deprecated': { get: hidden(groups('Account Read')) },
		'/zones/{zone_id}/deprecated': { get: hidden({ ...groups('Zone Read'), deprecated: true }) },
		// A route on another host isn't a copy's, though its path is.
		'/{account_or_zone}/{account_or_zone_id}/hosted': { get: op() },
		'/accounts/{account_id}/hosted': { get: hidden(groups('Account Read')) },
		'/zones/{zone_id}/hosted': { get: hidden({ ...groups('Data Plane Write'), servers: [{ url: 'https://data.example.com' }] }) },
	});
	assert.deepEqual(select(doc), { 'account or zone': 9, deprecated: 1, 'other server': 1 });
	const listed = (route: string): Schema => {
		const operation = doc.paths[`/{account_or_zone}/{account_or_zone_id}/${route}`]?.['get'];
		return { own: operation?.['x-api-token-group'], scoped: operation?.[SCOPED_PERMISSIONS] };
	};
	assert.deepEqual(listed('apart'), { own: undefined, scoped: { account: ['Account Things Read', 'Things Admin'], zone: ['Things Read', 'Things Admin'] } });
	assert.deepEqual(listed('own'), { own: undefined, scoped: { account: ['Account Read'], zone: ['Zone Read'] } });
	// The same for both are listed once.
	assert.deepEqual(listed('same'), { own: ['Logs Write'], scoped: undefined });
	// Its own stay where no copy lists any.
	assert.deepEqual(listed('usage'), { own: ['Stream Read'], scoped: undefined });
	assert.deepEqual(listed('deprecated'), { own: undefined, scoped: { account: ['Account Read'], zone: ['Zone Read'] } });
	assert.deepEqual(listed('hosted'), { own: undefined, scoped: { account: ['Account Read'] } });
	// And stop generation where they name what no copy does, as it isn't clear which scope that's for.
	const unlisted = document({
		'/{account_or_zone}/{account_or_zone_id}/both': { get: op(groups('Account Read', 'Both Read')) },
		'/accounts/{account_id}/both': { get: hidden(groups('Account Read')) },
	});
	assert.throws(() => select(unlisted), /check which scope each is for: GET \/\{account_or_zone\}\/\{account_or_zone_id\}\/both \(Both Read\)$/);
	// Only for one that's generated.
	const gone = document({
		'/{account_or_zone}/{account_or_zone_id}/gone': { get: hidden({ ...groups('Only Here'), deprecated: true }) },
		'/accounts/{account_id}/gone': { get: hidden({ ...groups('Account Read'), deprecated: true }) },
	});
	assert.deepEqual(select(gone), { deprecated: 2 });
});

test("Forge's own keys move onto the Fern keys, and stop generation where the two say different things", () => {
	const doc = document({
		'/both': {
			get: {
				'x-fern-sdk-group-name': 'g',
				'x-forge-group-name': 'g',
				'x-fern-sdk-method-name': 'm',
				'x-forge-method-name': 'm',
				'x-fern-ignore': true,
				'x-forge-skip': true,
			},
		},
		// A group written as a path on one key and as its parts on the other, and no group either way.
		'/forms': {
			get: { 'x-fern-sdk-group-name': ['g', 'h'], 'x-forge-group-name': 'g.h' },
			post: { 'x-fern-sdk-group-name': [], 'x-forge-group-name': '' },
		},
		'/native': {
			get: { 'x-forge-group-name': ['g', 'h'], 'x-forge-method-name': 'm', 'x-forge-availability': 'beta', 'x-forge-skip': false },
			post: { 'x-forge-skip': true, 'x-forge-hidden': true },
		},
	});
	foldNativeKeys(doc);
	assert.deepEqual(doc.paths['/both']?.['get'], { 'x-fern-sdk-group-name': 'g', 'x-fern-sdk-method-name': 'm', 'x-fern-ignore': true });
	assert.deepEqual(doc.paths['/native']?.['get'], { 'x-fern-sdk-group-name': ['g', 'h'], 'x-fern-sdk-method-name': 'm', 'x-fern-availability': 'beta' });
	assert.deepEqual(doc.paths['/forms']?.['get'], { 'x-fern-sdk-group-name': 'g.h' });
	assert.deepEqual(doc.paths['/forms']?.['post'], { 'x-fern-sdk-group-name': '' });
	// Keys with no Fern counterpart stay.
	assert.deepEqual(doc.paths['/native']?.['post'], { 'x-fern-ignore': true, 'x-forge-hidden': true });
	const clash = document({
		'/a': { get: { 'x-fern-sdk-method-name': 'm', 'x-forge-method-name': 'n' }, post: { 'x-fern-ignore': true, 'x-forge-skip': false } },
		// Forge makes `a-b/c` of the first, and `a/b/c` of the second.
		'/c': { get: { 'x-fern-sdk-group-name': ['a.b', 'c'], 'x-forge-group-name': 'a.b.c' } },
	});
	assert.throws(() => foldNativeKeys(clash), /GET \/a x-forge-method-name, POST \/a x-forge-skip, GET \/c x-forge-group-name$/);
});

test('an operation for another audience is removed, and one for the SDK is kept', () => {
	const doc = document({
		'/terraform': { get: hidden({ 'x-fern-audiences': ['terraform'] }), head: { 'x-fern-audiences': ['terraform'] } },
		'/sdk': { get: op({ 'x-fern-audiences': ['sdk'] }) },
	});
	assert.deepEqual(select(doc, {}, {}), { 'other audience': 2 });
	assert.equal(doc.paths['/terraform']?.['get'], undefined);
	assert.equal(doc.paths['/terraform']?.['head'], undefined);
	assert.ok(doc.paths['/sdk']?.['get']);
});

test('an operation that does not describe its response is left out, apart from a DELETE or a HEAD', () => {
	const bare = op({ responses: { '200': { description: 'A list.' }, '4XX': { description: 'An error.' } } });
	const doc = document({
		'/bare': { get: bare, post: { responses: { '2XX': { description: 'Done.' } } }, delete: bare, head: bare },
		'/empty': { post: op({ responses: { '204': { description: 'Done.' } } }) },
		'/described': { get: op({ responses: { '200': { content: { 'application/json': { schema: {} } } } } }) },
		'/referenced': { get: op({ responses: { '200': { $ref: '#/components/responses/ok' } } }) },
		'/undeclared': { get: op() },
		'/hidden': { get: hidden(bare) },
	});
	doc.components['responses'] = { ok: { content: { 'text/plain': {} } } };
	assert.deepEqual(select(doc, {}, {}), { 'no response schema': 3 });
	assert.deepEqual(Object.keys(doc.paths['/bare'] ?? {}), ['delete', 'head']);
	assert.deepEqual(Object.keys(doc.paths['/hidden'] ?? {}), []);
	for (const route of ['/empty', '/described', '/referenced', '/undeclared']) {
		assert.equal(Object.keys(doc.paths[route] ?? {}).length, 1, route);
	}
});

test('an operation served from another host is left out, wherever its servers are declared', () => {
	const doc = document({
		'/produce': { servers: [{ url: 'https://{stream_id}.k2.example' }], post: {} },
		'/elsewhere': { get: { servers: [{ url: 'https://other.example' }] } },
		'/base': { get: op({ servers: [{ url: 'https://api.example/v4' }] }) },
		'/plain': { get: op() },
	});
	doc['servers'] = [{ url: 'https://api.example/v4' }];
	assert.deepEqual(select(doc, {}, {}), { 'other server': 2 });
	assert.equal(doc.paths['/produce']?.['post'], undefined);
	assert.equal(doc.paths['/elsewhere']?.['get'], undefined);
	assert.ok(doc.paths['/base']?.['get']);
	assert.ok(doc.paths['/plain']?.['get']);
});

test('an operation without a group or method name is left out when listed, and otherwise stops generation', () => {
	const reason = 'A reason.';
	const unnamed = (): OpenApiDocument =>
		document({
			'/named': { get: op() },
			'/unnamed': { get: { operationId: 'nel-settings-get' }, patch: { 'x-fern-sdk-group-name': 'zones' } },
			// An empty group is none, as `''` is.
			'/empty': { get: { 'x-fern-sdk-group-name': [], 'x-fern-sdk-method-name': 'm' } },
			// Forge skips it, so it needs no name.
			'/old': { get: { 'x-fern-ignore': true, deprecated: true } },
		});
	const both = { 'GET /unnamed': reason, 'PATCH /unnamed': reason, 'GET /empty': reason };
	const doc = unnamed();
	assert.deepEqual(select(doc, {}, {}, both), { 'no name': 3, deprecated: 1 });
	assert.deepEqual(Object.keys(doc.paths['/empty'] ?? {}), []);
	assert.deepEqual(Object.keys(doc.paths['/named'] ?? {}), ['get']);
	assert.deepEqual(Object.keys(doc.paths['/unnamed'] ?? {}), []);
	assert.deepEqual(Object.keys(doc.paths['/old'] ?? {}), ['get']);
	assert.throws(() => select(unnamed(), {}, {}, { 'GET /unnamed': reason, 'GET /empty': reason }), /UNNAMED_OPERATIONS with a reason: PATCH \/unnamed$/);
	assert.throws(
		() => select(unnamed(), {}, {}, { ...both, 'GET /named': reason }),
		/no longer left out for having no name.*GET \/named/,
	);
	// Still without a name, but left out first for describing no response.
	const undescribed = document({ '/nel': { get: { operationId: 'nel-settings-get', responses: { '200': { description: 'OK' } } } } });
	assert.throws(
		() => select(undescribed, {}, {}, { 'GET /nel': reason }),
		/or another rule leaves them out first\. Check them and remove them: GET \/nel$/,
	);
});

test('the Domain Connect patch stops applying once its routes move or declare their servers', () => {
	const patch = SPEC_PATCHES.find(({ id }) => id === 'dns-domainconnect-routes')!;
	const paths = (extra: Schema = {}): Schema => ({
		'/v2/{domain}/settings': { get: op(), ...extra },
		'/v2/provconf/{provider}/{service}/{account}': { get: op() },
		'/v2/domainTemplates/providers/{provider}/services/{service}': { get: op() },
		'/v1/verify': { post: op() },
	});
	const doc = { paths: {}, components: { schemas: {} } } as OpenApiDocument;
	assert.equal(patch.applies(paths(), doc), true);
	const servers = [{ url: 'https://api.cloudflare.com/client/v4/dns/domainconnect' }];
	assert.equal(patch.applies(paths({ servers }), doc), false);
	assert.equal(patch.applies(paths({ get: { ...op(), servers } }), doc), false);
	assert.equal(patch.applies({ ...paths(), '/dns/domainconnect/v2/verify': { post: op() } }, doc), false);
});

test('the tags patches read the query parameters an operation takes, however the spec declares them', () => {
	const patch = (id: string) => SPEC_PATCHES.find((found) => found.id === `resource-tagging-${id}`)!;
	const application = { name: 'access_application_id', in: 'query', schema: { type: 'string' } };
	const worker = { name: 'worker_id', in: 'query', schema: { type: 'string' } };
	const typed = { name: 'resource_type', in: 'query', schema: { $ref: '#/components/schemas/resource-tagging_account_resource_type' } };
	const parameters = { application, chained: { $ref: '#/components/parameters/application' }, worker, typed };
	const doc = { paths: {}, components: { schemas: {}, parameters } } as unknown as OpenApiDocument;
	const ref = (name: string): Schema => ({ $ref: `#/components/parameters/${name}` });
	const item = (own: Schema[], shared?: Schema[]): Schema => ({
		get: { parameters: own },
		delete: { parameters: structuredClone(own) },
		...(shared === undefined ? {} : { parameters: shared }),
	});
	// The spec declares access_application_id: inline, at the end of a chain of $refs, or on the path item.
	const adding = patch('get-access-application-id');
	assert.equal(adding.applies(item([{ name: 'resource_id', in: 'query' }, worker]), doc), true);
	assert.equal(adding.applies(item([application, worker]), doc), false);
	assert.equal(adding.applies(item([ref('chained'), worker]), doc), false);
	assert.equal(adding.applies(item([worker], [ref('application')]), doc), false);
	// A header of that name isn't the query parameter.
	assert.equal(adding.applies(item([{ ...application, in: 'header' }, worker]), doc), true);
	// Without the operation, the path item's worker_id doesn't make the patch apply, so it's reported as stale.
	const withoutGet = item([], [worker]);
	delete withoutGet['get'];
	assert.equal(adding.applies(withoutGet, doc), false);
	assert.equal(patch('get-zone-types').applies(withoutGet, doc), false);
	// It's missing whether or not worker_id is there, and goes last without it.
	const alone = item([{ name: 'resource_id', in: 'query' }]);
	assert.equal(adding.applies(alone, doc), true);
	adding.apply(alone, doc);
	assert.deepEqual(
		(alone['get']['parameters'] as Schema[]).map((param) => param['name']),
		['resource_id', 'access_application_id'],
	);
	// It goes after worker_id, even one given by its $ref.
	const added = item([ref('worker'), { name: 'resource_id', in: 'query' }]);
	adding.apply(added, doc);
	assert.deepEqual(
		(added['get']['parameters'] as Schema[]).map((param) => param['name'] ?? param['$ref']),
		['#/components/parameters/worker', 'access_application_id', 'resource_id'],
	);
	// A resource_type the two operations share, by its $ref or on the path item, is patched as a copy for each.
	for (const shared of [item([ref('typed')]), item([], [ref('typed')])]) {
		for (const verb of ['delete', 'get']) {
			const zoneTypes = patch(`${verb}-zone-types`);
			assert.equal(zoneTypes.applies(shared, doc), true, verb);
			zoneTypes.apply(shared, doc);
			assert.equal(zoneTypes.applies(shared, doc), false, verb);
		}
		assert.deepEqual(typed.schema, { $ref: '#/components/schemas/resource-tagging_account_resource_type' });
	}
});

test('a property is nullable when one allOf branch allows null and the intersection would not', () => {
	const doc = document({});
	doc.components.schemas = {
		deployment: { type: 'object', properties: { id: { type: 'string' } } },
		maybe: { type: 'string', nullable: true },
		project: {
			type: 'object',
			properties: {
				latest: { allOf: [{ $ref: '#/components/schemas/deployment' }, { nullable: true, readOnly: true }] },
				// The referenced type already allows null.
				score: { allOf: [{ $ref: '#/components/schemas/maybe' }, { description: 'A score.' }] },
				plain: { allOf: [{ $ref: '#/components/schemas/deployment' }] },
			},
		},
	};
	assert.equal(normalizeFlags(doc).nullable, 1);
	const properties = doc.components.schemas['project']?.['properties'];
	assert.equal(properties.latest.nullable, true);
	assert.equal(properties.score.nullable, undefined);
	assert.equal(properties.plain.nullable, undefined);
});

test('an allOf that loses null is nullable wherever it is, not only as a property', () => {
	const row = { $ref: '#/components/schemas/row' };
	const doc = document({});
	doc.components.schemas = {
		row: { type: 'object', properties: { id: { type: 'string' } } },
		// As Zaraz's configuration history declares its values.
		history: { type: 'object', additionalProperties: { allOf: [row, { nullable: true, type: 'object' }] } },
		list: { type: 'array', items: { allOf: [row, { nullable: true }] } },
	};
	assert.equal(normalizeFlags(doc).nullable, 2);
	const schemas = doc.components.schemas;
	assert.equal(schemas['history']?.['additionalProperties'].nullable, true);
	assert.equal(schemas['list']?.['items'].nullable, true);
});

test('a reference to a readOnly schema is marked readOnly, and keeps its documentation', () => {
	const doc = document({});
	doc.components.schemas = {
		// As DNSSEC's `ds`.
		ds: { type: 'string', description: 'Full DS record.', deprecated: true, readOnly: true },
		plain: { type: 'string', readOnly: true },
		dnssec: { type: 'object', properties: { ds: { $ref: '#/components/schemas/ds' }, plain: { $ref: '#/components/schemas/plain' } } },
	};
	assert.equal(normalizeFlags(doc).readOnly, 2);
	const properties = doc.components.schemas['dnssec']?.['properties'];
	assert.deepEqual(properties.ds, {
		allOf: [{ $ref: '#/components/schemas/ds' }],
		readOnly: true,
		description: 'Full DS record.',
		deprecated: true,
	});
	assert.deepEqual(properties.plain, { allOf: [{ $ref: '#/components/schemas/plain' }], readOnly: true });
});

test('a writeOnly field stops being required, by its schema, by the branches of it and by a schema built on it', () => {
	const doc = document({});
	doc.components.schemas = {
		// As Realtime's storage configuration, whose branches require fields it marks writeOnly.
		storage: {
			type: 'object',
			properties: {
				type: { type: 'string' },
				secret: { type: 'string', writeOnly: true },
				password: { type: 'string', writeOnly: true },
				nested: { type: 'object', properties: { id: { type: 'string' } }, required: ['id', 'secret'] },
			},
			required: ['type', 'password'],
			oneOf: [
				{ properties: { secret: { minLength: 1 }, type: { enum: ['aws'] } }, required: ['secret', 'type'] },
				{ oneOf: [{ required: ['password'] }] },
			],
		},
		// As Hyperdrive's full connection options, which require what the schema they're built on marks writeOnly.
		options: { type: 'object', properties: { user: { type: 'string' }, password: { type: 'string', writeOnly: true } } },
		full: { allOf: [{ $ref: '#/components/schemas/options' }], required: ['user', 'password'] },
	};
	assert.equal(normalizeFlags(doc).writeOnly, 4);
	assert.deepEqual(doc.components.schemas['full']?.['required'], ['user']);
	const storage = doc.components.schemas['storage'];
	assert.deepEqual(storage?.['required'], ['type']);
	assert.deepEqual(storage?.['oneOf'][0].required, ['type']);
	assert.deepEqual(storage?.['oneOf'][1].oneOf[0].required, []);
	// A property's own schema is another object, so its `secret` is its own.
	assert.deepEqual(storage?.['properties'].nested.required, ['id', 'secret']);
});

test('a named schema that would turn nullable as a whole stops generation', () => {
	const doc = document({});
	doc.components.schemas = {
		row: { type: 'object', properties: { id: { type: 'string' } } },
		whole: { allOf: [{ $ref: '#/components/schemas/row' }, { nullable: true, properties: { extra: { type: 'string' } } }] },
	};
	assert.throws(() => normalizeFlags(doc), /nullable as a whole, and so would every use of them: whole\./);
	assert.equal(doc.components.schemas['whole']?.['nullable'], undefined);
});

test('a pagination override that has gone stale stops generation', () => {
	const listing: Schema = { responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } } };
	const doc = document({
		'/events': { get: listing },
		'/stated': { get: { ...listing, 'x-fern-pagination': { cursor: '$request.cursor' } } },
		'/hidden': { get: hidden(listing) },
	});
	// Whether the result still holds the array is the plugin's to check, as in plugin.test.ts.
	const override = { kind: 'page', items: 'events' } as const;
	checkPaginationOverrides(doc, { 'GET /events': override });
	const stale = [
		['GET /gone', /GET \/gone isn't generated/],
		['GET /hidden', /isn't generated/],
		['GET /stated', /states its own pagination/],
	] as const;
	for (const [key, message] of stale) {
		assert.throws(() => checkPaginationOverrides(doc, { [key]: override }), message, key);
	}
});

test('a required that Forge does not read is restated where it does', () => {
	const doc = document({});
	doc.components.schemas = {
		base: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string' } } },
		either: { anyOf: [{ type: 'object', properties: { kind: { type: 'string' } } }] },
		url: { type: 'object', properties: { target: { type: 'string' } } },
		text: { type: 'string' },
		target: { oneOf: [{ $ref: '#/components/schemas/url' }, { $ref: '#/components/schemas/text' }], required: ['target'] },
		full: { allOf: [{ $ref: '#/components/schemas/base' }], required: ['name'] },
	};
	// Forge reads a `required` beside an `allOf` for what its branches declare.
	const create = { allOf: [{ $ref: '#/components/schemas/base' }], required: ['name', 'kind'] };
	// Not for what only an `anyOf` in a branch declares, nor for a name every object has.
	const record = {
		allOf: [{ $ref: '#/components/schemas/either' }, { type: 'object', properties: { id: { type: 'string' } } }],
		required: ['id', 'kind', 'constructor'],
	};
	// A base that declares what it requires through its own `allOf` is read as it is.
	const built = { allOf: [{ $ref: '#/components/schemas/full' }, { $ref: '#/components/schemas/url' }] };
	doc.components['requestBodies'] = {
		create: { content: { 'application/json': { schema: create } } },
		record: { content: { 'application/json': { schema: record } } },
		built: { content: { 'application/json': { schema: built } } },
	};
	// `record`'s two names and `target`'s one: Forge reads what `create` and `built` require, as test/types.ts checks.
	assert.equal(restateRequired(doc), 3);
	assert.deepEqual(record.allOf.at(-1), { type: 'object', properties: { kind: {}, constructor: {} }, required: ['kind', 'constructor'] });
	const [url, text] = doc.components.schemas['target']?.['oneOf'] as Schema[];
	assert.deepEqual(url, {
		allOf: [{ $ref: '#/components/schemas/url' }, { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }],
	});
	// `required` means nothing to a string.
	assert.deepEqual(text, { $ref: '#/components/schemas/text' });
});

test('what a branch of a oneOf or anyOf requires of the schema it is in is restated there, once', () => {
	const string = { type: 'string' };
	const doc = document({});
	doc.components.schemas = {
		byName: { type: 'object', required: ['name'] },
		base: { type: 'object', properties: { owner: string } },
		build: {
			type: 'object',
			properties: { branch: string, name: string, secret: { type: 'string', writeOnly: true } },
			anyOf: [
				{ required: ['branch'] },
				{ $ref: '#/components/schemas/byName' },
				{ type: 'object', properties: { branch: string }, required: ['branch', 'other'] },
				{ required: ['secret'] },
				string,
			],
		},
		owned: { allOf: [{ $ref: '#/components/schemas/base' }], oneOf: [{ required: ['owner'] }] },
		mail: {
			properties: { to: string, secret: { type: 'string', writeOnly: true } },
			allOf: [{ anyOf: [{ required: ['to'] }, { required: ['secret'] }, { required: ['other'] }] }],
		},
		app: { allOf: [{ anyOf: [{ required: ['priority'] }] }, { properties: { priority: string } }] },
		storage: { properties: { host: string }, oneOf: [{ oneOf: [{ required: ['host'] }] }] },
		// An `allOf` that isn't a list is a property's name, or in an example.
		named: { properties: { allOf: string }, example: { allOf: { required: ['to'] } } },
		// A property's schema isn't part of the schema that has it.
		holder: { properties: { to: string, inner: { anyOf: [{ required: ['to'] }] } } },
	};
	assert.equal(restateRequired(doc), 6);
	const restated = (name: string, branch: Schema): Schema => ({
		allOf: [branch, { type: 'object', properties: { [name]: string }, required: [name] }],
	});
	assert.deepEqual(doc.components.schemas['build']?.['anyOf'], [
		restated('branch', { required: ['branch'] }),
		restated('name', { $ref: '#/components/schemas/byName' }),
		// Its own property is read already, and nothing declares `other`.
		{ type: 'object', properties: { branch: string }, required: ['branch', 'other'] },
		// A response doesn't promise a field only writes have.
		{ required: ['secret'] },
		string,
	]);
	// What an `allOf` beside it declares counts too.
	assert.deepEqual(doc.components.schemas['owned']?.['oneOf'], [restated('owner', { required: ['owner'] })]);
	// So does what a schema further out declares, with the same exceptions.
	assert.deepEqual(doc.components.schemas['mail']?.['allOf'], [
		{ anyOf: [restated('to', { required: ['to'] }), { required: ['secret'] }, { required: ['other'] }] },
	]);
	assert.deepEqual(doc.components.schemas['app']?.['allOf'], [
		{ anyOf: [restated('priority', { required: ['priority'] })] },
		{ properties: { priority: string } },
	]);
	assert.deepEqual(doc.components.schemas['storage']?.['oneOf'], [{ oneOf: [restated('host', { required: ['host'] })] }]);
	assert.deepEqual(doc.components.schemas['named'], { properties: { allOf: string }, example: { allOf: { required: ['to'] } } });
	assert.deepEqual(doc.components.schemas['holder']?.['properties'], { to: string, inner: { anyOf: [{ required: ['to'] }] } });
});

test('a property that would be restated inside itself stops generation, and one with a named schema does not', () => {
	const node = { $ref: '#/components/schemas/node' };
	const tree = (items: Schema): OpenApiDocument => {
		const doc = document({});
		doc.components.schemas['node'] = { type: 'object', properties: { children: { type: 'array', items } } };
		return doc;
	};
	// Each place a name is restated in.
	for (const items of [
		{ allOf: [node, { anyOf: [{ required: ['children'] }] }] },
		{ allOf: [node], anyOf: [{ required: ['children'] }] },
		{ allOf: [node, { required: ['children'] }] },
		{ oneOf: [node], required: ['children'] },
	]) {
		assert.throws(() => restateRequired(tree(items)), /would hold themselves, .*: children in node$/);
	}
	// The schema that declares it is named, and not one before it that the property is restated in.
	const wrapped = tree({ allOf: [node, { required: ['children'] }] });
	wrapped.components.schemas = { wrapper: { allOf: [node, { required: ['children'] }] }, ...wrapped.components.schemas };
	assert.throws(() => restateRequired(wrapped), /themselves, .*: children in node$/);
	// The next item of a list is that schema itself.
	const list = document({});
	list.components.schemas['node'] = { type: 'object', properties: { next: { allOf: [node, { required: ['next'] }] } } };
	assert.throws(() => restateRequired(list), /: next in node$/);
	// As a patch would leave it.
	const children = { $ref: '#/components/schemas/children' };
	const named = document({});
	named.components.schemas = {
		node: { type: 'object', properties: { children } },
		children: { type: 'array', items: { allOf: [node, { required: ['children'] }] } },
	};
	assert.equal(restateRequired(named), 1);
	assert.deepEqual(named.components.schemas['children']?.['items'].allOf.at(-1), {
		type: 'object',
		properties: { children },
		required: ['children'],
	});
});

test('data that looks like a schema is left as it is, and a name that looks like data is not data', () => {
	const string = { type: 'string' };
	const data = [
		{ oneOf: [{ required: true }], allOf: [{ required: true }, 'x', { nullable: true }], properties: 3 },
		{ type: 'object', properties: { secret: { writeOnly: true } }, required: ['secret'], anyOf: [{ required: ['secret'] }] },
	];
	const build = (): Schema => ({ properties: { branch: string }, anyOf: [{ required: ['branch'] }] });
	const make = (): OpenApiDocument => {
		const doc = document({
			'/a': {
				get: {
					'x-data': data,
					responses: {
						200: {
							content: { 'application/json': { example: data[0], examples: { one: { value: data } } } },
							links: { next: { requestBody: data[0], parameters: { id: data[1] } } },
						},
						default: { content: { 'application/json': { schema: build() } } },
						'x-data': data[0]!,
					},
				},
			},
			'x-data': { oneOf: [{ required: true }] },
		});
		doc.components.schemas = {
			held: { example: data[0], default: data[1], enum: data, 'x-data': data },
			named: { properties: { default: build(), links: build(), 'x-data': build() } },
			default: build(),
		};
		return doc;
	};
	const doc = make();
	assert.deepEqual(normalizeFlags(doc), { readOnly: 0, writeOnly: 0, nullable: 0 });
	// The response, the schema and the three properties.
	assert.equal(restateRequired(doc), 5);
	const restated: Schema = {
		properties: { branch: string },
		anyOf: [{ allOf: [{ required: ['branch'] }, { type: 'object', properties: { branch: string }, required: ['branch'] }] }],
	};
	const expected = make();
	expected.paths['/a']!['get']!['responses'].default.content['application/json'].schema = restated;
	expected.components.schemas['named'] = { properties: { default: restated, links: restated, 'x-data': restated } };
	expected.components.schemas['default'] = restated;
	assert.deepEqual(doc, expected);
});

test('a schema keyword that could hold schemas, and is not known to, stops generation', () => {
	const doc = document({});
	doc.components.schemas = { a: { properties: { prefixItems: { type: 'array', prefixItems: [{ type: 'string' }] } } }, b: { type: 'object' } };
	assert.throws(() => restateRequired(doc), /could hold schemas, .*: prefixItems$/);
	assert.throws(() => normalizeFlags(doc), /could hold schemas, .*: prefixItems$/);
});

test('the profile patch takes both IDs or neither, as a schema too', () => {
	const patch = SPEC_PATCHES.find(({ id }) => id === 'workers-profile-actor-with-namespace')!;
	const string = { type: 'string' };
	const body: Schema = { type: 'object', properties: { duration_ms: string, actor_id: string, namespace_id: string }, required: ['duration_ms'] };
	const doc = document({});
	assert.equal(patch.applies(body, doc), true);
	patch.apply(body, doc);
	const requires = (schema: Schema, names: string[]): boolean => (schema['required'] as string[]).every((name) => names.includes(name));
	const matches = (member: Schema, names: string[]): boolean =>
		requires(member, names) && !((member['not']?.['anyOf'] ?? []) as Schema[]).some((branch) => requires(branch, names));
	const matched = (...ids: string[]): number => (body['oneOf'] as Schema[]).filter((member) => matches(member, ['duration_ms', ...ids])).length;
	assert.equal(matched(), 1);
	assert.equal(matched('actor_id', 'namespace_id'), 1);
	assert.equal(matched('actor_id'), 0);
	assert.equal(matched('namespace_id'), 0);
	assert.equal(patch.applies(body, doc), false);
});

test('an alias gets the extensions of its operation that the plugin reads, and keeps its own', () => {
	const alias = (extra: Schema = {}): Schema => ({ 'x-fern-sdk-group-name': 'a', 'x-fern-sdk-method-name': 'm', ...extra });
	const doc = document({
		'/aliased': {
			get: op({
				'x-api-token-group': ['Read'],
				'x-fern-availability': 'beta',
				[LITERAL_SLASHES]: ['key'],
				'x-forge-aliases': [alias(), alias({ 'x-api-token-group': ['Own'], 'x-fern-availability': 'generally-available' })],
			}),
			post: op({ 'x-forge-aliases': [alias()] }),
		},
		'/plain': { get: op({ 'x-api-token-group': ['Read'] }) },
	});
	assert.equal(giveAliasesExtensions(doc), 2);
	assert.deepEqual(doc.paths['/aliased']?.['get']?.['x-forge-aliases'], [
		alias({ 'x-api-token-group': ['Read'], 'x-fern-availability': 'beta', [LITERAL_SLASHES]: ['key'] }),
		alias({ 'x-api-token-group': ['Own'], 'x-fern-availability': 'generally-available', [LITERAL_SLASHES]: ['key'] }),
	]);
	assert.deepEqual(doc.paths['/aliased']?.['post']?.['x-forge-aliases'], [alias()]);
});

test('a path parameter that allows reserved characters is passed on, wherever it is declared', () => {
	const literal = (name: string): Schema => ({ name, in: 'path', allowReserved: true });
	const doc = document({
		'/inline/{key}': { get: { parameters: [literal('key'), { name: 'other', in: 'path' }] } },
		'/shared/{key}': { parameters: [literal('key')], get: {}, put: {} },
		'/referenced/{key}': { get: { parameters: [{ $ref: '#/components/parameters/key' }] } },
		'/query': { get: { parameters: [{ name: 'q', in: 'query', allowReserved: true }] } },
		'/plain/{key}': { get: { parameters: [{ name: 'key', in: 'path' }] } },
	});
	doc.components['parameters'] = { key: literal('key') };
	markLiteralSlashes(doc);
	assert.deepEqual(doc.paths['/inline/{key}']?.['get']?.[LITERAL_SLASHES], ['key']);
	assert.deepEqual(doc.paths['/shared/{key}']?.['get']?.[LITERAL_SLASHES], ['key']);
	assert.deepEqual(doc.paths['/shared/{key}']?.['put']?.[LITERAL_SLASHES], ['key']);
	assert.deepEqual(doc.paths['/referenced/{key}']?.['get']?.[LITERAL_SLASHES], ['key']);
	assert.equal(doc.paths['/query']?.['get']?.[LITERAL_SLASHES], undefined);
	assert.equal(doc.paths['/plain/{key}']?.['get']?.[LITERAL_SLASHES], undefined);
});

test('a rename applies to any operation, hidden or not, and can move it to another group', () => {
	const named = (group: string, method: string, extra: Schema = {}): Schema => ({
		'x-fern-sdk-group-name': group,
		'x-fern-sdk-method-name': method,
		...extra,
	});
	const doc = document({
		'/a': { post: hidden(named('x.y', 'create')) },
		'/b': { post: named('x.account-y', 'old') },
		'/c': { get: { 'x-fern-sdk-group-name': ['x', 'z'], 'x-fern-sdk-method-name': 'get' } },
	});
	const reason = 'A reason.';
	select(doc, {}, {
		'POST /a': { from: 'x.y.create', to: 'x.move-one', reason },
		'POST /b': { from: 'x.account-y.old', to: 'x.y.renamed', reason },
		'GET /c': { from: 'x.z.get', to: 'x.z.read', reason },
	});
	const name = (path: string, verb: string): string =>
		`${String(doc.paths[path]?.[verb]?.['x-fern-sdk-group-name'])}.${String(doc.paths[path]?.[verb]?.['x-fern-sdk-method-name'])}`;
	assert.equal(name('/a', 'post'), 'x.move-one');
	assert.equal(name('/b', 'post'), 'x.y.renamed');
	assert.equal(name('/c', 'get'), 'x.z.read');
});

test('an entry that no longer matches stops generation', () => {
	const reason = 'A reason.';
	const gone = document({});
	assert.throws(() => select(gone, { 'GET /gone': reason }, {}), /GET \/gone/);
	assert.throws(() => select(gone, {}, { 'GET /gone': { from: 'x.get', to: 'y.get', reason } }), /renames no longer match.*GET \/gone/);
	const nowDeprecated = document({ '/old': { get: hidden({ deprecated: true }) } });
	assert.throws(() => select(nowDeprecated, { 'GET /old': reason }, {}), /no longer left out as hidden.*GET \/old/);
	// The spec fixed the name, or named it something else again.
	const fixed = document({ '/jobs': { get: { 'x-fern-sdk-group-name': 'logpush.jobs', 'x-fern-sdk-method-name': 'list' } } });
	assert.throws(
		() => select(fixed, {}, { 'GET /jobs': { from: 'logpush.account-jobs.list', to: 'logpush.jobs.list', reason } }),
		/The spec now names GET \/jobs logpush\.jobs\.list, not logpush\.account-jobs\.list/,
	);
});

test('a rename whose operation is not generated, or that is not group.method, stops generation', () => {
	const reason = 'A reason.';
	const named = { 'x-fern-sdk-group-name': 'x.account-y', 'x-fern-sdk-method-name': 'list' };
	// Renamed, then left out for describing no response, it would never go stale.
	const undescribed = document({ '/y': { get: { ...named, responses: { '200': { description: 'OK' } } } } });
	assert.throws(
		() => select(undescribed, {}, { 'GET /y': { from: 'x.account-y.list', to: 'x.y.list', reason } }),
		/renames no longer match a generated operation.*GET \/y/,
	);
	for (const [from, to] of [
		['x.account-y.list', 'list'],
		['list', 'x.y.list'],
		['x.account-y.list', 'x..list'],
		['x.account-y.list', 'x.y.'],
	] as const) {
		const doc = document({ '/y': { get: { ...named } } });
		assert.throws(() => select(doc, {}, { 'GET /y': { from, to, reason } }), /as group\.method: GET \/y/);
	}
});

test('a string described as a comma-separated list becomes a list, joined with commas', () => {
	const ids = { name: 'ids', in: 'query', required: true, schema: { $ref: '#/components/schemas/ids' } };
	const make = (description: string, extra: Schema = {}): OpenApiDocument => {
		const doc = document({ '/builds': { get: { parameters: [{ $ref: '#/components/parameters/ids' }], ...extra } } });
		doc.components.schemas['ids'] = { type: 'string', description };
		doc.components['parameters'] = { ids };
		return doc;
	};
	const doc = make('Comma-separated list of version UUIDs (max 20).');
	joinCommaLists(doc, { 'GET /builds': ['ids'] });
	assert.deepEqual(doc.paths['/builds']?.['get']?.['parameters'], [
		{
			...ids,
			schema: {
				type: 'array',
				items: { type: 'string' },
				description: 'Comma-separated list of version UUIDs (max 20). The list is sent joined with commas.',
			},
			explode: false,
		},
	]);
	// The shared parameter is left as it was.
	assert.deepEqual(doc.components['parameters']?.['ids'], ids);
	const stale = /aren't strings described as comma-separated lists.*GET \/builds ids/;
	assert.throws(() => joinCommaLists(make('A version UUID.'), { 'GET /builds': ['ids'] }), stale);
	assert.throws(() => joinCommaLists(make('Comma-separated list.', hidden()), { 'GET /builds': ['ids'] }), stale);
	assert.throws(() => joinCommaLists(make('Comma-separated list.'), { 'GET /builds': ['other'] }), /GET \/builds other/);
	// The spec says it in other words too, in the parameter's description or its schema's.
	for (const description of ['URL-encoded URLs separated by commas.', 'Comma delimited list of IDs.', 'Comma-separated SCIM attributes.']) {
		joinCommaLists(make(description), { 'GET /builds': ['ids'] });
	}
	const described = make('Unrelated.');
	described.components['parameters'] = { ids: { ...ids, description: 'A comma separated list of UUIDs.' } };
	joinCommaLists(described, { 'GET /builds': ['ids'] });
	assert.match(described.paths['/builds']?.['get']?.['parameters'][0].schema.description, /^A comma separated list of UUIDs\. /);
	// One the path item declares becomes the operation's own, which overrides it.
	const shared = document({ '/builds': { parameters: [{ $ref: '#/components/parameters/ids' }], get: {} } });
	shared.components.schemas['ids'] = { type: 'string', description: 'Comma-separated list.' };
	shared.components['parameters'] = { ids };
	joinCommaLists(shared, { 'GET /builds': ['ids'] });
	assert.equal(shared.paths['/builds']?.['get']?.['parameters'][0].explode, false);
	assert.deepEqual(shared.paths['/builds']?.['parameters'], [{ $ref: '#/components/parameters/ids' }]);
	// Once a list, as the spec may declare it later, it's stale too.
	const listed = make('Comma-separated list.');
	joinCommaLists(listed, { 'GET /builds': ['ids'] });
	assert.throws(() => joinCommaLists(listed, { 'GET /builds': ['ids'] }), stale);
});

test('a dry run or request variants that are not generated stop generation, and so does a key given twice', () => {
	const doc = document({ '/rulesets': { post: {} }, '/hidden': { post: hidden() } });
	checkDryRuns(doc, ['POST /rulesets']);
	assert.throws(() => checkDryRuns(doc, ['POST /rulesets', 'POST /hidden', 'POST /gone']), /aren't generated.*POST \/hidden, POST \/gone/);
	checkRequestVariants(doc, ['POST /rulesets']);
	assert.throws(() => checkRequestVariants(doc, ['POST /hidden', 'POST /gone']), /REQUEST_VARIANTS: POST \/hidden, POST \/gone/);
	assert.deepEqual(byKey('T', [['a', 1], ['b', 2]]), { a: 1, b: 2 });
	assert.throws(() => byKey('OPERATION_RENAMES', [['GET /a', 1], ['GET /a', 2]]), /OPERATION_RENAMES gives GET \/a twice/);
});
