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
  /** Atomic-ish counter for daily house-clip budget. Returns new count. */
  incrHouseCount(dayKey: string): Promise<number>;
  /** Simple lock with TTL. Returns true if acquired. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  /** Queue of paid jobs whose generation failed and should be retried. */
  pushDeferred(jobId: string): Promise<void>;
  popDeferred(): Promise<string | null>;
  /** TTL flag, e.g. "fal is balance-locked, pause submissions". */
  setFlag(key: string, ttlSeconds: number): Promise<void>;
  getFlag(key: string): Promise<boolean>;
  /** Presence heartbeat: viewers re-register on every poll; entries older
   * than the TTL are pruned, so the count only reflects live browsers. */
  touchPresence(viewerId: string, name: string): Promise<void>;
  getPresence(): Promise<{ count: number; sample: ViewerSample[] }>;
  /** Rolling public activity feed (paid submissions), newest first. */
  pushActivity(item: ActivityItem): Promise<void>;
  getActivity(): Promise<ActivityItem[]>;
  /** Webhook-fed Voltage payment state (bypasses their read-replica lag). */
  putPaymentState(paymentId: string, state: WebhookPaymentState): Promise<void>;
  getPaymentState(paymentId: string): Promise<WebhookPaymentState | null>;
}

export interface WebhookPaymentState {
  status: string;
  bolt11?: string;
  event: string;
  ts: number;
}

const PRESENCE_KEY = "infinite:presence";
const PRESENCE_TTL_MS = 30_000;
const ACTIVITY_KEY = "infinite:activity";
const ACTIVITY_MAX = 20;

const CLIPS_KEY = "infinite:clips";
const JOB_PREFIX = "infinite:job:";

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
    await this.redis.set(JOB_PREFIX + job.id, JSON.stringify(job), {
      ex: 60 * 60 * 24 * 7,
    });
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
  async setFlag(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`infinite:flag:${key}`, "1", { ex: ttlSeconds });
  }
  async getFlag(key: string): Promise<boolean> {
    return Boolean(await this.redis.get(`infinite:flag:${key}`));
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
  async putPaymentState(paymentId: string, state: WebhookPaymentState): Promise<void> {
    await this.redis.set(`infinite:vpay:${paymentId}`, JSON.stringify(state), {
      ex: 60 * 60 * 24,
    });
  }
  async getPaymentState(paymentId: string): Promise<WebhookPaymentState | null> {
    const raw = await this.redis.get<WebhookPaymentState>(`infinite:vpay:${paymentId}`);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
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
  async setFlag(key: string, ttlSeconds: number) {
    this.flags.set(key, Date.now() + ttlSeconds * 1000);
  }
  async getFlag(key: string) {
    const expires = this.flags.get(key);
    return Boolean(expires && expires > Date.now());
  }
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
  private paymentStates = new Map<string, WebhookPaymentState>();
  async putPaymentState(paymentId: string, state: WebhookPaymentState) {
    this.paymentStates.set(paymentId, state);
  }
  async getPaymentState(paymentId: string) {
    return this.paymentStates.get(paymentId) ?? null;
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
