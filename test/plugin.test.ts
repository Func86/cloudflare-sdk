import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Forge, Model, Type } from '@cloudflare/forge/plugin';
import { exclusiveUnion, namedGroups } from '../generator/plugin/index.ts';
import { namingProblems } from '../generator/plugin/names.ts';
import {
	alternativesOf,
	checkOverride,
	flatFields,
	type Param,
	readAccountOrZone,
	readDryRun,
	type ResolvedResponse,
} from '../generator/plugin/operations.ts';
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
	// Forge's root group holds the models more than one group uses.
	const models = new Models({ groups: [{ models: [upload, wrapper, plain] }] } as unknown as Forge);
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
	const paged = new Set(['page']);
	checkOverride('GET /events', override, response(envelope(events)), paged);
	checkOverride('GET /enveloped', override, response(both(envelope(events), envelope(generic))), paged);
	checkOverride('GET /root', { kind: 'page' }, response(envelope(array(string))), paged);
	const renamed = response(envelope(object(field('items', array(string)))));
	assert.throws(() => checkOverride('GET /renamed', override, renamed, paged), /GET \/renamed is stale.*no array at result\.events/);
	assert.throws(() => checkOverride('GET /bare', override, response(envelope(events), 'json'), paged), /no array at result\.events/);
	// A list paged by number must still take a page number.
	assert.throws(() => checkOverride('GET /events', override, response(envelope(events)), new Set()), /no page parameter/);
	// A cursor the caller can send must still be a parameter, and still come back in result_info.
	const cursored = { kind: 'page', cursors: [{ param: 'cursor', next: 'cursor' }] } as const;
	const withCursor = { ...response(envelope(array(string))), resultInfo: new Map([['cursor', field('cursor', string)]]) };
	checkOverride('GET /records', cursored, withCursor as ResolvedResponse, new Set(['cursor', 'page']));
	assert.throws(() => checkOverride('GET /records', cursored, withCursor as ResolvedResponse, new Set(['page'])), /no cursor parameter/);
	assert.throws(
		() => checkOverride('GET /records', cursored, response(envelope(array(string))), new Set(['cursor', 'page'])),
		/no result_info\.cursor/,
	);
});

test('an account-or-zone route is one the runtime can fill from account_id or zone_id', () => {
	const string: Type = { kind: 'scalar', scalar: 'string' };
	const param = (name: string, type: Type = string, location: Param['in'] = 'path'): Param => ({
		name,
		in: location,
		required: true,
		description: '',
		type,
	});
	const scope = (...values: string[]): Param[] => [
		param('account_or_zone', { kind: 'enum', values }),
		param('account_or_zone_id'),
	];
	const route = '/{account_or_zone}/{account_or_zone_id}/things';
	assert.equal(readAccountOrZone('GET /things', route, scope('zones', 'accounts')), true);
	assert.equal(readAccountOrZone('GET /root', '/{account_or_zone}/{account_or_zone_id}', scope('accounts', 'zones')), true);
	// The selector's values are read through models, and past a null.
	const selector: Type = { kind: 'enum', values: ['accounts', 'zones'] };
	const inModel = (type: Type): Type => ({ kind: 'model', model: model('scope', type) });
	const nullable = { kind: 'union', members: [selector, { kind: 'scalar', scalar: 'null' }] } as unknown as Type;
	for (const type of [inModel(selector), inModel(inModel(selector)), nullable, inModel(nullable)]) {
		assert.equal(readAccountOrZone('GET /model', route, [param('account_or_zone', type), param('account_or_zone_id')]), true);
	}
	assert.equal(readAccountOrZone('GET /accounts', '/accounts/{account_id}/things', [param('account_id')]), false);
	assert.throws(() => readAccountOrZone('GET /inner', '/users/{account_or_zone}/{account_or_zone_id}', scope('accounts', 'zones')), /first two segments/);
	assert.throws(() => readAccountOrZone('GET /twice', `${route}/{account_or_zone_id}`, scope('accounts', 'zones')), /first two segments/);
	assert.throws(() => readAccountOrZone('GET /users', route, scope('accounts', 'users')), /accounts or zones/);
	assert.throws(() => readAccountOrZone('GET /untyped', route, [param('account_or_zone'), param('account_or_zone_id')]), /accounts or zones/);
	const clash = [...scope('accounts', 'zones'), param('zone_id', string, 'query')];
	assert.throws(() => readAccountOrZone('GET /clash', route, clash), /GET \/clash: the query parameter zone_id/);
});

