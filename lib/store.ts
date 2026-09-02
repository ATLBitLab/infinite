import { Redis } from "@upstash/redis";
import { config } from "./config";
import type { ActivityItem, Clip, Job, ViewerSample } from "./types";

/** Storage layer: Upstash Redis in production, in-memory Map for local dev.
 * The in-memory store does not survive across serverless instances — it is
 * a dev convenience only. */

interface Store {
  getClips(): Promise<Clip[]>;
  addClip(clip: Clip): Promise<void>;
  getJob(id: string): Promise<Job | null>;
  putJob(job: Job): Promise<void>;
  /** Add the BOLT11 without replacing newer job state. */
  setJobInvoice(jobId: string, paymentId: string, bolt11: string): Promise<boolean>;
  /** Monotonic payment transitions. True means this call changed state. */
  markJobPaid(jobId: string, paymentId: string): Promise<boolean>;
  markJobPaymentFailed(jobId: string, paymentId: string, reason: string): Promise<boolean>;
  /** Claim the oldest jobs awaiting scheduled payment reconciliation. */
  claimPendingPaymentJobs(limit: number): Promise<Job[]>;
  /** Atomic-ish counter for daily house-clip budget. Returns new count. */
  incrHouseCount(dayKey: string): Promise<number>;
  /** Simple lock with TTL. Returns true if acquired. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  /** Queue of paid jobs whose generation failed and should be retried. */
  pushDeferred(jobId: string): Promise<void>;
  popDeferred(): Promise<string | null>;
  /** TTL flag, e.g. "fal is balance-locked, pause submissions". */
  setFlag(key: string, ttlSeconds: number, reason?: string): Promise<void>;
  getFlag(key: string): Promise<boolean>;
  /** Flag with diagnostics: why + when it was set (null when inactive). */
  getFlagInfo(key: string): Promise<{ reason: string; ts: number } | null>;
  /** Presence heartbeat: viewers re-register on every poll; entries older
   * than the TTL are pruned, so the count only reflects live browsers. */
  touchPresence(viewerId: string, name: string): Promise<void>;
  getPresence(): Promise<{ count: number; sample: ViewerSample[] }>;
  /** Rolling public activity feed (paid submissions), newest first. */
  pushActivity(item: ActivityItem): Promise<void>;
  getActivity(): Promise<ActivityItem[]>;
}

const PRESENCE_KEY = "infinite:presence";
const PRESENCE_TTL_MS = 30_000;
const ACTIVITY_KEY = "infinite:activity";
const ACTIVITY_MAX = 20;

const CLIPS_KEY = "infinite:clips";
const JOB_PREFIX = "infinite:job:";
const PENDING_PAYMENTS_KEY = "infinite:pending-payments";
const PENDING_PAYMENT_SCAN_CURSOR_KEY = "infinite:pending-payment-scan-cursor";
const JOB_TTL_SECONDS = 60 * 60 * 24 * 7;

// Webhook deliveries can be duplicated or arrive alongside a reconciliation
// read. Patch only payment-owned fields atomically so a late "generated" event
// can never replace "paid", "generating", or "done" state.
const SET_JOB_INVOICE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.paymentId ~= ARGV[1] then return 0 end
job.bolt11 = ARGV[2]
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[3])
return 1
`;

const MARK_JOB_PAID_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.paymentId ~= ARGV[1] then return 0 end
local payment_failure = job.status == "failed"
  and type(job.error) == "string"
  and string.sub(job.error, 1, 8) == "payment "
if job.status ~= "awaiting_payment" and not payment_failure then return 0 end
job.status = "paid"
job.error = nil
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[2])
redis.call("ZREM", KEYS[2], ARGV[3])
return 1
`;

