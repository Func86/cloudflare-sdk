# Changelog

Changes a caller notices, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/), under which anything can change before 1.0. A minor
version can break calls, so `^0.1.0` doesn't take 0.2.0. A patch can still make a type match what the API sends, or
change something few callers rely on; its entry says how to update a call.

## [Unreleased]

### Added

- `ApiError` can be made from a status and any headers, without a `Response`:
  `new ApiError({ status: 403 }, body, 'GET', '/route')`, as a test needs.

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
