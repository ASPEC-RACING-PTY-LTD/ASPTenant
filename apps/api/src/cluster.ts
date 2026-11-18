import { hostname } from 'node:os';
import { PLATFORM_SCOPE } from './directory/index.js';
import { SettingsStore } from './mail/store.js';
import type { Platform } from './platform.js';
import { scopedClient } from './tenancy.js';

/** How often each node reports in and renews or seeks the leader lease. */
export const HEARTBEAT_MS = 5_000;
/** A lease not renewed for this long is free for another node. */
export const LEASE_MS = 20_000;
/** The leader stops leader-only work this long before its lease could be taken. */
const SAFETY_MS = 5_000;
/** A node not seen for this long is shown as offline. */
export const OFFLINE_MS = 30_000;
/** The preferred (primary) node takes leadership back once it has been up this long. */
const FAILBACK_AFTER_MS = 30_000;

export interface ClusterNode {
  id: string;
  address: string | null;
  preferred: boolean;
  version: string;
  startedAt: number;
  lastSeen: number;
  online: boolean;
  leader: boolean;
  self: boolean;
}

/** Installation settings for redundancy, edited on the System page. */
export interface ClusterSettings {
  /** Point the mail apps hostname at the leading node whenever leadership moves. */
  dnsFailover: boolean;
  /** Result of the last attempt to move the mail apps hostname. */
  lastFailover: { at: number; node: string; ok: boolean; detail: string } | null;
}

const SETTINGS_KEY = 'cluster';

export interface ClusterStatus {
  /** Redundancy is configured on this node (NODE_ROLE set). */
  enabled: boolean;
  settings: ClusterSettings;
  self: string;
  leader: string | null;
  term: number;
  nodes: ClusterNode[];
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

/**
 * Redundancy nodes: several machines run ASPECTenant against one shared PostgreSQL database
 * (for example Neon). Every node serves the panel, mail apps and inbound mail. One node at a
 * time is the leader and runs the work that must happen once (scheduled backups, certificate
 * renewal, mailbox imports, update checks). Leadership is a lease row in the database, so a
 * node that stops renewing it is replaced automatically within LEASE_MS, and two nodes can
 * never both hold it. The node with NODE_ROLE=primary takes leadership back when it returns.
 */
export class Cluster {
  readonly nodeId: string;
  readonly enabled: boolean;
  private readonly preferred: boolean;
  private readonly platform: Platform;
  private timer: NodeJS.Timeout | null = null;
  private leaseUntil = 0;
  private term = 0;
  private leader: string | null = null;
  private wasLeader = false;
  private readonly seen = new Map<string, number>();
  /** Signals were read once, so a signal name seen for the first time after that is new. */
  private signalsRead = false;
  private readonly signalHandlers = new Map<string, () => void>();
  private readonly leaderHandlers: Array<() => void> = [];
  private ticking = false;
  private readonly settings: SettingsStore;

  constructor(platform: Platform) {
    this.platform = platform;
    this.settings = new SettingsStore(scopedClient(platform, PLATFORM_SCOPE));
    const config = platform.config;
    this.nodeId = (config.nodeName?.trim() || hostname()).slice(0, 100);
    this.enabled = Boolean(config.nodeRole);
    this.preferred = config.nodeRole !== 'secondary';
  }

  /** Whether this node may run leader-only work right now. */
  isLeader(now = Date.now()): boolean {
    return now < this.leaseUntil - SAFETY_MS;
  }

  /** Runs fn each time this node becomes the leader (after a failover or at startup). */
  onLeader(fn: () => void): void {
    this.leaderHandlers.push(fn);
  }

  /** Runs fn on every node when another node raises the named signal. */
  onSignal(name: string, fn: () => void): void {
    this.signalHandlers.set(name, fn);
  }

  /**
   * Tells every node something changed (for example "restart" after the public URL or signing
   * keys change). This node does not get its own signal back.
   */
  async signal(name: string): Promise<void> {
    const db = this.platform.db;
    const now = Date.now();
    const updated = await db.query(
      `UPDATE aspectenant_cluster_signals SET generation = generation + 1, updated_at = $1
       WHERE name = $2`,
      [now, name],
    );
    if (updated.rowCount === 0) {
      await db.query(
        `INSERT INTO aspectenant_cluster_signals (name, generation, updated_at) VALUES ($1, 1, $2)
         ON CONFLICT (name) DO UPDATE SET generation = aspectenant_cluster_signals.generation + 1`,
        [name, now],
      );
    }
    const row = await db.query<Row>(
      'SELECT generation FROM aspectenant_cluster_signals WHERE name = $1',
      [name],
    );
    this.seen.set(name, num(row.rows[0]?.generation ?? 0));
  }

