import { OrgsError } from './errors.js';

export function encodeCursor(time: number, id: string): string {
  return Buffer.from(`${time}:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { time: number; id: string } | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const idx = raw.indexOf(':');
    if (idx <= 0) throw new Error('bad');
    const time = Number(raw.slice(0, idx));
    const id = raw.slice(idx + 1);
    if (!Number.isFinite(time) || !id) throw new Error('bad');
    return { time, id };
  } catch {
    throw new OrgsError('ORGS_INVALID_CURSOR', 'Invalid pagination cursor');
  }
}
