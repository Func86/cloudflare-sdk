# Changelog

Changes a caller notices, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/), under which anything can change before 1.0. A minor
version can break calls, so `^0.1.0` doesn't take 0.2.0. A patch can still make a type match what the API sends, or
change something few callers rely on; its entry says how to update a call.

## [Unreleased]

### Breaking

- **27 operations are renamed by the spec,** now generated from Forge's `openapi@3dc49274` rather than `debf614f`. cf's
  commands take the same names, apart from 3 that its older pin hasn't renamed yet: `user.load-balancers.pools.edit`
  and `bulkEdit`, and `network.subnets.initial-resolved-ip.replace`. Each keeps its request and result:

  | Was | Now |
  | --- | --- |
  | `builds/repos/connections`: `upsert` | `builds/repos/connections`: `replace` |
  | `builds/triggers`: `update` | `builds/triggers`: `edit` |
  | `builds/triggers/environment-variables`: `upsert` | `builds/triggers/environment-variables`: `edit` |
  | `builds/workers`: `update` | `builds/workers`: `edit` |
  | `cloudforce-one/rules/email`: `updatePendingApproval` | `cloudforce-one/rules/email/approvals`: `replace` |
  | `dns/records`: `batch` | `dns/records`: `bulkApply` |
  | `email-routing/addresses`: `update` | `email-routing/addresses`: `edit` |
  | `email-routing/settings`: `apply`, `update` | `email-routing/settings`: `replace`, `edit` |
  | `batch` in the 7 `email-security/*` groups that have it, such as `email-security/domains` | `bulkApply`, or `bulkDelete` in `email-security/sending-domain-restrictions`, which only deletes |
  | `hyperdrive`: `update` | `hyperdrive`: `edit` |
  | `kv/bulk`: `delete`, `get`, `put` | `kv/keys`: `bulkDelete`, `bulkGet`, `bulkPut` |
  | `network/subnets/initial-resolved-ip`: `edit` | `network/subnets/initial-resolved-ip`: `replace` |
  | `user/load-balancers/pools/edit/pools`: `pool`, `pools` | `user/load-balancers/pools`: `edit`, `bulkEdit` |
  | `bulk` in `workers/secrets` and `workers-for-platforms/dispatch-namespaces/scripts/secrets` | `bulkEdit` |
  | `zero-trust/access/targets/bulk`: `replaceTags`, `update` | `zero-trust/access/targets`: `bulkReplaceTags`, `bulkCreate` |

- **`types/registrar-api` and `types/registrar-api-sandbox` are `types/registrar` and `types/registrar-sandbox`,** with
  the same types. Change the import path.
- **`ai-gateway.billing.topup.eligibility`, `limits` and `config.get` are gone,** as the spec deprecates them. Read the
  eligibility with `ai-gateway.billing.topup.getEligibility`, a GET without a body, which returns another type.
  `types/aig-billing` no longer exports `GetTopupEligibilityResult`, `GetTopupLimitsResult`, `GetTopupConfigResult`
  or `GetAuthoritativeTopupEligibilityResult`. Use `GetTopupEligibilityV2Result`, the new operation's result.

### Added

- 11 operations: `tunnels.hostnames.create`, `delete`, `edit`, `get` and `list`,
  `ai-gateway.billing.topup.getEligibility`, `cloudforce-one.priority-intelligence.topics.list` and
  `cloudforce-one.requests.quota.get`, whose responses the spec now describes, and `createLegacy`, `deleteLegacy` and
  `listLegacy` in `r2.buckets.domains.custom`, for the deprecated `custom_domains` route.
- 8 list operations are paginated, so `paginate` and `page` take them, and they take `page` and `per_page`:
  `network.virtual-networks.list`, `pages.domains.list`, `queues.list`, `ssl.keyless-certificates.list`,
  `ssl.mtls-certificates.list`, `ssl.origin-tls-client-auth.hostname-certificates.list`,
  `ssl.origin-tls-client-auth.zone-certificates.list` and `zones.hostnames.settings.tls.get`. `send` returns what it
  did. Given an `offset`, `paginate` moves it on for the last 4, as their spec says an offset wins over the page
  number.
