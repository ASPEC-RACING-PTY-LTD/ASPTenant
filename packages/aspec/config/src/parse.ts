import type { ConfigIssue } from './errors.js';

export function parseBoolean(raw: string): boolean | ConfigIssue {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return {
    path: '',
    problem: 'invalid_boolean',
    message: 'expected a boolean (true/false, 1/0, yes/no, on/off)',
    hint: 'use true or false',
  };
}

export function parseNumber(raw: string): number | ConfigIssue {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
    return {
      path: '',
      problem: 'invalid_number',
      message: 'expected a number',
      hint: 'use digits, for example 42 or 3.14',
    };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { path: '', problem: 'invalid_number', message: 'expected a finite number' };
  }
  return n;
}

export function parseInteger(raw: string): number | ConfigIssue {
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    return {
      path: '',
      problem: 'invalid_integer',
      message: 'expected an integer',
      hint: 'use whole numbers only',
    };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    return {
      path: '',
      problem: 'invalid_integer',
      message: 'integer is outside the safe integer range',
    };
  }
  return n;
}

export function parsePort(raw: string): number | ConfigIssue {
  const n = parseInteger(raw);
  if (typeof n !== 'number') return n;
  if (n < 1 || n > 65535) {
    return { path: '', problem: 'invalid_port', message: 'port must be between 1 and 65535' };
  }
  return n;
}

export function parseDurationMs(raw: string): number | ConfigIssue {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(raw.trim());
  if (!m) {
    return {
      path: '',
      problem: 'invalid_duration',
      message: 'expected a duration such as 30s, 5m, 2h or 500ms',
    };
  }
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  const mult =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
  const ms = n * mult;
  if (!Number.isFinite(ms) || ms < 0) {
    return { path: '', problem: 'invalid_duration', message: 'duration is out of range' };
  }
  return ms;
}

export function parseBytes(raw: string): number | ConfigIssue {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i.exec(raw.trim());
  if (!m) {
    return {
      path: '',
      problem: 'invalid_bytes',
      message: 'expected a size such as 10MB, 512kb or 1gb',
    };
  }
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  const mult =
    unit === 'b'
      ? 1
      : unit === 'kb'
        ? 1024
        : unit === 'mb'
          ? 1024 ** 2
          : unit === 'gb'
            ? 1024 ** 3
            : 1024 ** 4;
  const bytes = Math.floor(n * mult);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { path: '', problem: 'invalid_bytes', message: 'size is out of range' };
  }
  return bytes;
}

export function parseEmail(raw: string): string | ConfigIssue {
  const v = raw.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 254) {
    return { path: '', problem: 'invalid_email', message: 'expected an email address' };
  }
  return v;
}

export function parseUrl(raw: string, protocols?: readonly string[]): string | ConfigIssue {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      path: '',
      problem: 'invalid_url',
      message: 'expected a valid URL',
      hint: 'include a scheme, for example https://',
    };
  }
  if (protocols && protocols.length > 0 && !protocols.includes(url.protocol.replace(/:$/, ''))) {
    return {
      path: '',
      problem: 'invalid_url_protocol',
      message: `URL protocol must be one of: ${protocols.join(', ')}`,
    };
  }
  return url.toString();
}

export function parseList(raw: string, separator = ','): string[] {
  if (raw.trim() === '') return [];
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
