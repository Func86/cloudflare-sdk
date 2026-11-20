# TODO

## Type query parameters that exclude or require each other

Request types print query parameters as one flat object (`requestType` in `generator/plugin/index.ts`), so they accept
combinations the API refuses. Design one mechanism for every case below, with a table in `generator/patches.ts` and
evidence for each entry, rather than a fix per case.

- **Parameters that exclude each other.** Print them as a union in which each variant forbids the others' fields with
  `?: never`, as `exclusiveUnion` does for bodies.
  - `dns.records.list`: `page`, `cursor` and `prev_cursor`. A page number beside a cursor got 400, 9241, "Supply either
    cursor or a nonempty prev_cursor once, without page.", on 2026-11-20.
  - `zero-trust.dex.isps.list`: paged by number, but its `cursor` says "Mutually exclusive with page". `paginate` given
    a cursor sends `page=2` beside it, as `dns.records.list` did before its `cursors` override. Not tried live.
  - `workflows.instances.list`: paged by cursor, and its `cursor` says "Mutually exclusive with `page`".
  - To read first: custom hostnames' `hostname` filters against `id`, SCIM users' and groups' `cf_resource_id` and
    `idp_resource_id`, and Radar's `dateRange`.
- **A parameter required for one value of another.** `tags.resources.get` and `delete` need `worker_id` only when
  `resource_type` is `worker_version`. That splits an enum into variants, a second shape.

Found on spec `3dc49274` by searching query parameter descriptions for "mutually exclusive", "cannot be used with" and
the like. About half the hits were false positives, so read each description before adding an entry.
