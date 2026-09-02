import { Redis } from "@upstash/redis";
import { config } from "./config";
import { repairCredit } from "./names";
import type {
  ActivityItem,
  Clip,
  Job,
  JobFailureStage,
  JobStatus,
  ViewerSample,
} from "./types";

/** Storage layer: Upstash Redis in production, in-memory Map for local dev.
 * The in-memory store does not survive across serverless instances — it is
 * a dev convenience only. */

interface Store {
  getClips(): Promise<Clip[]>;
  addClip(clip: Clip): Promise<void>;
  getJob(id: string): Promise<Job | null>;
  /** Create the initial durable record once and return the winning record. */
  createPreparingJob(job: Job): Promise<Job>;
  putJob(job: Job): Promise<void>;
  /** Commit approved prompt data and make the job eligible for payment. */
  completeJobPreparation(job: Job): Promise<boolean>;
  /** Atomically reserve a bounded invoice POST attempt for a prepared job. */
  claimInvoiceRequest(
    jobId: string,
    minIntervalMs: number,
    maxAttempts: number,
  ): Promise<Job | null>;
  /** Attach diagnostics without replacing webhook-owned payment fields. */
  setJobError(
    jobId: string,
    expectedStatus: JobStatus,
    stage: JobFailureStage,
    error: string,
  ): Promise<boolean>;
  clearJobError(
    jobId: string,
    expectedStatus: JobStatus,
    stage: JobFailureStage,
  ): Promise<boolean>;
  /** Add the BOLT11 without replacing newer job state. */
  setJobInvoice(jobId: string, paymentId: string, bolt11: string): Promise<boolean>;
  /** Monotonic payment transitions. True means this call changed state. */
  markJobPaid(jobId: string, paymentId: string): Promise<boolean>;
  markJobPaymentFailed(jobId: string, paymentId: string, reason: string): Promise<boolean>;
  /** Claim the oldest jobs awaiting scheduled payment reconciliation. */
  claimPendingPaymentJobs(limit: number): Promise<Job[]>;
  /** Claim submissions whose immediate post-response preparation was missed. */
  claimPreparingJobs(limit: number): Promise<Job[]>;
  /** Atomic-ish counter for daily house-clip budget. Returns new count. */
  incrHouseCount(dayKey: string): Promise<number>;
  /** Simple lock with TTL. Returns true if acquired. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  /** Atomically move a due paid job into a leased generating state. */
  claimJobGeneration(jobId: string, leaseMs: number): Promise<Job | null>;
  /** Return due generation IDs without removing their recovery record. */
  claimPendingGenerationJobIds(limit: number): Promise<string[]>;
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
const PREPARING_JOBS_KEY = "infinite:preparing-jobs";
const PENDING_PAYMENTS_KEY = "infinite:pending-payments";
const GENERATION_JOBS_KEY = "infinite:generation-jobs";
const LEGACY_DEFERRED_JOBS_KEY = "infinite:deferred";
const PENDING_PAYMENT_SCAN_CURSOR_KEY = "infinite:pending-payment-scan-cursor";
const JOB_TTL_SECONDS = 60 * 60 * 24 * 7;

const CREATE_PREPARING_JOB_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if raw then
  local existing = cjson.decode(raw)
  if existing.status == "preparing" then
    redis.call("ZADD", KEYS[2], "NX", existing.createdAt, existing.id)
  end
  return raw
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
return ARGV[1]
`;

const COMPLETE_JOB_PREPARATION_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.status ~= "preparing" then return 0 end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
redis.call("ZREM", KEYS[2], ARGV[3])
redis.call("ZADD", KEYS[3], ARGV[4], ARGV[3])
return 1
`;

const CLAIM_INVOICE_REQUEST_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local job = cjson.decode(raw)
if job.status ~= "awaiting_payment" or not job.paymentId or job.bolt11 then
  return nil
end
local now = tonumber(ARGV[1])
local last_attempt = tonumber(job.invoiceRequestAt or job.preparedAt or 0)
local attempts = tonumber(job.invoiceRequestAttempts or 0)
if attempts >= tonumber(ARGV[3]) or now - last_attempt < tonumber(ARGV[2]) then
  return nil
end
job.invoiceRequestAttempts = attempts + 1
job.invoiceRequestAt = now
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[4])
return cjson.encode(job)
`;

// Webhook deliveries can be duplicated or arrive alongside a reconciliation
// read. Patch only payment-owned fields atomically so a late "generated" event
// can never replace "paid", "generating", or "done" state.
const SET_JOB_INVOICE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.paymentId ~= ARGV[1] then return 0 end
job.bolt11 = ARGV[2]
if job.failureStage == "invoice" then
  job.error = nil
  job.failureStage = nil
end
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[3])
return 1
`;

