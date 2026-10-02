import { randomBytes } from 'node:crypto';
import type { Clock, IdGenerator } from './ports.js';

/**
 * UUID version 7 (RFC 9562): 48-bit millisecond timestamp followed by random bits, so ids sort
 * roughly by creation time. Randomness comes from crypto.randomBytes.
 */
export function createUuidV7Generator(clock: Clock = { now: () => Date.now() }): IdGenerator {
  return () => {
    const bytes = randomBytes(16);
    const ms = BigInt(Math.max(0, Math.floor(clock.now())));
    for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
