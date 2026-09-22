# Client request metadata API

A machine client reads back what the proxy recorded about its own requests,
with the same key it sends those requests with. Every route is
`GET /client/v1/<resource>` and every row it can reach is one this key
produced. Prompts, response bodies, headers and payloads are never exposed;
identity and accounting are.

| Resource | Route | Purpose | Schema | Example |
| --- | --- | --- | --- | --- |
| `request` | `GET /client/v1/requests/{id}` | One request by id | [Schema](schemas/request.schema.json) | [JSON](examples/request.json) |
| `requests` | `GET /client/v1/requests?tag=&limit=&after=` | One page of requests carrying a correlation tag | [Schema](schemas/requests.schema.json) | [JSON](examples/requests.json) |
| retention | `GET /client/v1/retention` | `{"requestRetentionDays": 3650}` | (none) | (none) |

Field names are camelCase. Instants on this surface are milliseconds since the
Unix epoch, not RFC3339 strings. Accept unknown object fields: the schemas
allow additional properties and new fields are additive.

Every response, success or error, carries `Cache-Control: private, no-store`.

## Authentication

Send the client key in `x-api-key`, or as `Authorization: Bearer <key>`. Both
are the same credential the client proxies AI traffic with.

```sh
curl -s "$CLANKERMUX/client/v1/requests/$REQUEST_ID" -H "x-api-key: $CLIENT_KEY"
```

The namespace is GET-only. Any other method on a known route answers `405`
with `Allow: GET`. Authentication runs before the route lookup, so an
unauthenticated caller gets `401` for every path under `/client`, including
paths no route serves.

A read here does not count as a request by that client. `last_used` and
`usage_count` stay where they were, so polling your own history does not make
an idle client look active and `usage_count` keeps meaning "proxied requests".

## The error envelope

Every non-2xx response on this surface, from the mount and from the router
alike, has one body shape:

```json
{"type": "error", "error": {"type": "not_found", "message": "No request with that id is readable with this key."}}
```

| `error.type` | Status | Cause |
| --- | --- | --- |
| `authentication_error` | 401 | No key, an unknown key, or a disabled one |
| `invalid_request` | 400 | Missing or malformed `tag`, `limit` out of range, an `after` value this server did not issue |
| `method_not_allowed` | 405 | A known route addressed with something other than GET |
| `not_found` | 404 | No readable row with that id, or no route at that path |

Branch on `error.type` for these four. Treat any other value as its status
code says.

## Where the request id comes from

The proxy returns `x-clankermux-request-id` on the response to the proxied
request. That value is the `{id}` these routes take, and it is set for every
provider, so a client cannot tell from the header which backend served it.

It is present in the INITIAL response headers, before the first byte of the
body, for streamed and non-streamed responses alike. A client can record it when
headers return and start forwarding bytes without waiting.

A request the gateway refuses on its own carries it too, so a refusal is
reachable by id like any other request. The header identifies the REQUEST, not
a stored row: it is set whether or not the request is one Request History
keeps, so a lookup can still answer 404 for the reasons listed below.

The exception is a request rejected during ingestion, before an id is assigned
at all: a malformed body, a path that does not route, an authentication
failure. Those never reached a provider and there is nothing to look up.

One proxied request produces exactly ONE row under ONE id, whatever happens
upstream. If the proxy retries, or falls back to another account, provider or
model, every attempt stays under the id it first answered with. So more than one
distinct id for a single correlation tag means more than one request was made,
never that one request was split. `failoverAttempts` describes attempts INSIDE
that single row and never implies a second one.

## Correlation tags

Send `x-clankermux-correlation-tag` on a proxied request to label it with an
identifier you choose, then search for that label here.

- 1 to 128 bytes, every byte printable US-ASCII (0x20 to 0x7E). TAB and DEL
  are not printable US-ASCII and are rejected with everything else outside the
  range.
- Stored verbatim or not at all. A value that fails the test is dropped, the
  row's `correlationTag` is null, and the request itself still succeeds. A
  metadata header never fails a model call, and no repair is attempted: a tag
  silently rewritten to something valid would be a tag the client cannot look
  itself up by.
- Never forwarded to a provider. The whole `x-clankermux-` prefix is stripped
  from the outbound request.
- Not unique. The search returns every row carrying the value.

A tag is not a project, not a routing hint, and appears nowhere in the
dashboard. The search validates the query parameter with the same rule the
ingest header uses, so a tag that can be stored can always be searched for.

## Reading one request

