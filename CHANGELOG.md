# Changelog

Changes a caller notices, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/), under which anything can change before 1.0. A minor
version can break calls, so `^0.1.0` doesn't take 0.2.0. A patch can still make a type match what the API sends, or
change something few callers rely on; its entry says how to update a call.

## [Unreleased]

This release breaks calls: each breaking change below says how to update one.

### Breaking

- **32 operations are renamed by the spec,** now generated from cloudflare/api-schemas `9a5e4d44` rather than Forge's
  `openapi@2b2a4d86`, as below. cf's commands take the same names. Each keeps the shape of its request and result, but
  their types take the new name, so import them from the new path under that name, such as `BulkDeleteRequest` from
  `vectorize/vectors` for `DeleteByIdsRequest` from `vectorize`:

  | Was | Now |
  | --- | --- |
  | `addressing/address-maps/accounts`: `update` | `addressing/address-maps/accounts`: `create` |
  | `update`, `updateBulk` and `deleteBulk` in `addressing/address-maps/ips` and `addressing/address-maps/zones` | `create`, `bulkCreate` and `bulkDelete` |
  | `cache/origin-cloud-regions/bulk`: `delete`, `update` | `cache/origin-cloud-regions`: `bulkDelete`, `bulkReplace` |
  | `dns/settings/account/views`: `create`, `delete`, `edit`, `get`, `list` | `dns/views`: the same |
  | `intel/indicator-feeds/permissions`: `create`, `delete` | `intel/indicator-feeds/permissions`: `grant`, `revoke` |
  | `o11y/telemetry`: `heartbeat`, `liveTail` | `observability/telemetry`: the same |
  | `organizations/members/batch`: `create` | `organizations/members`: `bulkCreate` |
  | `update` in `resource-sharing/recipients` and `resource-sharing/excluded-recipients` | `replace` |
  | `vectorize`: `insert`, `upsert`, `query`, `listVectors`, `getByIds`, `deleteByIds` | `vectorize/vectors`: `insert`, `upsert`, `query`, `list`, `bulkGet`, `bulkDelete` |
  | `vectorize/metadata-index`: `create`, `delete`, `list` | `vectorize/metadata-indexes`: the same |
  | `waiting-rooms/rules`: `get` | `waiting-rooms/rules`: `list` |
  | `zero-trust/cws/tenant-structures/nodes`: `batch` | `zero-trust/cws/tenant-structures/nodes`: `bulkApply` |

- **`cloudforce-one.requests.list`, `create`, `get` and `update` call the v2 routes,** as the spec and cf name them,
  in place of `getRequestList`, `postRequestCreate`, `getRequestRead` and `putRequestUpdate`. The hidden v1 routes
  they called are `cloudforce-one.requests.legacy.list`, `create`, `get` and `update`, and
  `cloudforce-one.requests.delete`, which v2 doesn't have, is `cloudforce-one.requests.legacy.delete` beside them. A
  call written for v1 no longer compiles, as v2 takes a `project_type`: import it from `cloudforce-one/requests/legacy`
  to keep calling v1.
- **`types/bill-subs-api`, `types/botnet-feed-api` and `types/organizations-api` are `types/bill-subs`,
  `types/botnet-feed` and `types/organizations`,** with the same types, apart from the fields `Account` gains in
  `types/organizations`, as below. `types/rulesets` no longer exports `ManagedTransform`, `ManagedTransformInput`,
  `ManagedTransforms`, `ManagedTransformsPatchInput`, `ManagedTransformId` and `UrlNormalization`, which
  `types/managed-transforms` and `types/url-normalization` do, and `types/dlp` no longer exports the risk scoring models
  `Behavior`, `Behaviors`, `RiskEvent`, `RiskEvents`, `RiskLevel`, `RiskSummary`, `UpdateBehavior`, `UpdateBehaviors`
  and `UserRiskInfo`, which `types/risk-scoring` does, with the changes below. Change the import path. `types/tunnel`
  names the models of a tunnel hostname `HostnameRecord` where it named them `TunnelHostname`, such as
  `PostHostnameRecordBody` for `PostTunnelHostnameBody`, with the same types: change the name.
- **`cloudforce-one.threat-intel.events.legacy.bulkCreateWithRelationships` is gone,** as the spec no longer has its
  route, nor any in its place. To keep calling it while the API serves it, write its `Operation` and types by hand, as
  `{ method: 'POST', route: '/accounts/{account_id}/cloudforce-one/events/create/bulk/relationships', body: 'json',
  envelope: false }`, or stay on 0.4.0.

