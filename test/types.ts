/**
 * Compile-time checks, run by `npm run check:type`. Each `@ts-expect-error` is a
 * mistake the types must reject: tsc fails if one of them stops being an error.
 */
import { createClient, type AccountOrZone, type ApiError, type Client, type Operation } from '@libreflare/cloudflare-sdk';
import { createMockClient, withResultInfo } from '@libreflare/cloudflare-sdk/testing';
import { get as getEntitlements } from '@libreflare/cloudflare-sdk/accounts/entitlements';
import { list as listModels } from '@libreflare/cloudflare-sdk/ai/models';
import { create as createWatermark } from '@libreflare/cloudflare-sdk/stream/watermarks';
import { update as updateWebhook } from '@libreflare/cloudflare-sdk/stream/webhooks';
import type { CreateResult as ScriptResult, ExecuteResult as SessionScriptResult } from '@libreflare/cloudflare-sdk/browser-run/script';
import { get as getRawFile } from '@libreflare/cloudflare-sdk/artifacts/namespaces/repos/raw';
import { screenshot } from '@libreflare/cloudflare-sdk/browser-run/quick-action';
import { create as createImage, list as listImages } from '@libreflare/cloudflare-sdk/images';
import { get as getQueueMetrics } from '@libreflare/cloudflare-sdk/queues/metrics';
import { create as createScan } from '@libreflare/cloudflare-sdk/url-scanner/scans';
import { list as listListItems } from '@libreflare/cloudflare-sdk/rules/lists/items';
import type { Item as ListItem } from '@libreflare/cloudflare-sdk/types/lists';
import { put as putKey } from '@libreflare/cloudflare-sdk/kv/keys';
import { put as putObject } from '@libreflare/cloudflare-sdk/r2/objects';
import { create as createRuleset, get as getRuleset, type CreateResult as CreatedRuleset } from '@libreflare/cloudflare-sdk/rulesets';
import { list as listShadowHosts } from '@libreflare/cloudflare-sdk/security-insights/partners/shadow-hosts';
import { update as updateWorker } from '@libreflare/cloudflare-sdk/workers/legacy/scripts';
import * as buildTriggers from '@libreflare/cloudflare-sdk/builds/triggers';
import * as serviceTokens from '@libreflare/cloudflare-sdk/zero-trust/access/service-tokens';
import * as workers from '@libreflare/cloudflare-sdk/workers';
import * as deployments from '@libreflare/cloudflare-sdk/workers/deployments';
import { list as listAccounts } from '@libreflare/cloudflare-sdk/accounts';
import { get as getUser } from '@libreflare/cloudflare-sdk/user';
import type { PolicyWithId } from '@libreflare/cloudflare-sdk/types/client-side-security';
import type { DnsRecordBatchDelete } from '@libreflare/cloudflare-sdk/types/dns-records';
import type {
	HyperdriveConfigResponse,
	HyperdriveConfigInput,
	HyperdriveOriginFull,
	OverAccessOrigin,
} from '@libreflare/cloudflare-sdk/types/hyperdrive';
import type { GetResult as ZarazConfigs } from '@libreflare/cloudflare-sdk/zaraz/history/configs';
import type { Operation as ApiShieldOperation } from '@libreflare/cloudflare-sdk/types/api-shield';
import type { Project } from '@libreflare/cloudflare-sdk/types/pages';
import type { Deployment, DeploymentInput, VersionInput, VersionPatchInput } from '@libreflare/cloudflare-sdk/types/workers';
import type { TempAccessCredsRequest } from '@libreflare/cloudflare-sdk/types/r2';
import type { ListRequest as DnsRecordsRequest } from '@libreflare/cloudflare-sdk/dns/records';
import type {
	DeleteRequest as DeleteTagsRequest,
	GetRequest as GetTagsRequest,
	UpdateRequest as UpdateTagsRequest,
} from '@libreflare/cloudflare-sdk/tags/resources';
import type { AccountResourceType } from '@libreflare/cloudflare-sdk/types/resource-tagging';
import { list as listAnnotations, type ListRequest as AnnotationsRequest } from '@libreflare/cloudflare-sdk/radar/annotations';
import type { ListRequest as CustomHostnamesRequest } from '@libreflare/cloudflare-sdk/custom-hostnames';
import type { ListRequest as ScimUsersRequest } from '@libreflare/cloudflare-sdk/zero-trust/identity-providers/scim/users';
import type { ListRequest as InstancesRequest } from '@libreflare/cloudflare-sdk/workflows/instances';
import * as logpushJobs from '@libreflare/cloudflare-sdk/logpush/jobs';
import { get as getLatestBuilds } from '@libreflare/cloudflare-sdk/builds/latest';
import { get as getBuilds } from '@libreflare/cloudflare-sdk/builds/versions';
import type { LogpushJob } from '@libreflare/cloudflare-sdk/types/logpush';
import type { RequestRule, RequestRuleInput, ResponseRule } from '@libreflare/cloudflare-sdk/types/rulesets';
import * as rules from '@libreflare/cloudflare-sdk/rulesets/rules';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<_T extends true>(): void {}

