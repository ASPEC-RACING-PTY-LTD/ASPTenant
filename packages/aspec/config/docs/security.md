# Security

## Threat model

| Threat | Mitigation |
|--------|------------|
| Secrets in logs / JSON | `Secret` redacts `toString`, `toJSON`, `inspect` |
| Secrets in docs | Generators emit empty placeholders only |
| Error messages leaking values | Issues describe problems, never raw input for secrets |
| Path traversal in file provider | Rejects ids with `..` or separators |
| Dotenv expansion SSRF-like surprises | Expansion disabled by default |

## Defaults

Freeze on, expansion off, `_FILE` enabled, secrets write-only in JSON Schema.
