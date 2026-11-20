import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	checkDryRuns,
	checkPaginationOverrides,
	checkRequestVariants,
	joinCommaLists,
	markLiteralSlashes,
	normalizeFlags,
	restateRequired,
	selectOperations,
} from '../generator/prepare.ts';
import { byKey, SPEC_PATCHES } from '../generator/patches.ts';
import { LITERAL_SLASHES, type OpenApiDocument, type Schema } from '../generator/spec.ts';

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
			// Forge skips it, so it needs no name.
			'/old': { get: { 'x-fern-ignore': true, deprecated: true } },
		});
	const both = { 'GET /unnamed': reason, 'PATCH /unnamed': reason };
	const doc = unnamed();
	assert.deepEqual(select(doc, {}, {}, both), { 'no name': 2, deprecated: 1 });
	assert.deepEqual(Object.keys(doc.paths['/named'] ?? {}), ['get']);
	assert.deepEqual(Object.keys(doc.paths['/unnamed'] ?? {}), []);
	assert.deepEqual(Object.keys(doc.paths['/old'] ?? {}), ['get']);
	assert.throws(() => select(unnamed(), {}, {}, { 'GET /unnamed': reason }), /UNNAMED_OPERATIONS with a reason: PATCH \/unnamed$/);
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

test('a required in a shared request body, or beside a oneOf, is restated where Forge reads it', () => {
	const doc = document({});
	doc.components.schemas = {
		base: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string' } } },
		url: { type: 'object', properties: { target: { type: 'string' } } },
		text: { type: 'string' },
		target: { oneOf: [{ $ref: '#/components/schemas/url' }, { $ref: '#/components/schemas/text' }], required: ['target'] },
	};
	const create = { allOf: [{ $ref: '#/components/schemas/base' }], required: ['name', 'kind'] };
	doc.components['requestBodies'] = { create: { content: { 'application/json': { schema: create } } } };
	assert.equal(restateRequired(doc), 3);
	assert.deepEqual(create.allOf.at(-1), {
		type: 'object',
		properties: { name: { type: 'string' }, kind: { type: 'string' } },
		required: ['name', 'kind'],
	});
	const [url, text] = doc.components.schemas['target']?.['oneOf'] as Schema[];
	assert.deepEqual(url, {
		allOf: [{ $ref: '#/components/schemas/url' }, { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }],
	});
	// `required` means nothing to a string.
	assert.deepEqual(text, { $ref: '#/components/schemas/text' });
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
