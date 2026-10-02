import { randomBytes } from 'node:crypto';

/** UUID v7-style identifier (time-ordered, CSPRNG). */
export function createIdGenerator(): () => string {
  return () => {
    const ms = BigInt(Date.now());
    const bytes = randomBytes(16);
    bytes[0] = Number((ms >> 40n) & 0xffn);
    bytes[1] = Number((ms >> 32n) & 0xffn);
    bytes[2] = Number((ms >> 24n) & 0xffn);
    bytes[3] = Number((ms >> 16n) & 0xffn);
    bytes[4] = Number((ms >> 8n) & 0xffn);
    bytes[5] = Number(ms & 0xffn);
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[7] = (bytes[7]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