- `dns.records.list` takes `cursor` and `prev_cursor`, which page by cursor: an empty `cursor` starts. `paginate` pages
  it by number, as the API does without a cursor, and by cursor when given a `cursor`, even an empty one. Given a
  `prev_cursor`, it goes back to the first page, so earlier pages come later.
- Worker versions have `env`, their bindings as a map by name, beside `bindings`. In `workers.versions.latest.edit`,
  whose body is now a `VersionPatchInput`, an entry set to `null` removes that binding and keeps the others.
- `r2.temporary-credentials.create` takes S3 `actions` in place of a `permission`. Its type takes exactly one of them.

### Changed

- Types follow the spec's other changes. Those that can break a call:
  - `tags.resources.delete` takes `resource_id`, `resource_type` and `worker_id` beside `account_id` or `zone_id`,
    sent in the query, and no longer takes a `body`. Move the fields out of `body`. `types/resource-tagging` no longer
    exports `DeleteTagsRequestAccountLevel`, its body's type. It still requires `worker_id` for a `worker_version`,
    and no other resource takes one, as below.
  - `alerting.destinations.webhooks.update` takes only `name`, as the spec now says `url` and `secret` can't be
    changed. To change them, delete the webhook and create another.
  - `security-txt.update` requires `contact` and `expires`, and `security-txt.get` always returns them.
  - `pipelines.list` takes `per_page` as a number, not a string.
  - Workers' observability settings no longer have `agents.destinations`, wherever they're sent or read, such as in
    `workers.previews.update`.
  - `zaraz.config.update` takes a `ZarazConfigBodyInput`, and `types/zaraz` no longer exports `ZarazConfigBody`.
- Request types reject query parameters the API refuses together, so such a call fails to compile, not with a 400.
  Send one of them:
  - `dns.records.list`: one of `page`, `cursor` and `prev_cursor`. `zero-trust.dex.isps.list` and
    `workflows.instances.list`: one of `page` and `cursor`.
  - `custom-hostnames.list`: one of `hostname`, `hostname.exact`, `hostname.startsWith`, `hostname.contain` and `id`.
  - `zero-trust.identity-providers.scim.users.list` and `groups.list`: `cf_resource_id`, `idp_resource_id`, or the
    other filters.
  - 7 Radar operations: `dateRange`, or both `dateStart` and `dateEnd`. They're the `list` of `radar.annotations`,
    `radar.annotations.outages`, `radar.bgp.hijacks.events`, `radar.bgp.leaks.events` and `radar.traffic-anomalies`,
    and `radar.annotations.outages.locations` and `radar.traffic-anomalies.locations.get`.
  - `tags.resources.get` and `delete`: `worker_id` for a `worker_version`, and for no other resource. A
    `resource_type` typed as the whole `AccountResourceType` fits neither, so narrow it first:
    `type === 'worker_version' ? { resource_type: type, worker_id } : { resource_type: type }`.
- `paginate` throws a `TypeError`, before sending anything, for a request that sets what the API refuses beside the page
  number or cursor it moves on: a `cursor` for `zero-trust.dex.isps.list`, `page` for `workflows.instances.list`, or
  `page` beside a cursor for `dns.records.list`. It does so whatever the list's length, and the message says which
  parameter to leave out, or to read one page with `client.page`.
- Some results can hold values they couldn't:
  - A resource's `type` can be `'app_library_application'` in the results of `tags.resources.get`, `list` and
    `update`.
  - A CNI from `network-interconnects.cnis.create`, `get` and `update` can have `null` as its `bgp` and `bgp_mode`.
  - A `browser-run.crawl.get` record can have `null` as its `html`, `markdown` and `json`, and its `json` can be an
    array or a string.
  - `radar.entities.asns.get` returns `confidenceLevel` only when asked with `includeConfidenceLevel: true`.
  - A step in `workflows.instances.get` can leave out `end`.

## [0.3.0] - 2026-11-12

This release breaks calls: each breaking change below says how to update one.

