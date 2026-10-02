# Troubleshooting

## `AUDIT_INVALID_EVENT`

Action must be namespaced with dots (`auth.login.failed`). Actor IDs and resource
types must be non-empty strings within length limits.

## `AUDIT_EVENT_TOO_LARGE`

Reduce `metadata` or `changes`, or raise `maxEventBytes` (default 65536).

## `AUDIT_NOT_QUERYABLE`

`query`, `verifyChain` and `applyRetention` need a store sink
(`createMemoryAuditStore` or `createSqlAuditStore`). Console/JSONL alone cannot
serve queries.

## `AUDIT_INVALID_QUERY` / `AUDIT_INVALID_CURSOR`

Check filter types, time bounds and cursor opacity. Unknown admin query
parameters are rejected.

## `AUDIT_CHAIN_KEY_REQUIRED`

The stream was sealed with HMAC or a signed checkpoint. Provide the matching
`chain.hmacKey` / `previousHmacKeys` or `verifyKey`.

## `AUDIT_CHAIN_CONFLICT`

Two writers produced incompatible sequence numbers, or an event ID already
exists. Ensure a single store is the chain authority.

## `AUDIT_SINK_FAILED` / `AUDIT_QUEUE_FULL`

A required sink rejected the write, or the buffered queue is full under
`overflow: 'error'` / timed-out `block`. Increase `maxQueue` or speed up the
inner sink.

## `AUDIT_UNAUTHENTICATED` / `AUDIT_FORBIDDEN` / `AUDIT_NOT_FOUND`

Admin router authorisation failed or the event/route is missing. The admin API
is never public: configure `authorize` or `permissions`.

## `AUDIT_SINK_CLOSED`

The logger or sink was closed. Create a new instance after restart.
