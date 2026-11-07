/**
 * Compile-time checks, run by `npm run check:type`. Each `@ts-expect-error` is a
 * mistake the types must reject: tsc fails if one of them stops being an error.
 */
import { createClient, type AccountOrZone, type ApiError } from '@libreflare/cloudflare-sdk';
import { get as getEntitlements } from '@libreflare/cloudflare-sdk/accounts/entitlements';
import { list as listModels } from '@libreflare/cloudflare-sdk/ai/models';
import { create as createWatermark } from '@libreflare/cloudflare-sdk/stream/watermarks';
import { get as getRawFile } from '@libreflare/cloudflare-sdk/artifacts/namespaces/repos/raw';
import { screenshot } from '@libreflare/cloudflare-sdk/browser-run/quick-action';
import { create as createImage, list as listImages } from '@libreflare/cloudflare-sdk/images';
import { get as getQueueMetrics } from '@libreflare/cloudflare-sdk/queues/metrics';
import { create as createScan } from '@libreflare/cloudflare-sdk/url-scanner/scans';
import { list as listListItems } from '@libreflare/cloudflare-sdk/rules/lists/items';
import type { Item as ListItem } from '@libreflare/cloudflare-sdk/types/lists';
import { put as putKey } from '@libreflare/cloudflare-sdk/kv/keys';
import { put as putObject } from '@libreflare/cloudflare-sdk/r2/objects';
import { create as createRuleset } from '@libreflare/cloudflare-sdk/rulesets';
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
	OverAccessOrigin,
} from '@libreflare/cloudflare-sdk/types/hyperdrive';
import type { GetResult as ZarazConfigs } from '@libreflare/cloudflare-sdk/zaraz/history/configs';
import type { Operation as ApiShieldOperation } from '@libreflare/cloudflare-sdk/types/api-shield';
import type { Project } from '@libreflare/cloudflare-sdk/types/pages';
import type { Deployment, DeploymentInput } from '@libreflare/cloudflare-sdk/types/workers';

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

// A method named with a reserved word is exported only under its name, as in index.js.
// @ts-expect-error The local `delete_` isn't exported.
export type LocalAlias = (typeof deployments)['delete_'];

// A field that is `readOnly` only through the schema it refers to.
// @ts-expect-error The API always sends `id`.
export const readConfig: Pick<HyperdriveConfigResponse, 'id'> = {};
export const writeConfig: Pick<HyperdriveConfigInput, 'id'> = {};

// A `writeOnly` field isn't promised in what the API sends.
export const origin: Pick<OverAccessOrigin, 'access_client_secret'> = {};

export function isForbidden(error: ApiError): boolean {
	return error.status === 403 && error.errors.some((entry) => entry.code === 10000);
}