  /** Restarts every node: this one now, the others when they see the signal. */
  async restartAll(): Promise<void> {
    await this.signal('restart').catch((error: unknown) => {
      this.platform.logger.warn({ err: error }, 'could not tell the other nodes to restart');
    });
    this.platform.restart();
  }

  async getSettings(): Promise<ClusterSettings> {
    const stored = await this.settings.get<Partial<ClusterSettings>>(PLATFORM_SCOPE, SETTINGS_KEY);
    return { dnsFailover: false, lastFailover: null, ...(stored ?? {}) };
  }

  async saveSettings(patch: { dnsFailover?: boolean }): Promise<ClusterSettings> {
    const next = { ...(await this.getSettings()), ...patch };
    await this.settings.set(PLATFORM_SCOPE, SETTINGS_KEY, next);
    if (next.dnsFailover && this.isLeader()) await this.moveMailHostname();
    return this.getSettings();
  }

  /**
   * Points the mail apps hostname at this node when it leads and failover is on. The panel
   * itself needs no DNS change when every node runs a connector of the same Cloudflare Tunnel.
   */
  async moveMailHostname(): Promise<void> {
    const settings = await this.getSettings();
    if (!this.enabled || !settings.dnsFailover) return;
    const address = this.platform.config.nodeAddress?.trim();
    let result: ClusterSettings['lastFailover'];
    if (!address) {
      result = {
        at: Date.now(),
        node: this.nodeId,
        ok: false,
        detail: 'This node has no NODE_ADDRESS, so the mail hostname was not moved.',
      };
    } else {
      try {
        const detail = await this.platform.mailServers.pointHostnameAt(address);
        result = { at: Date.now(), node: this.nodeId, ok: true, detail };
      } catch (error) {
        result = {
          at: Date.now(),
          node: this.nodeId,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    this.platform.logger[result.ok ? 'info' : 'warn']({ failover: result }, result.detail);
    await this.settings.set(PLATFORM_SCOPE, SETTINGS_KEY, { ...settings, lastFailover: result });
  }

  async start(): Promise<void> {
    this.onLeader(() => void this.moveMailHostname().catch(() => undefined));
    await this.tick();
    this.timer = setInterval(() => void this.tick(), HEARTBEAT_MS);
    this.timer.unref();
  }

  /** Gives up leadership at shutdown so another node takes over at once. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.leaseUntil > Date.now()) {
      this.leaseUntil = 0;
      await this.platform.db
        .query(
          `UPDATE aspectenant_cluster_lease SET expires_at = 0 WHERE name = 'leader' AND holder = $1`,
          [this.nodeId],
        )
        .catch(() => undefined);
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      await this.heartbeat(now);
      await this.lease(now);
      await this.signals();
    } catch (error) {
      // Without the database this node cannot know who leads, so it stops leading.
      this.leaseUntil = 0;
      this.platform.logger.warn({ err: error }, 'cluster heartbeat failed');
    } finally {
      this.ticking = false;
    }
    const leading = this.isLeader();
    if (leading && !this.wasLeader) {
      this.platform.logger.info({ node: this.nodeId, term: this.term }, 'this node now leads');
      for (const fn of this.leaderHandlers) {
        try {
          fn();
        } catch (error) {
          this.platform.logger.error({ err: error }, 'leader start-up task failed');
        }
      }
    } else if (!leading && this.wasLeader) {
      this.platform.logger.info({ node: this.nodeId }, 'this node no longer leads');
    }
    this.wasLeader = leading;
  }

  private async heartbeat(now: number): Promise<void> {
    const db = this.platform.db;
    const params = [
      this.nodeId,
      this.platform.config.nodeAddress?.trim() || null,
      this.preferred ? 1 : 0,
      this.platform.config.appVersion,
      this.platform.startedAt,
      now,
    ];
    const updated = await db.query(
      `UPDATE aspectenant_cluster_nodes SET address = $2, preferred = $3, version = $4,
       started_at = $5, last_seen = $6 WHERE id = $1`,
      params,
    );
    if (updated.rowCount === 0) {
      await db.query(
        `INSERT INTO aspectenant_cluster_nodes (id, address, preferred, version, started_at, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        params,
      );
    }
  }

  private async lease(now: number): Promise<void> {
    const db = this.platform.db;
    await db.query(
      `INSERT INTO aspectenant_cluster_lease (name, holder, term, expires_at)
       VALUES ('leader', '', 0, 0) ON CONFLICT (name) DO NOTHING`,
    );
    // A secondary stands aside while a primary is up and settled: it hands leadership back
    // and does not take the lease, so the primary picks it up on its next heartbeat.
    const standAside = !this.preferred && (await this.preferredNodeReady(now));
    if (standAside && this.leaseUntil > 0) {
      await db.query(
        `UPDATE aspectenant_cluster_lease SET expires_at = 0 WHERE name = 'leader' AND holder = $1`,
        [this.nodeId],
      );
      this.platform.logger.info({ node: this.nodeId }, 'handing leadership back to the primary');
    }
    // Renew our own lease, or take one that has expired. The row is the only arbiter.
    const taken = standAside
      ? { rowCount: 0 }
      : await db.query(
          `UPDATE aspectenant_cluster_lease
       SET term = CASE WHEN holder = $1 THEN term ELSE term + 1 END, holder = $1, expires_at = $2
       WHERE name = 'leader' AND (holder = $1 OR expires_at < $3)`,
          [this.nodeId, now + LEASE_MS, now],
        );
    const row = (
      await db.query<Row>(
        `SELECT holder, term, expires_at FROM aspectenant_cluster_lease WHERE name = 'leader'`,
      )
    ).rows[0];
    this.leader = row && num(row.expires_at) >= now ? String(row.holder) || null : null;
    this.term = num(row?.term ?? 0);
    this.leaseUntil = taken.rowCount && row?.holder === this.nodeId ? num(row.expires_at) : 0;
  }

  /** A preferred node is online and has been up long enough to take over. */
  private async preferredNodeReady(now: number): Promise<boolean> {
    const rows = await this.platform.db.query<Row>(
      `SELECT started_at FROM aspectenant_cluster_nodes
       WHERE preferred = 1 AND id <> $1 AND last_seen > $2`,
      [this.nodeId, now - OFFLINE_MS / 2],
    );
    return rows.rows.some((item) => now - num(item.started_at) > FAILBACK_AFTER_MS);
  }

  private async signals(): Promise<void> {
    const rows = await this.platform.db.query<Row>(
      'SELECT name, generation FROM aspectenant_cluster_signals',
    );
    for (const row of rows.rows) {
      const name = String(row.name);
      const generation = num(row.generation);
      const known = this.seen.get(name) ?? (this.signalsRead ? 0 : undefined);
      this.seen.set(name, generation);
      // The first look only records where we are; later increases are new signals.
      if (known === undefined || generation <= known) continue;
      const handler = this.signalHandlers.get(name);
      if (!handler) continue;
      this.platform.logger.info({ signal: name, generation }, 'cluster signal received');
      try {
        handler();
      } catch (error) {
        this.platform.logger.error({ err: error, signal: name }, 'cluster signal handler failed');
      }
    }
    this.signalsRead = true;
  }

  async status(): Promise<ClusterStatus> {
    const now = Date.now();
    const rows = await this.platform.db.query<Row>(
      `SELECT id, address, preferred, version, started_at, last_seen
       FROM aspectenant_cluster_nodes ORDER BY preferred DESC, id`,
    );
    return {
      enabled: this.enabled,
      settings: await this.getSettings(),
      self: this.nodeId,
      leader: this.leader,
      term: this.term,
      nodes: rows.rows.map((row) => {
        const id = String(row.id);
        const lastSeen = num(row.last_seen);
        return {
          id,
          address: row.address ? String(row.address) : null,
          preferred: num(row.preferred) === 1,
          version: String(row.version),
          startedAt: num(row.started_at),
          lastSeen,
          online: now - lastSeen < OFFLINE_MS,
          leader: id === this.leader,
          self: id === this.nodeId,
        };
      }),
    };
  }

  /** Removes an offline node from the list (a machine that was retired). */
  async forget(id: string): Promise<boolean> {
    if (id === this.nodeId) return false;
    const result = await this.platform.db.query(
      'DELETE FROM aspectenant_cluster_nodes WHERE id = $1 AND last_seen < $2',
      [id, Date.now() - OFFLINE_MS],
    );
    return Boolean(result.rowCount);
  }
}