const SET_JOB_ERROR_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.status ~= ARGV[1] then return 0 end
job.error = ARGV[2]
job.failureStage = ARGV[3]
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[4])
return 1
`;

const CLEAR_JOB_ERROR_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.status ~= ARGV[1] or job.failureStage ~= ARGV[2] then return 0 end
job.error = nil
job.failureStage = nil
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[3])
return 1
`;

const CLAIM_JOB_GENERATION_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
  redis.call("ZREM", KEYS[2], ARGV[3])
  return nil
end
local job = cjson.decode(raw)
local now = tonumber(ARGV[1])
local lease_until = tonumber(job.generationLeaseUntil or 0)
if job.status ~= "paid" and not (job.status == "generating" and lease_until <= now) then
  if job.status ~= "generating" then
    redis.call("ZREM", KEYS[2], ARGV[3])
  end
  return nil
end
job.status = "generating"
job.generationLeaseUntil = now + tonumber(ARGV[2])
job.error = nil
job.failureStage = nil
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[4])
redis.call("ZADD", KEYS[2], job.generationLeaseUntil, ARGV[3])
return cjson.encode(job)
`;

const CLAIM_PENDING_GENERATION_IDS_SCRIPT = `
local limit = tonumber(ARGV[2])
for _ = 1, limit do
  local job_id = redis.call("LPOP", KEYS[2])
  if not job_id then break end
  redis.call("ZADD", KEYS[1], "NX", 0, job_id)
