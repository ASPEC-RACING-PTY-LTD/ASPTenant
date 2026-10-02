import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SettingsStore } from './mail/store.js';
import type { Platform } from './platform.js';

const SETTINGS_KEY = 'updates';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface UpdateSettings {
  autoUpdate: boolean;
  latest?: { version: string; url: string; publishedAt: string | null; notes: string } | null;
  checkedAt?: number | null;
  lastError?: string | null;
}

export interface UpdateStatus {
  current: string;
  repository: string;
  autoUpdate: boolean;
  latest: UpdateSettings['latest'];
  checkedAt: number | null;
  lastError: string | null;
  updateAvailable: boolean;
  updater: {
    available: boolean;
    pending: boolean;
    state: string | null;
    finishedAt: number | null;
    log: string | null;
  };
}

function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `candidate` is a newer semantic version than `current`. Dev builds always update. */
export function isNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  if (!next) return false;
  const now = parseVersion(current);
  if (!now) return true;
  for (let i = 0; i < 3; i += 1) {
    const a = next[i] ?? 0;
    const b = now[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export class UpdateService {
  private readonly platform: Platform;
  private readonly settings: SettingsStore;
  private timer: NodeJS.Timeout | null = null;

  constructor(platform: Platform) {
    this.platform = platform;
    this.settings = new SettingsStore(platform.db);
  }

  private async tenantId(): Promise<string> {
    return (await this.platform.orgs.getDefaultOrg()).id;
  }

  private async load(): Promise<UpdateSettings> {
    return (
      (await this.settings.get<UpdateSettings>(await this.tenantId(), SETTINGS_KEY)) ?? {
        autoUpdate: true,
      }
    );
  }

  private async save(next: UpdateSettings): Promise<void> {
    await this.settings.set(await this.tenantId(), SETTINGS_KEY, next);
  }

  private dir(): string {
    return this.platform.config.updatesDir;
  }

  private async readFileOrNull(name: string): Promise<string | null> {
    try {
      return await readFile(join(this.dir(), name), 'utf8');
    } catch {
      return null;
    }
  }

  async status(): Promise<UpdateStatus> {
    const stored = await this.load();
    const current = this.platform.config.appVersion;
    const heartbeat = Number((await this.readFileOrNull('heartbeat'))?.trim() ?? 0);
    const statusRaw = await this.readFileOrNull('status.json');
    let state: string | null = null;
    let finishedAt: number | null = null;
    if (statusRaw) {
      try {
        const parsed = JSON.parse(statusRaw) as { state?: string; at?: number };
        state = parsed.state ?? null;
        finishedAt = parsed.at ? parsed.at * 1000 : null;
      } catch {
        state = null;
      }
    }
    let pending = false;
    try {
      await stat(join(this.dir(), 'request'));
      pending = true;
    } catch {
      pending = false;
    }
    return {
      current,
      repository: this.platform.config.updateRepo,
      autoUpdate: stored.autoUpdate,
      latest: stored.latest ?? null,
      checkedAt: stored.checkedAt ?? null,
      lastError: stored.lastError ?? null,
      updateAvailable: stored.latest ? isNewer(stored.latest.version, current) : false,
      updater: {
        available: heartbeat > 0 && Date.now() / 1000 - heartbeat < 120,
        pending,
        state,
        finishedAt,
        log: (await this.readFileOrNull('last.log'))?.slice(-4000) ?? null,
      },
    };
  }

  async setAutoUpdate(autoUpdate: boolean): Promise<UpdateStatus> {
    await this.save({ ...(await this.load()), autoUpdate });
    return this.status();
  }

  async check(): Promise<UpdateStatus> {
    const stored = await this.load();
    const repo = this.platform.config.updateRepo;
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'aspectenant-updater' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        await this.save({ ...stored, latest: null, checkedAt: Date.now(), lastError: null });
        return this.status();
      }
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const body = (await response.json()) as {
        tag_name: string;
        html_url: string;
        published_at: string | null;
        body: string | null;
      };
      await this.save({
        ...stored,
        latest: {
          version: body.tag_name.replace(/^v/, ''),
          url: body.html_url,
          publishedAt: body.published_at,
          notes: (body.body ?? '').slice(0, 4000),
        },
        checkedAt: Date.now(),
        lastError: null,
      });
    } catch (error) {
      await this.save({
        ...stored,
        checkedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    return this.status();
  }

  /** Asks the updater sidecar to pull and restart the api and web containers. */
  async apply(): Promise<UpdateStatus> {
    const status = await this.status();
    if (!status.updater.available) {
      throw new Error(
        'The updater container is not running. Re-run the installer to add it, or update with docker compose pull && docker compose up -d.',
      );
    }
    await mkdir(this.dir(), { recursive: true });
    await writeFile(join(this.dir(), 'request'), `${status.latest?.version ?? 'latest'}\n`);
    this.platform.logger.info({ version: status.latest?.version }, 'update requested');
    return this.status();
  }

  start(): void {
    const tick = async () => {
      try {
        const status = await this.check();
        if (status.autoUpdate && status.updateAvailable && status.updater.available) {
          await this.apply();
        }
      } catch (error) {
        this.platform.logger.warn({ err: error }, 'automatic update check failed');
      }
    };
    this.timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
    this.timer.unref();
    setTimeout(() => void tick(), 60_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