const cf = createClient({ token: 't', headers: { 'api-version': '2026-11-07' } });
const scope = { account_id: 'a', script_name: 's' };

export async function checks(): Promise<void> {
	// #2805: the list's result is what the API sends, and its items are deployments.
	const result = await cf.send(deployments.list, scope);
	const first: Deployment | undefined = result.deployments[0];
	void first;
	for await (const deployment of cf.paginate(deployments.list, scope)) {
		assertType<Equal<typeof deployment, Deployment>>();
	}
	const page = await cf.page(deployments.list, { ...scope, per_page: 1 });
	assertType<Equal<(typeof page.items)[number], Deployment>>();
	void page.resultInfo?.total_pages;

	// @ts-expect-error The items are `deployments`, not `items`.
	void result.items;

	// A nested group is reached from its parent, and it is the same operation.
	assertType<Equal<typeof workers.deployments.list, typeof deployments.list>>();

	// @ts-expect-error A required path parameter is missing.
	await cf.send(deployments.list, { account_id: 'a' });
	// @ts-expect-error The request as a whole is required.
	await cf.send(deployments.list);
	// @ts-expect-error A parameter the operation doesn't have.
	await cf.send(deployments.list, { account_id: 'a', script_name: 's', per_pages: 1 });
	// @ts-expect-error A parameter of the wrong type.
	await cf.send(deployments.list, { ...scope, per_page: '1' });
	// @ts-expect-error An operation that isn't paginated can't be paginated.
	cf.paginate(deployments.get, { ...scope, deployment_id: 'd' });

	// A request with nothing required can be left out, and a reserved word is still a name.
	await cf.send(listAccounts);
	await cf.send(getUser);
	await cf.send(deployments.delete, { ...scope, deployment_id: 'd' });

	// A declared Content-Type is a field of the request, as for an R2 object.
	const object = { account_id: 'a', bucket_name: 'b', object_key: 'index.html' };
	await cf.send(putObject, { ...object, 'Content-Type': 'text/html', body: new Blob(['<p>']) });

	// Fields only the server sets can't be required of a request.
	const input: DeploymentInput = {
		strategy: 'percentage',
		versions: [{ percentage: 100, version_id: 'v' }],
	};
	await cf.send(deployments.create, { ...scope, body: input });
	// @ts-expect-error A read deployment has the server's fields.
	const read: Deployment = input;
	void read;
	// A value read from the API can be sent back as it is.
	const back: DeploymentInput = result.deployments[0]!;
	void back;

	// Libreflare widens the official SDK's type by hand to send service token tags.
	await cf.send(serviceTokens.create, { account_id: 'a', body: { name: 'n', tags: { team: 'x' } } });

	// An operation for an account or a zone takes one of their IDs, and the scope of an account operation fits.
	await cf.send(serviceTokens.list, { zone_id: 'z' });
	await cf.send(serviceTokens.list, scope);
	const either = Math.random() > 0.5 ? { zone_id: 'z' } : { account_id: 'a' };
	await cf.send(serviceTokens.list, either);
	for await (const token of cf.paginate(serviceTokens.list, { zone_id: 'z' })) {
		void token.client_id;
	}
	// @ts-expect-error It needs an account or a zone.
	await cf.send(serviceTokens.create, { body: { name: 'n' } });
	// @ts-expect-error Even when it asks for nothing else.
	await cf.send(getEntitlements);
	// @ts-expect-error Not both.
	await cf.send(serviceTokens.list, { account_id: 'a', zone_id: 'z' });
	// @ts-expect-error The selector the route is written with isn't a field.
	await cf.send(serviceTokens.list, { zone_id: 'z', account_or_zone: 'zones' });
	// A helper's scope typed as `AccountOrZone` keeps the rule, unlike one made with `Omit`.
	const zone = (zone_id: string): AccountOrZone => ({ zone_id });
	await cf.send(serviceTokens.list, { ...zone('z'), name: 'n' });
	// @ts-expect-error Not both.
	const bothScopes: AccountOrZone = { account_id: 'a', zone_id: 'z' };
	void bothScopes;

	// Libreflare calls this with a hand-written envelope and result type.
	const triggers = await cf.send(buildTriggers.list, { account_id: 'a', external_script_id: 's' });
	void triggers;

	// A file can go in a multipart body as an object, whether the spec's field is inline or in a model.
	const file = new File(['x'], 'x.js');
	await cf.send(createImage, { account_id: 'a', body: { file } });
	await cf.send(updateWorker, { account_id: 'a', script_name: 's', body: { files: [file], metadata: {} } });
	const key = { account_id: 'a', namespace_id: 'n', key_name: 'k' };
	await cf.send(putKey, { ...key, body: { value: file } });
	await cf.send(putKey, { ...key, body: { value: 'text' } });
	// @ts-expect-error A number is neither a file nor text.
	await cf.send(createImage, { account_id: 'a', body: { file: 1 } });

	// An operation that can answer in several formats has to be narrowed.
	const shot = await cf.send(screenshot, { account_id: 'a', body: { url: 'https://example.com' } });
	// @ts-expect-error It may not be bytes.
	void shot.byteLength;
	if (shot instanceof Uint8Array) {
		void shot.byteLength;
	}
	const raw = await cf.send(getRawFile, { account_id: 'a', namespace: 'n', name: 'r', ref: 'main', path: 'dir/file' });
	assertType<Equal<typeof raw, Uint8Array>>();
	// Its items are still those of its JSON, although it can also answer in CSV.
	for await (const host of cf.paginate(listShadowHosts, { zone_id: 'z', partner: 'riskrecon' })) {
		assertType<Equal<[typeof host] extends [never] ? true : false, false>>();
	}

	// A form beside JSON is a FormData, and an operation with no form doesn't take one.
	await cf.send(createWatermark, { account_id: 'a', body: new FormData() });
	await cf.send(createWatermark, { account_id: 'a', body: { url: 'https://example.com/mark.png' } });
	// @ts-expect-error This operation only takes JSON.
	await cf.send(deployments.create, { ...scope, body: new FormData() });

	// A spec patch declares the webhook URL under the name SDKs send.
	await cf.send(updateWebhook, { account_id: 'a', body: { notificationUrl: 'https://example.com/hook' } });
	// @ts-expect-error The spec hides `notification_url` from SDKs, so it's an unknown field even beside `notificationUrl`.
	await cf.send(updateWebhook, { account_id: 'a', body: { notificationUrl: 'https://example.com/hook', notification_url: 'https://example.com/hook' } });

	// A bare branch of a union is part of the result, and doesn't change the items.
	const models = await cf.send(listModels, { account_id: 'a' });
	// @ts-expect-error It may be the bare `{ data }`, which isn't an array.
	void models.length;
	void (Array.isArray(models) ? models.length : models.data);
	for await (const model of cf.paginate(listModels, { account_id: 'a' })) {
		assertType<Equal<[typeof model] extends [never] ? true : false, false>>();
		void model.name;
	}

	// A result declared in several branches keeps each: the base's token, and the images.
	const images = await cf.send(listImages, { account_id: 'a', 'meta.status[eq]': 'active', 'meta.priority[gte:number]': '1' });
	void images.continuation_token;
	void images.images;
	// @ts-expect-error A metadata filter needs an operator.
	await cf.send(listImages, { account_id: 'a', 'meta.status': 'active' });
	// A concrete list isn't replaced by the base's generic one.
	for await (const item of cf.paginate(listListItems, { account_id: 'a', list_id: 'l' })) {
		assertType<Equal<typeof item, ListItem>>();
	}

	// Server-sent events are a stream, read as they arrive.
	const metrics = await cf.send(getQueueMetrics, { account_id: 'a', queue_id: 'q' });
	// @ts-expect-error It may be the stream.
	void metrics.backlog_count;
	if (metrics instanceof ReadableStream) {
		void metrics.getReader();
	} else {
		void metrics.backlog_count;
	}

	// A `result` beside other data is part of the response, which isn't unwrapped.
	const scan = await cf.send(createScan, { account_id: 'a', body: { url: 'https://example.com' } });
	assertType<Equal<typeof scan.uuid, string>>();
	assertType<Equal<typeof scan.result, string>>();

	// A declared 204 has no content.
	const entitlements = await cf.send(getEntitlements, { account_id: 'a' });
	// @ts-expect-error It may be undefined.
	void entitlements.length;
	void entitlements?.length;
}

