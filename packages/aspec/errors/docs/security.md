# Security

Threat model: attackers provoke errors to fish for stacks and secrets. Defaults: 5xx not exposed, stacks never in production responses, redaction of sensitive keys, validated correlation IDs. Set NODE_ENV=production in deployment.