test('generation stops if a model that holds a file is used where JSON is sent', () => {
	const { upload, wrapper, plain, models } = setup();
	const printer = new Printer(models, undefined);
	assert.match(printer.type({ kind: 'model', model: plain }, 'read'), /Plain/);
	for (const used of [upload, wrapper]) {
		assert.throws(() => printer.type({ kind: 'model', model: used }, 'read'), /holds a file/);
	}
});

test('a name that says another verb, an account group on an account-or-zone route, or a repeated group needs a look', () => {
	const json = { kind: 'json', formAlternative: false, exclusive: false, required: true, description: '', type: undefined } as const;
	const at = (method: string, route: string, accountOrZone = false, body?: typeof json) => ({ method, route, accountOrZone, body });
	const aoz = '/{account_or_zone}/{account_or_zone_id}';
	assert.deepEqual(namingProblems(['logpush', 'account-validate', 'destination'], 'delete', at('POST', `${aoz}/logpush/validate/destination`, true)), [
		'its name says a verb its HTTP method does not do',
		'an account- or zone- group on a route that serves both',
	]);
	assert.deepEqual(namingProblems(['cloudforce-one', 'requests'], 'cloudforce-one-request-list', at('POST', '/accounts/{a}/cloudforce-one/requests')), [
		'its name says a verb its HTTP method does not do',
		'its method repeats its group',
	]);
	// An RPC-style route names its verb, and a route for accounts only can have an account group.
	assert.deepEqual(namingProblems(['kv', 'bulk'], 'delete', at('POST', '/accounts/{a}/storage/kv/namespaces/{n}/bulk/delete')), []);
	assert.deepEqual(namingProblems(['intel', 'permissions'], 'delete', at('PUT', '/accounts/{a}/intel/permissions/remove')), []);
	assert.deepEqual(namingProblems(['dns', 'account-settings'], 'get', at('GET', '/accounts/{a}/dns_settings')), []);
	assert.deepEqual(namingProblems(['logpush', 'jobs'], 'list', at('GET', `${aoz}/logpush/jobs`, true)), []);
	assert.deepEqual(namingProblems(['rulesets', 'rules'], 'edit', at('PATCH', `${aoz}/rulesets/{r}/rules/{id}`, true)), []);
	// A read by POST whose body says what to read, as a search or a bulk get does.
	assert.deepEqual(namingProblems(['ai-audit', 'robots'], 'bulk-get', at('POST', '/zones/{z}/ai-audit/robots/bulk', false, json)), []);
	assert.deepEqual(namingProblems(['cloudforce-one', 'requests'], 'list', at('POST', '/accounts/{a}/cloudforce-one/requests', false, json)), []);
	// A bulk change by POST whose body lists what it acts on, as a bulk delete does, but not without a body.
	const batch = '/accounts/{a}/email-security/settings/sending_domain_restrictions/batch';
	assert.deepEqual(namingProblems(['email-security', 'sending-domain-restrictions'], 'bulk-delete', at('POST', batch, false, json)), []);
	assert.deepEqual(namingProblems(['email-security', 'sending-domain-restrictions'], 'bulk-delete', at('POST', batch)), [
		'its name says a verb its HTTP method does not do',
	]);
	// Not anything else by POST with a body, such as a validation.
	assert.deepEqual(namingProblems(['logpush', 'validate'], 'delete', at('POST', `${aoz}/logpush/validate/destination`, true, json)), [
		'its name says a verb its HTTP method does not do',
	]);
	// A word that names something every object has is a word like any other.
	for (const method of ['find-constructor', 'toString', '__proto__']) {
		assert.deepEqual(namingProblems(['x'], method, at('GET', '/x')), []);
	}
});