// Forge drops what these rely on, so generator/prepare.ts moves it to where Forge reads it.

// A `required` beside an `allOf`, naming a property of the referenced model.
// @ts-expect-error `action` is required by the composed schema.
export const policyAction: Pick<PolicyWithId, 'action'> = {};
// @ts-expect-error `id` is required, although only a branch of the `allOf` declares it.
export const batchDelete: DnsRecordBatchDelete = {};
// The same, in a request body shared under `components.requestBodies`.
export async function rulesetCreate(): Promise<void> {
	// @ts-expect-error `name`, `kind` and `phase` are required.
	await cf.send(createRuleset, { zone_id: 'z', body: {} });
}

// A `nullable` in one `allOf` branch: a Pages project with no deployment has none.
assertType<Equal<null extends Project['latest_deployment'] ? true : false, true>>();
// The same in a map's values.
assertType<Equal<null extends ZarazConfigs[string] ? true : false, true>>();
// Except where a spec patch says the branch's `nullable` isn't about the whole.
assertType<Equal<null extends ApiShieldOperation ? true : false, false>>();

// Spec patches let a Browser Run script's result hold nested arrays, or be server-sent events from its `Response`.
assertType<Equal<number[][] extends ScriptResult & SessionScriptResult ? true : false, true>>();
assertType<Equal<ReadableStream<Uint8Array> extends ScriptResult & SessionScriptResult ? true : false, true>>();

