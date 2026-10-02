import { invalidOption } from './errors.js';

/**
 * Deterministic pseudo-random generator for test data. It is NOT cryptographically secure and
 * must never produce secrets, tokens or keys (the JWT helpers use node:crypto instead).
 */
export interface Random {
  /** The seed this generator was created from. */
  readonly seed: string;
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Float in [min, max), optionally rounded to `decimals` places. */
  float(min: number, max: number, decimals?: number): number;
  /** True with probability `probability` (default 0.5). */
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Picks `count` distinct items. */
  sample<T>(items: readonly T[], count: number): T[];
  /** Returns a shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
  /** RFC 9562 version 4 layout UUID derived from the seed. */
  uuid(): string;
  hex(length: number): string;
  alphanumeric(length: number): string;
  firstName(): string;
  lastName(): string;
  fullName(): string;
  username(): string;
  /** Email on a reserved test domain (default `example.test`, RFC 2606). */
  email(options?: { firstName?: string; lastName?: string; domain?: string }): string;
  word(): string;
  words(count: number): string[];
  sentence(wordCount?: number): string;
  paragraph(sentenceCount?: number): string;
  slug(wordCount?: number): string;
  url(options?: { domain?: string }): string;
  /** Date uniformly between `from` and `to` (defaults: the reference date and one year after). */
  date(options?: { from?: Date | number; to?: Date | number }): Date;
  /** Date up to `days` (default 365) before the reference date. */
  pastDate(days?: number): Date;
  /** Date up to `days` (default 365) after the reference date. */
  futureDate(days?: number): Date;
  /** Independent generator derived from this seed and `key` (stable regardless of call order). */
  fork(key: string | number): Random;
}

export interface RandomOptions {
  /** Reference time for pastDate, futureDate and date defaults. Default 2026-01-01T00:00:00Z. */
  referenceDate?: Date | number;
}

export const DEFAULT_REFERENCE_DATE = Date.UTC(2026, 0, 1);

const FIRST_NAMES = [
  'Ada',
  'Alan',
  'Amara',
  'Anika',
  'Aria',
  'Ben',
  'Carlos',
  'Chen',
  'Dara',
  'Diego',
  'Elena',
  'Emeka',
  'Farah',
  'Grace',
  'Hana',
  'Ibrahim',
  'Isla',
  'Jonas',
  'Kai',
  'Kofi',
  'Lena',
  'Liam',
  'Maya',
  'Mateo',
  'Nadia',
  'Noah',
  'Olu',
  'Priya',
  'Quinn',
  'Rafael',
  'Sara',
  'Sofia',
  'Tariq',
  'Uma',
  'Victor',
  'Wei',
  'Xena',
  'Yara',
  'Yusuf',
  'Zoe',
] as const;

const LAST_NAMES = [
  'Abara',
  'Andersen',
  'Bianchi',
  'Chen',
  'Costa',
  'Dubois',
  'Evans',
  'Fischer',
  'Garcia',
  'Haddad',
  'Ito',
  'Jensen',
  'Kaur',
  'Kim',
  'Lovelace',
  'Martin',
  'Mensah',
  'Nakamura',
  'Novak',
  'Okafor',
  'Patel',
  'Quispe',
  'Rossi',
  'Santos',
  'Schmidt',
  'Silva',
  'Tanaka',
  'Turing',
  'Usman',
  'Vargas',
  'Walker',
  'Wong',
  'Yilmaz',
  'Zhang',
] as const;

const WORDS = [
  'alpha',
  'anchor',
  'apple',
  'arch',
  'atlas',
  'beacon',
  'birch',
  'bloom',
  'bridge',
  'canvas',
  'cedar',
  'cipher',
  'cloud',
  'comet',
  'coral',
  'delta',
  'drift',
  'ember',
  'field',
  'flint',
  'forest',
  'frost',
  'garden',
  'glade',
  'harbor',
  'hollow',
  'island',
  'ivory',
  'jade',
  'kernel',
  'lantern',
  'lattice',
  'maple',
  'meadow',
  'meridian',
  'nebula',
  'orbit',
  'pebble',
  'pine',
  'prism',
  'quartz',
  'river',
  'saffron',
  'signal',
  'silver',
  'summit',
  'thistle',
  'timber',
  'tundra',
  'umber',
  'valley',
  'vector',
  'willow',
  'window',
  'yarrow',
  'zenith',
] as const;

const HEX = '0123456789abcdef';
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DAY_MS = 86_400_000;

/** cyrb128 string hash: four 32-bit words used to seed sfc32. */
function hashSeed(input: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32: small, fast, well distributed 32-bit generator. */
function sfc32(seed: [number, number, number, number]): () => number {
  let [a, b, c, d] = seed;
  const nextFn = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) nextFn();
  return nextFn;
}

