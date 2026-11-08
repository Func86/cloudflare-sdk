import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nameChanges } from '../generator/manifest.ts';

const entry = (id: string, method: string, route: string) => ({ id, method, route });

/**
 * The groups that one of the package's own subpaths, from its `exports`, would hide from their
 * import path: `./testing` hides a group named `testing`, and `./types/*` each group under
 * `types/`, though not one named `types`, which `./*` still reaches.
 */
function hiddenGroups(exports: Readonly<Record<string, unknown>>, groups: readonly string[]): string[] {
	const own = Object.keys(exports)
		.filter((key) => key !== '.' && key !== './*')
		.map((key) => key.replace(/^\.\//, ''));
	return groups.filter((group) => own.some((path) => (path.endsWith('/*') ? group.startsWith(path.slice(0, -1)) : group === path)));
}

test('a name change between outputs is a rename, a removal or an addition', () => {
	const before = [
		entry('logpush.account-jobs.list', 'GET', '/{account_or_zone}/{account_or_zone_id}/logpush/jobs'),
		entry('o11y.query', 'POST', '/accounts/{account_id}/o11y/query'),
		entry('observability.query', 'POST', '/accounts/{account_id}/o11y/query'),
		entry('zones.get', 'GET', '/zones/{zone_id}'),
		entry('old.get', 'GET', '/old'),
	];
	const after = [
		entry('logpush.jobs.list', 'GET', '/{account_or_zone}/{account_or_zone_id}/logpush/jobs'),
		// An alias's names in another order are the same names.
		entry('observability.query', 'POST', '/accounts/{account_id}/o11y/query'),
		entry('o11y.query', 'POST', '/accounts/{account_id}/o11y/query'),
		entry('zones.get', 'GET', '/zones/{zone_id}'),
		entry('new.get', 'GET', '/new'),
	];
	assert.deepEqual(nameChanges(before, after), {
		renamed: [['logpush.account-jobs.list', 'logpush.jobs.list']],
		removed: ['old.get'],
		added: ['new.get'],
	});
});

test('a name is compared by name: one that moves route is unchanged, and a lost alias is removed', () => {
	// Account and zone routes merged: the name still imports.
	const moved = nameChanges([entry('a.get', 'GET', '/accounts/{account_id}/a')], [entry('a.get', 'GET', '/{account_or_zone}/{account_or_zone_id}/a')]);
	assert.deepEqual(moved, { renamed: [], removed: [], added: [] });
	// One of two names of an operation is gone.
	const lost = nameChanges([entry('x', 'GET', '/r'), entry('y', 'GET', '/r')], [entry('x', 'GET', '/r')]);
	assert.deepEqual(lost, { renamed: [], removed: ['y'], added: [] });
	// Another name took its place, or two names became one.
	const swapped = nameChanges([entry('x', 'GET', '/r'), entry('y', 'GET', '/r')], [entry('x', 'GET', '/r'), entry('z', 'GET', '/r')]);
	assert.deepEqual(swapped, { renamed: [['y', 'z']], removed: [], added: [] });
	const merged = nameChanges([entry('x', 'GET', '/r'), entry('y', 'GET', '/r')], [entry('z', 'GET', '/r')]);
	assert.deepEqual(merged, { renamed: [['x, y', 'z']], removed: [], added: [] });
});

test("a group that one of the package's own subpaths would hide is found", () => {
	const exports = { '.': {}, './testing': {}, './types/*': {}, './*': {}, './package.json': './package.json' };
	assert.deepEqual(hiddenGroups(exports, ['rulesets', 'rulesets/rules', 'testing', 'testing/runs', 'types', 'types/foo']), [
		'testing',
		'types/foo',
	]);
});

test("the package's own subpaths hide no generated group", () => {
	const generated = fileURLToPath(new URL('../generated/', import.meta.url));
	const groups = readdirSync(generated, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name === 'index.js')
		.map((entry) => relative(generated, entry.parentPath).split(sep).join('/'));
	assert.ok(groups.includes('rulesets/rules'));
	const { exports } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };
	assert.deepEqual(hiddenGroups(exports, groups), [], 'rename these groups, or the subpath');
});