// A method named with a reserved word is exported only under its name, as in index.js.
// @ts-expect-error The local `delete_` isn't exported.
export type LocalAlias = (typeof deployments)['delete_'];

// A field that is `readOnly` only through the schema it refers to.
// @ts-expect-error The API always sends `id`.
export const readConfig: Pick<HyperdriveConfigResponse, 'id'> = {};
export const writeConfig: Pick<HyperdriveConfigInput, 'id'> = {};

// A `writeOnly` field isn't promised in what the API sends.
export const origin: Pick<OverAccessOrigin, 'access_client_secret'> = {};
// Through an `allOf` of a schema whose own `allOf` declares the fields and a `required` beside it requires them:
// the full origin requires the database, but not its write-only password.
export const publicOrigin: HyperdriveOriginFull = { scheme: 'postgres', database: 'db', user: 'u', host: 'db.example.com', port: 5432 };
// @ts-expect-error `database` is required, though the full origin's own schema doesn't declare it.
export const noDatabase: HyperdriveOriginFull = { scheme: 'postgres', user: 'u', host: 'db.example.com', port: 5432 };

export function isForbidden(error: ApiError): boolean {
	return error.status === 403 && error.errors.some((entry) => entry.code === 10000);
}

// A validation error points at the field it's about, such as `/rules/0/action`.
export function pointerOf(error: ApiError): string | undefined {
	return error.errors[0]?.source?.pointer;
}