### Breaking

- **58 operations are renamed by the spec,** now generated from Forge's `openapi@debf614f` rather than `07fc9fa4`.
  Most names now follow their routes, and cf's commands take the same ones. Each moved to another import path,
  another export, or both:

  | Was | Now |
  | --- | --- |
  | `builds/logs`: `get` | `builds`: `logs` |
  | `dns/zone-transfers/force-axfr`: `create` | `dns/zone-transfers`: `forceAxfr` |
  | `dns/zone-transfers/outgoing/status`: `get` | `dns/zone-transfers/outgoing`: `status` |
  | `queues/subscriptions`: `update` | `queues/subscriptions`: `edit` |
  | `r2/buckets/sippy`: `delete`, `update` | `r2/buckets/sippy`: `disable`, `enable` |
  | `workers-builds/workers`: `migrateToPreviews` | `builds/workers`: `migrateToPreviews` |
  | `workers-builds/workers/previews`: `createBuild`, `edit`, `get`, `list`, `listBuilds` | `builds/previews`: the same, with `update` for `edit` |
  | `summaryV2` and `timeseriesGroupsV2`, in the 10 `radar/*` groups that have them, such as `radar/http` | `summary` and `timeseriesGroups` |
  | `radar/ai/timeseries-groups`: `summary` | `radar/ai/bots`: `summary` |
  | `radar/annotations/outages`: `get` | `radar/annotations/outages`: `list` |
  | `radar/as112/top`: `locations`, `dnssec`, `edns`, `ipVersion` | `get` in `radar/as112/top/locations` and its `dnssec`, `edns` and `ip-version` |
  | `radar/bots/web-crawlers`: `summary`, `timeseriesGroups` | `radar/bots/crawlers`: the same |
  | `radar/entities`: `get` | `radar/entities/ips`: `get` |
  | `get` in `radar/http/ases`, `radar/http/locations` and the 8 groups inside each | The same under `radar/http/top`, with `http-version` for `http-method` |

- **`builds.create` and `radar.traffic-anomalies.get` are other operations now.** `builds.create` starts a build for
  a Worker by its `external_script_id`, and starting one from a trigger is `builds.triggers.createBuild`, with the
  same request as before. `radar.traffic-anomalies.get` reads one anomaly by `uuid`, which was `getById`, and listing
  them is `list`. A typed call to either under its old meaning no longer compiles, as each needs another path
  parameter.
- **`dns.domainconnect.getHeartbeat` is gone,** as the spec no longer has `GET /_heartbeat`.

### Added

- 20 operations, such as `builds.retry`, `builds.workers.purgeCache`, `browser-run.script.create`,
  `d1.insights.queries`, `pipelines.sinks.update`, `tunnels.config.delete` and `zero-trust.region.get`.

### Changed

- Types follow the spec's other changes. Those that can break a call:
  - `realtime.turn.keys.create` returns the key as `secret`, not `key`.
  - `network.subnets.warp.edit` no longer takes `network`.
  - The `zones.holds` operations return `include_subdomains` as a `boolean`, not a `string`.
  - `zero-trust.casb.applications.list` takes only `'fedramp'` or `'standard'` as its `environment`.
  - `realtime.kit.apps.update` no longer returns `cf_account_tag` or `is_org_on_kv`.
  - `stream.webhooks.update` takes `notificationUrl`, the name Stream's docs send, in place of `notification_url`,
    which the spec now hides from SDKs. Rename the field.
  - `types/iam` no longer exports `AccountInput`, and `types/stream` no longer exports `WatermarkAtUpload_2`: use
    `ComponentsSchemasAccountInput`, which `accounts.update` takes, and `WatermarkAtUpload`.
  - `workers.legacy.scripts.content.get` and `workers-for-platforms.dispatch-namespaces.scripts.content.get` return a
    `Uint8Array`, not a `string`. The spec now says what the API sends: `multipart/form-data` for a module Worker, one
    part per module, which can be binary, such as WebAssembly, and `application/javascript` for a service-worker
    script. Split the modules with `new Response(bytes, { headers: { 'content-type': type } }).formData()`, with `type`
    taken from the response through `onResponse`, or decode a script with `new TextDecoder().decode(bytes)`.
