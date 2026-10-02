import type {
  AuditEventInput,
  AuditSink,
  EnqueueOptions,
  JobQueue,
  LoggerLike,
  Mailer,
  MailMessage,
  PermissionChecker,
  ResourceRef,
  Subject,
} from '../../src/ports.js';

export class FakeClock {
  current: number;
  constructor(current = Date.UTC(2026, 8, 29, 12, 0, 0)) {
    this.current = current;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  failNext = false;
  async send(message: MailMessage): Promise<{ id?: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP unavailable');
    }
    this.sent.push(message);
    return { id: `msg-${this.sent.length}` };
  }
  /** Extracts the invitation token from the last email text. */
  lastToken(): string {
    const text = this.sent[this.sent.length - 1]?.text ?? '';
    const match = /token=([A-Za-z0-9_.%-]+)/.exec(text);
    if (!match?.[1]) throw new Error('no token in email');
    return decodeURIComponent(match[1]);
  }
}

export class FakeAudit implements AuditSink {
  events: AuditEventInput[] = [];
  async record(event: AuditEventInput): Promise<unknown> {
    this.events.push(structuredClone(event));
    return undefined;
  }
  actions(): string[] {
    return this.events.map((e) => e.action);
  }
}

export class FakeJobs implements JobQueue {
  jobs: Array<{ name: string; payload: unknown; options: EnqueueOptions | undefined }> = [];
  async add(name: string, payload: unknown, options?: EnqueueOptions): Promise<{ id: string }> {
    this.jobs.push({ name, payload, options });
    return { id: `job-${this.jobs.length}` };
  }
}

/** Grants permissions listed per subject ID; everything else is denied. */
export class FakePermissions implements PermissionChecker {
  calls: Array<{ subject: Subject; permission: string; resource: ResourceRef | undefined }> = [];
  private readonly grants: Record<string, readonly string[]>;
  constructor(grants: Record<string, readonly string[]>) {
    this.grants = grants;
  }
  async can(subject: Subject, permission: string, resource?: ResourceRef): Promise<boolean> {
    this.calls.push({ subject, permission, resource });
    return this.grants[subject.id]?.includes(permission) ?? false;
  }
}

export class MemoryLogger implements LoggerLike {
  entries: Array<{ level: string; obj: Record<string, unknown>; msg: string | undefined }> = [];
  debug(obj: Record<string, unknown>, msg?: string) {
    this.entries.push({ level: 'debug', obj, msg });
  }
  info(obj: Record<string, unknown>, msg?: string) {
    this.entries.push({ level: 'info', obj, msg });
  }
  warn(obj: Record<string, unknown>, msg?: string) {
    this.entries.push({ level: 'warn', obj, msg });
  }
  error(obj: Record<string, unknown>, msg?: string) {
    this.entries.push({ level: 'error', obj, msg });
  }
}

export function sequentialIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, '0')}`;
}
