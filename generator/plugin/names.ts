/**
 * Finds names worth a person's look. Names come from the spec's `x-fern-sdk-group-name`
 * and `x-fern-sdk-method-name`, and these rules catch the kinds of mistake seen there.
 * A rename in generator/patches.ts fixes one; the rest stay in `_meta/report.json`.
 */
import type { ResolvedOperation } from './operations.ts';

/** The HTTP methods a method name's last word implies. A `Map`, as any word can be looked up. */
const VERB_METHODS: ReadonlyMap<string, readonly string[]> = new Map([
	['get', ['GET']],
	['list', ['GET']],
	['delete', ['DELETE']],
	['create', ['POST', 'PUT']],
	['update', ['PUT', 'PATCH', 'POST']],
	['edit', ['PATCH', 'PUT', 'POST']],
]);
/** Last route segments that name that verb, as an RPC-style route does, such as `POST …/bulk/delete`. */
const VERB_SEGMENTS: ReadonlyMap<string, readonly string[]> = new Map([['delete', ['delete', 'remove']]]);
/** Verbs that read, which a POST can do when its body says what to read, as a search or a bulk get does. */
const READS = new Set(['get', 'list']);

/** Why an operation's name needs a look, if it does: one reason per problem. */
export function namingProblems(
	groups: readonly string[],
	method: string,
	operation: Pick<ResolvedOperation, 'method' | 'route' | 'accountOrZone' | 'body'>,
): string[] {
	const problems: string[] = [];
	const verb = method.split('-').at(-1)!;
	const segment = operation.route.split('/').filter((part) => part !== '' && !part.startsWith('{')).at(-1);
	const allowed = VERB_METHODS.get(verb);
	const rpc = (VERB_SEGMENTS.get(verb) ?? [verb]).includes(segment ?? '');
	const readByPost = READS.has(verb) && operation.method === 'POST' && operation.body !== undefined;
	// A bulk method's body lists what it acts on, so a POST can carry any verb, as a bulk delete does.
	const bulkByPost = method.startsWith('bulk-') && operation.method === 'POST' && operation.body !== undefined;
	if (allowed && !allowed.includes(operation.method) && !rpc && !readByPost && !bulkByPost) {
		problems.push('its name says a verb its HTTP method does not do');
	}
	if (operation.accountOrZone && groups.some((group) => /^(account|zone)s?-/.test(group))) {
		problems.push('an account- or zone- group on a route that serves both');
	}
	if (groups.some((group) => method.startsWith(`${group}-`) || method.startsWith(`${group.replace(/s$/, '')}-`))) {
		problems.push('its method repeats its group');
	}
	return problems;
}
