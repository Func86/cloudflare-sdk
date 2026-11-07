/**
 * Corrections to the spec, each with the evidence for it.
 *
 * A patch that no longer applies stops generation, so a fix upstream retires
 * the patch rather than leaving it to rot. Paths are JSON pointers.
 */
import type { Pagination } from '../src/client.ts';
import { type OpenApiDocument, pointerGet, type Schema } from './spec.ts';

export interface SpecPatch {
	id: string;
	/** What was observed, and when. */
	evidence: string;
	pointer: string;
	/** Whether the node still has the defect this patch fixes. */
	applies: (node: Schema) => boolean;
	apply: (node: Schema) => void;
}

const ARTIFACTS_RAW = '/paths/~1accounts~1{account_id}~1artifacts~1namespaces~1{namespace}~1repos~1{name}~1raw~1{ref}~1{path}';

/** A response declared under the media type `string`, which isn't one, for a Worker's script source. */
function scriptSourceAsText(id: string, path: string): SpecPatch {
	return {
		id,
		evidence:
			'"string" isn\'t a media type. The schema is a string whose example is a Worker\'s JavaScript, so it\'s text, as the generator read it before. The Content-Type the API sends wasn\'t checked.',
		pointer: `/paths/${path.replaceAll('/', '~1')}/get/responses/200/content`,
		applies: (node) => node['string'] !== undefined && node['text/plain'] === undefined,
		apply: (node) => {
			node['text/plain'] = node['string'];
			delete node['string'];
		},
	};
}

export const SPEC_PATCHES: readonly SpecPatch[] = [
	{
		id: 'abuse-reports-list-null-reports',
		evidence:
			'GET /accounts/{id}/abuse-reports?per_page=1 returned {"reports":null} for an account with no reports, 2026-11-07.',
		pointer:
			'/paths/~1accounts~1{account_id}~1abuse-reports/get/responses/200/content/application~1json/schema/properties/result/properties/reports',
		applies: (node) => node['type'] === 'array' && node['nullable'] !== true,
		apply: (node) => {
			node['nullable'] = true;
		},
	},
	{
		id: 'artifacts-raw-path-slashes',
		evidence:
			'Its description says "File path. May contain slashes.", so it needs the allowReserved that R2 object keys declare. Not called: the test account gets a 403 from Artifacts, 2026-11-07.',
		pointer: `${ARTIFACTS_RAW}/get/parameters/3`,
		applies: (node) => node['name'] === 'path' && node['in'] === 'path' && node['allowReserved'] !== true,
		apply: (node) => {
			node['allowReserved'] = true;
		},
	},
	{
		id: 'artifacts-raw-always-bytes',
		evidence:
			'The response says "File bytes with sniffed Content-Type", so its media types are what a file can be, and a JSON file is still a file. Its application/json schema is a plain string. Not called, as above.',
		pointer: `${ARTIFACTS_RAW}/get/responses/200/content`,
		applies: (node) => node['application/json']?.schema?.type === 'string' && node['application/octet-stream'] !== undefined,
		apply: (node) => {
			for (const mediaType of Object.keys(node)) {
				if (mediaType !== 'application/octet-stream') {
					delete node[mediaType];
				}
			}
		},
	},
	{
		id: 'api-shield-operation-not-nullable',
		evidence:
			'A nullable branch of an allOf makes the whole nullable, as generator/prepare.ts reads it, so every listed operation, and the one created or read, would be `Operation | null`. The branch only adds `features`, with a default of {}, so its `nullable` reads as being about that. Read from the spec\'s shape; not called.',
		pointer: '/components/schemas/api-shield_operation/allOf/1',
		applies: (node) => node['nullable'] === true && node['properties']?.['features'] !== undefined,
		apply: (node) => {
			delete node['nullable'];
		},
	},
	scriptSourceAsText('worker-script-content-text', '/accounts/{account_id}/workers/scripts/{script_name}/content/v2'),
	scriptSourceAsText(
		'dispatch-script-content-text',
		'/accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/content',
	),
];

/** Applies the patches, and stops when one of them no longer applies. */
export function applyPatches(doc: OpenApiDocument): void {
	for (const patch of SPEC_PATCHES) {
		const node = pointerGet(doc, patch.pointer) as Schema | undefined;
		if (node === undefined || !patch.applies(node)) {
			throw new Error(`The spec patch ${patch.id} no longer applies. Check whether it was fixed upstream, and remove it.`);
		}
		patch.apply(node);
	}
}

const REPLACED_BY_V2 = 'Replaced by the generally available /v2/ route, whose group takes this name.';
const USE_SINGULAR_PATH = 'Its description says to use the singular /zones/{zone_id}/subscription path instead.';
const PILOT_ONLY = 'Alpha, and its description says it is available only to one pilot account behind a gate.';

/**
 * Operations the spec marks `x-fern-ignore` that stay out, by `METHOD /path`, each
 * with the reason. The mark says nothing about whether an operation works, and
 * Libreflare calls one, so an operation that isn't deprecated is generated unless
 * it's listed here. An entry that no longer matches stops generation.
 */
export const EXCLUDED_IGNORED: Readonly<Record<string, string>> = {
	'GET /accounts/{account_id}/cloudforce-one/requests/constants': REPLACED_BY_V2,
	'GET /accounts/{account_id}/cloudforce-one/requests/quota': REPLACED_BY_V2,
	'GET /accounts/{account_id}/cloudforce-one/requests/types': REPLACED_BY_V2,
	'PUT /zones/{zone_id}/subscriptions': USE_SINGULAR_PATH,
	'DELETE /zones/{zone_id}/subscriptions': USE_SINGULAR_PATH,
	'GET /accounts/{account_id}/email/domain-changes': PILOT_ONLY,
	'GET /accounts/{account_id}/email/domains': PILOT_ONLY,
	'POST /accounts/{account_id}/email/domains': PILOT_ONLY,
	'GET /accounts/{account_id}/email/domains/{email_domain_id}': PILOT_ONLY,
	'DELETE /accounts/{account_id}/email/domains/{email_domain_id}': PILOT_ONLY,
	'POST /accounts/{account_id}/email/domains/{email_domain_id}/verify': PILOT_ONLY,
};

export interface OperationRename {
	/** The new dotted group, when the operation moves to another one. */
	group?: string;
	method: string;
}

/**
 * New names for operations marked `x-fern-ignore` whose own names would collide
 * with a visible operation, by `METHOD /path`. Only hidden operations are renamed,
 * so a visible name never changes. An entry that no longer matches stops generation.
 */
export const OPERATION_RENAMES: Readonly<Record<string, OperationRename>> = {
	// Its own name, `email-security.investigate.move.create`, needs a group named
	// `move` beside the visible method of that name, which moves messages in bulk.
	'POST /accounts/{account_id}/email-security/investigate/{investigate_id}/move': {
		group: 'email-security.investigate',
		method: 'move-one',
	},
};

/**
 * Pagination the spec's shape can't decide, by `METHOD /path`. These pages hold
 * more than one array, and the override names the one that is paged. An entry
 * whose operation is gone, now states its own pagination, or no longer has that
 * array stops generation.
 */
export const PAGINATION_OVERRIDES: Readonly<Record<string, Pagination>> = {
	'GET /radar/bgp/hijacks/events': { kind: 'page', items: 'events' },
	'GET /radar/bgp/leaks/events': { kind: 'page', items: 'events' },
};
