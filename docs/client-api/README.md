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
| `inputTokens` | number \| null | As stored |
| `outputTokens` | number \| null | As stored |
| `cacheReadInputTokens` | number \| null | As stored |
| `cacheCreationInputTokens` | number \| null | As stored |
| `usageSource` | `provider` \| `approximate` \| `none` \| null | Provenance of the token vector |
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

`false` means a token vector may still land, and `usageSource` is null.

One residual is worth planning for. A row that persisted without usage stays
open for a late patch for about sixty seconds. A shutdown the server performs
itself closes those rows on the way out, including the ones whose settling
write it could not queue at the time. When the server's write queue is full it
holds such a row's accounting in memory and retries it rather than dropping it,
so a sustained backlog grows that memory with no ceiling; the accounting is
never discarded to bound it. What remains is the process dying abruptly (a
crash, a kill, or a power loss) inside that window. Nothing is then left to
close the row and it stays `finalized: false` permanently. No row-level
evidence distinguishes it from a row that is still waiting. Resolve such a row
as unknown when your own reconciliation window closes.

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

Each count is `number | null`, reported as stored and not normalised.

A null is genuinely ambiguous. Either the provider reported nothing for that
class, or it reported zero and the write path collapsed the zero to null. The
surface publishes null rather than a `0` the row does not claim, so a consumer
that needs a number must decide which reading to apply.

Values are upstream-reported and are not validated for sign or bound. The
schemas constrain neither.

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
is asynchronous, so absence has four causes this response cannot tell apart:

1. The request is still running.
2. The write is queued, or retrying against a locked database.
3. The write was dropped under writer backpressure and will never be retried.
4. The row was deleted, by retention or by an operator statistics reset.

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
