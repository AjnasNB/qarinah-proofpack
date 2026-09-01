import { createHash, timingSafeEqual } from "node:crypto";

import { hashCanonical, hashText } from "@/lib/proof/canonical";
import type { PreflightRequest, PreflightResponse } from "./types";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_DAILY_BUDGET_MICROS = 1_000_000;
const DEFAULT_PRINCIPAL_MINUTE_LIMIT = 2;
const DEFAULT_PRINCIPAL_DAY_LIMIT = 10;
const DEFAULT_GLOBAL_CONCURRENCY = 2;
const DEFAULT_CACHE_TTL_SECONDS = 86_400;
const DEFAULT_PENDING_TTL_SECONDS = 180;

export type SpendGuardReadiness = "ready" | "missing_store" | "missing_access_keys" | "invalid_configuration";

export interface SpendGuardConfig {
  redisUrl: string;
  redisToken: string;
  accessKeyHashes: string[];
  dailyBudgetMicros: number;
  principalMinuteLimit: number;
  principalDayLimit: number;
  globalConcurrency: number;
  cacheTtlSeconds: number;
  pendingTtlSeconds: number;
}

export interface SpendGuardStatus {
  readiness: SpendGuardReadiness;
  configured: boolean;
  access_required: boolean;
}

export type SpendReservation =
  | { status: "reserved"; requestKey: string; responseKey: string; fingerprint: string }
  | { status: "complete"; response: PreflightResponse }
  | { status: "conflict" | "pending" | "failed" | "budget_exhausted" | "principal_limited" | "busy" };

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError("Spend guard limits must be positive integers.");
  return parsed;
}

function normalizeRedisUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function configuredAccessHashes(value: string | undefined): string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => HASH_PATTERN.test(entry)))];
}

export function readSpendGuardConfig(): SpendGuardConfig | null {
  const redisUrl = normalizeRedisUrl(
    process.env.PROOFGATE_REDIS_REST_URL
      ?? process.env.UPSTASH_REDIS_REST_URL
      ?? process.env.KV_REST_API_URL,
  );
  const redisToken = process.env.PROOFGATE_REDIS_REST_TOKEN
    ?? process.env.UPSTASH_REDIS_REST_TOKEN
    ?? process.env.KV_REST_API_TOKEN
    ?? "";
  const accessKeyHashes = configuredAccessHashes(process.env.PROOFGATE_ACCESS_KEY_HASHES);
  if (!redisUrl || redisToken.length < 16 || accessKeyHashes.length === 0) return null;

  try {
    return {
      redisUrl,
      redisToken,
      accessKeyHashes,
      dailyBudgetMicros: positiveInteger(process.env.PROOFGATE_DAILY_BUDGET_USDC_MICROS, DEFAULT_DAILY_BUDGET_MICROS),
      principalMinuteLimit: positiveInteger(process.env.PROOFGATE_PRINCIPAL_MINUTE_LIMIT, DEFAULT_PRINCIPAL_MINUTE_LIMIT),
      principalDayLimit: positiveInteger(process.env.PROOFGATE_PRINCIPAL_DAY_LIMIT, DEFAULT_PRINCIPAL_DAY_LIMIT),
      globalConcurrency: positiveInteger(process.env.PROOFGATE_GLOBAL_CONCURRENCY, DEFAULT_GLOBAL_CONCURRENCY),
      cacheTtlSeconds: positiveInteger(process.env.PROOFGATE_IDEMPOTENCY_TTL_SECONDS, DEFAULT_CACHE_TTL_SECONDS),
      pendingTtlSeconds: positiveInteger(process.env.PROOFGATE_PENDING_TTL_SECONDS, DEFAULT_PENDING_TTL_SECONDS),
    };
  } catch {
    return null;
  }
}

export function spendGuardStatus(): SpendGuardStatus {
  const storeUrl = process.env.PROOFGATE_REDIS_REST_URL
    ?? process.env.UPSTASH_REDIS_REST_URL
    ?? process.env.KV_REST_API_URL;
  const storeToken = process.env.PROOFGATE_REDIS_REST_TOKEN
    ?? process.env.UPSTASH_REDIS_REST_TOKEN
    ?? process.env.KV_REST_API_TOKEN;
  const accessHashes = configuredAccessHashes(process.env.PROOFGATE_ACCESS_KEY_HASHES);
  if (!storeUrl || !storeToken) return { readiness: "missing_store", configured: false, access_required: true };
  if (accessHashes.length === 0) return { readiness: "missing_access_keys", configured: false, access_required: true };
  return readSpendGuardConfig()
    ? { readiness: "ready", configured: true, access_required: true }
    : { readiness: "invalid_configuration", configured: false, access_required: true };
}

export function hashAccessKey(value: string): string {
  return hashText(value.normalize("NFKC"));
}

export function authenticateSpendPrincipal(rawAccessKey: string | null, config: SpendGuardConfig): string | null {
  if (!rawAccessKey || rawAccessKey.length < 16 || rawAccessKey.length > 512) return null;
  const candidate = hashAccessKey(rawAccessKey);
  const candidateBytes = Buffer.from(candidate.slice("sha256:".length), "hex");
  const accepted = config.accessKeyHashes.some((expected) => {
    const expectedBytes = Buffer.from(expected.slice("sha256:".length), "hex");
    return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
  });
  return accepted ? candidate : null;
}

function canonicalRequestFingerprint(request: PreflightRequest): string {
  return hashCanonical({
    action: request.action,
    policy: request.policy,
    claims: request.claims ?? null,
  });
}

function utcBucket(date: Date): { day: string; minute: string } {
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), minute: iso.slice(0, 16) };
}