// An entry's message is only text the server sent, so it may have none.
export function messageOf(error: ApiError): string {
	const first = error.errors[0];
	// @ts-expect-error An entry such as `{ code, detail }` has no message.
	const said: string = first === undefined ? '' : first.message;
	return said;
}

export async function logpushAndBuilds(): Promise<void> {
	// A listed job isn't null, though a single job's result can be, and it has the filter the API sends.
	const jobs = await cf.send(logpushJobs.list, { zone_id: 'z' });
	assertType<Equal<typeof jobs, LogpushJob[]>>();
	// A numeric path parameter takes the number the API sends as the job's ID, or its text.
	const job = await cf.send(logpushJobs.get, { zone_id: 'z', job_id: jobs[0]?.id ?? 1 });
	void job?.filter;
	await cf.send(logpushJobs.get, { zone_id: 'z', job_id: '1' });
	// @ts-expect-error Neither a number nor text.
	await cf.send(logpushJobs.get, { zone_id: 'z', job_id: true });
	// Version IDs and script tags are lists, sent joined with commas.
	await cf.send(getBuilds, { account_id: 'a', version_ids: ['v1', 'v2'] });
	// @ts-expect-error Not joined by hand.
	await cf.send(getBuilds, { account_id: 'a', version_ids: 'v1,v2' });
	await cf.send(getLatestBuilds, { account_id: 'a', external_script_ids: ['s1', 's2'] });
	// @ts-expect-error Not joined by hand.
	await cf.send(getLatestBuilds, { account_id: 'a', external_script_ids: 's1,s2' });
}

// A ruleset rule names its action, which tells the variants apart.
assertType<Equal<undefined extends RequestRule['action'] ? true : false, false>>();
// @ts-expect-error A rule needs an action.
export const ruleWithoutAction: RequestRuleInput = { expression: 'true' };
export function redirectTarget(rule: RequestRule): string | undefined {
	return rule.action === 'redirect' ? rule.action_parameters?.from_value?.target_url?.value : undefined;
}
// A rule can be moved by its position alone, though otherwise an update is the whole rule.
export async function moveRule(): Promise<void> {
	const scope = { zone_id: 'z', ruleset_id: 'r' };
	await cf.send(rules.update, { ...scope, rule_id: 'x', body: { position: { index: 1 } } });
	await cf.send(rules.update, { ...scope, rule_id: 'x', body: { action: 'block', expression: 'true', position: { before: 'y' } } });
	// @ts-expect-error Not another field alone.
	await cf.send(rules.update, { ...scope, rule_id: 'x', body: { enabled: false } });
	// A position beside any field of a rule makes it a whole rule, whether the body is written in
	// the call or built before it.
	// @ts-expect-error A whole rule needs its action.
	await cf.send(rules.update, { ...scope, rule_id: 'x', body: { enabled: false, position: { index: 1 } } });
	const invalid = { action: 'invalid', position: { index: 1 } };
	// @ts-expect-error Not an action, and not a move only.
	await cf.send(rules.update, { ...scope, rule_id: 'x', body: invalid });
	const disabled = { enabled: false, position: { index: 1 } };
	// @ts-expect-error A whole rule needs its action.
	await cf.send(rules.update, { ...scope, rule_id: 'x', body: disabled });
	const moved = { action: 'block' as const, expression: 'true', enabled: false, position: { index: 1 } };
	await cf.send(rules.update, { ...scope, rule_id: 'x', body: moved });
	// @ts-expect-error A new rule needs its action.
	await cf.send(rules.create, { ...scope, body: { position: { index: 1 } } });
}

