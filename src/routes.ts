/**
 * The route prefix of an operation for an account or a zone. The generator marks each
 * operation whose route starts with it, and the runtime fills it from the request's
 * `account_id` or `zone_id`, so the two agree. It isn't part of the package's exports.
 */
export const ACCOUNT_OR_ZONE = '/{account_or_zone}/{account_or_zone_id}';

/** The rest of a route after an account-or-zone prefix, or undefined if it doesn't start with one. */
export function afterAccountOrZone(route: string): string | undefined {
	return route === ACCOUNT_OR_ZONE || route.startsWith(`${ACCOUNT_OR_ZONE}/`) ? route.slice(ACCOUNT_OR_ZONE.length) : undefined;
}
