import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	checkPaginationOverrides,
	markLiteralSlashes,
	normalizeFlags,
	restateRequired,
	selectOperations,
} from '../generator/prepare.ts';
import { LITERAL_SLASHES, type OpenApiDocument, type Schema } from '../generator/spec.ts';

function document(paths: Record<string, Record<string, Schema>>): OpenApiDocument {
	return { paths, components: { schemas: {} } };
}

const hidden = (extra: Schema = {}): Schema => ({ 'x-fern-ignore': true, ...extra });

test('a hidden operation is included unless it is deprecated or excluded', () => {
	const doc = document({
		'/kept': { get: hidden() },
		'/old': { get: hidden({ 'x-fern-availability': 'deprecated' }), post: hidden({ deprecated: true }) },
		'/excluded': { get: hidden() },
		'/visible': { get: {} },
	});
	const skipped = selectOperations(doc, { 'GET /excluded': 'A reason.' }, {});
	assert.deepEqual(skipped, { deprecated: 2, excluded: 1 });
	assert.equal(doc.paths['/kept']?.['get']?.['x-fern-ignore'], undefined);
	assert.equal(doc.paths['/old']?.['get']?.['x-fern-ignore'], true);
	assert.equal(doc.paths['/excluded']?.['get']?.['x-fern-ignore'], true);
});

test('an operation for another audience is removed, and one for the SDK is kept', () => {
	const doc = document({
		'/terraform': { get: hidden({ 'x-fern-audiences': ['terraform'] }), head: { 'x-fern-audiences': ['terraform'] } },
		'/sdk': { get: { 'x-fern-audiences': ['sdk'] } },
	});
	assert.deepEqual(selectOperations(doc, {}, {}), { 'other audience': 2 });
	assert.equal(doc.paths['/terraform']?.['get'], undefined);
	assert.equal(doc.paths['/terraform']?.['head'], undefined);
	assert.ok(doc.paths['/sdk']?.['get']);
});

test('an operation that does not describe its response is left out, apart from a DELETE or a HEAD', () => {
	const bare = { responses: { '200': { description: 'A list.' }, '4XX': { description: 'An error.' } } };
	const doc = document({
		'/bare': { get: bare, post: { responses: { '2XX': { description: 'Done.' } } }, delete: bare, head: bare },
		'/empty': { post: { responses: { '204': { description: 'Done.' } } } },
		'/described': { get: { responses: { '200': { content: { 'application/json': { schema: {} } } } } } },
		'/referenced': { get: { responses: { '200': { $ref: '#/components/responses/ok' } } } },
		'/undeclared': { get: {} },
		'/hidden': { get: hidden(bare) },
	});
	doc.components['responses'] = { ok: { content: { 'text/plain': {} } } };
	assert.deepEqual(selectOperations(doc, {}, {}), { 'no response schema': 3 });
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
		'/base': { get: { servers: [{ url: 'https://api.example/v4' }] } },
		'/plain': { get: {} },
	});
	doc['servers'] = [{ url: 'https://api.example/v4' }];
	assert.deepEqual(selectOperations(doc, {}, {}), { 'other server': 2 });
	assert.equal(doc.paths['/produce']?.['post'], undefined);
	assert.equal(doc.paths['/elsewhere']?.['get'], undefined);
	assert.ok(doc.paths['/base']?.['get']);
	assert.ok(doc.paths['/plain']?.['get']);
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

test('a rename applies to a hidden operation, and can move it to another group', () => {
	const doc = document({
		'/a': { post: hidden({ 'x-fern-sdk-group-name': 'x.y', 'x-fern-sdk-method-name': 'create' }) },
		'/b': { post: hidden({ 'x-fern-sdk-group-name': 'x.y', 'x-fern-sdk-method-name': 'old' }) },
	});
	selectOperations(doc, {}, { 'POST /a': { group: 'x', method: 'move-one' }, 'POST /b': { method: 'renamed' } });
	assert.equal(doc.paths['/a']?.['post']?.['x-fern-sdk-group-name'], 'x');
	assert.equal(doc.paths['/a']?.['post']?.['x-fern-sdk-method-name'], 'move-one');
	assert.equal(doc.paths['/b']?.['post']?.['x-fern-sdk-group-name'], 'x.y');
	assert.equal(doc.paths['/b']?.['post']?.['x-fern-sdk-method-name'], 'renamed');
});

test('an entry that no longer matches a hidden operation stops generation', () => {
	const gone = document({});
	assert.throws(() => selectOperations(gone, { 'GET /gone': 'A reason.' }, {}), /GET \/gone/);
	const nowVisible = document({ '/visible': { get: {} } });
	assert.throws(() => selectOperations(nowVisible, {}, { 'GET /visible': { method: 'renamed' } }), /GET \/visible/);
	const nowDeprecated = document({ '/old': { get: hidden({ deprecated: true }) } });
	assert.throws(() => selectOperations(nowDeprecated, { 'GET /old': 'A reason.' }, {}), /GET \/old/);
});
