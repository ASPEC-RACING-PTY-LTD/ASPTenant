import { validationError } from './errors.js';

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?::[A-Za-z0-9*][A-Za-z0-9_.*-]{0,63})?$/;

/** Validates a single scope string (`resource:action` or `resource:*`). */
export function assertScope(scope: string): string {
  if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
    throw validationError(`Invalid scope "${scope}"`, { scope });
  }
  return scope;
}

export function assertScopes(scopes: readonly string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw validationError('scopes must be a non-empty array');
  }
  if (scopes.length > 64) throw validationError('scopes must have at most 64 entries');
  const out = scopes.map(assertScope);
  return [...new Set(out)];
}

/**
 * Returns true when `held` covers `required`.
 * `read:*` covers `read:users`. `*` or `*:*` covers everything.
 * Exact match always covers.
 */
export function scopeCovers(held: string, required: string): boolean {
  if (held === '*' || held === '*:*') return true;
  if (held === required) return true;
  const [hRes, hAct = '*'] = held.split(':');
  const [rRes, rAct = '*'] = required.split(':');
  const resOk = hRes === '*' || hRes === rRes;
  if (!resOk) return false;
  if (hAct === '*') return true;
  return hAct === rAct;
}

/** True when any held scope covers every required scope. */
export function hasAllScopes(held: readonly string[], required: readonly string[]): boolean {
  return required.every((req) => held.some((h) => scopeCovers(h, req)));
}

/** True when any held scope covers at least one required scope. */
export function hasAnyScope(held: readonly string[], required: readonly string[]): boolean {
  return required.some((req) => held.some((h) => scopeCovers(h, req)));
}

/**
 * Validates scopes against an optional catalogue. When catalogue is set, every scope must
 * be listed or covered by a catalogue entry with wildcards.
 */
export function validateAgainstCatalogue(
  scopes: readonly string[],
  catalogue: readonly string[] | undefined,
): void {
  if (!catalogue || catalogue.length === 0) return;
  for (const scope of scopes) {
    const ok = catalogue.some((c) => scopeCovers(c, scope) || scope === c);
    if (!ok) {
      throw validationError(`Scope "${scope}" is not in the catalogue`, { scope, catalogue });
    }
  }
}

/** True when `next` introduces any scope not already covered by `current` (escalation). */
export function scopesEscalate(current: readonly string[], next: readonly string[]): boolean {
  return next.some((n) => !current.some((c) => scopeCovers(c, n)));
}