function toTime(value: Date | number, option: string): number {
  const t = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(t))
    throw invalidOption(option, 'must be a valid date or epoch milliseconds');
  return t;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Creates a deterministic generator. The same seed always yields the same sequence. */
export function createRandom(seed: string | number, options: RandomOptions = {}): Random {
  const seedText = String(seed);
  const next = sfc32(hashSeed(seedText));
  const reference = toTime(options.referenceDate ?? DEFAULT_REFERENCE_DATE, 'referenceDate');

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw invalidOption('int', `expected integers with min <= max, received ${min} and ${max}`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw invalidOption('pick', 'items must not be empty');
    return items[int(0, items.length - 1)] as T;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  const chars = (alphabet: string, length: number, option: string): string => {
    if (!Number.isInteger(length) || length < 0 || length > 10_000) {
      throw invalidOption(option, 'length must be an integer between 0 and 10000');
    }
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet.charAt(int(0, alphabet.length - 1));
    return out;
  };
  const word = (): string => pick(WORDS);
  const words = (count: number): string[] => {
    if (!Number.isInteger(count) || count < 0 || count > 10_000) {
      throw invalidOption('words', 'count must be an integer between 0 and 10000');
    }
    return Array.from({ length: count }, word);
  };
  const sentence = (wordCount?: number): string => {
    const text = words(wordCount ?? int(4, 12)).join(' ');
    return `${capitalise(text)}.`;
  };
  const date = (opts: { from?: Date | number; to?: Date | number } = {}): Date => {
    const from = opts.from === undefined ? reference : toTime(opts.from, 'date.from');
    const to = opts.to === undefined ? from + 365 * DAY_MS : toTime(opts.to, 'date.to');
    if (to < from) throw invalidOption('date', '"to" must not be before "from"');
    return new Date(from + Math.floor(next() * (to - from + 1)));
  };

  const random: Random = {
    seed: seedText,
    next,
    int,
    float(min, max, decimals) {
      if (!(Number.isFinite(min) && Number.isFinite(max)) || max < min) {
        throw invalidOption('float', 'expected finite numbers with min <= max');
      }
      const value = min + next() * (max - min);
      if (decimals === undefined) return value;
      const factor = 10 ** decimals;
      return Math.floor(value * factor) / factor;
    },
    bool(probability = 0.5) {
      return next() < probability;
    },
    pick,
    sample(items, count) {
      if (count > items.length) throw invalidOption('sample', 'count exceeds the number of items');
      return shuffle(items).slice(0, count);
    },
    shuffle,
    uuid() {
      const h = chars(HEX, 32, 'uuid');
      const variant = HEX.charAt(8 + int(0, 3));
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
    hex: (length) => chars(HEX, length, 'hex'),
    alphanumeric: (length) => chars(ALNUM, length, 'alphanumeric'),
    firstName: () => pick(FIRST_NAMES),
    lastName: () => pick(LAST_NAMES),
    fullName: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    username: () => `${pick(FIRST_NAMES).toLowerCase()}${int(1, 9999)}`,
    email(opts = {}) {
      const first = (opts.firstName ?? pick(FIRST_NAMES)).toLowerCase().replace(/[^a-z0-9]/g, '');
      const last = (opts.lastName ?? pick(LAST_NAMES)).toLowerCase().replace(/[^a-z0-9]/g, '');
      return `${first}.${last}${int(1, 9999)}@${opts.domain ?? 'example.test'}`;
    },
    word,
    words,
    sentence,
    paragraph(sentenceCount) {
      return Array.from({ length: sentenceCount ?? int(3, 6) }, () => sentence()).join(' ');
    },
    slug: (wordCount = 3) => words(wordCount).join('-'),
    url(opts = {}) {
      return `https://${opts.domain ?? 'example.test'}/${words(2).join('/')}`;
    },
    date,
    pastDate: (days = 365) => date({ from: reference - days * DAY_MS, to: reference }),
    futureDate: (days = 365) => date({ from: reference, to: reference + days * DAY_MS }),
    fork: (key) => createRandom(`${seedText}:${String(key)}`, { referenceDate: reference }),
  };
  return random;
}

let globalSeed: string = process.env.ASPEC_TEST_SEED ?? 'aspec-testing';

/** Sets the seed used by factories and `seededRandom()`. Default: ASPEC_TEST_SEED or "aspec-testing". */
export function setSeed(seed: string | number): void {
  globalSeed = String(seed);
}

export function getSeed(): string {
  return globalSeed;
}

/** A generator derived from the current global seed and `key`. */
export function seededRandom(
  key: string | number = 'default',
  options: RandomOptions = {},
): Random {
  return createRandom(`${globalSeed}:${String(key)}`, options);
}
