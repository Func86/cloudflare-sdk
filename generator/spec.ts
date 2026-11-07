/** Reading the OpenAPI document: local references, and the Cloudflare envelope. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an OpenAPI node is read by shape
export type Schema = { [key: string]: any };

export interface OpenApiDocument {
	paths: Record<string, Record<string, Schema>>;
	components: { schemas: Record<string, Schema> } & Record<string, Record<string, Schema>>;
	[key: string]: unknown;
}

/** The extension `prepare` adds for the plugin, naming the path parameters that keep their slashes. */
export const LITERAL_SLASHES = 'x-sdk-literal-slashes';
/**
 * The extension a spec patch adds for the plugin: the operation's body is one of its alternatives
 * only, as `oneOf` says, so a field one of them declares is absent from the others.
 */
export const EXCLUSIVE_BODY = 'x-sdk-exclusive-body';

/** Reads the node at a JSON pointer, as `#/a/b` or `/a/b`. */
export function pointerGet(doc: unknown, pointer: string): unknown {
	let current = doc;
	for (const raw of pointer.replace(/^#?\//, '').split('/')) {
		const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
		if (typeof current !== 'object' || current === null) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export class Spec {
	readonly doc: OpenApiDocument;

	constructor(doc: OpenApiDocument) {
		this.doc = doc;
	}

	/** Follows a chain of references to the node it ends at. */
	deref(node: Schema | undefined): Schema {
		let current = node ?? {};
		const seen = new Set<string>();
		while (typeof current['$ref'] === 'string' && !seen.has(current['$ref'])) {
			seen.add(current['$ref']);
			current = (pointerGet(this.doc, current['$ref']) as Schema | undefined) ?? {};
		}
		return current;
	}

	/**
	 * The properties a composed schema ends up with. Later `allOf` branches and
	 * the schema's own properties override earlier ones: the envelope bases
	 * declare a generic `result`, and each operation refines it.
	 */
	flatProperties(schema: Schema | undefined, into: Record<string, Schema> = {}, depth = 0): Record<string, Schema> {
		const resolved = this.deref(schema);
		if (depth > 16) {
			return into;
		}
		for (const branch of resolved['allOf'] ?? []) {
			this.flatProperties(branch, into, depth + 1);
		}
		for (const [name, value] of Object.entries<Schema>(resolved['properties'] ?? {})) {
			if (!(name in into) || Object.keys(value).length > 0) {
				into[name] = value;
			}
		}
		return into;
	}
}
