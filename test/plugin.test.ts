import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Forge, Model, Type } from '@cloudflare/forge/plugin';
import { exclusiveUnion, namedGroups, variantUnion } from '../generator/plugin/index.ts';
import { namingProblems } from '../generator/plugin/names.ts';
import {
	alternativesOf,
	checkOverride,
	flatFields,
	type Param,
	readAccountOrZone,
	readDryRun,
	readVariants,
	type ResolvedBody,
	type ResolvedResponse,
	throws3xx,
	type VariantContext,
	withExcludes,
} from '../generator/plugin/operations.ts';
import type { EnumValue, RequestVariant } from '../generator/patches.ts';
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
	// A cursor list's own, with its array further down.
	const list = { kind: 'cursor', items: 'page.items', param: 'cursor', next: 'cursor' } as const;
	const nested = { ...withCursor, types: [object(field('page', object(field('items', array(string)))))] } as ResolvedResponse;
	checkOverride('GET /nested', list, nested, new Set(['cursor']));
	assert.throws(() => checkOverride('GET /nested', list, nested, new Set()), /no cursor parameter/);
	assert.throws(() => checkOverride('GET /nested', { ...list, next: 'next_cursor' }, nested, new Set(['cursor'])), /no result_info\.next_cursor/);
	assert.throws(() => checkOverride('GET /nested', { ...list, items: 'page.rows' }, nested, new Set(['cursor'])), /no array at result\.page\.rows/);
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

