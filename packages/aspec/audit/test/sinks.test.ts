import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAuditLogger } from '../src/logger.js';
import { createBufferedSink } from '../src/sinks/buffered.js';
import { createConsoleSink } from '../src/sinks/console.js';
import { createFanoutSink } from '../src/sinks/fanout.js';
import { createJsonlFileSink, listJsonlFiles, readJsonlEvents } from '../src/sinks/jsonl.js';
import type { AuditEventSink } from '../src/store.js';
import { createMemoryAuditStore } from '../src/stores/memory.js';
import type { AuditEvent } from '../src/types.js';

describe('sinks', () => {
  it('writes console JSON lines', async () => {
    const chunks: string[] = [];
    const sink = createConsoleSink({
      stream: { write: (c) => chunks.push(String(c)) },
    });
    const audit = createAuditLogger({ sink });
    await audit.record({ action: 'jobs.worker.start' });
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0] as string)).toMatchObject({ action: 'jobs.worker.start' });
  });

  it('fans out to multiple sinks', async () => {
    const mem = createMemoryAuditStore();
    const collected: AuditEvent[] = [];
    const audit = createAuditLogger({
      sinks: [
        mem,
        createFanoutSink([
          {
            name: 'collect',
            write: async (events) => {
              collected.push(...events);
            },
          },
        ]),
      ],
    });
    await audit.record({ action: 'app.boot' });
    expect(mem.size()).toBe(1);
    expect(collected).toHaveLength(1);
    await audit.close();
  });

  it('rotates JSONL files by size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-audit-'));
    const path = join(dir, 'audit.jsonl');
    try {
      const jsonl = createJsonlFileSink({ path, maxBytes: 2048, maxFiles: 20 });
      const mem = createMemoryAuditStore();
      const audit = createAuditLogger({ sinks: [mem, jsonl] });
      for (let i = 0; i < 40; i++) {
        await audit.record({
          action: 'jobs.tick',
          metadata: { i, pad: 'x'.repeat(80) },
          category: 'system',
        });
      }
      await audit.flush();
      await audit.close();
      const files = await listJsonlFiles(path, 20);
      expect(files.length).toBeGreaterThan(1);
      const { events } = await readJsonlEvents(files);
      expect(events.length).toBe(40);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('buffers with backpressure and flushes on close', async () => {
    const written: AuditEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: AuditEventSink = {
      name: 'slow',
      async write(events) {
        await gate;
        written.push(...events);
      },
    };
    const buffered = createBufferedSink(slow, {
      maxQueue: 2,
      batchSize: 10,
      flushIntervalMs: 60_000,
      overflow: 'error',
      flushOnExit: false,
    });
    const write1 = buffered.write([{ id: '1' } as AuditEvent, { id: '2' } as AuditEvent]);
    await expect(buffered.write([{ id: '3' } as AuditEvent])).rejects.toMatchObject({
      code: 'AUDIT_QUEUE_FULL',
    });
    release();
    await write1;
    await buffered.flush();
    expect(written.length).toBeGreaterThanOrEqual(2);
    await buffered.close();
  });

  it('drop-newest overflow discards incoming events', async () => {
    const dropped: number[] = [];
    const inner: AuditEventSink = {
      name: 'inner',
      write: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
    };
    const buffered = createBufferedSink(inner, {
      maxQueue: 1,
      batchSize: 1,
      flushIntervalMs: 60_000,
      overflow: 'drop-newest',
      flushOnExit: false,
      onDrop: (events) => dropped.push(events.length),
    });
    const p = buffered.write([{ id: 'a' } as AuditEvent]);
    await buffered.write([{ id: 'b' } as AuditEvent]);
    await buffered.write([{ id: 'c' } as AuditEvent]);
    await p;
    await buffered.close();
    expect(dropped.length).toBeGreaterThan(0);
  });

  it('fsync option writes durable JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aspec-audit-'));
    const path = join(dir, 'a.jsonl');
    try {
      const jsonl = createJsonlFileSink({ path, fsync: true });
      const audit = createAuditLogger({ sink: jsonl });
      await audit.record({ action: 'app.boot' });
      await audit.close();
      const text = await readFile(path, 'utf8');
      expect(text.trim().length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
