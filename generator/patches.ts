/**
 * Corrections to the spec, each with the evidence for it.
 *
 * A patch that no longer applies stops generation, so a fix upstream retires
 * the patch rather than leaving it to rot. Paths are JSON pointers.
 */
import type { Pagination } from '../src/client.ts';
import { EXCLUSIVE_BODY, type OpenApiDocument, operationPointer, pointerGet, type Schema } from './spec.ts';

export interface SpecPatch {
	id: string;
	/** What was observed, and when. */
	evidence: string;
	pointer: string;
	/** Whether the node still has the defect this patch fixes. */
	applies: (node: Schema) => boolean;
	apply: (node: Schema) => void;
}

/** The prefix of an account-or-zone route. */
const AOZ = '/{account_or_zone}/{account_or_zone_id}';
const ARTIFACTS_RAW = operationPointer('/accounts/{account_id}/artifacts/namespaces/{namespace}/repos/{name}/raw/{ref}/{path}', 'get');

/** Domain Connect's routes as the spec writes them, and where the API serves them. */
const DOMAIN_CONNECT_ROUTES: Readonly<Record<string, string>> = {
	'/v2/{domain}/settings': '/dns/domainconnect/v2/{domain}/settings',
	'/v2/provconf/{provider}/{service}/{account}': '/dns/domainconnect/v2/provconf/{provider}/{service}/{account}',
	'/v2/domainTemplates/providers/{provider}/services/{service}':
		'/dns/domainconnect/v2/domainTemplates/providers/{provider}/services/{service}',
	'/v1/verify': '/dns/domainconnect/v2/verify',
};

/** Whether a path item, or an operation in it, declares servers of its own. */
function declaresServers(pathItem: Schema): boolean {
	return [pathItem, ...Object.values<unknown>(pathItem)].some(
		(node) => typeof node === 'object' && node !== null && !Array.isArray(node) && (node as Schema)['servers'] !== undefined,
	);
}

/** What a Logpush job has that its model leaves out. */
const LOGPUSH_JOB_FIELDS: readonly [string, Schema][] = [
	['filter', { $ref: '#/components/schemas/logpush_filter' }],
	['logstream', { type: 'boolean' }],
	['time_created', { description: 'When the job was created.', type: 'string' }],
];

const LOGPUSH_JOB_NOT_NULL =
	"The model and the list's items are both nullable, so every job listed is `LogpushJob | null`, but the list captured on 2026-11-07 held only objects. The single job's response declares its own result nullable, which stays.";

const MOVE_RULE =
	"A dry run of PATCH /zones/{id}/rulesets/{id}/rules/{id} with only a position was refused for its index alone, 20011, \"the rule is already in that position\", and one with only `enabled` for its missing action, 20015, 2026-11-08: a position alone moves a rule without changing it. Creating a rule shares the body, and needs the rule's action, so the update gets a body of its own.";

const RULE_ACTION_PARAMETERS =
	'Dry runs of POST /zones/{id}/rulesets on 2026-11-08 refused an unknown key in action_parameters with "invalid JSON: unknown field", for block, skip and the six actions that declare no parameters (challenge, js_challenge, managed_challenge, log, force_connection_close, ddos_dynamic), before checking the phase or the plan. Those six took {} or none, and the managed rulesets read from the playground zone send none for them.';

const R2_ONE_SELECTOR =
	'Temporary R2 credentials asked for with neither `permission` nor `actions`, or with both, got 400, 10040, "The JSON you provided was not well formed", on the playground account, 2026-11-20. Either alone got past that, to 401 for a made-up parent key. The descriptions say exactly one.';

const VERSION_PATCH_NULL_ENV =
	"Patching a probe Worker's latest version with `env: { NAME: null }` removed that binding and kept the other, on the playground account, 2026-11-20, as `env`'s description says. Creating a version shares the body, so the patch gets one of its own.";

const RULESET_WITHOUT_RULES =
	'An empty zone ruleset came back without rules from every read and write tried on the playground zone, 2026-11-08, including deleting its last rule. So did a managed ruleset read by a tag no rule has. All had version and last_updated.';

/** The result of a ruleset response, which requires `rules` that an empty ruleset leaves out. */
function rulesetRulesOptional(id: string, pointer: string): SpecPatch {
	return {
		id,
		evidence: RULESET_WITHOUT_RULES,
		pointer,
		applies: (node) => node['properties']?.['rules'] !== undefined && node['required']?.includes('rules') === true,
		apply: (node) => {
			node['required'] = (node['required'] as string[]).filter((name) => name !== 'rules');
		},
	};
}

