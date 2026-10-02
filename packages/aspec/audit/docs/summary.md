# Summary

`@aspec/audit` records structured, tamper-evident audit events for Node.js apps.
Use it when you need actor and resource attribution, before-and-after change
metadata, request correlation, security event recording, querying, retention and
sensitive-data redaction. Events are normalised, redacted, then hash-chained
(SHA-256 or HMAC) before they reach memory, SQL, JSON Lines or console sinks.
Correlation middleware for Express, Fastify, Hono and Fetch fills request IDs and
actors automatically. An admin query router is always protected by an authorise
hook or PermissionChecker.