// A rule's action_parameters are its action's: the API refuses any other key, and an action that
// takes none, such as log, takes none.
// @ts-expect-error A block takes no redirect.
export const blockWithRedirect: RequestRuleInput = { action: 'block', expression: 'true', action_parameters: { from_value: {} } };
// @ts-expect-error A log takes no parameters.
export const logWithParameters: RequestRuleInput = { action: 'log', expression: 'true', action_parameters: { x: 1 } };
export const skipCurrent: RequestRuleInput = { action: 'skip', expression: 'true', action_parameters: { ruleset: 'current' } };
// Any rule's parameters can be read, as a rule whose action takes none has none.
export function parametersOf(rule: ResponseRule): unknown {
	return rule.action_parameters;
}
// One action's rule is picked from the union, with its own parameters.
type RewriteRule = Extract<ResponseRule, { action: 'rewrite' }>;
assertType<Equal<[RewriteRule] extends [never] ? true : false, false>>();
export function headersOf(rule: RewriteRule): unknown {
	return rule.action_parameters?.headers;
}
// @ts-expect-error A block rule isn't a rewrite.
export const notRewrite: RewriteRule = { id: 'i', ref: 'r', enabled: true, expression: 'true', action: 'block' };

// An empty ruleset leaves out its rules, and always has its version.
export async function ruleCount(ruleset_id: string): Promise<number> {
	const ruleset = await cf.send(getRuleset, { zone_id: 'z', ruleset_id });
	// @ts-expect-error `rules` may be absent.
	void ruleset.rules.length;
	void ruleset.version.length;
	return (ruleset.rules ?? []).length;
}

// A ruleset write returns what it changed, and a dry run, which only validates, returns null.
export async function dryRun(flag: boolean): Promise<void> {
	const body = { name: 'n', kind: 'zone' as const, phase: 'http_request_firewall_custom' as const };
	const created = await cf.send(createRuleset, { zone_id: 'z', body });
	assertType<Equal<typeof created, NonNullable<CreatedRuleset>>>();
	const kept = await cf.send(createRuleset, { zone_id: 'z', dry_run: false, body });
	assertType<Equal<typeof kept, NonNullable<CreatedRuleset>>>();
	const validated = await cf.send(createRuleset, { zone_id: 'z', dry_run: true, body });
	assertType<Equal<typeof validated, null>>();
	const either = await cf.send(createRuleset, { zone_id: 'z', dry_run: flag, body });
	assertType<Equal<typeof either, CreatedRuleset | null>>();
	// An optional true may be left out, which makes the change.
	const optional = await cf.send(createRuleset, { zone_id: 'z', body, ...(flag ? { dry_run: true as const } : {}) });
	assertType<Equal<typeof optional, CreatedRuleset>>();
	assertType<Equal<null extends typeof optional ? true : false, true>>();
	const deleted = await cf.send(rules.delete, { zone_id: 'z', ruleset_id: 'r', rule_id: 'x', dry_run: true });
	assertType<Equal<typeof deleted, null>>();
	// The result type keeps the dry run's null, so it holds where the operation is any operation.
	assertType<Equal<null extends CreatedRuleset ? true : false, true>>();
	const send = <Req, Res>(operation: Operation<Req, Res>, request: Req): Promise<Res> => cf.send(operation, request);
	const wrapped = await send(createRuleset, { zone_id: 'z', dry_run: true, body });
	assertType<Equal<typeof wrapped, CreatedRuleset>>();
	// The request is checked as before.
	// @ts-expect-error A misspelled parameter.
	await cf.send(createRuleset, { zone_id: 'z', dryrun: true, body });
	// @ts-expect-error Not a ruleset.
	await cf.send(createRuleset, { zone_id: 'z', dry_run: true, body: {} });
	// @ts-expect-error A whole rule needs its action, in a dry run too.
	await cf.send(rules.update, { zone_id: 'z', ruleset_id: 'r', rule_id: 'x', dry_run: true, body: { enabled: false, position: { index: 1 } } });
}

// Temporary R2 credentials take a permission or a list of actions, and the API refuses neither or both.
const credentials = { bucket: 'b', parentAccessKeyId: 'k', ttlSeconds: 60 };
export const byPermission: TempAccessCredsRequest = { ...credentials, permission: 'object-read-only' };
export const byActions: TempAccessCredsRequest = { ...credentials, actions: ['GetObject'] };
// @ts-expect-error Neither.
export const noSelector: TempAccessCredsRequest = credentials;
// @ts-expect-error Both.
export const bothSelectors: TempAccessCredsRequest = { ...credentials, permission: 'object-read-only', actions: ['GetObject'] };

