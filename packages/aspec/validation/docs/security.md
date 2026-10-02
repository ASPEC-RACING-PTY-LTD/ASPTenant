# Security

Never put secrets in issue messages shown to clients. validateConfig sanitises messages for sensitive key names. Enforce bodyLimit on Fetch/Hono parsers. Prefer allow-lists in schemas.