### Added

- 29 operations: `accounts.applications.references`; `ai-gateway.model-aliases.create`, `delete`, `get`, `list` and
  `update`; `d1.insights.recommendations` and `d1.insights.settings.get` and `update`; `feedback.diagnose` and
  `feedback.send`, which reports a problem to Cloudflare, with a `User-Agent` the spec says starts with `cf-cli/` or
  `cloudflare-mcp`; `flagship.apps.ofrep.evaluate` and `evaluateAll`, by the OpenFeature Remote Evaluation Protocol;
  `images.config.get` and `edit`, for an account's Images settings; `network-quality.settings.get` and `update` and
  `network-quality.tokens.create`, in beta, for Network Quality Tests; `o11y.destinations.get`;
  `pay-per-use.agreements.create` and `list` and `pay-per-use.enabled-publishers.list`; `user.subscriptions.get`;
  `workers.previews.deployments.profile`, which returns the profile's bytes; and
  `zero-trust.risk-scoring.behaviours.high-dlp.get` and `update`, `zero-trust.risk-scoring.behaviours.single.get` and
  `update`, for a behavior with no other settings, and `zero-trust.risk-scoring.event-clusters.list`, which groups a
  user's risk events by day.
  `ai-gateway.model-aliases.list`, `d1.insights.recommendations`, `pay-per-use.agreements.list` and
  `zero-trust.risk-scoring.event-clusters.list` are paginated.
- Doc comments say `flagship.apps.ofrep.evaluateAll` throws an `ApiError` with status 304 given a matching
  `If-None-Match`.
- `queues.subscriptions.list` takes `queue_id`, and Spectrum applications take `edge_alpn_protocols`. `d1.list` takes
  `fields`, `dns.records.list` orders by `created_on` or `modified_on`, `cloudforce-one.threat-signals.articles.list`
  takes `feed_category_id`, and RealtimeKit's storage configuration takes the type `cloudflare`, which requires an
  `account_id`. The `filters` of an alerting policy take `source`, `execution_interval`,
  `alert_trigger_preferences_operator`, `alert_trigger_preferences_short_window`,
  `alert_trigger_preferences_long_window` and `alert_trigger_preferences_minimum_threshold`, mostly for
  `custom_analytics` alerts.
- Results have new fields: `file_size`, `num_tables` and, when `fields` asks for it, `recommendation_count` on a
  database of `d1.list`; `scheduled_removal_date` on an abuse report's mitigation; `location.repo` on a finding of a
  vulnerability report; and `enterprise_provisioning_status` and `provisioning_mode` on an account of
  `organizations.accounts.list`.
- `alert_enabled` in `cloudforce-one.threat-intel.events.queries` is no longer deprecated, as the spec says it sends
  notifications again.
- `types/*` export the models that Forge's release wrote in place, such as `DnsFirewallCluster`, `DnsViewInput` and
  the `ApiResponseCommon` of several modules.

### Changed

- The spec is the `openapi.json` of a cloudflare/api-schemas commit, as cf's is since 2026-11-23, rather than Forge's
  `openapi.forge.json` release of it, which leaves the account-or-zone operations hidden and unnamed from `0c348dc4`
  on. Types follow it where the release changed the spec:
  - A recursive type refers to itself where the release cut it short as `{ [key: string]: unknown }`, such as
    `JsonValue` in `types/flagship`, `CrawlJsonValue` in `types/brapi` and an `ActiveSession`'s `breakout_rooms` in
    `types/realtimekit`.
  - A value whose alternatives include `""` takes only those, where the release took any string: `model` and
    `reranking.model` in `autorag.aiSearch` and `autorag.search` take the listed models or `""`, and
    `notification_email` in `load-balancers.pools.bulkEdit` and `user.load-balancers.pools.bulkEdit` takes only `""`,
    as its description says.
- Doc comments of the account-or-zone operations list token permissions for an account and for a zone apart where the
  two differ, such as `Account Custom Pages Write` and `Custom Pages Write`, rather than one set for both.
- Doc comments of operations the spec names by an alias, such as those in `o11y` and `workflows.instances.pause`, list
  their token permissions, and the 24 in `o11y` that the spec says are in beta, such as `o11y.issues.list`, say so.