`GET /client/v1/requests/{id}` answers with the `request` resource:

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | `clankermux.client.request.v1` |
| `id` | string | The request id, as returned in `x-clankermux-request-id` |
| `timestamp` | number | When the row was written, ms epoch |
| `finalized` | boolean | Whether accounting for this row is complete |
| `statusCode` | number \| null | The status recorded for the exchange |
| `error` | string \| null | The recorded error text, null when none was recorded |
| `model` | string \| null | The model the accounting was recorded against |
| `requestedModel` | string \| null | The model the client asked for |
| `inputTokens` | number \| null | Prompt tokens that neither cache class covers |
| `outputTokens` | number \| null | Generated tokens |
| `cacheReadInputTokens` | number \| null | Prompt tokens served from the cache |
| `cacheCreationInputTokens` | number \| null | Prompt tokens written to the cache |
| `usageSource` | `provider` \| `approximate` \| `none` \| null | Provenance of the token vector |
| `failoverAttempts` | number \| null | The attempt index the answering try was made under. Above 0 means earlier attempts happened; 0 does not prove none did, and null says the same as 0 |
| `project` | string \| null | The project the proxy attributed the request to |
| `apiKeyId` | string | The client id the row is scoped to |
| `correlationTag` | string \| null | The stored tag, null when none was accepted |

`model` is what the accounting names, so it stays null until a token vector
lands, while `requestedModel` is known from the request itself. The two differ
whenever the proxy or the provider served something other than what was asked
for.

## Searching by tag

`GET /client/v1/requests?tag={tag}&limit={n}&after={cursor}` answers with the
`requests` resource: a `requests` array of the shape above, and `next`.

- `tag` is required. A search without one would be "every request this key ever
  made", which is a different resource with a different cost.
- `limit` is 1 to 200, default 50. A value outside the range is a `400`.
- `after` is the `next` value from a previous page. Omit it for the first page.
- `next` is null on the last page. A non-null `next` means there is at least
  one more row, so a client never learns it is finished by fetching an empty
  page.

### The cursor's exact guarantee

Rows are ordered by `(timestamp, id)` ascending. `id` is the primary key, so
the pair is a total order and rows sharing a timestamp still have exactly one
successor. The cursor is opaque: it encodes that pair and nothing a client is
invited to construct. A cursor this server did not issue is a `400`, never a
silent restart from the beginning, because a reconciliation scan that restarts
re-delivers everything it already processed and the caller cannot tell that
from a page of new rows.

The guarantee is stable pagination over rows that do not change. It is not
lossless change discovery. Ordering is by persist time, and a re-upserted row's
`timestamp` is rewritten, so a row an earlier page already returned can in
principle reappear later in the scan. Consumers should deduplicate by `id`,
keep unsettled ids for direct polling by id, and re-scan a tail of the range
while requests are still outstanding.

## `finalized`

`true` means accounting for that request is complete and `usageSource` will not
change. It is a property of the committed row rather than an elapsed-time
guess: `usage_source` is write-once in SQL, so a row that reports `true` can
never be contradicted by a later write.

The COUNTS are covered by the same guarantee. The token vector and
`usage_source` are written by one statement, so a later write cannot move the
numbers while leaving the provenance alone, and a row read as finalized will
report the same counts on every later read. Settle from the first finalized
read; re-reading it gains nothing.

`false` means a token vector may still land, and `usageSource` is null.

One residual is worth planning for. A row that persisted without usage stays
open for a late patch for about sixty seconds. A shutdown the server performs
itself closes those rows on the way out, including the ones whose settling
write it could not queue at the time. When the server's write queue is full it
holds such a row's accounting in memory and retries it rather than dropping it,
so a sustained backlog grows that memory with no ceiling; the accounting is
never discarded to bound it. That promise covers the SETTLING PATCH, the write
that completes a row already on disk. The initial row insert is a different
write and can be dropped outright, which is the third cause of a 404 below.

Two things remain. The process can die abruptly (a crash, a kill, or a power
loss) inside that window. And a write the queue ACCEPTED can still fail at the
database: acceptance is what releases the in-memory record, so a write that is
then refused for the whole retry deadline has nothing left to retry it. Either
way the row stays `finalized: false` permanently, no row-level evidence
distinguishes it from a row that is still waiting, and the answer is the same:
resolve such a row as unknown when your own reconciliation window closes.

## `usageSource`

| Value | Asserts |
| --- | --- |
| `provider` | The provider reported the token counts this row carries. |
| `approximate` | Not established as provider-reported. |
| `none` | No token vector was ever stored. |
| `null` | `finalized` is false; the row has not stated a provenance yet. |

`approximate` is deliberately a negative claim. It covers a proxy-side estimate
(the stream did not end cleanly, or the provider reported no output count) and
also a historical row recorded before provenance was tracked, whose counts may
well be exact. Reading it as "these numbers were estimated" would be a false
claim about the legacy rows.

`none` means no usage was recorded at all: usage was waived, the response was
produced locally without an upstream call, or the summary carried nothing
usable.

## Token counts

The four classes are DISJOINT and ADDITIVE. `inputTokens` excludes both cache
classes, so `inputTokens + cacheReadInputTokens + cacheCreationInputTokens` is
the whole prompt and adding `outputTokens` gives the billable total. No class
contains another, and summing any subset double counts nothing.

Providers do not agree on this. Some report a prompt total with the cache
classes as parts of it; the proxy subtracts them at the translation boundary so
one convention reaches this surface.

A counter that does not fit its own total is never published as though it did.
Where the proxy can drop it, it does, and the class reads as not received. Where
it repairs the vector instead, the row reports `usageSource: "approximate"`, so
a repaired figure is never published under a claim that the provider reported
it. A row reporting `provider` carries counts as the provider stated them.