// A patch of a Worker's latest version removes one binding with null, which a new version can't send.
export const removeBinding: VersionPatchInput = { env: { OLD: null, NEW: { type: 'plain_text', text: 'x' } } };
// @ts-expect-error Only a patch removes a binding.
export const newWithout: VersionInput = { env: { OLD: null } };

// Query parameters that exclude each other take one of them, or none.
const zone = { zone_id: 'z' };
export const byPage: DnsRecordsRequest = { ...zone, page: 2, per_page: 10 };
export const byCursor: DnsRecordsRequest = { ...zone, cursor: '', per_page: 10 };
export const back: DnsRecordsRequest = { ...zone, prev_cursor: 'p' };
export const noPaging: DnsRecordsRequest = zone;
// @ts-expect-error The API refuses a page number beside a cursor.
export const pageAndCursor: DnsRecordsRequest = { ...zone, page: 1, cursor: '' };
// @ts-expect-error Or both cursors.
export const bothCursors: DnsRecordsRequest = { ...zone, cursor: 'c', prev_cursor: 'p' };
export const byInstanceCursor: InstancesRequest = { account_id: 'a', workflow_name: 'w', cursor: 'c' };
// @ts-expect-error A cursor list's deprecated page number, beside its cursor.
export const instances: InstancesRequest = { account_id: 'a', workflow_name: 'w', page: 1, cursor: 'c' };
export const oneFilter: CustomHostnamesRequest = { ...zone, 'hostname.contain': 'app' };
export const oneHostname: CustomHostnamesRequest = { ...zone, hostname: 'a.example.com' };
export const oneId: CustomHostnamesRequest = { ...zone, id: 'x' };
// @ts-expect-error One hostname filter at most, and not beside an ID.
export const twoFilters: CustomHostnamesRequest = { ...zone, hostname: 'a.example.com', id: 'x' };
const idp = { account_id: 'a', identity_provider_id: 'i' };
export const byNameAndEmail: ScimUsersRequest = { ...idp, name: 'n', email: 'e' };
export const byId: ScimUsersRequest = { ...idp, cf_resource_id: ['x'] };
// @ts-expect-error An ID lookup takes no other filter.
export const idAndName: ScimUsersRequest = { ...idp, cf_resource_id: ['x'], name: 'n' };

// Radar's dateStart and dateEnd go together, and not beside dateRange.
export const relative: AnnotationsRequest = { dateRange: '7d' };
export const absolute: AnnotationsRequest = { dateStart: '2026-11-01T00:00:00Z', dateEnd: '2026-11-08T00:00:00Z' };
// @ts-expect-error Not beside dateRange.
export const rangeAndStart: AnnotationsRequest = { dateRange: '7d', dateStart: '2026-11-01T00:00:00Z', dateEnd: '2026-11-08T00:00:00Z' };
// @ts-expect-error Not one without the other.
export const startOnly: AnnotationsRequest = { dateStart: '2026-11-01T00:00:00Z' };
// A request of only optional fields is still optional.
export const annotations = cf.send(listAnnotations);

// A worker version's tags need its worker_id, which no other resource takes.
const account = { account_id: 'a' };
export const versionTags: GetTagsRequest = { ...account, resource_type: 'worker_version', resource_id: 'v', worker_id: 'w' };
export const workerTags: DeleteTagsRequest = { ...account, resource_type: 'worker', resource_id: 'w' };
// @ts-expect-error A worker version without its worker_id.
export const versionWithout: GetTagsRequest = { ...account, resource_type: 'worker_version', resource_id: 'v' };
// @ts-expect-error A worker with one.
export const workerWith: DeleteTagsRequest = { ...account, resource_type: 'worker', resource_id: 'w', worker_id: 'w' };
// A type of the account's is narrowed first, to send a worker_id with a worker version only.
export function accountTags(resource_type: AccountResourceType, worker_id: string): GetTagsRequest {
	return resource_type === 'worker_version'
		? { ...account, resource_type, resource_id: 'r', worker_id }
		: { ...account, resource_type, resource_id: 'r' };
}