async function redisCommand(
  config: SpendGuardConfig,
  command: Array<string | number>,
  fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
  const response = await fetchImpl(config.redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Spend guard store returned HTTP ${response.status}.`);
  const body = await response.json() as { result?: unknown; error?: string };
  if (body.error || !("result" in body)) throw new Error("Spend guard store returned an invalid result.");
  return body.result;
}

const RESERVE_SCRIPT = `
local status = redis.call('GET', KEYS[1])
if status then
  local separator = string.find(status, '|', 1, true)
  local fingerprint = separator and string.sub(status, 1, separator - 1) or ''
  local state = separator and string.sub(status, separator + 1) or ''
  if fingerprint ~= ARGV[1] then return {'CONFLICT'} end
  if state == 'COMPLETE' then
    local cached = redis.call('GET', KEYS[2])
    return cached and {'COMPLETE', cached} or {'FAILED'}
  end
  return {state}
end
local reserve = tonumber(ARGV[2])
local daily_limit = tonumber(ARGV[3])
local minute_limit = tonumber(ARGV[4])
local principal_day_limit = tonumber(ARGV[5])
local concurrency_limit = tonumber(ARGV[6])
local global_spend = tonumber(redis.call('GET', KEYS[3]) or '0')
local principal_minute = tonumber(redis.call('GET', KEYS[4]) or '0')
local principal_day = tonumber(redis.call('GET', KEYS[5]) or '0')
local concurrency = tonumber(redis.call('GET', KEYS[6]) or '0')
if global_spend + reserve > daily_limit then return {'BUDGET_EXHAUSTED'} end
if principal_minute >= minute_limit or principal_day >= principal_day_limit then return {'PRINCIPAL_LIMITED'} end
if concurrency >= concurrency_limit then return {'BUSY'} end
redis.call('SET', KEYS[1], ARGV[1] .. '|PENDING', 'EX', tonumber(ARGV[7]), 'NX')
redis.call('INCRBY', KEYS[3], reserve)
redis.call('EXPIRE', KEYS[3], 172800)
redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[4], 120)
redis.call('INCR', KEYS[5])
redis.call('EXPIRE', KEYS[5], 172800)
redis.call('INCR', KEYS[6])
redis.call('EXPIRE', KEYS[6], tonumber(ARGV[7]))
return {'RESERVED'}
`;

const FINALIZE_SCRIPT = `
local status = redis.call('GET', KEYS[1])
if status ~= ARGV[1] .. '|PENDING' then return {'STALE'} end
if ARGV[2] == 'COMPLETE' then
  redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
end
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. ARGV[2], 'EX', tonumber(ARGV[4]))
local concurrency = tonumber(redis.call('GET', KEYS[3]) or '0')
if concurrency > 0 then redis.call('DECR', KEYS[3]) end
return {'OK'}
`;

export async function reservePaidPreflight(input: {
  config: SpendGuardConfig;
  principal: string;
  requestId: string;
  request: PreflightRequest;
  maximumPaidCalls: number;
  maximumPaymentMicros: number;
  now?: Date;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<SpendReservation> {
  const now = input.now ?? new Date();
  const { day, minute } = utcBucket(now);
  const fingerprint = canonicalRequestFingerprint(input.request);
  const opaqueRequest = createHash("sha256")
    .update(`${input.principal}\0${input.requestId}`, "utf8")
    .digest("hex");
  const principalKey = input.principal.slice("sha256:".length);
  const requestKey = `pg:idem:${opaqueRequest}`;
  const responseKey = `pg:result:${opaqueRequest}`;
  const concurrencyKey = "pg:concurrency";
  const result = await redisCommand(input.config, [
    "EVAL",
    RESERVE_SCRIPT,
    6,
    requestKey,
    responseKey,
    `pg:budget:${day}`,
    `pg:principal:${principalKey}:minute:${minute}`,
    `pg:principal:${principalKey}:day:${day}`,
    concurrencyKey,
    fingerprint,
    input.maximumPaidCalls * input.maximumPaymentMicros,
    input.config.dailyBudgetMicros,
    input.config.principalMinuteLimit,
    input.config.principalDayLimit,
    input.config.globalConcurrency,
    input.config.pendingTtlSeconds,
  ], input.fetchImpl ?? globalThis.fetch);
  const tuple = Array.isArray(result) ? result : [];
  const state = typeof tuple[0] === "string" ? tuple[0] : "";
  if (state === "RESERVED") return { status: "reserved", requestKey, responseKey, fingerprint };
  if (state === "COMPLETE" && typeof tuple[1] === "string") {
    try {
      return { status: "complete", response: JSON.parse(tuple[1]) as PreflightResponse };
    } catch {
      return { status: "failed" };
    }
  }
  const mapped = {
    CONFLICT: "conflict",
    PENDING: "pending",
    FAILED: "failed",
    BUDGET_EXHAUSTED: "budget_exhausted",
    PRINCIPAL_LIMITED: "principal_limited",
    BUSY: "busy",
  } as const;
  return { status: mapped[state as keyof typeof mapped] ?? "failed" };
}

export async function finalizePaidPreflight(input: {
  config: SpendGuardConfig;
  reservation: Extract<SpendReservation, { status: "reserved" }>;
  response?: PreflightResponse;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<void> {
  const state = input.response ? "COMPLETE" : "FAILED";
  const result = await redisCommand(input.config, [
    "EVAL",
    FINALIZE_SCRIPT,
    3,
    input.reservation.requestKey,
    input.reservation.responseKey,
    "pg:concurrency",
    input.reservation.fingerprint,
    state,
    input.response ? JSON.stringify(input.response) : "",
    input.config.cacheTtlSeconds,
  ], input.fetchImpl ?? globalThis.fetch);
  if (!Array.isArray(result) || result[0] !== "OK") {
    throw new Error("Spend guard could not finalize the idempotency record.");
  }
}