- Doc comments of the `workers-for-platforms.dispatch-namespaces` operations list the token permissions the spec now
  gives them beside `Workers Scripts Write`, such as `Workers Admin` and `Workers Namespace Admin`, and 3 that listed
  none list theirs.
- What the spec requires in a branch of a `oneOf` or `anyOf`, of a field that a schema around it declares, is required:
  - `builds.create`, `builds.previews.createBuild` and `builds.triggers.createBuild` need `branch` or `commit_hash`;
    `stream.videos.copy` `input` or `url`; `abuse-reports.mitigations.review` `appeals` or `type`;
    `email-sending.send` `to`, `cc` or `bcc`, and `text` or `html`; `email-sending.subdomains.update`
    `drop_suppressed_recipients` or `preview_enabled`; `magic-transit.apps.create` `hostnames`, `ip_subnets` or
    `source_subnets`; `magic-transit.apps.edit` and `update` any of those, `name` or `type`; and
    `magic-transit.sites.app-configuration.create` `breakout` or `priority`. A field that may be `undefined` no longer
    counts as given, so check it first.
  - In results, a transferable domain of `registrar.registrations.transferCheck` has its `pricing`, and a ramp of
    `magic-transit.cf1-sites.ramps` has one of its kinds, such as `gre`.
- `workers.versions.profile` takes `actor_id` and `namespace_id` together or not at all, as the API refuses either
  alone.
- `zero-trust.risk-scoring.get` and `zero-trust.risk-scoring.summary.get` are paginated, over a user's `events` and an
  account's `users`, and take an order. `get` also takes a time range and a time zone.
  `zero-trust.risk-scoring.behaviours.update` takes a behavior's `points` beside its `risk_level`, which it no longer
  requires.
- Forge is 0.3.0, which reads a `required` beside an `allOf`, as a restated branch already did, so no field changes. It
  writes some models in place, so `types/access` no longer exports `AppRespEmbeddedTargetCriteriaInfra` and
  `AppRespEmbeddedTargetCriteriaSelfHosted`, `types/dns-settings` `DnsView`, `types/smartshield`
  `SmartShieldSettings`, and `types/waf-managed-rules` `Base`, `Group` and `SchemasBase`. Name the type that holds
  one instead, such as `DnsViewResponse`.
- Types follow the spec's other changes. Those that can break a call:
  - `cloudforce-one.threat-signals.articles.list` and `cloudforce-one.threat-signals.search` take a list as `feed_id`:
    give one feed as `[feed_id]`.
  - `turnstile.widgets.create` no longer takes `page`, `per_page`, `order`, `direction` and `filter`, which are
    `list`'s, and `turnstile.widgets.update` no longer takes `region`, which can't change after creation.
  - `web3.hostnames.delete` and `web3.hostnames.ipfs-universal-paths.content-lists.entries.delete` no longer take a
    `body`.
  - `url-scanner.scans.create` no longer takes `CD`, `CW`, `GD`, `GU`, `HT`, `LR`, `MA`, `MM`, `MW`, `TJ` and `UZ`
    as its `country`.
  - DEX notification outcomes from `zero-trust.dex.notifications` no longer have `sample_interval`, nor their counts
    `estimated`, as the counts are exact. The results of `pay-per-use.enabled-domains.list`,
    `pay-per-use.pricing.listOperators` and `pay-per-use.proposals.list` no longer have `non_billable_since`.
  - Risk scoring behaviors and events have `points`, `zero-trust.risk-scoring.get` always has `last_reset_time`, a
    user's `max_risk_level` from `zero-trust.risk-scoring.summary.get` can be `unset`, and
    `zero-trust.risk-scoring.behaviours.update` returns every behavior as a `Behaviors`, rather than an
    `UpdateBehaviors`.

## [0.4.0] - 2026-11-22

This release breaks calls: each breaking change below says how to update one.

### Breaking

