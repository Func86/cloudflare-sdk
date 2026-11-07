import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameChanges } from '../generator/manifest.ts';

const entry = (id: string, method: string, route: string) => ({ id, method, route });

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
