import { createHash } from 'node:crypto';
import { configError, RateLimitError } from '../errors.js';
import type { Clock } from '../ports.js';
import type {
  BanLookup,
  BanState,
  PenaltyConfig,
  RateLimitStore,
  StoreOperation,
  StoreResult,
  ViolationResult,
} from '../store.js';

/** Minimal script-capable client. Use `fromIoredis` or `fromNodeRedis` to build one. */
export interface RedisScriptClient {
  evalSha(sha: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
  scriptLoad(script: string): Promise<unknown>;
  del(keys: readonly string[]): Promise<unknown>;
}

/** Structural subset of an ioredis `Redis` or `Cluster` instance. */
export interface IoredisLike {
  evalsha(sha: string, numKeys: number, ...args: string[]): Promise<unknown>;
  script(subcommand: 'LOAD', script: string): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

/** Structural subset of a node-redis (`redis` package) client. */
export interface NodeRedisLike {
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  scriptLoad(script: string): Promise<unknown>;
  del(keys: string[]): Promise<unknown>;
}

export function fromIoredis(client: IoredisLike): RedisScriptClient {
  return {
    evalSha: (sha, keys, args) => client.evalsha(sha, keys.length, ...keys, ...args),
    scriptLoad: (script) => client.script('LOAD', script),
    del: (keys) => client.del(...keys),
  };
}

export function fromNodeRedis(client: NodeRedisLike): RedisScriptClient {
  return {
    evalSha: (sha, keys, args) => client.evalSha(sha, { keys: [...keys], arguments: [...args] }),
    scriptLoad: (script) => client.scriptLoad(script),
    del: (keys) => client.del([...keys]),
  };
}

export interface RedisStoreOptions {
  client: RedisScriptClient;
  /** Prefix for every key. Default "rl:". */
  keyPrefix?: string;
  /**
   * Clock used instead of Redis server time. Leave unset in production: server time keeps
   * every application instance consistent even when their clocks drift.
   */
  clock?: Clock;
}

const NOW = `
local now
if ARGV[#ARGV] ~= '' then
  now = tonumber(ARGV[#ARGV])
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
`;

/** Mirrors applyAlgorithm() in algorithms.ts. KEYS: state, sequence. */
export const APPLY_SCRIPT = `${NOW}
local key = KEYS[1]
local algo = ARGV[1]
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local burst = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local mode = ARGV[6]
local allowed = 0
local remaining = 0
local reset_at = now
local retry = -1

if algo == 'token-bucket' then
  local function ms_for(n) return math.ceil((n * window) / limit - 1e-9) end
  local s = redis.call('HMGET', key, 't', 'u')
  local tokens = burst
  if s[1] then
    local elapsed = now - tonumber(s[2])
    if elapsed < 0 then elapsed = 0 end
    tokens = math.min(burst, tonumber(s[1]) + (elapsed * limit) / window)
  end
  local write = false
  if mode == 'force' then
    tokens = tokens - cost
    write = true
    if tokens >= 1 then allowed = 1 else retry = ms_for(1 - tokens) end
  elseif tokens >= cost then
    allowed = 1
    if mode == 'consume' then
      tokens = tokens - cost
      write = true
    end
  else
    retry = ms_for(cost - tokens)
  end
  local refill = math.max(0, ms_for(burst - tokens))
  remaining = math.max(0, math.floor(tokens))
  reset_at = now + refill
  if write then
    redis.call('HSET', key, 't', string.format('%.17g', tokens), 'u', string.format('%.17g', now))
    redis.call('PEXPIRE', key, refill + 1000)
  end
elseif algo == 'gcra' then
  local interval = window / limit
  local tolerance = interval * burst
  local saved = redis.call('GET', key)
  local tat = now
  if saved then tat = math.max(tonumber(saved), now) end
  local new_tat = tat + interval * cost
  local allow_at = new_tat - tolerance
  local stored = tat
  local write = false
  if mode == 'force' then
    stored = new_tat
    write = true
    local next_allow = new_tat + interval - tolerance
    if now >= next_allow then allowed = 1 else retry = math.ceil(next_allow - now) end
  elseif now >= allow_at then
    allowed = 1
    if mode == 'consume' then
      stored = new_tat
      write = true
    end
  else
    retry = math.ceil(allow_at - now)
  end
  local available = math.floor((now - (stored - tolerance)) / interval + 1e-9)
  remaining = math.max(0, math.min(burst, available))
  reset_at = math.ceil(math.max(stored, now))
  if write then
    redis.call('SET', key, string.format('%.17g', stored), 'PX', math.ceil(math.max(0, stored - now)) + 1000)
  end
elseif algo == 'fixed-window' then
  local index = math.floor(now / window)
  reset_at = (index + 1) * window
  local s = redis.call('HMGET', key, 'w', 'c')
  local count = 0
  if s[1] and tonumber(s[1]) == index then count = tonumber(s[2]) end
  local write = false
  if mode == 'force' then
    count = count + cost
    write = true
    if count + 1 <= limit then allowed = 1 end
  elseif count + cost <= limit then
    allowed = 1
    if mode == 'consume' then
      count = count + cost
      write = true
    end
  end
  remaining = math.max(0, limit - count)
  if allowed == 0 then retry = math.max(1, reset_at - now) end
  if write then
    redis.call('HSET', key, 'w', string.format('%d', index), 'c', string.format('%d', count))
    redis.call('PEXPIRE', key, reset_at - now + 1000)
  end
elseif algo == 'sliding-window' then
  local index = math.floor(now / window)
  local start = index * window
  local elapsed = now - start
  local s = redis.call('HMGET', key, 'w', 'c', 'p')
  local curr = 0
  local prev = 0
  if s[1] then
    local w = tonumber(s[1])
    if w == index then
      curr = tonumber(s[2])
      prev = tonumber(s[3])
    elseif w == index - 1 then
      prev = tonumber(s[2])
    end
  end
  local estimate = prev * ((window - elapsed) / window) + curr
  local used = estimate
  local write = false
  if mode == 'force' then
    curr = curr + cost
    used = estimate + cost
    write = true
    if used + 1 <= limit then allowed = 1 end
  elseif estimate + cost <= limit then
    allowed = 1
    if mode == 'consume' then
      curr = curr + cost
      used = estimate + cost
      write = true
    end
  end
  remaining = math.max(0, math.floor(limit - used + 1e-9))
  reset_at = start + window
  if allowed == 0 then
    local need = cost
    if mode == 'force' then need = 1 end
    local budget = limit - need
    local wait
    if curr <= budget and prev > 0 then
      wait = window - elapsed - ((budget - curr) * window) / prev
    else
      local into_next = 0
      if curr > 0 then into_next = math.max(0, window - (budget * window) / curr) end
      wait = window - elapsed + into_next
    end
    retry = math.max(1, math.ceil(wait))
    reset_at = now + retry
  end
  if write then
    redis.call('HSET', key, 'w', string.format('%d', index), 'c', string.format('%d', curr), 'p', string.format('%d', prev))
    redis.call('PEXPIRE', key, start + 2 * window - now + 1000)
  end
elseif algo == 'sliding-log' then
  redis.call('ZREMRANGEBYSCORE', key, '-inf', string.format('%.17g', now - window))
  local count = redis.call('ZCARD', key)
  local need = cost
  if mode == 'force' then need = 1 end
  local write = false
  local function add(n)
    for i = 1, n do
      local seq = redis.call('INCR', KEYS[2])
      redis.call('ZADD', key, string.format('%.17g', now), string.format('%.17g', now) .. ':' .. seq)
    end
    count = count + n
    write = true
  end
  if mode == 'force' then
    add(cost)
    local over = count - limit * 2
    if over > 0 then
      redis.call('ZREMRANGEBYRANK', key, 0, over - 1)
      count = count - over
    end
    if count + 1 <= limit then allowed = 1 end
  elseif count + cost <= limit then
    allowed = 1
    if mode == 'consume' then add(cost) end
  end
  remaining = math.max(0, limit - count)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] then reset_at = tonumber(oldest[2]) + window else reset_at = now + window end
  if allowed == 0 then
    local idx = count + need - limit - 1
    local pivot = now
    local entry = redis.call('ZRANGE', key, idx, idx, 'WITHSCORES')
    if entry[2] then pivot = tonumber(entry[2]) end
    retry = math.max(1, pivot + window - now)
    reset_at = now + retry
  end
  if write then
    redis.call('PEXPIRE', key, window + 1000)
    redis.call('PEXPIRE', KEYS[2], window + 1000)
  end
else
  return redis.error_reply('ERR unknown rate limit algorithm')
end

return {allowed, remaining, reset_at, retry, now}
`;

/** KEYS: violations, ban. ARGV: threshold, violationWindowMs, banMs, multiplier, maxBanMs, decayMs, now. */
export const VIOLATION_SCRIPT = `${NOW}
local threshold = tonumber(ARGV[1])
local violations = redis.call('INCR', KEYS[1])
if violations == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if violations < threshold then return {violations, 0, 0, 0, now} end
redis.call('DEL', KEYS[1])
local level = tonumber(redis.call('HGET', KEYS[2], 'l') or '0') + 1
local duration = math.floor(math.min(tonumber(ARGV[5]), tonumber(ARGV[3]) * tonumber(ARGV[4]) ^ (level - 1)))
local until_at = now + duration
redis.call('HSET', KEYS[2], 'u', string.format('%d', until_at), 'l', string.format('%d', level))
redis.call('PEXPIRE', KEYS[2], duration + tonumber(ARGV[6]))
return {violations, 1, until_at, level, now}
`;

/** KEYS: ban. ARGV: now. */
export const GET_BAN_SCRIPT = `${NOW}
local s = redis.call('HMGET', KEYS[1], 'u', 'l')
return {tonumber(s[1] or '0'), tonumber(s[2] or '0'), now}
`;

/** KEYS: ban. ARGV: durationMs, decayMs, now. */
export const SET_BAN_SCRIPT = `${NOW}
local level = tonumber(redis.call('HGET', KEYS[1], 'l') or '0')
if level < 1 then level = 1 end
local until_at = now + tonumber(ARGV[1])
redis.call('HSET', KEYS[1], 'u', string.format('%d', until_at), 'l', string.format('%d', level))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]))
return {until_at, level, now}
`;

interface Script {
  source: string;
  sha: string;
}

function script(source: string): Script {
  return { source, sha: createHash('sha1').update(source).digest('hex') };
}

const SCRIPTS = {
  apply: script(APPLY_SCRIPT),
  violation: script(VIOLATION_SCRIPT),
  getBan: script(GET_BAN_SCRIPT),
  setBan: script(SET_BAN_SCRIPT),
};

const PREFIX_PATTERN = /^[A-Za-z0-9:_.-]{0,64}$/;

function numbers(reply: unknown, length: number): number[] {
  if (!Array.isArray(reply) || reply.length < length) {
    throw new RateLimitError('RATE_LIMIT_STORE_ERROR', 'Unexpected reply from Redis script');
  }
  return reply.map((v) => Number(v));
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && /NOSCRIPT/i.test(error.message);
}

export interface RedisRateLimitStore extends RateLimitStore {
  /** Loads every script with SCRIPT LOAD (optional; scripts load lazily on NOSCRIPT). */
  loadScripts(): Promise<void>;
}

/**
 * Redis-compatible store (Redis, Valkey, and compatible servers). All state changes run in
 * Lua scripts so that concurrent consumers across processes never exceed the limit. Keys use
 * a hash tag so the keys of one limiter key share a cluster slot.
 */
export function createRedisStore(options: RedisStoreOptions): RedisRateLimitStore {
  const client = options?.client;
  if (!client || typeof client.evalSha !== 'function' || typeof client.scriptLoad !== 'function') {
    throw configError('client', 'must be a RedisScriptClient (use fromIoredis or fromNodeRedis)');
  }
  const prefix = options.keyPrefix ?? 'rl:';
  if (!PREFIX_PATTERN.test(prefix)) {
    throw configError('keyPrefix', 'must match [A-Za-z0-9:_.-]{0,64}');
  }
  const clock = options.clock;
  const nowArg = (): string => (clock ? String(Math.floor(clock.now())) : '');
  const base = (key: string): string => `${prefix}{${key}}`;

  const run = async (s: Script, keys: string[], args: string[]): Promise<unknown> => {
    const argv = [...args, nowArg()];
    try {
      return await client.evalSha(s.sha, keys, argv);
    } catch (error) {
      if (!isNoScript(error)) throw error;
      await client.scriptLoad(s.source);
      return client.evalSha(s.sha, keys, argv);
    }
  };

  return {
    async loadScripts() {
      for (const s of Object.values(SCRIPTS)) await client.scriptLoad(s.source);
    },
    async apply(op: StoreOperation): Promise<StoreResult> {
      const k = base(op.key);
      const reply = await run(
        SCRIPTS.apply,
        [k, `${k}:seq`],
        [
          op.config.algorithm,
          String(op.config.limit),
          String(op.config.windowMs),
          String(op.config.burst),
          String(op.cost),
          op.mode,
        ],
      );
      const [allowed, remaining, resetAt, retry, now] = numbers(reply, 5) as [
        number,
        number,
        number,
        number,
        number,
      ];
      const result: StoreResult = {
        allowed: allowed === 1,
        limit:
          op.config.algorithm === 'token-bucket' || op.config.algorithm === 'gcra'
            ? op.config.burst
            : op.config.limit,
        remaining,
        resetAt,
        now,
      };
      if (retry >= 0) result.retryAfterMs = retry;
      return result;
    },
    async reset(key: string): Promise<void> {
      const k = base(key);
      await client.del([k, `${k}:seq`, `${k}:v`]);
    },
    async recordViolation(key: string, config: PenaltyConfig): Promise<ViolationResult> {
      const k = base(key);
      const reply = await run(
        SCRIPTS.violation,
        [`${k}:v`, `${k}:b`],
        [
          String(config.threshold),
          String(config.violationWindowMs),
          String(config.banMs),
          String(config.multiplier),
          String(config.maxBanMs),
          String(config.decayMs),
        ],
      );
      const [violations, banned, until, level, now] = numbers(reply, 5) as [
        number,
        number,
        number,
        number,
        number,
      ];
      const result: ViolationResult = { violations, now };
      if (banned === 1) result.ban = { until, level };
      return result;
    },
    async getBan(key: string): Promise<BanLookup> {
      const reply = await run(SCRIPTS.getBan, [`${base(key)}:b`], []);
      const [until, level, now] = numbers(reply, 3) as [number, number, number];
      return { ban: until > now ? { until, level } : undefined, now };
    },
    async setBan(key: string, durationMs: number, decayMs: number): Promise<BanState> {
      const reply = await run(
        SCRIPTS.setBan,
        [`${base(key)}:b`],
        [String(durationMs), String(decayMs)],
      );
      const [until, level] = numbers(reply, 3) as [number, number, number];
      return { until, level };
    },
    async clearBan(key: string): Promise<void> {
      const k = base(key);
      await client.del([`${k}:b`, `${k}:v`]);
    },
  };
}
