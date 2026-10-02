import { UsersError } from './errors.js';

export function encodeCursor(time: number, id: string): string {
  return Buffer.from(JSON.stringify([time, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { time: number; id: string } | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const invalid = () => new UsersError('USERS_INVALID_CURSOR', 'The pagination cursor is invalid');
  if (typeof cursor !== 'string' || cursor.length > 512) throw invalid();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'number' &&
      Number.isFinite(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      parsed[1].length <= 200
    ) {
      return { time: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw invalid();
}