test('request variants name parameters the operation takes, and values its enums have', () => {
	const string: Type = { kind: 'scalar', scalar: 'string' };
	const query = (name: string, type: Type = string, required = false): Param => ({ name, in: 'query', required, description: '', type });
	const on = (params: readonly Param[], more: Partial<VariantContext> = {}): VariantContext => ({
		params,
		accountOrZone: false,
		body: undefined,
		model: () => undefined,
		...more,
	});
	const dns = 'GET /zones/{zone_id}/dns_records';
	const cursors = [query('page'), query('cursor'), query('prev_cursor')];
	assert.equal(readVariants('GET /unlisted', on(cursors)), undefined);
	assert.equal(readVariants(dns, on(cursors))?.length, 3);
	assert.throws(() => readVariants(dns, on(cursors.slice(0, 2))), /dns_records are stale.*no prev_cursor parameter/);
	const types = (...values: EnumValue[]): Type => ({ kind: 'enum', values }) as unknown as Type;
	const pair = (name: string, type: Type, required = false) => [query(name, type), query('id', string, required)];
	const limited = (values: NonNullable<RequestVariant['values']>): RequestVariant[] => [{ takes: ['kind'], values }, { takes: ['id'] }];
	const key = 'GET /a';
	assert.throws(() => readVariants(key, on(pair('kind', types('a'))), limited({ kind: { only: ['b'] } })), /kind has no value "b"/);
	assert.throws(() => readVariants(key, on(pair('kind', string)), limited({ kind: { only: ['a'] } })), /limits kind, which it doesn't take as an enum/);
	// A variant can't leave out a parameter the operation requires.
	assert.throws(() => readVariants(key, on(pair('kind', types('a'), true)), limited({ kind: { only: ['a'] } })), /leaves out id/);
	assert.throws(() => readVariants(key, on(pair('kind', types('a'))), limited({ kind: { only: [] } })), /lists no values of kind/);
	assert.throws(() => readVariants(key, on(pair('kind', types('a'))), limited({ kind: { not: [] } })), /lists no values of kind/);
	// A number or boolean enum can be limited, by its values as they are.
	const ssl = (value: EnumValue): RequestVariant[] => [{ takes: ['ssl'], values: { ssl: { only: [value] } } }, { takes: ['id'] }];
	assert.equal(readVariants(key, on(pair('ssl', types(0, 1))), ssl(1))?.length, 2);
	assert.throws(() => readVariants(key, on(pair('ssl', types(0, 1))), ssl('1')), /ssl has no value "1"/);
	// A template names keys that a variant can't give `?: never`.
	const meta = [query('meta.<field>[<operator>]'), query('id')];
	assert.throws(
		() => readVariants(key, on(meta), [{ takes: ['meta.<field>[<operator>]'] }, { takes: ['id'] }]),
		/meta\.<field>\[<operator>\] is a template, whose keys a variant can't forbid/,
	);
	// The tags route's variants each run against the account or the zone, by the spec's enums of each.
	const accountTypes = model('resource-tagging_account_resource_type', types('worker', 'worker_version'));
	const zoneTypes = model('resource-tagging_zone_resource_type', types('zone', 'access_application_policy'));
	const either: Type = { kind: 'union', members: [accountTypes, zoneTypes].map((found) => ({ kind: 'model', model: found })) } as unknown as Type;
	const tagged = [query('resource_type', either, true), query('worker_id'), query('access_application_id')];
	const named = (name: string) => [accountTypes, zoneTypes].find((found) => found.schemaName === name);
	const tags = 'GET /{account_or_zone}/{account_or_zone_id}/tags';
	assert.equal(readVariants(tags, on(tagged, { accountOrZone: true, model: named }))?.length, 4);
	assert.throws(() => readVariants(tags, on(tagged, { accountOrZone: true })), /resource-tagging_zone_resource_type, which isn't an enum model/);
	assert.throws(() => readVariants(tags, on(tagged, { model: named })), /scope, but its route isn't an account-or-zone route/);
	assert.throws(
		() => readVariants(tags, on([query('resource_type', { kind: 'model', model: accountTypes }, true), ...tagged.slice(1)], { accountOrZone: true, model: named })),
		/resource_type has no value "zone" of resource-tagging_zone_resource_type/,
	);
	// A null beside the enums doesn't stop them being one.
	const members = (either as unknown as { members: unknown[] }).members;
	const nullable = { kind: 'union', members: [...members, { kind: 'scalar', scalar: 'null' }] } as unknown as Type;
	assert.equal(readVariants(tags, on([query('resource_type', nullable, true), ...tagged.slice(1)], { accountOrZone: true, model: named }))?.length, 4);
	// A limit to some values can name its scope's enum, which holds them.
	assert.throws(
		() =>
			readVariants(tags, on(tagged, { accountOrZone: true, model: named }), [
				{ scope: 'account', takes: ['resource_type'] },
				{ scope: 'zone', takes: ['resource_type'], values: { resource_type: { model: 'resource-tagging_zone_resource_type', only: ['worker_version'] } } },
			]),
		/resource_type has no value "worker_version"/,
	);
	const scoped = (...variants: RequestVariant[]) => readVariants(key, on(pair('kind', types('a')), { accountOrZone: true }), variants);
	assert.throws(() => scoped({ scope: 'account', takes: ['kind'] }, { takes: ['id'] }), /some variants have a scope and others not/);
	assert.throws(() => scoped({ scope: 'zone', takes: ['kind'] }, { scope: 'zone', takes: ['id'] }), /run against the account or the zone only/);
	// A variant's body is one of the body's alternatives.
	const bodies = [model('a_account', object()), model('a_zone', object())];
	const body: ResolvedBody = {
		kind: 'json',
		required: true,
		description: '',
		formAlternative: false,
		exclusive: false,
		type: { kind: 'union', members: bodies.map((found) => ({ kind: 'model', model: found })) } as unknown as Type,
	};
	const put = (...variants: RequestVariant[]) => readVariants('PUT /a', on([], { accountOrZone: true, body }), variants);
	assert.equal(put({ scope: 'account', body: 'a_account' }, { scope: 'zone', body: 'a_zone' })?.length, 2);
	assert.throws(() => put({ scope: 'account', body: 'a_account' }, { scope: 'zone', body: 'a_other' }), /its JSON body has no alternative a_other/);
	assert.throws(() => put({ scope: 'account', body: 'a_account' }, { scope: 'zone' }), /some variants have a body and others not/);
	const exclusive = (...variants: RequestVariant[]) =>
		readVariants('PUT /a', on([], { accountOrZone: true, body: { ...body, exclusive: true } }), variants);
	assert.throws(
		() => exclusive({ scope: 'account', body: 'a_account' }, { scope: 'zone', body: 'a_zone' }),
		/would drop the \?: never of its exclusive body/,
	);
});

test("request variants print as a union that gives each the others' parameters as never", () => {
	const { models } = setup();
	const printer = new Printer(models, undefined);
	const string: Type = { kind: 'scalar', scalar: 'string' };
	const query = (name: string, type: Type = string): Param => ({ name, in: 'query', required: false, description: '', type });
	const kinds = { kind: 'enum', values: ['a', 'b'] } as unknown as Type;
	const params = [query('kind', kinds), query('id'), query('from'), query('to')];
	assert.equal(
		variantUnion(
			[{ takes: ['kind', 'id'], requires: ['id'], values: { kind: { only: ['a'] } } }, { takes: ['kind'], values: { kind: { not: ['a'] } } }],
			params,
			printer,
		),
		'{\n\tkind?: "a";\n\tid: string;\n} | {\n\tkind?: Exclude<"a" | "b", "a">;\n\tid?: never;\n}',
	);
	assert.equal(
		variantUnion([{ takes: ['from', 'to'], requires: ['from', 'to'] }, { takes: ['id'] }], params, printer),
		'{\n\tfrom: string;\n\tto: string;\n\tid?: never;\n} | {\n\tid?: string;\n\tfrom?: never;\n\tto?: never;\n}',
	);
	// A scope comes first and a body last, and a limit can be of another enum, by its model.
	const kindsModel = model('a_kinds', kinds);
	const bodies = [model('a_account', object()), model('a_zone', object())];
	const scopedPrinter = new Printer(new Models({ groups: [{ models: [kindsModel, ...bodies] }] } as unknown as Forge), undefined);
	const body: ResolvedBody = {
		kind: 'json',
		required: true,
		description: 'The tags.',
		formAlternative: false,
		exclusive: false,
		type: { kind: 'union', members: bodies.map((found) => ({ kind: 'model', model: found })) } as unknown as Type,
	};
	assert.equal(
		variantUnion(
			[
				{ scope: 'account', takes: ['kind'], values: { kind: { model: 'a_kinds', not: ['a'] } }, body: 'a_account' },
				{ scope: 'zone', takes: ['id'], body: 'a_zone' },
			],
			params,
			scopedPrinter,
			body,
		),
		'{\n\t/** The account to run against. */\n\taccount_id: string;\n\tzone_id?: never;\n\tkind?: Exclude<$a.Kinds, "a">;\n\tid?: never;\n\t/** The tags. */\n\tbody: $a.Account;\n} | {\n\t/** The zone to run against. */\n\tzone_id: string;\n\taccount_id?: never;\n\tid?: string;\n\tkind?: never;\n\t/** The tags. */\n\tbody: $a.Zone;\n}',
	);
	// A model's enum keeps the null the parameter can hold.
	const nullableKinds = [query('kind', { kind: 'union', members: [kinds, { kind: 'scalar', scalar: 'null' }] } as unknown as Type), query('id')];
	assert.match(
		variantUnion([{ takes: ['kind'], values: { kind: { model: 'a_kinds', not: ['a'] } } }, { takes: ['id'] }], nullableKinds, scopedPrinter),
		/\tkind\?: Exclude<\$a\.Kinds, "a"> \| null;\n/,
	);
	// A body the operation also takes as a form can be a FormData in each variant.
	const formed = variantUnion([{ scope: 'account', body: 'a_account' }, { scope: 'zone', body: 'a_zone' }], params, scopedPrinter, {
		...body,
		formAlternative: true,
	});
	assert.match(formed, /\tbody: FormData \| \$a\.Account;\n/);
	assert.match(formed, /\tbody: FormData \| \$a\.Zone;\n/);
	// What the API refuses beside each parameter paginate moves on.
	const exclusive = [{ takes: ['page'] }, { takes: ['cursor'] }, { takes: ['prev_cursor'] }];
	const cursors = [{ param: 'cursor', next: 'cursor' }];
	assert.deepEqual(withExcludes('GET /a', { kind: 'page', cursors }, exclusive), {
		kind: 'page',
		cursors: [{ param: 'cursor', next: 'cursor', excludes: ['page', 'prev_cursor'] }],
		excludes: ['cursor', 'prev_cursor'],
	});
	assert.deepEqual(withExcludes('GET /a', { kind: 'cursor', param: 'cursor', next: 'cursor' }, exclusive.slice(0, 2)), {
		kind: 'cursor',
		param: 'cursor',
		next: 'cursor',
		excludes: ['page'],
	});
	// Variants that don't govern what it moves on change nothing.
	assert.deepEqual(withExcludes('GET /a', { kind: 'offset' }, exclusive), { kind: 'offset' });
	assert.deepEqual(withExcludes('GET /a', { kind: 'page' }, undefined), { kind: 'page' });
	// paginate checks no excludes for an offset that takes precedence over page.
	const offsets = [{ takes: ['offset'] }, { takes: ['cursor'] }];
	assert.deepEqual(withExcludes('GET /a', { kind: 'page' }, offsets), { kind: 'page' });
	assert.throws(() => withExcludes('GET /a', { kind: 'page', offsetWins: true }, offsets), /GET \/a say what offset excludes/);
});

test('a declared 3xx that fetch passes on is noted, and a redirect it follows or a range is not', () => {
	const response = (status: string, description = '') => ({ status, description, contents: [], json: undefined });
	// Sorted by status, as Forge gives them.
	const errors = [
		response('300'),
		response('301', 'Moved.'),
		response('304', " A deployment already exists for the branch's latest commit.\n"),
		response('307'),
		response('3XX', 'Any redirect.'),
		response('404', 'Not found.'),
	];
	assert.deepEqual(throws3xx({ errors }), [
		{ status: '300', description: '' },
		{ status: '304', description: "A deployment already exists for the branch's latest commit." },
	]);
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
