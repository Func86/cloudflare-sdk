import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Forge, Model, Type } from '@cloudflare/forge/plugin';
import { checkOverride, flatFields, type ResolvedResponse } from '../generator/plugin/operations.ts';
import { Models, Printer } from '../generator/plugin/types.ts';

const binary: Type = { kind: 'scalar', scalar: 'binary' };

function model(schemaName: string, type: Type): Model {
	return { schemaName, description: '', type } as unknown as Model;
}

function field(wireName: string, type: Type): unknown {
	return { wireName, type, required: true, readOnly: false, description: '', deprecated: false };
}

function object(...fields: unknown[]): Type {
	return { kind: 'object', fields } as unknown as Type;
}

/** A model with a file, and one that holds a file only through referring to it. */
function setup() {
	const upload = model('files_upload', object(field('file', binary)));
	const wrapper = model('files_wrapper', object(field('upload', { kind: 'model', model: upload })));
	const plain = model('files_plain', object(field('name', { kind: 'scalar', scalar: 'string' })));
	const models = new Models({ models: [upload, wrapper, plain], groups: [] } as unknown as Forge);
	return { upload, wrapper, plain, models };
}

test('a binary field in a form is a file or text, and elsewhere is a string', () => {
	const { models } = setup();
	const printer = new Printer(models, undefined);
	assert.equal(printer.type(binary, 'write'), 'string');
	printer.form = true;
	assert.equal(printer.type(binary, 'write'), 'Blob | string');
	assert.equal(printer.type({ kind: 'array', elem: binary } as Type, 'write'), '(Blob | string)[]');
	const string: Type = { kind: 'scalar', scalar: 'string' };
	assert.equal(printer.type({ kind: 'union', members: [string, binary] } as unknown as Type, 'write'), 'Blob | string');
});

test('a model that holds a file can be used in a form, directly or not', () => {
	const { upload, wrapper, plain, models } = setup();
	assert.equal(models.holdsFile(upload), true);
	assert.equal(models.holdsFile(wrapper), true);
	assert.equal(models.holdsFile(plain), false);
	const printer = new Printer(models, undefined);
	printer.form = true;
	assert.match(printer.type({ kind: 'model', model: wrapper }, 'write'), /Wrapper/);
});

test('a result declared in several branches keeps what each concrete declaration says', () => {
	const string: Type = { kind: 'scalar', scalar: 'string' };
	const array = (elem: Type): Type => ({ kind: 'array', elem }) as Type;
	const both = (...members: Type[]): Type => ({ kind: 'intersection', members }) as unknown as Type;
	const envelope = (result: Type): Type => object(field('result', result));
	const resultOf = (...results: Type[]): Type | undefined => flatFields(both(...results.map(envelope))).get('result')?.type;
	// The bases' `result`: any object, array or string.
	const generic = { kind: 'union', members: [object(), array(object()), string] } as unknown as Type;

	// Images: the base pages with a token, and the operation adds the images.
	const token = object(field('continuation_token', string));
	const images = object(field('images', array(string)));
	assert.deepEqual(resultOf(generic, token, images), both(token, images));
	// Lists: a concrete list, then generic ones, which say nothing more.
	const items = { kind: 'model', model: model('lists_items', array(object(field('id', string)))) } as Type;
	assert.equal(resultOf(items, array(object()), generic), items);
	// The same model twice is one, and two lists are a list of both items.
	assert.deepEqual(resultOf(items, { ...items }), items);
	assert.deepEqual(resultOf(array(token), array(images)), array(both(token, images)));
});

test('a pagination override must name an array of the result, as the types read it', () => {
	const string: Type = { kind: 'scalar', scalar: 'string' };
	const array = (elem: Type): Type => ({ kind: 'array', elem }) as Type;
	const both = (...members: Type[]): Type => ({ kind: 'intersection', members }) as unknown as Type;
	const envelope = (result: Type): Type => object(field('result', result));
	const response = (result: Type, kind: ResolvedResponse['kind'] = 'envelope'): ResolvedResponse => ({
		kind,
		types: [flatFields(result).get('result')!.type],
		resultInfo: new Map(),
		alternatives: [],
		noContent: false,
		jsonTypes: [],
	});
	// Two arrays, so the shape alone can't say which is paged.
	const events = object(field('events', array(string)), field('asn_info', array(string)));
	// The bases' `result`: any object, array or string, declared after the operation's.
	const generic = { kind: 'union', members: [object(), array(object()), string] } as unknown as Type;
	const override = { kind: 'page', items: 'events' } as const;
	checkOverride('GET /events', override, response(envelope(events)));
	checkOverride('GET /enveloped', override, response(both(envelope(events), envelope(generic))));
	checkOverride('GET /root', { kind: 'page' }, response(envelope(array(string))));
	const renamed = response(envelope(object(field('items', array(string)))));
	assert.throws(() => checkOverride('GET /renamed', override, renamed), /GET \/renamed is stale.*no array at result\.events/);
	assert.throws(() => checkOverride('GET /bare', override, response(envelope(events), 'json')), /no array at result\.events/);
});

test('generation stops if a model that holds a file is used where JSON is sent', () => {
	const { upload, wrapper, plain, models } = setup();
	const printer = new Printer(models, undefined);
	assert.match(printer.type({ kind: 'model', model: plain }, 'read'), /Plain/);
	for (const used of [upload, wrapper]) {
		assert.throws(() => printer.type({ kind: 'model', model: used }, 'read'), /holds a file/);
	}
});