- Some results can hold values they couldn't, so an exhaustive `switch` over them needs more cases:
  `alerting.policies.get` and `list` have 22 more `alert_type`s, `abuse-reports.mitigations.list` and `review` have
  `'domain'` as an `entity_type`, `workflows.versions.graph` has `step_runner` and `step_dynamic` nodes, and an
  `ai-search` instance's `type` can be `'d1'` in the results of `create`, `delete`, `get`, `list` and `update`.

### Fixed

- **The `dns.domainconnect` operations reach the API.** The spec leaves out the `/dns/domainconnect` their routes are
  under, so `getDomainSettings`, `getProviderConfiguration` and `getProviderTemplate` failed with 404, "No route for
  that URI". The new `postVerify` is sent to `v2/verify`, where the API serves it, rather than the spec's `v1`.

## [0.2.1] - 2026-11-08

### Added

- `ApiError` can be made from a status and any headers, without a `Response`, a method or a path:
  `new ApiError({ status: 403 }, body)`, as a test needs. Its message then starts `A request failed with 403`.
- `@libreflare/cloudflare-sdk/testing` gives `createMockClient()`, a client for tests whose `.on(operation, handler)`
  answers an operation from a handler typed from it, in place of the API. `withResultInfo` answers page by page. A
  test no longer mocks `send` by hand, with a cast to `Client['send']`.

### Changed

- **An `ApiMessage` has a `message` only when the server sent one.** An entry of `ApiError.errors` or `messages`
  without one, such as Builds' `{ issues, name: 'ZodError' }` or `{ code, detail }`, no longer gets its JSON as its
  `message`, so code that shows an entry's message can skip it. `ApiError`'s own message still shows such an entry
  as JSON. Replace `entry.message` with `entry.message ?? fallback`, including in a template string, where a missing
  one would read `undefined`. A `message` that isn't a string is left out too.

### Fixed

- **A ruleset's `rules` can be absent,** as an empty ruleset leaves them out, in the result of the 11 operations that
  return a whole ruleset, such as `rulesets.get`, `rulesets.entrypoint.update`, `rulesets.versions.get` and
  `rulesets.rules.delete`. Read `ruleset.rules ?? []`.
- `ClientOptions.headers`' doc names `api-version`, the header the API reads a version date from, rather than
  `Cloudflare-Version`.
- The `builds` map of `builds.versions.get` says it's keyed by the version ID asked for.

## [0.2.0] - 2026-11-08

This release breaks calls: each breaking change below says how to update one.

### Breaking

- **An account-or-zone operation takes `account_id` or `zone_id`.** The 134 operations on a
  `/{account_or_zone}/{account_or_zone_id}` route, such as `rulesets.list` and `logpush.jobs.list`, no longer take
  `account_or_zone` and `account_or_zone_id`. Replace `{ account_or_zone: 'zones', account_or_zone_id: id }` with
  `{ zone_id: id }`, and `'accounts'` with `{ account_id: id }`. Giving both or neither is a compile error, and a
  `TypeError` without types. Type a helper's scope as the new `AccountOrZone`: an `Omit` or `Pick` of a request type
  loses the rule.