`null` means one thing: no count for that class was received. A provider that
reports zero is stating that none of that class was consumed, and that is
published as `0`.

That holds for responses the proxy translates as well as the ones it forwards
untouched. Some provider dialects require an input and an output count in their
wire shape, so a translator handed a response that reported neither still has to
emit the fields; those placeholders are tracked per response and never reach a
row. A `0` on this surface is always a count some provider actually stated.

Rows written before this guarantee existed are not backfilled, and on those a
null may still be a collapsed zero. A client whose traffic begins after the
version that publishes this document has no such rows.

Values are upstream-reported except an estimated output count, which
`usageSource: "approximate"` marks, and are not validated for sign or bound. The
schemas constrain neither.

The counts describe ONE upstream attempt: the one that produced the response.
Attempts abandoned before it are recorded nowhere. The proxy can discard a
provider response it has already been billed for, most often when a provider
answers as a different model than it was sent, and no column holds what that
attempt cost. A row whose request failed over is therefore a LOWER BOUND on what
the request consumed.

`failoverAttempts` is the signal for that, with one limit worth stating
precisely. Above 0 it means earlier attempts happened and their cost is missing.
At 0 it does NOT prove none did: the value is the attempt index the answering
try was made under, and a retry against the same account after a hold restarts
that index. Read a positive value as evidence, and 0 as absence of evidence
rather than evidence of absence. **Null says exactly what 0 says**, for the same
reason: the column defaults to 0 and is written on every row this surface
publishes, so a null is a row from before the column existed, not a distinct
outcome.

The hold that restarts the index decides whether a 0 can be trusted on a
FORWARDED row, and it cannot. The rejection that sends a request into such a
hold does bill nothing on its own: exclusion for context-window size is decided
locally, by comparing an estimate against the model's own window, and nothing
reaches a provider. But the hold's re-probes are ordinary upstream attempts and
carry the same risk any attempt does, including a response discarded because the
provider answered as a different model than it was sent. So a forwarded row can
read 0 and still have had a billed attempt thrown away before it.

`usageSource` qualifies the counts independently and both have to be read. An
`approximate` row had its output count estimated from the generated content
because the provider reported none, so it is not exact whatever
`failoverAttempts` says.

Two caveats:

- Devin reports its cache reads disjoint from its input, which matches this
  convention and was confirmed against recorded traffic. Its cache-write
  counter has never been observed above zero, so that half is unobserved
  rather than verified.
- `usageSource: "provider"` says the counts came from a provider. It does not
  certify the convention, which this section does.

## `timestamp`

`timestamp` is the moment the row was written, not the moment the request
started. The recorder stamps it as it persists, after the asynchronous writer
drains, so it trails the exchange by the response duration plus queue depth.

It is the paging order. It is not a request clock, and it must not be used to
reconstruct when a request ran. A client that needs that has its own clock
around the call.

## What a 404 means

A row becomes readable only after two things have happened: the request's
transport closed, and the metadata write committed. A stream may legitimately
run for a long time (the recorder's own backstop is 35 minutes), and the write
is asynchronous, so absence has five causes this response cannot tell apart:

1. The request is still running.
2. The write is queued, or retrying against a locked database.
3. The row INSERT was dropped under writer backpressure and will never be
   retried. This is the one write that can be dropped, and it is what the
   `finalized` section's never-discarded promise does not cover: that promise is
   about the later settling patch, which is held in memory and retried rather
   than dropped. No row is written, so nothing is left to find.
4. The row was deleted, by retention or by an operator statistics reset.
5. The request is one Request History does not keep, such as an internal
   probe. Its response still carried an id.

No elapsed-time rule makes a 404 terminal. The SQL adapter retries a busy
database against a ten-minute deadline, so "it has been a while" establishes
nothing. Bound your own retry window against your own observation of the
response ending, then resolve to unknown.

A 404 is also the answer for another client's request id. The scope is applied
in SQL, so "not yours", "never existed" and "expired" are one answer on
purpose, and a `403` is never returned because it would confirm that the row
exists. This endpoint is not an existence oracle for request ids.

## Key rotation

Scope is `requests.api_key_id`, the client's id rather than its secret.
Rotating a client's secret preserves the id, so history stays readable through
a rotation. Deleting the client and creating a new one produces a new id, and
the old history becomes unreachable with the new key.

## Retention

```
GET /client/v1/retention  ->  {"requestRetentionDays": 3650}
```

Rows older than that are deleted by the hourly retention sweep. A consumer's
reconciliation window has to be shorter than this number, and the number is
operator-configurable, so read it rather than assuming the default.

## Rate limiting

There is none on this surface.

## Maintaining the contract

```sh
bun run public-api:generate
bun run public-api:check
bun test scripts/public-api/schema.test.ts
```

Schemas use Draft 2020-12 and are generated from the named client DTO types.
The published examples are validated against them in tests; no schema tooling
runs in the API request path.
