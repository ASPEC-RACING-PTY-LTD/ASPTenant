import { canonicalJson } from '../canonical.js';
import type { AuditEventSink } from '../store.js';

export interface ConsoleSinkOptions {
  /** Destination with a write(string) method. Default process.stdout. */
  stream?: { write(chunk: string): unknown };
  /** Indented JSON instead of one line per event. Default false. */
  pretty?: boolean;
}

/** Writes each event as one JSON line to stdout (or another stream), for log shippers. */
export function createConsoleSink(options: ConsoleSinkOptions = {}): AuditEventSink {
  const out = options.stream ?? process.stdout;
  const pretty = options.pretty ?? false;
  return {
    name: 'console',
    async write(events) {
      for (const e of events) {
        out.write(
          `${pretty ? JSON.stringify(JSON.parse(canonicalJson(e)), null, 2) : canonicalJson(e)}\n`,
        );
      }
    },
  };
}
