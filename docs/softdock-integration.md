# SoftDock integration boundary

SoftDock is a separate product. ASPECTenant must not implement SoftDock features, share SoftDock's process, or read SoftDock's database.

`D:/SoftDock` was inspected on 2026-10-02. The directory existed and was empty, so no SoftDock code, APIs or UI conventions were copied. The integration design below is therefore based on ASPECTenant's own API-first rules, not on a SoftDock implementation.

## Boundary

| SoftDock may | SoftDock must not |
|--------------|-------------------|
| Call ASPECTenant HTTP APIs with a service identity | Import ASPECTenant modules at runtime |
| Receive signed webhooks (future) | Use the human admin cookie |
| Sign users in through ASPECTenant SSO (future OIDC) | Store the organisation's mailbox |
| Display ASPECTenant as an upstream identity provider | Be bundled inside this repository |

## Planned interfaces

1. **Service identity.** An API key or OAuth client issued in ASPECTenant, hashed at rest (`@aspec/api-keys` is vendored for this). Scopes will be explicit (`users:read`, `mail:send` is not implied, and so on).
2. **Stable HTTP API.** Versioned under `/api/v1`. Breaking changes get a new version.
3. **Events.** Webhooks or a feed for user lifecycle, group changes and mailbox provisioning. `@aspec/webhooks` was not vendored because it is unused.
4. **SSO.** SoftDock becomes an application in the future application catalogue, not a special case hardcoded into auth.

Until those interfaces exist, treat SoftDock as an external system with no runtime coupling.
