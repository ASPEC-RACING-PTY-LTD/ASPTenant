import { describe, expect, it } from 'vitest';
import { createRequestContext, injectTraceHeaders, runWithRequestContext } from '../src/context.js';
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
  parseTracestate,
} from '../src/trace-context.js';

describe('trace and request context', () => {
  it('accepts valid request IDs and generates otherwise', () => {
    const valid = createRequestContext({ requestIdHeader: 'abcDEF123456' });
    expect(valid.requestId).toBe('abcDEF123456');
    const generated = createRequestContext({});
    expect(generated.requestId.length).toBeGreaterThan(8);
  });

  it('parses valid traceparent and rejects invalid input', () => {
    const tid = generateTraceId();
    const sid = generateSpanId();
    const header = formatTraceparent({ traceId: tid, spanId: sid, traceFlags: 1 });
    const parsed = parseTraceparent(header);
    expect(parsed?.traceId).toBe(tid);
    expect(parsed?.parentId).toBe(sid);
    expect(parseTraceparent('not-a-trace')).toBeUndefined();
    expect(parseTraceparent('00-zzzz-01')).toBeUndefined();
    expect(parseTraceparent('')).toBeUndefined();
  });

  it('parses tracestate and injects outgoing headers', () => {
    expect(parseTracestate('vendor=value,other=1')).toHaveLength(2);
    const ctx = createRequestContext({
      requestIdHeader: 'req-1234567890',
      traceparent: formatTraceparent({
        traceId: generateTraceId(),
        spanId: generateSpanId(),
        traceFlags: 1,
      }),
      tracestate: 'a=b',
    });
    const headers = runWithRequestContext(ctx, () => injectTraceHeaders());
    expect(headers.get('x-request-id')).toBe('req-1234567890');
    expect(headers.get('traceparent')).toMatch(/^00-/);
    expect(headers.get('tracestate')).toBe('a=b');
  });
});