- **31 operations are renamed**, mostly `account-` groups from before the account and zone routes were merged. Each
  moved to another import path, another export, or both:

  | Was | Now |
  | --- | --- |
  | `cloudforce-one/requests`: `cloudforceOneRequestGet`, `…List`, `…New`, `…Update` | `cloudforce-one/requests`: `get`, `list`, `create`, `update` |
  | `custom-pages/account-assets`: `create`, `delete`, `get`, `list`, `update` | `custom-pages/assets`: the same |
  | `custom-pages/account-custom-pages`: `get`, `list`, `update` | `custom-pages`: the same |
  | `custom-pages/account-custom-pages/preview-tokens`: `create` | `custom-pages/preview-tokens`: `create` |
  | `logpush/account-datasets/fields`: `get` | `logpush/datasets/fields`: `get` |
  | `logpush/account-datasets/jobs`: `get` | `logpush/datasets/jobs`: `get` |
  | `logpush/account-jobs`: `create`, `delete`, `get`, `list`, `update` | `logpush/jobs`: the same |
  | `logpush/account-ownership`: `create` | `logpush/ownership`: `create` |
  | `logpush/account-ownership/validate`: `create` | `logpush/ownership`: `validate` |
  | `logpush/account-validate`: `destinationExistsDelete` | `logpush/validate`: `destinationExists` |
  | `logpush/account-validate/destination`: `delete` | `logpush/validate`: `destination` |
  | `logpush/account-validate/origin`: `create` | `logpush/validate`: `origin` |
  | `monetization/account-eligibility`: `check`, `get` | `monetization/eligibility`: the same |
  | `tags/account-resources`: `delete`, `get`, `update` | `tags/resources`: the same, beside `list` |
  | `waiting-rooms/account-waiting-rooms`: `list` | `waiting-rooms`: `list` |

- **Builds' `version_ids` and `external_script_ids` are lists**, which the runtime sends joined with commas, as their
  descriptions say. Replace `version_ids: id` with `[id]`, and `'a,b'` with `['a', 'b']`, in `builds.versions.get`
  and `builds.latest.get`. `types/builds` no longer exports `VersionIds` or `ExternalScriptIds`.
- **A ruleset rule needs its `action`,** in every variant of `RequestRule` and `RequestRuleInput`, as the API refuses
  a rule without one. The exception is `rulesets.rules.update` with a `position` alone, which moves a rule. A
  `position` beside any other field of a rule is a whole rule, so it needs the `action` too.
- **A rule's `action_parameters` take only its action's own keys,** as the API refuses any other. A `block` rule with
  redirect parameters is a compile error. The six actions without parameters (`challenge`, `js_challenge`,
  `managed_challenge`, `log`, `force_connection_close` and `ddos_dynamic`) take none. The API accepts `{}` there, but
  drops it.
- **The base `Rule` and `RuleInput` types no longer declare `action_parameters`.** Type any rule as `ResponseRule`
  (or `RequestRule` for one being sent): `Partial<Rule>` becomes `Partial<ResponseRule>`. `action_parameters` can be
  read on any of them.

### Added

- `send` types a ruleset write's dry run. For `rulesets.create`, `rulesets.update`, `rulesets.entrypoint.update`,
  `rulesets.rules.create`, `rulesets.rules.update` and `rulesets.rules.delete`, it returns `null` when the request
  has `dry_run: true`, and the ruleset without `| null` when `dry_run` is left out or `false`. When it may be
  either, as an optional `true` or a `boolean` may, the result is both. Their result types, such as `CreateResult`,
  still include `null`. These operations are typed as the new `DryRunOperation`.
- A numeric path parameter, such as Logpush's `job_id`, takes the number the API sends as well as text. The 57 such
  parameters were `string` only.
- `ApiMessage` declares `documentation_url` and `source`, whose `pointer` names the field a validation error is
  about, such as `/rules/0/action`.
- A Logpush job declares the `filter`, `logstream` and `time_created` the API sends.
- `Operation` declares `accountOrZone` and `dryRun`, for an operation written by hand: `accountOrZone: true` has the
  runtime fill an account-or-zone route from `account_id` or `zone_id`.

### Changed

- An error names the route it was sent to, such as `GET /zones/{zone_id}/rulesets failed with 403: …`, rather than
  `/{account_or_zone}/{account_or_zone_id}/rulesets`.
- An entry of `ApiError.errors` or `messages` leaves out a `code` that isn't a number or a string, a
  `documentation_url` that isn't a string, a `source` that isn't an object, and a `pointer` in it that isn't a string.
  `ApiError.body` keeps the response as sent.
- `logpush.jobs.list` returns `LogpushJob[]`, no longer `(LogpushJob | null)[]`. `logpush.jobs.get` can still return
  `null`.

## [0.1.0] - 2026-11-07

The first release.
