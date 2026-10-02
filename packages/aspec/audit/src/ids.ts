import { randomBytes } from 'node:crypto';
import type { Clock, IdGenerator } from './ports.js';

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Creates a UUID version 7 generator (RFC 9562): 48-bit millisecond timestamp followed by
 * random bits. A 12-bit counter in `rand_a` keeps identifiers strictly increasing when several
 * are generated in the same millisecond, so identifiers sort in creation order.
 */
export function createUuidV7Generator(clock: Clock = { now: () => Date.now() }): IdGenerator {
  let lastMs = -1;
  let counter = 0;
  return () => {
    let ms = clock.now();
    if (ms <= lastMs) {
      counter++;
      if (counter > 0xfff) {
        lastMs++;
        counter = 0;
      }
      ms = lastMs;
    } else {
      lastMs = ms;
      counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
    }
    const bytes = randomBytes(16);
    const high = Math.floor(ms / 0x100000000);
    const low = ms >>> 0;
    bytes[0] = (high >>> 8) & 0xff;
    bytes[1] = high & 0xff;
    bytes[2] = (low >>> 24) & 0xff;
    bytes[3] = (low >>> 16) & 0xff;
    bytes[4] = (low >>> 8) & 0xff;
    bytes[5] = low & 0xff;
    bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
    let out = '';
    for (let i = 0; i < 16; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
      out += HEX[bytes[i] ?? 0];
    }
    return out;
  };
}

/** Generates one UUID version 7 using the system clock. */
export const uuidv7: IdGenerator = createUuidV7Generator();
