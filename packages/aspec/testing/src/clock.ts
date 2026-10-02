import { invalidOption } from './errors.js';
import type { Clock } from './ports.js';

/** A Clock whose time only moves when the test says so. */
export interface TestClock extends Clock {
  /** Current time as a Date. */
  date(): Date;
  /** Sets the current time. */
  set(time: Date | number): void;
  /** Moves time forward (or backward with a negative value) by `ms`. Returns the new time. */
  advance(ms: number): number;
}

/** Default start time: 2026-01-01T00:00:00.000Z. */
export const DEFAULT_TEST_TIME = Date.UTC(2026, 0, 1);

function toMs(time: Date | number, option: string): number {
  const ms = time instanceof Date ? time.getTime() : time;
  if (!Number.isFinite(ms))
    throw invalidOption(option, 'must be a valid Date or epoch milliseconds');
  return ms;
}

/** Creates a controllable Clock (the Clock port: `now()` returns epoch milliseconds). */
export function createTestClock(start: Date | number = DEFAULT_TEST_TIME): TestClock {
  let now = toMs(start, 'start');
  return {
    now: () => now,
    date: () => new Date(now),
    set(time) {
      now = toMs(time, 'time');
    },
    advance(ms) {
      if (!Number.isFinite(ms)) throw invalidOption('ms', 'must be a finite number');
      now += ms;
      return now;
    },
  };
}