/** The `position` a ruleset rule request body declares beside the rule. */
function positionOf(body: Schema | undefined): Schema | undefined {
	const branches = body?.['content']?.['application/json']?.['schema']?.['allOf'] as Schema[] | undefined;
	return branches?.find((branch) => branch['properties']?.['position'])?.['properties']['position'] as Schema | undefined;
}

/** The `allOf` branch of each ruleset rule variant that declares its `action`. */
function ruleActionBranches(schemas: Schema): Schema[] {
	const mapping: Record<string, string> = schemas['rulesets_RequestRule']?.['discriminator']?.['mapping'] ?? {};
	return Object.values(mapping).map((ref) => {
		const name = ref.replace('#/components/schemas/', '');
		const branch = (schemas[name]?.['allOf'] as Schema[] | undefined)?.find((member) => member['properties']?.['action']);
		if (branch === undefined) {
			throw new Error(`The ruleset rule ${name} no longer declares its action in an allOf branch; check rulesets-rule-action-required.`);
		}
		return branch;
	});
}

/** The 200 of a Browser Run dynamic script, which declares less than a script can return. */
function scriptOutput(path: string): string {
	return `${operationPointer(path, 'post')}/responses/200/content`;
}

/** The array branch of a dynamic script's `result`. */
function arrayBranch(result: Schema): Schema | undefined {
	return (result['anyOf'] as Schema[] | undefined)?.find((branch) => branch['type'] === 'array');
}

/** A dynamic script's `result`, whose array items leave out arrays. */
function scriptNestedArrays(id: string, path: string): SpecPatch {
	return {
		id,
		evidence:
			'A script returning [[1], [2, [3]], "x"] got it back as its result on the playground account, 2026-11-12, as the result\'s description says. Its array items leave out arrays.',
		pointer: `${scriptOutput(path)}/application~1json/schema/properties/result`,
		applies: (node) =>
			(arrayBranch(node)?.['items']?.['anyOf'] as Schema[] | undefined)?.every((branch) => branch['type'] !== 'array') === true,
		apply: (node) => {
			(arrayBranch(node)!['items']['anyOf'] as Schema[]).push({ nullable: true, type: 'array', items: {} });
		},
	};
}

/** A dynamic script's 200, which a `Response` the script returns answers in its own content type. */
function scriptEventStream(id: string, path: string): SpecPatch {
	return {
		id,
		evidence:
			"A Response a script returned as image/png came back as an image on the playground account, 2026-11-12, as the 200's description says a Response keeps its content type. So one returned as text/event-stream should be server-sent events, which the runtime reads as a stream. Not seen, as the tool used hides headers.",
		pointer: scriptOutput(path),
		applies: (node) => node['text/event-stream'] === undefined && node['application/octet-stream'] !== undefined,
		apply: (node) => {
			node['text/event-stream'] = {
				schema: { description: 'Server-sent events, from a script that returns them as a `Response`.', type: 'string' },
			};
		},
	};
}

