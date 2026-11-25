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
 * The extension `prepare` adds for the plugin to an operation that takes the account or the zone:
 * the token permissions for each, as `{ account?: string[]; zone?: string[] }`, any one of which it takes.
 */
export const SCOPED_PERMISSIONS = 'x-sdk-scoped-permissions';
/**
 * The extension a spec patch adds for the plugin: the operation's body is one of its alternatives
 * only, as `oneOf` says, so a field one of them declares is absent from the others.
 */
export const EXCLUSIVE_BODY = 'x-sdk-exclusive-body';
/**
 * The extensions of an operation that the plugin reads, or that Forge reads for it, as it does
 * the availability, which `prepare` gives its aliases too.
 */
export const OPERATION_EXTENSIONS = [
	EXCLUSIVE_BODY,
	LITERAL_SLASHES,
	SCOPED_PERMISSIONS,
	'x-api-token-group',
	'x-cfDeprecation',
	'x-fern-availability',
	'x-fern-pagination',
	'x-forge-sunset',
	'x-stainless-deprecation-message',
] as const;

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

/** The JSON pointer to a route's path item, such as `/paths/~1zones` for `/zones`. */
export function pathPointer(route: string): string {
	return `/paths/${route.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/** The JSON pointer to an operation, such as `/paths/~1zones/get` for `GET /zones`. */
export function operationPointer(route: string, verb: string): string {
	return `${pathPointer(route)}/${verb}`;
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
			if (!Object.hasOwn(into, name) || Object.keys(value).length > 0) {
				into[name] = value;
			}
		}
		return into;
	}
}