// A scope typed as AccountOrZone is narrowed first, as the account and the zone take their own types.
export function scopedTags(scope: AccountOrZone, resource_id: string): GetTagsRequest {
	return scope.zone_id === undefined
		? { ...scope, resource_type: 'worker', resource_id }
		: { ...scope, resource_type: 'zone', resource_id };
}
// @ts-expect-error A scope that can be the zone, with an account's type.
export const unnarrowed = (scope: AccountOrZone): GetTagsRequest => ({ ...scope, resource_type: 'worker', resource_id: 'r' });

// A zone's resources are tagged with its zone_id, and each route refuses the other's types.
export const recordTags: GetTagsRequest = { ...zone, resource_type: 'dns_record', resource_id: 'r' };
// @ts-expect-error An account's type on the zone.
export const workerOnZone: GetTagsRequest = { ...zone, resource_type: 'worker', resource_id: 'w' };
// @ts-expect-error A zone's type on the account.
export const recordOnAccount: GetTagsRequest = { ...account, resource_type: 'dns_record', resource_id: 'r' };
// @ts-expect-error A worker version on the zone.
export const versionOnZone: GetTagsRequest = { ...zone, resource_type: 'worker_version', resource_id: 'v', worker_id: 'w' };
// An Access policy's tags need its application's ID, which no other resource takes.
export const policyTags: DeleteTagsRequest = { ...zone, resource_type: 'access_application_policy', resource_id: 'p', access_application_id: 'app' };
// @ts-expect-error A policy without its application.
export const policyWithout: DeleteTagsRequest = { ...zone, resource_type: 'access_application_policy', resource_id: 'p' };
// @ts-expect-error A record with one.
export const recordWith: GetTagsRequest = { ...zone, resource_type: 'dns_record', resource_id: 'r', access_application_id: 'app' };
// Setting tags takes the account's body with account_id, and the zone's with zone_id.
export const setRecordTags: UpdateTagsRequest = { ...zone, body: { resource_type: 'dns_record', resource_id: 'r', tags: { env: 'prod' } } };
export const setWorkerTags: UpdateTagsRequest = { ...account, body: { resource_type: 'worker', resource_id: 'w', tags: { env: 'prod' } } };
// @ts-expect-error An account's body on the zone.
export const workerBodyOnZone: UpdateTagsRequest = { ...zone, body: { resource_type: 'worker', resource_id: 'w', tags: {} } };
// @ts-expect-error A zone's body on the account.
export const recordBodyOnAccount: UpdateTagsRequest = { ...account, body: { resource_type: 'dns_record', resource_id: 'r', tags: {} } };

// A mock client is keyed by the operation imported, and each handler is typed from it.
export const mocked = createMockClient()
	.on(deployments.list, (request) => {
		assertType<Equal<typeof request.script_name, string>>();
		return { deployments: [] };
	})
	.on(deployments.list, async () => withResultInfo({ deployments: [] }, { page: 1, total_pages: 2 }))
	.on(createRuleset, () => null);
// @ts-expect-error Not the operation's result.
mocked.on(deployments.list, () => ({ deployments: 1 }));
// @ts-expect-error Nor in a page.
mocked.on(deployments.list, () => withResultInfo({ deployments: 1 }, {}));
// @ts-expect-error A page is made by withResultInfo, not an object like it, which the mock would read as the result.
mocked.on(deployments.list, () => ({ result: { deployments: [] }, resultInfo: {} }));
// @ts-expect-error Nor a spread of one.
mocked.on(deployments.list, () => ({ ...withResultInfo({ deployments: [] }, {}) }));
mocked.on(deployments.list, (request) => {
	// @ts-expect-error The request has no such field.
	void request.nope;
	return { deployments: [] };
});
// A handler typed loosely, as a test framework's mock function is, fits any operation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- such as vitest's `vi.fn()`.
declare const loose: (...args: any[]) => any;
mocked.on(deployments.list, loose);
// It's a client, with no cast.
export const asClient: Client = mocked;