export const SPEC_PATCHES: readonly SpecPatch[] = [
	{
		id: 'abuse-reports-list-null-reports',
		evidence:
			'GET /accounts/{id}/abuse-reports?per_page=1 returned {"reports":null} for an account with no reports, 2026-11-07.',
		pointer: `${operationPointer('/accounts/{account_id}/abuse-reports', 'get')}/responses/200/content/application~1json/schema/properties/result/properties/reports`,
		applies: (node) => node['type'] === 'array' && node['nullable'] !== true,
		apply: (node) => {
			node['nullable'] = true;
		},
	},
	{
		id: 'artifacts-raw-path-slashes',
		evidence:
			'Its description says "File path. May contain slashes.", so it needs the allowReserved that R2 object keys declare. Not called: the test account gets a 403 from Artifacts, 2026-11-07.',
		pointer: `${ARTIFACTS_RAW}/parameters/3`,
		applies: (node) => node['name'] === 'path' && node['in'] === 'path' && node['allowReserved'] !== true,
		apply: (node) => {
			node['allowReserved'] = true;
		},
	},
	{
		id: 'artifacts-raw-always-bytes',
		evidence:
			'The response says "File bytes with sniffed Content-Type", so its media types are what a file can be, and a JSON file is still a file. Its application/json schema is a plain string. Not called, as above.',
		pointer: `${ARTIFACTS_RAW}/responses/200/content`,
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
	scriptNestedArrays('browser-run-script-create-nested-arrays', '/accounts/{account_id}/browser-rendering/script'),
	scriptNestedArrays('browser-run-script-execute-nested-arrays', '/accounts/{account_id}/browser-rendering/script/{session_id}'),
	scriptEventStream('browser-run-script-create-event-stream', '/accounts/{account_id}/browser-rendering/script'),
	scriptEventStream('browser-run-script-execute-event-stream', '/accounts/{account_id}/browser-rendering/script/{session_id}'),
	{
		id: 'builds-by-version-key',
		evidence:
			"GET /accounts/{id}/builds/builds with 10 version IDs returned { builds } with a build under each ID asked for, and none of the builds had a worker_version_id, 2026-11-08. The spec doesn't say what the key is.",
		pointer: '/components/schemas/builds_BuildsByVersionResponse/properties/builds',
		applies: (node) => node['description'] === undefined && node['additionalProperties'] !== undefined,
		apply: (node) => {
			node['description'] = "Each build under the ID of the Worker version it was asked for, as a build doesn't name its version.";
		},
	},
	{
		id: 'dns-domainconnect-routes',
		evidence:
			'Under /dns/domainconnect, which the API gives as its urlAPI, GET v2/setuna.top/settings returned its settings and made-up providers and templates got "unknown provider" and "unknown template", 2026-11-12. The spec\'s routes got 404, "No route for that URI", and so did v1/verify under the prefix. v2/verify reads v1\'s body: made-up domain, hash and sig got 403, "unknown public key domain", and the same without sig got 400, "POST data is incomplete".',
		pointer: '/paths',
		// Not once a route declares servers, which would be a fix too, and would leave the moved operations out.
		applies: (node) =>
			Object.entries(DOMAIN_CONNECT_ROUTES).every(
				([from, to]) => node[from] !== undefined && node[to] === undefined && !declaresServers(node[from] as Schema),
			),
		apply: (node) => {
			for (const [from, to] of Object.entries(DOMAIN_CONNECT_ROUTES)) {
				node[to] = node[from];
				delete node[from];
			}
		},
	},
	{
		id: 'logpush-job-undeclared-fields',
		evidence:
			'GET /accounts/{id}/logpush/jobs returned filter (a string), logstream (a boolean) and time_created (a string) on each job, none of them declared, 2026-11-07. The request bodies declare filter.',
		pointer: '/components/schemas/logpush_logpush_job/properties',
		// Only while the spec declares none of them, so declaring one stops generation, to narrow it.
		applies: (node) => LOGPUSH_JOB_FIELDS.every(([name]) => node[name] === undefined),
		apply: (node) => {
			for (const [name, schema] of LOGPUSH_JOB_FIELDS) {
				node[name] = schema;
			}
		},
	},
	{
		id: 'logpush-job-not-nullable',
		evidence: LOGPUSH_JOB_NOT_NULL,
		pointer: '/components/schemas/logpush_logpush_job',
		applies: (node) => node['nullable'] === true,
		apply: (node) => {
			delete node['nullable'];
		},
	},
	{
		id: 'logpush-job-list-items-not-nullable',
		evidence: LOGPUSH_JOB_NOT_NULL,
		pointer: '/components/schemas/logpush_logpush_job_response_collection/allOf/1/properties/result/items',
		applies: (node) => node['nullable'] === true,
		apply: (node) => {
			delete node['nullable'];
		},
	},
	{
		id: 'r2-temp-access-creds-one-selector',
		evidence: R2_ONE_SELECTOR,
		pointer: '/components/schemas/r2_temp_access_creds_request',
		applies: (node) =>
			node['oneOf'] === undefined &&
			Array.isArray(node['required']) &&
			node['properties']?.['permission'] !== undefined &&
			node['properties']?.['actions'] !== undefined &&
			!['permission', 'actions'].some((name) => node['required']?.includes(name)),
		apply: (node) => {
			const { permission, actions, ...shared } = node['properties'] as Record<string, Schema>;
			const required = node['required'] as string[];
			const member = (name: string, field: Schema): Schema => ({
				type: 'object',
				properties: { ...structuredClone(shared), [name]: field },
				required: [...required, name],
			});
			node['oneOf'] = [member('permission', permission!), member('actions', actions!)];
			delete node['type'];
			delete node['properties'];
			delete node['required'];
		},
	},
	{
		id: 'rulesets-rule-action-required',
		evidence:
			'A dry run of POST /zones/{id}/rulesets with a rule that has no action failed with 20015, "the action is required to create or update a rule", 2026-11-08. RequestRule also names action as its discriminator, which OpenAPI requires in each variant.',
		pointer: '/components/schemas',
		applies: (node) => ruleActionBranches(node).some((branch) => !branch['required']?.includes('action')),
		apply: (node) => {
			for (const branch of ruleActionBranches(node)) {
				if (!branch['required']?.includes('action')) {
					branch['required'] = [...(branch['required'] ?? []), 'action'];
				}
			}
		},
	},
	{
		id: 'rulesets-rule-action-parameters-closed',
		evidence: `${RULE_ACTION_PARAMETERS} The base Rule declares action_parameters as any object, which every variant shares, so no key in it was checked. Each variant that takes parameters declares its own.`,
		pointer: '/components/schemas/rulesets_Rule/properties',
		applies: (node) => {
			const parameters = node['action_parameters'] as Schema | undefined;
			return parameters?.['type'] === 'object' && parameters['properties'] === undefined && parameters['additionalProperties'] === undefined;
		},
		apply: (node) => {
			delete node['action_parameters'];
		},
	},
	{
		id: 'rulesets-rule-move-body',
		evidence: MOVE_RULE,
		pointer: '/components/requestBodies',
		applies: (node) => node['rulesets_RuleUpdate'] === undefined && positionOf(node['rulesets_Rule']) !== undefined,
		apply: (node) => {
			const rule = structuredClone(node['rulesets_Rule'] as Schema);
			const schema = rule['content']['application/json']['schema'];
			rule['content']['application/json']['schema'] = {
				oneOf: [
					schema,
					{
						description: 'Moves the rule without changing it.',
						type: 'object',
						properties: { position: structuredClone(positionOf(node['rulesets_Rule'])) },
						required: ['position'],
					},
				],
			};
			node['rulesets_RuleUpdate'] = rule;
		},
	},
	{
		id: 'rulesets-rule-move-only',
		evidence: MOVE_RULE,
		pointer: operationPointer(`${AOZ}/rulesets/{ruleset_id}/rules/{rule_id}`, 'patch'),
		applies: (node) => node['requestBody']?.['$ref'] === '#/components/requestBodies/rulesets_Rule',
		apply: (node) => {
			node['requestBody'] = { $ref: '#/components/requestBodies/rulesets_RuleUpdate' };
			// So a body with a position and any field of a rule is a whole rule, needing its action.
			node[EXCLUSIVE_BODY] = true;
		},
	},
	rulesetRulesOptional(
		'rulesets-ruleset-rules-optional',
		'/components/responses/rulesets_Ruleset/content/application~1json/schema/allOf/1/properties/result/allOf/1',
	),
	rulesetRulesOptional(
		'rulesets-ruleset-or-dry-run-rules-optional',
		'/components/responses/rulesets_RulesetOrDryRun/content/application~1json/schema/allOf/1/properties/result/oneOf/0/allOf/1',
	),
	{
		id: 'stream-webhook-notification-url',
		evidence:
			"The body requires notificationUrl or notification_url but declares only notification_url, which the spec hides from SDKs. Stream's webhook docs send notificationUrl, and the response declares it. Not called: the playground account has no Stream, 2026-11-12.",
		pointer: '/components/schemas/stream_webhook_request',
		applies: (node) =>
			node['properties']?.['notificationUrl'] === undefined &&
			node['properties']?.['notification_url']?.['x-stainless-skip'] === true &&
			(node['anyOf'] as Schema[] | undefined)?.some((branch) => branch['required']?.includes('notificationUrl')) === true,
		apply: (node) => {
			const field = structuredClone(node['properties']['notification_url'] as Schema);
			delete field['x-fern-ignore'];
			delete field['x-stainless-skip'];
			node['properties']['notificationUrl'] = field;
			// The SDK spelling is the only one left, so it's the one required.
			node['required'] = [...((node['required'] as string[] | undefined) ?? []), 'notificationUrl'];
			delete node['anyOf'];
		},
	},
	{
		id: 'workers-version-patch-body',
		evidence: VERSION_PATCH_NULL_ENV,
		pointer: '/components/schemas',
		applies: (node) =>
			node['workers_VersionPatch'] === undefined &&
			node['workers_Version']?.['properties']?.['env']?.['allOf']?.[0]?.['$ref'] === '#/components/schemas/workers_env',
		apply: (node) => {
			const version = structuredClone(node['workers_Version'] as Schema);
			const env = version['properties']['env'] as Schema;
			delete env['allOf'];
			env['type'] = 'object';
			env['additionalProperties'] = { allOf: [{ $ref: '#/components/schemas/workers_env_binding_item' }], nullable: true };
			node['workers_VersionPatch'] = version;
		},
	},
	{
		id: 'workers-version-patch-only',
		evidence: VERSION_PATCH_NULL_ENV,
		pointer: `${operationPointer('/accounts/{account_id}/workers/workers/{worker_id}/versions/latest', 'patch')}/requestBody/content`,
		applies: (node) =>
			Object.keys(node).length > 0 &&
			Object.values<Schema>(node).every((content) => content['schema']?.['allOf']?.[0]?.['$ref'] === '#/components/schemas/workers_Version'),
		apply: (node) => {
			for (const content of Object.values<Schema>(node)) {
				content['schema'] = { $ref: '#/components/schemas/workers_VersionPatch' };
			}
		},
	},
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

/**
 * Query parameters the spec declares as a string its description calls a list separated by
 * commas, in whatever words, by `METHOD /path`. Each becomes a list of strings, which the
 * runtime sends joined with commas. Another is added after reading its description, as some
 * of the 52 such strings aren't plain lists: Workers' `tags` takes `tag:yes` pairs, a `status`
 * can be `all`, and Page Shield's `urls` takes URLs encoded beforehand. The runtime sends the
 * joining comma encoded, as `%2C`, which Builds splits: two version UUIDs so joined passed its
 * check of each UUID, and the same two with the text `%2C` between them failed it, on 2026-11-08.
 * An entry whose parameter isn't such a string stops generation.
 */
export const COMMA_LISTS: Readonly<Record<string, readonly string[]>> = {
	'GET /accounts/{account_id}/builds/builds': ['version_ids'],
	'GET /accounts/{account_id}/builds/builds/latest': ['external_script_ids'],
};

/**
 * Models the spec declares as a `oneOf` whose members have only their own fields, by schema
 * name, with the evidence. Each member says the fields only the others have are absent, as
 * `x-sdk-exclusive-body` does for a body, so code can read such a field on any member and a value
 * with another member's field is a compile error. One that isn't a `oneOf`, or isn't printed,
 * stops generation.
 */
export const EXCLUSIVE_MODELS: Readonly<Record<string, string>> = {
	// A patch makes it a oneOf.
	r2_temp_access_creds_request: R2_ONE_SELECTOR,
	rulesets_RequestRule: `${RULE_ACTION_PARAMETERS} A managed_challenge rule saved with action_parameters {} on the playground zone, 2026-11-08, came back without the field, in the write's response and when read. So a rule whose action takes no parameters has none, sent or read, which action_parameters?: never says.`,
};

/**
 * Operations that a request with `dry_run: true` only validates, answering with a `null` result,
 * by `METHOD /path`. Their result types keep that `null`, and `send` leaves it out of a request
 * that isn't a dry run. Their `dry_run` says so, and a dry run of a rule's create and update
 * returned `result: null` on 2026-11-08. A ruleset's DELETE answers 204 either way. An entry that
 * isn't generated, has no boolean `dry_run` or no `null` result stops generation.
 */
export const DRY_RUNS: readonly string[] = [
	`POST ${AOZ}/rulesets`,
	`PUT ${AOZ}/rulesets/phases/{ruleset_phase}/entrypoint`,
	`PUT ${AOZ}/rulesets/{ruleset_id}`,
	`POST ${AOZ}/rulesets/{ruleset_id}/rules`,
	`DELETE ${AOZ}/rulesets/{ruleset_id}/rules/{rule_id}`,
	`PATCH ${AOZ}/rulesets/{ruleset_id}/rules/{rule_id}`,
];

const REPLACED_BY_V2 = 'Replaced by the generally available /v2/ route, whose group takes this name.';
const USE_SINGULAR_PATH = 'Its description says to use the singular /zones/{zone_id}/subscription path instead.';

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
};

const SETTING_ID_REACHES_IT =
	"The spec names neither the group nor the method. zones.settings.get and edit reach the same URL with setting_id 'nel', as their setting_id takes any string.";

/**
 * Operations the spec gives no group or method name that stay out, by `METHOD /path`, each
 * with the reason. Forge would name such an operation by its `operationId` outside any
 * group, which has no import path, so one that isn't listed stops generation, and so does
 * an entry that no longer matches one.
 */
export const UNNAMED_OPERATIONS: Readonly<Record<string, string>> = {
	'GET /zones/{zone_id}/settings/nel': SETTING_ID_REACHES_IT,
	'PATCH /zones/{zone_id}/settings/nel': SETTING_ID_REACHES_IT,
};

export interface OperationRename {
	/** The spec's name, as `group.method` in its own spelling. Generation stops once the spec names it otherwise. */
	from: string;
	/** The new name, spelt the same way. */
	to: string;
	reason: string;
}

const SERVES_ZONES =
	"The group's `account-` dates from before the account and zone routes were merged, and the route serves both. The new name is the official SDK's, where it has one.";
const VALIDATES =
	'Besides its `account-` group, as above, its method names a verb it does not do: it validates, by POST. The new name is the official SDK\'s.';

const CLOUDFORCE_REQUESTS = '/accounts/{account_id}/cloudforce-one/requests';
const REPEATS_GROUP =
	"Hidden in the spec, where a name is never shown, and it repeats its group, as `cloudforceOneRequestGet`. The new name is the official SDK's.";

function renames(
	reason: string,
	entries: readonly (readonly [key: string, from: string, to: string])[],
): [key: string, rename: OperationRename][] {
	return entries.map(([key, from, to]) => [key, { from, to, reason }]);
}

/** Entries by key, stopping on a key given twice, which would otherwise keep only the last. */
export function byKey<T>(table: string, entries: readonly (readonly [key: string, value: T])[]): Record<string, T> {
	const record: Record<string, T> = {};
	for (const [key, value] of entries) {
		if (Object.hasOwn(record, key)) {
			throw new Error(`${table} gives ${key} twice`);
		}
		record[key] = value;
	}
	return record;
}

/**
 * New names, by `METHOD /path`, for names the spec gets wrong. Names otherwise come
 * from the spec's `x-fern-sdk-group-name` and `x-fern-sdk-method-name`, as in cf.
 * An entry whose operation is gone, or that the spec now names otherwise, stops
 * generation, so an upstream fix retires it.
 */
export const OPERATION_RENAMES: Readonly<Record<string, OperationRename>> = byKey('OPERATION_RENAMES', [
	[
		'POST /accounts/{account_id}/email-security/investigate/{investigate_id}/move',
		{
			from: 'email-security.investigate.move.create',
			to: 'email-security.investigate.move-one',
			reason:
				'Hidden, and its own name needs a group named `move` beside the visible method of that name, which moves messages in bulk.',
		},
	],
	...renames(SERVES_ZONES, [
		[`POST ${AOZ}/custom_pages/assets`, 'custom-pages.account-assets.create', 'custom-pages.assets.create'],
		[`DELETE ${AOZ}/custom_pages/assets/{asset_name}`, 'custom-pages.account-assets.delete', 'custom-pages.assets.delete'],
		[`GET ${AOZ}/custom_pages/assets/{asset_name}`, 'custom-pages.account-assets.get', 'custom-pages.assets.get'],
		[`GET ${AOZ}/custom_pages/assets`, 'custom-pages.account-assets.list', 'custom-pages.assets.list'],
		[`PUT ${AOZ}/custom_pages/assets/{asset_name}`, 'custom-pages.account-assets.update', 'custom-pages.assets.update'],
		[`GET ${AOZ}/custom_pages/{identifier}`, 'custom-pages.account-custom-pages.get', 'custom-pages.get'],
		[`GET ${AOZ}/custom_pages`, 'custom-pages.account-custom-pages.list', 'custom-pages.list'],
		[`PUT ${AOZ}/custom_pages/{identifier}`, 'custom-pages.account-custom-pages.update', 'custom-pages.update'],
		[
			`POST ${AOZ}/custom_pages/preview_tokens`,
			'custom-pages.account-custom-pages.preview-tokens.create',
			'custom-pages.preview-tokens.create',
		],
		[`GET ${AOZ}/logpush/datasets/{dataset_id}/fields`, 'logpush.account-datasets.fields.get', 'logpush.datasets.fields.get'],
		[`GET ${AOZ}/logpush/datasets/{dataset_id}/jobs`, 'logpush.account-datasets.jobs.get', 'logpush.datasets.jobs.get'],
		[`POST ${AOZ}/logpush/jobs`, 'logpush.account-jobs.create', 'logpush.jobs.create'],
		[`DELETE ${AOZ}/logpush/jobs/{job_id}`, 'logpush.account-jobs.delete', 'logpush.jobs.delete'],
		[`GET ${AOZ}/logpush/jobs/{job_id}`, 'logpush.account-jobs.get', 'logpush.jobs.get'],
		[`GET ${AOZ}/logpush/jobs`, 'logpush.account-jobs.list', 'logpush.jobs.list'],
		[`PUT ${AOZ}/logpush/jobs/{job_id}`, 'logpush.account-jobs.update', 'logpush.jobs.update'],
		[`POST ${AOZ}/logpush/ownership`, 'logpush.account-ownership.create', 'logpush.ownership.create'],
		[`POST ${AOZ}/logpush/ownership/validate`, 'logpush.account-ownership.validate.create', 'logpush.ownership.validate'],
		[`POST ${AOZ}/monetization`, 'monetization.account-eligibility.check', 'monetization.eligibility.check'],
		[`GET ${AOZ}/monetization`, 'monetization.account-eligibility.get', 'monetization.eligibility.get'],
		// Beside `tags.resources.list`, which lists the tagged resources: these read and write the tags
		// of the account or zone named.
		[`DELETE ${AOZ}/tags`, 'tags.account-resources.delete', 'tags.resources.delete'],
		[`GET ${AOZ}/tags`, 'tags.account-resources.get', 'tags.resources.get'],
		[`PUT ${AOZ}/tags`, 'tags.account-resources.update', 'tags.resources.update'],
		[`GET ${AOZ}/waiting_rooms`, 'waiting-rooms.account-waiting-rooms.list', 'waiting-rooms.list'],
	]),
	...renames(REPEATS_GROUP, [
		[
			`GET ${CLOUDFORCE_REQUESTS}/{request_id}`,
			'cloudforce-one.requests.cloudforceOneRequestGet',
			'cloudforce-one.requests.get',
		],
		[`POST ${CLOUDFORCE_REQUESTS}`, 'cloudforce-one.requests.cloudforceOneRequestList', 'cloudforce-one.requests.list'],
		[`POST ${CLOUDFORCE_REQUESTS}/new`, 'cloudforce-one.requests.cloudforceOneRequestNew', 'cloudforce-one.requests.create'],
		[
			`PUT ${CLOUDFORCE_REQUESTS}/{request_id}`,
			'cloudforce-one.requests.cloudforceOneRequestUpdate',
			'cloudforce-one.requests.update',
		],
	]),
	...renames(VALIDATES, [
		[
			`POST ${AOZ}/logpush/validate/destination/exists`,
			'logpush.account-validate.destination-exists-delete',
			'logpush.validate.destination-exists',
		],
		[`POST ${AOZ}/logpush/validate/destination`, 'logpush.account-validate.destination.delete', 'logpush.validate.destination'],
		[`POST ${AOZ}/logpush/validate/origin`, 'logpush.account-validate.origin.create', 'logpush.validate.origin'],
	]),
]);

/**
 * Pagination the spec's shape can't decide, by `METHOD /path`. Some pages hold more
 * than one array, and the override names the one that is paged. Others declare a
 * cursor that only an empty one on the first request starts, and page by number
 * otherwise, so the override names the cursors to follow when the caller sends one. An
 * entry whose operation is gone, now states its own pagination, or no longer has that
 * array or a cursor stops generation.
 */
export const PAGINATION_OVERRIDES: Readonly<Record<string, Pagination>> = {
	'GET /radar/bgp/hijacks/events': { kind: 'page', items: 'events' },
	'GET /radar/bgp/leaks/events': { kind: 'page', items: 'events' },
	// Without a cursor, the API pages by number and sends no cursor back. With one, even
	// empty, it refuses a page number beside it, 9241. `prev_cursor` goes back, and the
	// first page has none (live, 2026-11-20).
	'GET /zones/{zone_id}/dns_records': {
		kind: 'page',
		cursors: [
			{ param: 'cursor', next: 'cursor' },
			{ param: 'prev_cursor', next: 'prev_cursor' },
		],
	},
};
