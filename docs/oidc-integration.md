# Signing in to an application with ASPECTenant (OpenID Connect)

This guide is for developers connecting an application (web portal, desktop app, internal tool) to ASPECTenant for sign-in. ASPECTenant is a standard OpenID Connect provider, so any certified OIDC client library works. Use one; do not hand-roll the protocol.

SAML, SCIM and LDAP are not available. OpenID Connect is the only sign-in protocol.

## 1. Register the application

An administrator of the organisation (tenant) that owns the application registers it under **Applications**:

| Type | When | You get |
|------|------|---------|
| Web application with a server (confidential) | Anything with a backend that can keep a secret | Client ID and client secret. The secret is shown once, stored hashed and can be replaced (the old one stops working at once). |
| Desktop or mobile app (public) | Native apps that cannot keep a secret | Client ID only. PKCE protects the exchange. |

- Redirect URIs are matched exactly: scheme, host, port, path and trailing slash.
- Desktop apps register a loopback URI such as `http://127.0.0.1/callback`. At sign-in any port is accepted (`http://127.0.0.1:53124/callback`), as in RFC 8252.
- The same page shows the issuer and discovery URL, and can require two-step verification or limit sign-in to assigned people and groups.

The installation must have its public URL set (Settings) to an `https://` address. The issuer is that URL followed by `/oidc`. Without a public URL every `/oidc` endpoint answers 503.

## 2. Provider configuration

Point the library at the discovery document and let it read the rest:

```
Issuer:     https://<public URL>/oidc
Discovery:  https://<public URL>/oidc/.well-known/openid-configuration
```

| Endpoint | Path |
|----------|------|
| Authorization | `/oidc/auth` |
| Token | `/oidc/token` |
| JWKS | `/oidc/jwks` |
| Userinfo | `/oidc/me` |
| End session | `/oidc/session/end` |
| Revocation | `/oidc/token/revocation` |

| Setting | Value |
|---------|-------|
| Response type | `code` only |
| PKCE | Required for every client, `S256` only |
| Client authentication | `client_secret_basic` or `client_secret_post` (confidential), `none` (public) |
| ID token signing | `RS256`, verify with the JWKS by `kid` |
| Scopes | `openid` (required), `email`, `profile`, `offline_access` |
| Authorization response | Includes `iss` (RFC 9207); check it if your library supports it |

Typical library settings: Authority/Issuer = the issuer above, Client ID, Client secret (confidential only), Response type `code`, PKCE on, Scopes `openid email profile`.

## 3. The flow

1. Your app redirects the browser to the authorization endpoint with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, `nonce`, `code_challenge` and `code_challenge_method=S256`.
2. ASPECTenant shows its sign-in page (password, then a code if the person uses two-step verification). Someone already signed in only confirms with Continue. There is no consent screen; applications are first party.
3. The browser returns to your `redirect_uri` with `code`, `state` and `iss`.
4. Your server exchanges the code at the token endpoint with the `code_verifier` and its client authentication. The code is single use and valid for 60 seconds.
5. Validate the ID token (signature, `iss`, `aud`, `exp`, `nonce`) and create your own session.

Token exchange, confidential client:

```bash
curl -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=authorization_code \
  -d code="$CODE" \
  -d redirect_uri="https://portal.example.com/callback" \
  -d code_verifier="$VERIFIER" \
  https://<public URL>/oidc/token
```

Public clients send `client_id` in the body and no secret.

Make the token call from your server. Browser JavaScript calls to the token endpoint are refused for confidential clients. Public clients may call it from a browser, but a backend is still the safer design for web applications.

## 4. Tokens and claims

The token response contains `id_token`, `access_token`, `token_type`, `expires_in`, `scope` and, with `offline_access`, `refresh_token`.

ID token claims:

| Claim | Meaning |
|-------|---------|
| `iss` | The issuer |
| `aud` | Your client ID |
| `exp`, `iat` | Expiry (one hour) and issue time |
| `nonce` | The nonce you sent |
| `sub` | Stable account ID. Use this as the user key, never the email. One person has the same `sub` in every organisation. |
| `tid` | Organisation (tenant) ID that owns the application. Always present. |
| `auth_time` | When the person last actually signed in (seconds). Always present. |
| `email` | With scope `email` |
| `email_verified` | With scope `email`. Currently always `false`: ASPECTenant does not run email verification yet, so do not gate access on it. |
| `name` | With scope `profile`. Display name, or the email when none is set. |

The `claims` request parameter is not supported. There is no `amr` or `acr` claim; enforce two-step verification with the application setting instead (section 6).

The access token is opaque, valid for one hour, and only useful at the userinfo endpoint (`GET /oidc/me` with `Authorization: Bearer <token>`), which returns the same claims. Do not try to decode it or use it as an API credential for your own services.

Refresh tokens: request `offline_access` together with `prompt=consent`. Refresh tokens last 30 days and are not rotated. They stop working when the person leaves the organisation, is suspended, or loses access to the application.

## 5. Fresh sign-in for sensitive actions

Before a dangerous action (payroll changes, owner controls), send the person through the authorization endpoint again with either:

- `prompt=login`: they must sign in again now, even with an active session.
- `max_age=<seconds>`: they must have signed in within that time.

Then check `auth_time` in the new ID token is recent enough. People with two-step verification enter a code again as part of signing in.

## 6. Who can sign in

- Only active members of the organisation that owns the application can sign in. A person who belongs to several organisations signs in to each application under that application's organisation (`tid`).
- **Only assigned people and groups**: when enabled, only listed people or members of listed groups can sign in.
- **Require two-step verification**: people without it see a message to turn it on under Your account first.

Refused people see the reason on the ASPECTenant sign-in page. If they cancel, your redirect URI receives `error=access_denied` with `state`. Handle that error the same way as any other OIDC error.

## 7. Signing out

Send the browser to the end session endpoint with `id_token_hint`, `post_logout_redirect_uri` and `state`. The post-logout URI must be one of the application's registered `http(s)` redirect URIs. ASPECTenant asks the person to confirm, ends their provider session and returns to your URI. Clear your own session too.

## 8. Signing keys

ID tokens are signed with RS256. Operators can rotate the signing key; the previous keys stay in the JWKS (up to three) so tokens they signed still verify. Cache the JWKS and fetch it again when a token carries a `kid` you do not know. Most libraries do this automatically.

## 9. Checklist

- [ ] Application registered with the right type and exact redirect URIs
- [ ] Discovery URL configured; PKCE S256 on; scopes `openid email profile`
- [ ] Token exchange happens on the server (confidential clients)
- [ ] ID token validated: signature via JWKS, `iss`, `aud`, `exp`, `nonce`
- [ ] Users keyed on `sub`; organisation taken from `tid`
- [ ] `state` checked on return; `error=access_denied` handled
- [ ] `prompt=login` or `max_age` plus an `auth_time` check before sensitive actions
- [ ] Sign-out sends the person to the end session endpoint
