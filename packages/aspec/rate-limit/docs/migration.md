# Migration

This module has no persistent SQL schema. Counters live in process memory or in Redis keys under your configured prefix.

When upgrading:

1. Redeploy the application with the new package version.
2. Optionally flush Redis keys matching the old prefix if algorithm state formats change in a breaking release (none for 1.0.0).
3. Memory stores reset on process restart; no migration step.