test('an exclusive body reads its alternatives through models, and keeps null as one', () => {
	const { models } = setup();
	const printer = new Printer(models, undefined);
	const string: Type = { kind: 'scalar', scalar: 'string' };
	const nothing: Type = { kind: 'scalar', scalar: 'null' };
	const union = (exclusive: boolean, ...members: Type[]): Type =>
		({ kind: 'union', members, exclusive, discriminator: undefined }) as unknown as Type;
	const a = object(field('a', string));
	const b = object(field('b', string));
	const nullable = [
		union(true, a, b, nothing),
		union(true, union(true, a, b), nothing),
		{ kind: 'model', model: model('x_body', union(true, union(true, a, b), nothing)) } as Type,
	];
	for (const type of nullable) {
		assert.deepEqual(alternativesOf(type), { members: [a, b], nullable: true, exclusive: true });
		assert.equal(
			exclusiveUnion(type, printer, 'write', '\t'),
			'({\n\t\ta: string;\n\t} & {\n\t\tb?: never;\n\t}) | ({\n\t\tb: string;\n\t} & {\n\t\ta?: never;\n\t}) | null',
		);
	}
	assert.equal(alternativesOf(union(true, a, b))?.nullable, false);
	// An anyOf beside null is no oneOf, though Forge marks a type and null exclusive.
	assert.equal(alternativesOf(union(true, union(false, a, b), nothing))?.exclusive, false);
	assert.equal(alternativesOf(union(true, a, nothing)), undefined);
});

test('a listed dry run needs a boolean dry_run and a result that can be null', () => {
	const key = 'POST /{account_or_zone}/{account_or_zone_id}/rulesets';
	const ruleset = object(field('id', { kind: 'scalar', scalar: 'string' }));
	const nothing: Type = { kind: 'scalar', scalar: 'null' };
	const response = (result: Type): ResolvedResponse => ({
		kind: 'envelope',
		types: [result],
		resultInfo: new Map(),
		alternatives: [],
		noContent: false,
		jsonTypes: [],
	});
	const nullable = response({ kind: 'union', members: [ruleset, nothing], exclusive: true, discriminator: undefined } as unknown as Type);
	const flag = (type: Type): Param[] => [{ name: 'dry_run', in: 'query', required: false, description: '', type }];
	const boolean = flag({ kind: 'scalar', scalar: 'boolean' });
	assert.equal(readDryRun(key, boolean, nullable), true);
	// Not listed, so not one, though it has both.
	assert.equal(readDryRun('POST /other', boolean, nullable), false);
	const stale = /dry run of POST .*rulesets is stale/;
	assert.throws(() => readDryRun(key, [], nullable), stale);
	assert.throws(() => readDryRun(key, flag({ kind: 'scalar', scalar: 'string' }), nullable), stale);
	assert.throws(() => readDryRun(key, boolean, response(ruleset)), stale);
});

test("Forge's root group gets no files, and generation stops if it has methods", () => {
	const root = { parent: undefined, methods: [] as unknown[] };
	const zones = { parent: root, methods: [] };
	const forge = { groups: [root, zones] } as unknown as Forge;
	assert.deepEqual(namedGroups(forge), [zones]);
	root.methods.push({ httpMethod: 'GET', path: '/zones/{zone_id}/settings/nel' });
	assert.throws(() => namedGroups(forge), /in its root group, which has no import path: GET \/zones\/\{zone_id\}\/settings\/nel\. .*UNNAMED_OPERATIONS/);
});
