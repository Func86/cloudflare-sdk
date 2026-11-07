# @libreflare/cloudflare-sdk

A small, always-current Cloudflare API client, generated the way the [cf CLI](https://github.com/cloudflare/cf)
generates its commands: a pinned `openapi.forge.json`, prepared, normalized by `forge normalize`, and run through a
Forge plugin.

```sh
npm install @libreflare/cloudflare-sdk
```

## Usage

An operation is a plain object you import. A client sends it. Nothing else reaches the bundle.

```ts
import { createClient } from '@libreflare/cloudflare-sdk';
import { list } from '@libreflare/cloudflare-sdk/workers/deployments';

const cf = createClient({ token, headers: { 'api-version': '2026-11-07' } });

const { deployments } = await cf.send(list, { account_id, script_name }); // the envelope's `result`
const page = await cf.page(list, { account_id, script_name, per_page: 10 }); // { items, result, resultInfo }
for await (const deployment of cf.paginate(list, { account_id, script_name })) {
	// every item of every page, with no trailing request when the last page is known
}
```

- Field names are the wire names, with no renaming or runtime conversion.
- A request is one object: path, query and header parameters, plus a `body` field for the payload.
- An operation for an account or a zone, such as `rulesets.list`, takes `account_id` or `zone_id`: `{ zone_id }` sends it
  to `/zones/{zone_id}/rulesets`. Its request type is `AccountOrZone & { ... }`, so a request with both or neither is a
  compile error, and a `TypeError` without types. A type made from it with `Omit` or `Pick` loses that rule, as it does
  for any union, so type a helper's scope as `AccountOrZone`.
- `send` returns `undefined` when a success leaves out `result`, though result types don't say so. 1,280 of the 2,835
  success envelopes declare `result` optional, mostly through shared base schemas, and adding `| undefined` would make
  nearly half of all calls check for a case not seen live. The official SDK types it the same way.
- A ruleset write that takes `dry_run`, such as `rulesets.create`, returns what it changed, or `null` with
  `dry_run: true`, which only validates. With a `dry_run` that may be either, such as an optional `true` or a
  `boolean`, it's both. Such an operation is a `DryRunOperation`, listed in `DRY_RUNS` in `generator/patches.ts`. Its
  result type, such as `CreateResult`, keeps the `null`, so it holds wherever the operation is passed as an
  `Operation`; `send` leaves it out of a request whose `dry_run` is left out or `false`.
- Types are importable from `@libreflare/cloudflare-sdk/types/<prefix>`, such as `types/workers`.
- `paginate` only accepts paginated operations, so calling it on anything else is a compile error. It throws a
  `TypeError` on a response that isn't a page, such as CSV, rather than looking like an empty list.
- Failures throw `ApiError` (with `status`, `errors`, `messages`) or `ApiConnectionError`. `errors` keeps what the server
  said in any shape: strings, objects with no `message`, and a failure under `error`, `message` or `msg`. An entry's
  `source.pointer` names the field a validation error is about, such as `/rules/0/action`. An entry leaves out a `code`
  that isn't a number or a string, a `documentation_url` that isn't a string, a `source` that isn't an object, and a
  `pointer` in it that isn't a string; `body` keeps the response as sent.
- `ApiError` also covers a 2XX whose body should be JSON and isn't, such as a proxy's HTML page, and a failed envelope
  from an operation that answers in another format or with no content. `ApiConnectionError` also covers a response that
  breaks off or times out while it's read.
- An operation that can answer in several formats returns a union, so narrow it: `screenshot` gives a `Uint8Array` for
  an image. A call's `headers` can ask for a format, such as `{ accept: 'text/csv' }`.
- Server-sent events, which `queues.metrics.get` sends when asked for `text/event-stream`, come back as a
  `ReadableStream` to read as they arrive. `timeoutMs` stops applying once it's returned, and the call's `signal` ends
  it.
- Headers apply from least to most specific: the client's, then the operation's `accept` and content type, then the
  request's header fields, then the call's `headers`. A form always leaves its content type to `fetch`, which adds the
  boundary.
- A path parameter with a `.` or `..` segment throws `TypeError` before any request, because URL parsing would resolve
  it against the route and reach another endpoint.
- `maxRetries` waits as long as `Retry-After` says, in seconds or as a date, up to 60 s, and `0` retries at once. A
  longer wait throws the failure at once, with the header in `error.headers`. Without one, or with a date that has
  passed, the wait doubles from 0.5 s, up to 8 s.
- `timeoutMs` bounds each attempt, not the waits between them. A call's `signal`, such as `AbortSignal.timeout(10_000)`,
  bounds the whole call.
- The `fetch` option is called as a plain function, so wrap a service binding's:
  `fetch: (input, init) => env.API.fetch(input, init)`. Passing `env.API.fetch` fails with "Illegal invocation".
- Two groups are named `default`, `zaraz.default` and `zero-trust.devices.profiles.default`, so they're their parent
  module's default export: `import zaraz from '.../zaraz'` gives only `zaraz.default`. Use `import * as` or a group's
  own path.
- A stream can be a raw body, and isn't retried, because it can only be read once.
- Names are the spec's, as cf's commands are, not the official SDK's. On the 2,531 routes both cover, 56% of names
  match. Most differences are in the group, such as `browserRun` for its `browserRendering`, and some in the method,
  such as `rulesets.rules.update` for its `rulesets.rules.edit`.

## Generating

```sh
npm install
npm run generate    # builds generator/sdk.wasm, downloads the pinned document, replaces generated/ when it succeeds
npm run build       # compiles src/ to dist/; the generated types import from it
npm run check:type
npm run lint        # ESLint with type information, and Knip for unused files, exports and dependencies
npm test
```

The package ships `generated/` as `npm run generate` wrote it. `npm publish` builds `dist/` and runs the type checks,
lint and tests first.

`npm run lint` runs Knip twice: over everything, and then over `src/` alone for exports that only tests or the
generator use, since only `src/` ships as code.

Forge isn't on npm, so this pins the same pkg.pr.new build as cf. npm 12 refuses tarball URLs by default, so `.npmrc`
sets `allow-remote=root`, which allows ones listed in this `package.json` and not ones its dependencies declare.

| File | What it does |
| --- | --- |
| `generator/generate.ts` | Holds the pin, and pipes the document through `forge normalize` into the plugin |
| `generator/prepare.ts` | Changes the document for what the plugin can't decide (see below) |
| `generator/patches.ts` | Spec corrections with evidence, pagination overrides, hidden operations left out, renames, comma-separated lists |
| `generator/entry.ts` | The plugin's entry module, which `forge-plugin build` compiles |
| `generator/plugin/operations.ts` | Reads Forge's methods, including pagination inference |
| `generator/plugin/types.ts` | Prints Forge's types as TypeScript, with separate read and write variants |
| `generator/plugin/index.ts` | Writes each group's `index.js` and `index.d.ts`, and `_types/` |
| `generator/plugin/names.ts` | Finds names that need a look, for `_meta/report.json` |
| `generator/manifest.ts` | Lists the names a run changes against the last output |
| `generator/names.ts` | Lists the names the output changes against a commit, for release notes |
| `generator/conformance.ts` | Compares captured live response shapes with the spec |
| `src/client.ts` | The hand-written runtime |
| `src/media.ts` | How a media type is read, a rule the runtime and the generator share |
| `src/routes.ts` | The account-or-zone route prefix, which the runtime and the generator share |
| `eslint.config.mjs`, `knip.json` | Lint for simple mistakes, and for unused code and dependencies |

### What the generator decides

- **Pagination is inferred from the response shape.** Only 2 operations state it with `x-fern-pagination`. A GET
  with page, cursor or offset parameters paginates over `result`, or over the one array inside it. Anything
  ambiguous isn't paginated and is listed in `generated/_meta/report.json` (44 operations today).
- **`readOnly` fields get a separate input type,** `FooInput`, where they're optional. A value read from the API can
  still be sent back.
- **An operation with several formats is read by each response's content type.** 15 operations declare JSON and
  something else, so their result is a union. The 3 with a binary format send `Accept: */*`, as operations with no JSON
  do. The 11 with a text format and the 1 with server-sent events keep `application/json`, because some choose by
  `Accept`, such as CSV. The 15 SCIM operations ask for `application/scim+json`, the only JSON they declare. One
  operation declares several formats and no JSON, `cloudforce-one.threat-signals.feeds.getRaw`: it's read the same way,
  as `Uint8Array | string` for its XML and text, and a response with no content type, or with JSON, is read as XML is.
  The runtime and the generator sort media types by one rule, in `src/media.ts`.
- **A field declared in several `allOf` branches keeps what each says.** Envelopes often declare `result` more than
  once: a generic one never replaces a concrete one, and concrete ones combine. `images.list` keeps the base's
  `continuation_token` beside its `images`, and `rules.lists.*` keeps its list types over the base's "any object or
  array". The plugin checks pagination overrides with this rule, and the conformance checker repeats it on the raw
  schemas.
- **A query parameter named as a template is a pattern.** Images' `meta.<field>[<operator>]` is typed as any key
  matching `` `meta.${string}[${string}]` ``, such as `meta.status[eq]`, and each one given is sent.
- **A declared `Accept` or `Content-Type` parameter is a request field.** `r2.objects.put` takes the object's
  `Content-Type`, which otherwise defaults to the declared `application/octet-stream`, and 2 operations choose a format
  with `Accept`.
- **An account-or-zone route takes `account_id` or `zone_id`.** The spec writes 78 routes, used by 134 operations, as
  `/{account_or_zone}/{account_or_zone_id}/...`, with a selector and an ID. Their request types take the account's or the
  zone's ID instead, as other operations do, and their docs show both routes. Each literal is marked `accountOrZone`, and
  the runtime fills the prefix only for a marked operation, so a hand-written one can still give the pair. Generation
  stops if the pair appears anywhere but at the start, if the selector takes anything but `accounts` and `zones`, or if
  the operation has its own `account_id` or `zone_id`.
- **A cursor list ends when its cursor does.** An empty page can have more after it: KV documents this for deleted
  keys, and R2 does it for keys grouped by a delimiter.
- **A page list ends at the total `result_info` gives,** or at a short page when it states the page size. An offset
  list ends at `total_count`, which none of the 22 declares. Only `ai-search.items.chunks` declares `result_info`
  fields, `limit` and `total`, and the runtime doesn't read them. Otherwise either ends at an empty page, at the cost
  of one more request, because the API may cap the size asked for. A repeated page ends it only when there's no total,
  since two pages alike can be real data.
- **A binary field in a form is `Blob | string`,** whether it's inline or in a model, so a KV value can be text. A model
  is printed once, so generation stops if one with such a field is used in JSON, where it would need a variant.
- **A declared 204 is part of the result type.** 4 operations that answer in JSON add `undefined`.
- **A `result` beside other data isn't an envelope.** A response with `result` is unwrapped when it also declares
  `success`, `errors` or `messages`, or declares nothing else, as 9 operations such as `dns.records.delete` do.
  `url-scanner.scans.create` and `abuse-reports.create` declare `result` beside their data, the report's URL beside
  the scan's `uuid` and `"success"` beside the report's `abuse_rand`, so they return the whole body.
- **A bare branch of a success is part of the result type.** `ai.models.list` with `format: 'openrouter'` answers with
  only `{ data }`. `send` and `page` return it, and `paginate` throws.
- **A form beside JSON is a `FormData`.** 3 operations declare both, such as `stream.watermarks.create`, where only a
  form can carry a file. Their `body` type adds `FormData`, which the runtime sends as a form, so that form's fields
  aren't typed. Other operations with several body formats reach the same result through the one generated.
- **An operation served from another host is left out.** K2's 9 data-plane operations declare
  `https://{stream_id}.k2.cloudflarestorage.com`, and the runtime would send them to the API's base URL.
- **A numeric path parameter takes a number or its text.** Other path parameters are strings, whatever model names
  them, but the 57 declared as integers or numbers, such as a Logpush `job_id`, also take the number the API sends as
  the ID. Text keeps an int64 above 2^53, or a decimal such as a Magic connector event's timestamp, exact.
- **Spec patches expire.** A patch whose defect has gone stops generation, so an upstream fix retires it. So does a
  pagination override whose operation is gone, now states its own pagination, or no longer has the array it names.
  Besides those described elsewhere, patches require each ruleset rule's `action`, which the API rejects a rule
  without and the spec names as the discriminator, apart from an update that only moves a rule, by its `position` with no
  field of a rule beside it; take each rule's `action_parameters` from its action alone, as the API refuses any other
  key; and add the 3 fields a Logpush job has undeclared and stop a listed job from being `null`. `RequestRule` lists
  its variants so that each declares `?: never` for the fields only others have, as `EXCLUSIVE_MODELS` in
  `generator/patches.ts` says: the six actions that take no parameters, such as `log`, have `action_parameters?:
  never`, though the API also accepts `{}`. Code can read `action_parameters` on any `RequestRule` or
  `ResponseRule`, but not on `Rule`, the base every variant shares, which no longer declares it.
- **A string described as a comma-separated list is a list,** sent joined with commas, where `COMMA_LISTS` in
  `generator/patches.ts` names it: Builds' `version_ids` and `external_script_ids` for now. Of the 52 query strings
  whose description says comma-separated, comma-delimited or separated by commas, each of the other 50 is added after
  reading its description, because some aren't plain lists: Workers' `tags` takes `tag:yes` pairs, a `status` can be
  `all`, and Page Shield's `urls` takes URLs encoded beforehand. The joining comma is sent encoded, as `%2C`, which
  Builds splits, as a live check showed.
- **Names come from the spec, apart from its mistakes.** `x-fern-sdk-group-name` and `x-fern-sdk-method-name` name
  3,631 of its 3,633 operations, and cf uses them too. They follow current product names, and a mistake in them shows
  in Cloudflare's own CLI. A rename in `generator/patches.ts` fixes a mistake, with its reason, and stops generation once
  the spec names the operation otherwise. 32 are renamed, to the official SDK's names where it has them: an `account-`
  group from before account and zone routes were merged, such as `logpush.account-jobs` for `logpush.jobs`; Logpush
  validations named `delete` and `create`; 4 hidden Cloudforce One methods that repeat their group, such as
  `cloudforceOneRequestGet` for `get`, as a hidden operation's name is never shown; and the hidden Email Security move
  described below. Forge stops when two operations take one name, so a rename can't take another's. Every name passes three rules, which
  `npm test` checks: its verb is one its HTTP method does, apart from an RPC-style route such as `POST …/bulk/delete`
  and a read by POST whose body says what to read, such as `ai-audit.robots.bulkGet`; an account-or-zone route has no
  `account-` or `zone-` group; and a method doesn't repeat its group. `npm run generate` lists the names that break one
  in `_meta/report.json`, and prints the names it renamed or removed against the last output, which break the calls
  that import them. It compares names, so one that moves to another route is unchanged. A second run would print
  nothing, so for release notes `npm run names -- <git ref>` compares the output with a commit's, such as the last
  release's.

### What `prepare.ts` works around

A plugin only sees Forge's model, and each of these is lost before it runs. All were found by comparing the plugin's
output with a direct reading of the spec. No type check catches them, because the types only become weaker.

| In the spec | What Forge does | What `prepare.ts` does |
| --- | --- | --- |
| `required` beside an `allOf` or a `oneOf`, or in a branch without the property | Ignores it, so the field is optional | Restates it in a branch that declares the property (249 names) |
| `readOnly` only on the schema a `$ref` points at | Doesn't see it, and ignores keys beside a `$ref` | Wraps the reference in `allOf` with the flag and the schema's description (592 properties) |
| `writeOnly` | Has no such flag | Stops requiring the field (14), so responses don't promise it |
| `nullable` in one `allOf` branch, such as Pages' `latest_deployment` | Drops it, or intersects it away | Makes the `allOf` nullable (9 that reach a type, and an error body), whether a property, an item or a map's values, as the official SDK types Pages' |

A spec patch exempts API Shield's `operation`, whose nullable branch only adds `features`: read as written, every
operation listed, created or read would be nullable. Any other named schema that would turn nullable as a whole stops
generation until a patch like that one decides it, because every use of it would change.

These apply to schemas wherever they're declared, including shared request bodies such as `rulesets.create`'s, which
now requires `name`, `kind` and `phase`.

The `writeOnly` change is a trade-off: a request type no longer requires a field like `password`, and the API reports
that with a clear error. Fields with `x-stainless-skip`, such as `access.Tag.app_count`, are left out, as they are in cf.

Forge also has no `allowReserved`, which R2 object keys declare because the spec requires their slashes to stay literal.
`prepare.ts` names such parameters in an `x-sdk-literal-slashes` extension, which the plugin reads.

### Hidden operations

The spec marks 522 operations `x-fern-ignore` without saying why, and Forge drops them. This generator removes the mark
unless there's a concrete reason not to, because the mark doesn't mean an operation is broken: Libreflare calls
`POST /secrets_store/stores`, which is one of them.

| Left out | Operations | Reason |
| --- | --- | --- |
| Deprecated | 293 | The spec marks them deprecated |
| For Terraform alone | 9 | `x-fern-audiences` names only Terraform |
| `/email/domains*`, `/email/domain-changes` | 6 | Alpha, and documented as open to one pilot account behind a gate |
| `PUT` and `DELETE /zones/{zone_id}/subscriptions` | 2 | Documented as replaced by the singular `/zones/{zone_id}/subscription` |
| `cloudforce-one/requests/{constants,quota,types}` | 3 | Replaced by generally available `/v2/` routes, whose groups take these names |

The rest are generated, subject to the rule below. The last three rows are `EXCLUDED_IGNORED` in `generator/patches.ts`,
and an entry that no longer matches a hidden operation stops generation. `POST .../events/{event_id}/raw/{raw_id}` stays
in although it says "legacy", because it also says it has no direct replacement. The hidden single-message move is
renamed to `email-security.investigate.moveOne`, so it doesn't collide with the visible bulk
`email-security.investigate.move`.

None of these has been called against the live API. Since the spec doesn't say why they're hidden, some may turn out to
be unfinished.

### Operations with no declared response

28 operations, hidden or not, answer with a status like 200 and declare no content, only a description such as
`"200": { "description": "List of PIRs" }`. No type exists to generate, and the official SDK has none either. Only a
captured response could provide one, and nothing here uses them, so they're left out. They include 19 under
`cloudforce-one`, such as `priority-intelligence` and `requests/{project_type}/quota`.

`DELETE`s are the exception: 13 stay in as `void`, because a caller doesn't depend on the body and a failure still throws
`ApiError`. This is a rule rather than a list, so an operation comes back once Cloudflare describes its response, or once
a spec patch does, since patches run first.

## Findings

Measured on 2026-11-07, against `cloudflare` 7.1.0 and 7.4.0, spec `07fc9fa4` and Forge `0d187743`.

### Why not the official SDK

- **#2805 is a class of bug, not one bug.** 17 of the 18 operations using `V4PagePagination` read `result.items`,
  while the spec names the array something else. Confirmed live for `deployments`, `images`, `resources` (load
  balancer search) and `reports` (abuse reports). The other 13 are by the spec only.
- **Coverage.** 722 of the spec's 3,111 non-ignored operations have a path that appears nowhere in the 7.4.0 source,
  including 36 for Workers Builds. Libreflare hand-writes its `/builds/*` calls and types for this reason.
- **Freshness.** Five SDK releases since July, against several spec releases a day.
- **Binary responses and empty pages.** It types the screenshot result as only `{ success, errors }`, and ends a cursor
  list at the first empty page.

It isn't behind on everything: it handles streamed bodies, `.` or `..` path segments, multipart beside JSON, errors
outside the usual shape, the order of headers and a cap on its own backoff, as this package does.

### Size, on Libreflare's 38 operations

| | Official, tree-shaken | Official, full client | This package |
| --- | --- | --- | --- |
| Bundle, minified | 52.0 KB | 633 KB | 11.7 KB |
| Bundle, gzipped | 13.4 KB | 76.6 KB | 4.1 KB |
| Import + create client in Node, median | 2.6 ms | 38 ms | 1.2 ms |
| `tsc` files, consumer with 7 calls | 1,146 | not measured | 170 |
| `tsc` memory, same consumer | 231 MB | not measured | 68 MB |
| Package, gzipped | 7.3 MB | 7.3 MB | 1.0 MB |
| Package, files | 16,289 | 16,289 | 2,722 |

Libreflare's hand-kept resource list already avoids the official client's worst cost, so the bundle and cold-start
gains are modest in absolute terms. Coverage, correctness and not maintaining that list matter more.

Import through direct group paths. `import * as workers` followed by `workers.deployments.list` compiles, but
esbuild keeps the whole nested group: 32 KB for the same operations.

### Accuracy of the spec

The generated types are only as right as the spec, so this is the main risk. 13 read endpoints on a test account,
300 fields, by `generator/conformance.ts`:

- 7 fields have the wrong nullability, such as `zones[].owner.id` and `accounts[].settings.abuse_contact_email`.
- 27 fields are undeclared, such as `user.username` and `rulesets[].source`. A patch adds the 3 on a Logpush job,
  such as `filter`, which leaves 24.
- No required field was absent.
- The official SDK has the same gaps on the fields looked up there.

This is a small sample of one account. Six other endpoints couldn't be checked: three returned empty lists, two
needed permissions the test token lacks, and one needs a build to query. Expect to write patches.

### Verified

- The issue's scenario against the live API: 2 deployments in 2 requests with `per_page: 1`. This ran on an earlier
  generator that read the spec directly, whose operation literals match the plugin's on all 3,110 routes both generate.
- `workerd` 2026-11-01 runs the runtime: pagination, multipart uploads, a form beside JSON, binary responses, a cancelled
  retry delay, a streamed body as far as `new Request`, the order of headers, failures in other formats, a body that
  breaks off, a `Retry-After` beyond 60 s or as a date, server-sent events read past a timeout, and Images' metadata
  filters. Node sends a streamed body to a local server with its real `fetch`.
- Read-only on the live API: the screenshot endpoint returns a PNG. `intel.dns.list` reads `start` and ignores both
  `start_end_params` forms tried. An R2 listing with a delimiter returns empty pages with cursors. Audit logs and R2 stop
  sending a cursor at the end of a list. `ai.models.list` with `format=openrouter` returns only `{ data }`.
  `GET /builds/builds/not-a-uuid` fails with `error` rather than `errors`.
- The generated declarations pass strict `tsc`. Pagination matches the official SDK on 179 operations, and of the
  operations generated, the SDK paginates none that this doesn't.
- The plugin's types against those of that earlier generator, with TypeScript's checker: 5,119 of 5,136 models are
  identical across 29,917 fields, and each of the 17 others is explained.

### Not verified

- 23 operations this paginates and the official SDK doesn't. 6 where the spec declares a cursor and the SDK uses page
  numbers.
- Any write operation against the live API.
- Bundlers other than esbuild.
- `Accept: */*` on binary operations, and `application/scim+json` on SCIM's. The tool used for live checks can't set
  headers, so neither these nor the earlier `application/json` were tried on the API.
- `queues.metrics.get` as server-sent events, and Images' metadata filters, on the live API. Both were tried only
  against stand-in responses.
- That the API caps a page size without saying so. Where only the caller gave the size, a list now ends at an empty
  page, which costs a request either way.
- That the 9 schemas made nullable are sent as `null`. The spec marks a branch of each nullable, and the official SDK
  types Pages' `latest_deployment` as nullable too. Nor that API Shield's `operation`, exempted by a patch, never is.
- That literal slashes matter. A `GET` of an existing R2 key worked live both with them and with `%2F`, as far as that
  tool passes a path unchanged. They're kept because the spec requires them. `PUT` and `DELETE` weren't tried.
- `artifacts.namespaces.repos.raw.get`. Its two spec patches rest on its descriptions, as the test account gets a 403.
- That every cursor ends. A cursor list has no request limit, because a limit would silently cut it short. Most cursor
  endpoints weren't tried, and one that always sent a new cursor would never finish.
- String entries in `errors` and `messages`. The spec declares them on 184 operations, but the responses tried had objects
  or empty lists.

## Known gaps

- **Cloudforce One request quota isn't reachable.** v1 is left out in favour of v2, and v2 declares no response.
- **K2's data plane isn't reachable.** Its operations are on a host for each stream, which the runtime has no way to
  name.
- **`cloudforce-one.requests.constants.get` has the wrong type.** Its schema is nested one level too deep, under a
  literal `properties` key.
- **The official SDK reaches 130 endpoints this doesn't:** 96 deprecated, 18 not in the spec, 7 for Terraform alone, 4
  with no declared response (including `POST /stream`), 3 left out above, and 2 with no group name
  (`/zones/{zone_id}/settings/nel`).

## Forge dependencies

Forge is early. Its plugin interface is pre-1.0 (WIT 0.3.0), and it says breaking changes will bump the minor version.
Pinning it by commit means nothing moves until the pin does, and a change in the spec's extensions reaches this code
through `forge normalize`. Aliases replace the name they rename, so the output has `o11y.*` and not `observability.*`,
as cf does.

## Why not Forge's built-in `--target ts`

- It fails on the pinned spec: `schemas "stream_watermarkAtUpload" and "stream_watermark_at_upload" have the same name`.

From its source, once that's fixed:

- It decodes `date-time` to `Temporal.Instant` and rethrows the `ReferenceError` when `Temporal` is missing, which it
  is on `workerd`.
- It skips non-JSON operations (58 by its rule), including Worker uploads.
- It renames fields to camelCase through runtime codecs, which adds weight this design avoids.

Cloudflare says official Forge-based SDKs are coming, with no date. Keeping application code to `send` and `paginate`
should keep a later move cheap.
