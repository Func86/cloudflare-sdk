/**
 * Compares the operation names of two outputs, so that a spec bump shows which names
 * it changes. A renamed or removed operation breaks every call that imports it.
 */

/** An operation in `_meta/operations.json`. */
export interface ManifestEntry {
	id: string;
	method: string;
	route: string;
}

export interface NameChanges {
	/** Names gone from a route that has new names, by the names gone and the new ones. */
	renamed: [from: string, to: string][];
	/** Names gone from a route that has no new name, one by one. */
	removed: string[];
	/** New names on a route that lost none. */
	added: string[];
}

/** The names of the entries that aren't in `others`, by `METHOD /route`. */
function namesByRoute(entries: readonly ManifestEntry[], others: ReadonlySet<string>): Map<string, string[]> {
	const names = new Map<string, string[]>();
	for (const entry of entries) {
		if (!others.has(entry.id)) {
			const key = `${entry.method} ${entry.route}`;
			names.set(key, [...(names.get(key) ?? []), entry.id]);
		}
	}
	return names;
}

/**
 * The lines that report changes against `baseline`: the counts, then each name renamed or
 * removed, which break the calls that import them, so they go in the release notes.
 */
export function reportNameChanges(changes: NameChanges, baseline: string): string[] {
	return [
		`names against ${baseline}: ${changes.renamed.length} renamed, ${changes.removed.length} removed, ${changes.added.length} added`,
		...changes.renamed.map(([from, to]) => `  renamed ${from} -> ${to}`),
		...changes.removed.map((name) => `  removed ${name}`),
	];
}

/**
 * Compares by name, as a call imports an operation by its name: a name in both outputs is
 * unchanged, whatever route it moved to. A route that lost names and has new ones renamed
 * them; an alias puts one operation under several names.
 */
export function nameChanges(before: readonly ManifestEntry[], after: readonly ManifestEntry[]): NameChanges {
	const gone = namesByRoute(before, new Set(after.map((entry) => entry.id)));
	const fresh = namesByRoute(after, new Set(before.map((entry) => entry.id)));
	const changes: NameChanges = { renamed: [], removed: [], added: [] };
	for (const [key, names] of gone) {
		const now = fresh.get(key);
		if (now === undefined) {
			changes.removed.push(...names);
		} else {
			changes.renamed.push([names.sort().join(', '), now.sort().join(', ')]);
		}
	}
	for (const [key, names] of fresh) {
		if (!gone.has(key)) {
			changes.added.push(...names);
		}
	}
	return changes;
}