const MARK_JOB_PAYMENT_FAILED_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.paymentId ~= ARGV[1] or job.status ~= "awaiting_payment" then return 0 end
job.status = "failed"
job.error = ARGV[2]
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[3])
redis.call("ZREM", KEYS[2], ARGV[4])
return 1
`;

class RedisStore implements Store {
  private redis: Redis;
  constructor() {
    this.redis = new Redis({ url: config.redisUrl, token: config.redisToken });
  }
  async getClips(): Promise<Clip[]> {
    const raw = await this.redis.lrange<Clip>(CLIPS_KEY, 0, -1);
    return raw.map((c) => (typeof c === "string" ? JSON.parse(c) : c));
  }
  async addClip(clip: Clip): Promise<void> {
    await this.redis.rpush(CLIPS_KEY, JSON.stringify(clip));
  }
  async getJob(id: string): Promise<Job | null> {
    const raw = await this.redis.get<Job>(JOB_PREFIX + id);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  async putJob(job: Job): Promise<void> {
    const pipeline = this.redis
      .pipeline()
      .set(JOB_PREFIX + job.id, JSON.stringify(job), { ex: JOB_TTL_SECONDS });
    if (job.status === "awaiting_payment" && job.paymentId) {
      pipeline.zadd(
        PENDING_PAYMENTS_KEY,
        { nx: true },
        { score: job.createdAt, member: job.id },
      );
    } else {
      pipeline.zrem(PENDING_PAYMENTS_KEY, job.id);
    }
    await pipeline.exec();
  }
  async setJobInvoice(jobId: string, paymentId: string, bolt11: string): Promise<boolean> {
    const changed = await this.redis.eval<[string, string, string], number>(
      SET_JOB_INVOICE_SCRIPT,
      [JOB_PREFIX + jobId],
      [paymentId, bolt11, String(JOB_TTL_SECONDS)],
    );
    return changed === 1;
  }
  async markJobPaid(jobId: string, paymentId: string): Promise<boolean> {
    const changed = await this.redis.eval<[string, string, string], number>(
      MARK_JOB_PAID_SCRIPT,
      [JOB_PREFIX + jobId, PENDING_PAYMENTS_KEY],
      [paymentId, String(JOB_TTL_SECONDS), jobId],
    );
    return changed === 1;
  }
  async markJobPaymentFailed(jobId: string, paymentId: string, reason: string): Promise<boolean> {
    const changed = await this.redis.eval<[string, string, string, string], number>(
      MARK_JOB_PAYMENT_FAILED_SCRIPT,
      [JOB_PREFIX + jobId, PENDING_PAYMENTS_KEY],
      [paymentId, reason, String(JOB_TTL_SECONDS), jobId],
    );
    return changed === 1;
  }
  async claimPendingPaymentJobs(limit: number): Promise<Job[]> {
    if (limit <= 0) return [];
    await this.backfillPendingPaymentIndex();
    const jobIds = await this.redis.zrange<string[]>(
      PENDING_PAYMENTS_KEY,
      0,
      limit - 1,
    );
    if (jobIds.length === 0) return [];

    const rawJobs = await this.redis.mget<(Job | string | null)[]>(
      ...jobIds.map((id) => JOB_PREFIX + id),
    );
    const jobs: Job[] = [];
    const pipeline = this.redis.pipeline();
    const claimedAt = Date.now();
    for (let i = 0; i < jobIds.length; i++) {
      const raw = rawJobs[i];
      const job = typeof raw === "string" ? (JSON.parse(raw) as Job) : raw;
      if (job?.status === "awaiting_payment" && job.paymentId) {
        jobs.push(job);
        // Move claimed jobs to the back so one stuck payment cannot starve
        // newer jobs when a sweep reaches its per-run limit.
        pipeline.zadd(PENDING_PAYMENTS_KEY, {
          score: claimedAt,
          member: job.id,
        });
      } else {
        pipeline.zrem(PENDING_PAYMENTS_KEY, jobIds[i]);
      }
    }
    if (pipeline.length() > 0) await pipeline.exec();
    return jobs;
  }
  private async backfillPendingPaymentIndex(): Promise<void> {
    // Incrementally scan the existing seven-day job window. This picks up
    // in-flight jobs created before the pending index was deployed, including
    // legacy jobs whose job and Voltage payment IDs differ.
    const storedCursor = await this.redis.get<string | number>(
      PENDING_PAYMENT_SCAN_CURSOR_KEY,
    );
    const cursor = storedCursor === null ? "0" : String(storedCursor);
    const [nextCursor, keys] = await this.redis.scan(cursor, {
      match: `${JOB_PREFIX}*`,
      count: 100,
    });
    const pipeline = this.redis.pipeline().set(
      PENDING_PAYMENT_SCAN_CURSOR_KEY,
      nextCursor,
    );
    if (keys.length === 0) {
      await pipeline.exec();
      return;
    }

    const rawJobs = await this.redis.mget<(Job | string | null)[]>(...keys);
    for (let i = 0; i < keys.length; i++) {
      const raw = rawJobs[i];
      const job = typeof raw === "string" ? (JSON.parse(raw) as Job) : raw;
      const jobId = keys[i].slice(JOB_PREFIX.length);
      if (job?.status === "awaiting_payment" && job.paymentId) {
        pipeline.zadd(
          PENDING_PAYMENTS_KEY,
          { nx: true },
          { score: job.createdAt, member: job.id },
        );
      } else {
        pipeline.zrem(PENDING_PAYMENTS_KEY, jobId);
      }
    }
    await pipeline.exec();
  }
  async incrHouseCount(dayKey: string): Promise<number> {
    const key = `infinite:housecount:${dayKey}`;
    const n = await this.redis.incr(key);
    await this.redis.expire(key, 60 * 60 * 48);
    return n;
  }
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const ok = await this.redis.set(`infinite:lock:${key}`, "1", {
      nx: true,
      ex: ttlSeconds,
    });
    return ok === "OK";
  }
  async releaseLock(key: string): Promise<void> {
    await this.redis.del(`infinite:lock:${key}`);
  }
  async pushDeferred(jobId: string): Promise<void> {
    await this.redis.rpush("infinite:deferred", jobId);
  }
  async popDeferred(): Promise<string | null> {
    return await this.redis.lpop<string>("infinite:deferred");
  }
  async setFlag(key: string, ttlSeconds: number, reason = ""): Promise<void> {
    await this.redis.set(
      `infinite:flag:${key}`,
      JSON.stringify({ reason, ts: Date.now() }),
      { ex: ttlSeconds },
    );
  }
  async getFlag(key: string): Promise<boolean> {
    return Boolean(await this.redis.get(`infinite:flag:${key}`));
  }
  async getFlagInfo(key: string): Promise<{ reason: string; ts: number } | null> {
    const raw = await this.redis.get<{ reason: string; ts: number } | string>(
      `infinite:flag:${key}`,
    );
    if (!raw) return null;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return { reason: String(parsed.reason ?? ""), ts: Number(parsed.ts ?? 0) };
    } catch {
      return { reason: "", ts: 0 }; // legacy "1" value
    }
  }
  async touchPresence(viewerId: string, name: string): Promise<void> {
    await this.redis.zadd(PRESENCE_KEY, {
      score: Date.now(),
      member: `${viewerId}|${name}`,
    });
  }
  async getPresence(): Promise<{ count: number; sample: ViewerSample[] }> {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    await this.redis.zremrangebyscore(PRESENCE_KEY, 0, cutoff);
    const [count, members] = await Promise.all([
      this.redis.zcard(PRESENCE_KEY),
      this.redis.zrange<string[]>(PRESENCE_KEY, 0, 7),
    ]);
    return { count, sample: members.map(parseViewerMember) };
  }
  async pushActivity(item: ActivityItem): Promise<void> {
    await this.redis.lpush(ACTIVITY_KEY, JSON.stringify(item));
    await this.redis.ltrim(ACTIVITY_KEY, 0, ACTIVITY_MAX - 1);
  }
  async getActivity(): Promise<ActivityItem[]> {
    const raw = await this.redis.lrange<ActivityItem>(ACTIVITY_KEY, 0, ACTIVITY_MAX - 1);
    return raw.map((a) => (typeof a === "string" ? JSON.parse(a) : a));
  }
}

function parseViewerMember(member: string): ViewerSample {
  const sep = member.indexOf("|");
  return sep === -1
    ? { id: member, name: "viewer" }
    : { id: member.slice(0, sep), name: member.slice(sep + 1) };
}

class MemoryStore implements Store {
  private clips: Clip[] = [];
  private jobs = new Map<string, Job>();
  private pendingPaymentAttempts = new Map<string, number>();
  private counters = new Map<string, number>();
  private locks = new Map<string, number>();
  async getClips() {
    return [...this.clips];
  }
  async addClip(clip: Clip) {
    this.clips.push(clip);
  }
  async getJob(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async putJob(job: Job) {
    this.jobs.set(job.id, job);
    if (job.status === "awaiting_payment" && job.paymentId) {
      if (!this.pendingPaymentAttempts.has(job.id)) {
        this.pendingPaymentAttempts.set(job.id, job.createdAt);
      }
    } else {
      this.pendingPaymentAttempts.delete(job.id);
    }
  }
  async setJobInvoice(jobId: string, paymentId: string, bolt11: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.paymentId !== paymentId) return false;
    job.bolt11 = bolt11;
    return true;
  }
  async markJobPaid(jobId: string, paymentId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.paymentId !== paymentId) return false;
    const paymentFailure = job.status === "failed" && job.error?.startsWith("payment ");
    if (job.status !== "awaiting_payment" && !paymentFailure) return false;
    job.status = "paid";
    delete job.error;
    this.pendingPaymentAttempts.delete(jobId);
    return true;
  }
  async markJobPaymentFailed(jobId: string, paymentId: string, reason: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.paymentId !== paymentId || job.status !== "awaiting_payment") return false;
    job.status = "failed";
    job.error = reason;
    this.pendingPaymentAttempts.delete(jobId);
    return true;
  }
  async claimPendingPaymentJobs(limit: number) {
    const ids = [...this.pendingPaymentAttempts]
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.max(0, limit))
      .map(([id]) => id);
    const claimedAt = Date.now();
    const jobs: Job[] = [];
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job?.status === "awaiting_payment" && job.paymentId) {
        jobs.push(job);
        this.pendingPaymentAttempts.set(id, claimedAt);
      } else {
        this.pendingPaymentAttempts.delete(id);
      }
    }
    return jobs;
  }
  async incrHouseCount(dayKey: string) {
    const n = (this.counters.get(dayKey) ?? 0) + 1;
    this.counters.set(dayKey, n);
    return n;
  }
  async acquireLock(key: string, ttlSeconds: number) {
    const now = Date.now();
    const expires = this.locks.get(key);
    if (expires && expires > now) return false;
    this.locks.set(key, now + ttlSeconds * 1000);
    return true;
  }
  async releaseLock(key: string) {
    this.locks.delete(key);
  }
  private deferred: string[] = [];
  private flags = new Map<string, number>();
  async pushDeferred(jobId: string) {
    this.deferred.push(jobId);
  }
  async popDeferred() {
    return this.deferred.shift() ?? null;
  }
  async setFlag(key: string, ttlSeconds: number, reason = "") {
    this.flags.set(key, Date.now() + ttlSeconds * 1000);
    this.flagReasons.set(key, { reason, ts: Date.now() });
  }
  async getFlag(key: string) {
    const expires = this.flags.get(key);
    return Boolean(expires && expires > Date.now());
  }
  async getFlagInfo(key: string) {
    return (await this.getFlag(key)) ? (this.flagReasons.get(key) ?? null) : null;
  }
  private flagReasons = new Map<string, { reason: string; ts: number }>();
  private presence = new Map<string, { name: string; ts: number }>();
  private activity: ActivityItem[] = [];
  async touchPresence(viewerId: string, name: string) {
    this.presence.set(viewerId, { name, ts: Date.now() });
  }
  async getPresence() {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [id, v] of this.presence) {
      if (v.ts < cutoff) this.presence.delete(id);
    }
    const sample = [...this.presence.entries()]
      .slice(0, 8)
      .map(([id, v]) => ({ id, name: v.name }));
    return { count: this.presence.size, sample };
  }
  async pushActivity(item: ActivityItem) {
    this.activity.unshift(item);
    this.activity.length = Math.min(this.activity.length, ACTIVITY_MAX);
  }
  async getActivity() {
    return [...this.activity];
  }
}

// Persist the memory store across dev hot-reloads via globalThis.
const globalStore = globalThis as unknown as { __infiniteStore?: Store };

export function getStore(): Store {
  if (!globalStore.__infiniteStore) {
    globalStore.__infiniteStore =
      config.redisUrl && config.redisToken ? new RedisStore() : new MemoryStore();
  }
  return globalStore.__infiniteStore;
}

export function usingRedis(): boolean {
  return Boolean(config.redisUrl && config.redisToken);
}

/** True when running on real deployed infra where the in-memory store is
 * unusable (each serverless instance has its own memory, so writes vanish). */
export function persistenceMisconfigured(): boolean {
  const deployed = Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";
  return deployed && !usingRedis();
}