- **33 operations are renamed by the spec,** now generated from Forge's `openapi@2b2a4d86` rather than `debf614f`. cf's
  commands take the same names. Each keeps the shape of its request and result, but their types take the new name, so
  import them from the new path under that name, such as `EditRequest` for `UpdateRequest` in `realtime/kit/apps`, or
  `BulkDeleteRequest` from `kv/keys` for `DeleteRequest` from `kv/bulk`:

  | Was | Now |
  | --- | --- |
  | `builds/repos/connections`: `upsert` | `builds/repos/connections`: `replace` |
  | `builds/triggers`: `update` | `builds/triggers`: `edit` |
  | `builds/triggers/environment-variables`: `upsert` | `builds/triggers/environment-variables`: `edit` |
  | `builds/workers`: `update` | `builds/workers`: `edit` |
  | `cloudforce-one/rules/email`: `updatePendingApproval` | `cloudforce-one/rules/email/approvals`: `replace` |
  | `dns/dnssec/list`: `zsks` | `dns/dnssec/zsks`: `list` |
  | `dns/records`: `batch` | `dns/records`: `bulkApply` |
  | `email-routing/addresses`: `update` | `email-routing/addresses`: `edit` |
  | `email-routing/settings`: `apply`, `update` | `email-routing/settings`: `replace`, `edit` |
  | `batch` in the 7 `email-security/*` groups that have it, such as `email-security/domains` | `bulkApply`, or `bulkDelete` in `email-security/sending-domain-restrictions`, which only deletes |
  | `hyperdrive`: `update` | `hyperdrive`: `edit` |
  | `kv/bulk`: `delete`, `get`, `put` | `kv/keys`: `bulkDelete`, `bulkGet`, `bulkPut` |
  | `network/subnets/initial-resolved-ip`: `edit` | `network/subnets/initial-resolved-ip`: `replace` |
  | `update` in `realtime/kit/apps`, `realtime/kit/meetings`, `realtime/kit/meetings/participants`, `realtime/kit/presets` and `realtime/kit/webhooks` | `edit` |
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

- 12 operations: `tunnels.hostnames.create`, `delete`, `edit`, `get` and `list`,
  `ai-gateway.billing.topup.getEligibility`, `cloudforce-one.priority-intelligence.topics.list` and
  `cloudforce-one.requests.quota.get`, whose responses the spec now describes, `createLegacy`, `deleteLegacy` and
  `listLegacy` in `r2.buckets.domains.custom`, for the deprecated `custom_domains` route, and
  `pages.deploy-hooks.trigger`, which starts a deploy hook's deployment.
- Doc comments say when an operation throws an `ApiError` with status 304, which a caller may take for success:
  `pages.deploy-hooks.trigger` when a deployment of the branch's latest commit already exists, and 7 GETs given a
  matching `If-None-Match` or `If-Modified-Since`, such as `r2.objects.get`.
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
- `stream.videos.copy` and `stream.videos.direct-upload.create` take `encodingMode`, to make a preview rendition
  first, and Stream videos report it with `previewStatus`.

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
  - `realtime.kit.meetings.active.kick` and `mute` require `participant_ids` and no longer take
    `custom_participant_ids`. The `participants` they return have only an `id`, as `ActionParticipant`s, and
    `types/realtimekit` no longer exports `SessionParticipant`.
  - `realtime.kit.sessions.transcripts.export` returns `session_id` in place of `sessionId`.
- `realtime.kit.meetings.active.muteAll` can be sent without a body, and its `allow_unmute` is deprecated, as the API
  ignores it: a muted participant can unmute themselves if their preset lets them produce audio.
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
    `type === 'worker_version' ? { resource_type: type, worker_id } : { resource_type: type }`. With `zone_id`,
    they take `access_application_id` for an `access_application_policy` alone, as below.
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
  - A realtime-kit session's `ended_at`, in `realtime.kit.sessions.get` and `list` and
    `realtime.kit.meetings.active.get`, can be `null`.

### Fixed

- Realtime recordings' `storage_config` no longer promises `access_key`, `password` or `private_key` in the results
  of `realtime.kit.recordings.get`, `list`, `start` and `control`, as the API never returns them. Nor does
  `realtime.kit.recordings.start` require them, as for other write-only fields.
- `tags.resources.get`, `delete` and `update` can tag a zone's resources. With `zone_id`, they took only the account's
  resource types, which the zone route refuses. Now they take the zone's, such as `zone` and `dns_record`, and
  `update` takes the zone's body, a `SetTagsRequestZoneLevel`. An `access_application_policy` takes its
  `access_application_id`: in the query for `get` and `delete`, and in the body for `update`. With `account_id`, they
  take the account's as before. A call that sends the account's resource type or body with `zone_id` no longer
  compiles, as the API refuses it. Nor does one whose scope is typed as `AccountOrZone`, as it could be either, so
  narrow it first: `scope.zone_id === undefined ? { ...scope, resource_type: 'worker', resource_id } : { ...scope,
  resource_type: 'zone', resource_id }`.
  `types/resource-tagging` exports `ZoneResourceType` and the zone's body types.

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
