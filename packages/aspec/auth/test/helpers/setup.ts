import { randomBytes } from 'node:crypto';
import { type Auth, type AuthOptions, createAuth } from '../../src/auth.js';
import { createScryptHasher } from '../../src/password.js';
import type { AuditEventInput, AuditSink } from '../../src/ports.js';
import { createMemoryAuthStore } from '../../src/stores/memory.js';

export function mutableClock(start = Date.parse('2026-01-15T12:00:00.000Z')) {
  let now = start;
  return {
    now: () => now,
    set(ms: number) {
      now = ms;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

export function memoryAudit() {
  const events: AuditEventInput[] = [];
  const sink: AuditSink = {
    async record(event) {
      events.push(event);
      return { id: String(events.length) };
    },
  };
  return { events, sink };
}

/** Fast scrypt for unit tests (production default remains ln=17). */
export const testHasher = createScryptHasher({ logN: 10, r: 8, p: 1 });

export function encryptionKey(): string {
  return randomBytes(32).toString('base64');
}

export function createTestAuth(overrides: Partial<AuthOptions> = {}): {
  auth: Auth;
  clock: ReturnType<typeof mutableClock>;
  events: AuditEventInput[];
  store: ReturnType<typeof createMemoryAuthStore>;
} {
  const clock = mutableClock();
  const { events, sink } = memoryAudit();
  const store = createMemoryAuthStore({ clock, sweepIntervalMs: 0 });
  const auth = createAuth({
    store,
    clock,
    hasher: testHasher,
    audit: sink,
    appName: 'Auth Test',
    ...overrides,
  });
  return { auth, clock, events, store };
}

export const STRONG_PASSWORD = 'correct-horse-battery-staple-99';