end
return redis.call(
  "ZRANGEBYSCORE",
  KEYS[1],
  "-inf",
  ARGV[1],
  "LIMIT",
  0,
  limit
)
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
job.failureStage = nil
job.generationLeaseUntil = nil
redis.call("SET", KEYS[1], cjson.encode(job), "EX", ARGV[2])
redis.call("ZREM", KEYS[2], ARGV[3])
redis.call("ZADD", KEYS[3], ARGV[4], ARGV[3])
return 1
`;

const MARK_JOB_PAYMENT_FAILED_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.paymentId ~= ARGV[1] or job.status ~= "awaiting_payment" then return 0 end
job.status = "failed"
job.error = ARGV[2]
job.failureStage = "payment"
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
    return raw.map((c) => {
      const clip: Clip = typeof c === "string" ? JSON.parse(c) : c;
      // Legacy rows carry "grumpy undefined" credits from the old name bug.
      return { ...clip, credit: repairCredit(clip.credit, clip.id) };
    });
  }
  async addClip(clip: Clip): Promise<void> {
    await this.redis.rpush(CLIPS_KEY, JSON.stringify(clip));
  }
  async getJob(id: string): Promise<Job | null> {
    const raw = await this.redis.get<Job>(JOB_PREFIX + id);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  async createPreparingJob(job: Job): Promise<Job> {
    const raw = await this.redis.eval<
      [string, string, string, string],
      Job | string
    >(
      CREATE_PREPARING_JOB_SCRIPT,
      [JOB_PREFIX + job.id, PREPARING_JOBS_KEY],
      [
        JSON.stringify(job),
        String(JOB_TTL_SECONDS),
        String(job.createdAt),
        job.id,
      ],
    );
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  async putJob(job: Job): Promise<void> {
    const pipeline = this.redis
      .pipeline()
      .set(JOB_PREFIX + job.id, JSON.stringify(job), { ex: JOB_TTL_SECONDS });
    if (job.status === "preparing") {
      pipeline.zadd(
        PREPARING_JOBS_KEY,
        { nx: true },
        { score: job.createdAt, member: job.id },
      );
    } else {
      pipeline.zrem(PREPARING_JOBS_KEY, job.id);
    }
    if (job.status === "awaiting_payment" && job.paymentId) {
      pipeline.zadd(
        PENDING_PAYMENTS_KEY,
        { nx: true },
        { score: job.createdAt, member: job.id },
      );
    } else {
      pipeline.zrem(PENDING_PAYMENTS_KEY, job.id);
    }
    if (job.status === "paid") {
      pipeline.zadd(GENERATION_JOBS_KEY, {
        score: Date.now(),
        member: job.id,
      });
    } else if (job.status === "generating" && job.generationLeaseUntil) {
      pipeline.zadd(GENERATION_JOBS_KEY, {
        score: job.generationLeaseUntil,
        member: job.id,
      });
    } else {
      pipeline.zrem(GENERATION_JOBS_KEY, job.id);
    }
    await pipeline.exec();
  }
  async completeJobPreparation(job: Job): Promise<boolean> {
    const changed = await this.redis.eval<
      [string, string, string, string],
      number
    >(
      COMPLETE_JOB_PREPARATION_SCRIPT,
      [JOB_PREFIX + job.id, PREPARING_JOBS_KEY, PENDING_PAYMENTS_KEY],
      [
        JSON.stringify(job),
        String(JOB_TTL_SECONDS),
        job.id,
        String(job.createdAt),
      ],
    );
    return changed === 1;
  }
  async claimInvoiceRequest(
    jobId: string,
    minIntervalMs: number,
    maxAttempts: number,
  ): Promise<Job | null> {
    const raw = await this.redis.eval<
      [string, string, string, string],
      Job | string | null
    >(
      CLAIM_INVOICE_REQUEST_SCRIPT,
      [JOB_PREFIX + jobId],
      [
        String(Date.now()),
        String(Math.max(0, minIntervalMs)),
        String(Math.max(0, maxAttempts)),
        String(JOB_TTL_SECONDS),
      ],
    );
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  async setJobError(
    jobId: string,
    expectedStatus: JobStatus,
    stage: JobFailureStage,
    error: string,
  ): Promise<boolean> {
    const changed = await this.redis.eval<
      [string, string, string, string],
      number
    >(
      SET_JOB_ERROR_SCRIPT,
      [JOB_PREFIX + jobId],
      [expectedStatus, error, stage, String(JOB_TTL_SECONDS)],
    );
    return changed === 1;
  }
  async clearJobError(
    jobId: string,
    expectedStatus: JobStatus,
    stage: JobFailureStage,
  ): Promise<boolean> {
    const changed = await this.redis.eval<[string, string, string], number>(
      CLEAR_JOB_ERROR_SCRIPT,
      [JOB_PREFIX + jobId],
      [expectedStatus, stage, String(JOB_TTL_SECONDS)],
    );
    return changed === 1;
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
    const changed = await this.redis.eval<[string, string, string, string], number>(
      MARK_JOB_PAID_SCRIPT,
      [JOB_PREFIX + jobId, PENDING_PAYMENTS_KEY, GENERATION_JOBS_KEY],
      [paymentId, String(JOB_TTL_SECONDS), jobId, String(Date.now())],
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
  async claimPreparingJobs(limit: number): Promise<Job[]> {
    if (limit <= 0) return [];
    const jobIds = await this.redis.zrange<string[]>(
      PREPARING_JOBS_KEY,
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
      if (job?.status === "preparing") {
        jobs.push(job);
        pipeline.zadd(PREPARING_JOBS_KEY, {
          score: claimedAt,
          member: job.id,
        });
      } else {
        pipeline.zrem(PREPARING_JOBS_KEY, jobIds[i]);
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
  async claimJobGeneration(
    jobId: string,
    leaseMs: number,
  ): Promise<Job | null> {
    const raw = await this.redis.eval<
      [string, string, string, string],
      Job | string | null
    >(
      CLAIM_JOB_GENERATION_SCRIPT,
      [JOB_PREFIX + jobId, GENERATION_JOBS_KEY],
      [
        String(Date.now()),
        String(Math.max(1, leaseMs)),
        jobId,
        String(JOB_TTL_SECONDS),
      ],
    );
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  async claimPendingGenerationJobIds(limit: number): Promise<string[]> {
    if (limit <= 0) return [];
    return this.redis.eval<[string, string], string[]>(
      CLAIM_PENDING_GENERATION_IDS_SCRIPT,
      [GENERATION_JOBS_KEY, LEGACY_DEFERRED_JOBS_KEY],
      [String(Date.now()), String(limit)],
    );
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
    return raw.map((a) => {
      const item: ActivityItem = typeof a === "string" ? JSON.parse(a) : a;
      return { ...item, name: repairCredit(item.name, item.id) };
    });
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
  private preparingAttempts = new Map<string, number>();
  private pendingPaymentAttempts = new Map<string, number>();
  private generationDue = new Map<string, number>();
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
  async createPreparingJob(job: Job) {
    const existing = this.jobs.get(job.id);
    if (existing) {
      if (existing.status === "preparing" && !this.preparingAttempts.has(job.id)) {
        this.preparingAttempts.set(job.id, existing.createdAt);
      }
      return existing;
    }
    this.jobs.set(job.id, job);
    this.preparingAttempts.set(job.id, job.createdAt);
    return job;
  }
  async putJob(job: Job) {
    this.jobs.set(job.id, job);
    if (job.status === "preparing") {
      if (!this.preparingAttempts.has(job.id)) {
        this.preparingAttempts.set(job.id, job.createdAt);
      }
    } else {
      this.preparingAttempts.delete(job.id);
    }
    if (job.status === "awaiting_payment" && job.paymentId) {
      if (!this.pendingPaymentAttempts.has(job.id)) {
        this.pendingPaymentAttempts.set(job.id, job.createdAt);
      }
    } else {
      this.pendingPaymentAttempts.delete(job.id);
    }
    if (job.status === "paid") {
      this.generationDue.set(job.id, Date.now());
    } else if (job.status === "generating" && job.generationLeaseUntil) {
      this.generationDue.set(job.id, job.generationLeaseUntil);
    } else {
      this.generationDue.delete(job.id);
    }
  }
  async completeJobPreparation(job: Job) {
    const current = this.jobs.get(job.id);
    if (!current || current.status !== "preparing") return false;
    this.jobs.set(job.id, job);
    this.preparingAttempts.delete(job.id);
    this.pendingPaymentAttempts.set(job.id, job.createdAt);
    return true;
  }
  async claimInvoiceRequest(
    jobId: string,
    minIntervalMs: number,
    maxAttempts: number,
  ) {
    const job = this.jobs.get(jobId);
    if (
      !job ||
      job.status !== "awaiting_payment" ||
      !job.paymentId ||
      job.bolt11
    ) {
      return null;
    }
    const now = Date.now();
    const lastAttempt = job.invoiceRequestAt ?? job.preparedAt ?? 0;
    const attempts = job.invoiceRequestAttempts ?? 0;
    if (
      attempts >= Math.max(0, maxAttempts) ||
      now - lastAttempt < Math.max(0, minIntervalMs)
    ) {
      return null;
    }
    job.invoiceRequestAttempts = attempts + 1;
    job.invoiceRequestAt = now;
    return job;
  }
  async setJobError(
    jobId: string,
    expectedStatus: JobStatus,
    stage: JobFailureStage,
    error: string,
  ) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== expectedStatus) return false;
    job.error = error;
    job.failureStage = stage;
    return true;
  }
  async clearJobError(
    jobId: string,
    expectedStatus: JobStatus,
    stage: JobFailureStage,
  ) {
    const job = this.jobs.get(jobId);
    if (job?.status !== expectedStatus || job.failureStage !== stage) return false;
    delete job.error;
    delete job.failureStage;
    return true;
  }
  async setJobInvoice(jobId: string, paymentId: string, bolt11: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.paymentId !== paymentId) return false;
    job.bolt11 = bolt11;
    if (job.failureStage === "invoice") {
      delete job.error;
      delete job.failureStage;
    }
    return true;
  }
  async markJobPaid(jobId: string, paymentId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.paymentId !== paymentId) return false;
    const paymentFailure = job.status === "failed" && job.error?.startsWith("payment ");
    if (job.status !== "awaiting_payment" && !paymentFailure) return false;
    job.status = "paid";
    delete job.error;
    delete job.failureStage;
    delete job.generationLeaseUntil;
    this.pendingPaymentAttempts.delete(jobId);
    this.generationDue.set(jobId, Date.now());
    return true;
  }
  async markJobPaymentFailed(jobId: string, paymentId: string, reason: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.paymentId !== paymentId || job.status !== "awaiting_payment") return false;
    job.status = "failed";
    job.error = reason;
    job.failureStage = "payment";
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
  async claimPreparingJobs(limit: number) {
    const ids = [...this.preparingAttempts]
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.max(0, limit))
      .map(([id]) => id);
    const claimedAt = Date.now();
    const jobs: Job[] = [];
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job?.status === "preparing") {
        jobs.push(job);
        this.preparingAttempts.set(id, claimedAt);
      } else {
        this.preparingAttempts.delete(id);
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
  private flags = new Map<string, number>();
  async claimJobGeneration(jobId: string, leaseMs: number) {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.generationDue.delete(jobId);
      return null;
    }
    const now = Date.now();
    if (
      job.status !== "paid" &&
      !(job.status === "generating" && (job.generationLeaseUntil ?? 0) <= now)
    ) {
      if (job.status !== "generating") this.generationDue.delete(jobId);
      return null;
    }
    job.status = "generating";
    job.generationLeaseUntil = now + Math.max(1, leaseMs);
    delete job.error;
    delete job.failureStage;
    this.generationDue.set(jobId, job.generationLeaseUntil);
    return job;
  }
  async claimPendingGenerationJobIds(limit: number) {
    const now = Date.now();
    return [...this.generationDue]
      .filter(([, due]) => due <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.max(0, limit))
      .map(([id]) => id);
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
