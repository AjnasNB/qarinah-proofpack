import { wrapFetchWithPayment, x402Client, type PaymentRequirements } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

import type {
  TelegraphAskResult,
  TelegraphClient,
  TelegraphIntent,
  TelegraphJsonSchema,
  TelegraphMiner,
  TelegraphMinerEndpoint,
  TelegraphMinerScore,
  TelegraphSignalLookup,
} from "./types";

const DEFAULT_NODE_URL = "https://devnode.telegraphprotocol.com";
const BASE_SEPOLIA = "eip155:84532" as const;
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const ABSOLUTE_PAYMENT_CAP_USDC_MICROS = 100_000n;
const MAX_EXTERNAL_BODY_BYTES = 2 * 1024 * 1024;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SIGNAL_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TEXT_INPUT_FIELDS = ["query", "question", "claim", "statement", "topic", "prompt", "text"] as const;

export type TelegraphClientErrorCode =
  | "NOT_CONFIGURED"
  | "DISCOVERY_FAILED"
  | "NO_VIABLE_MINER"
  | "PAYMENT_FAILED"
  | "REQUEST_FAILED"
  | "INVALID_RESPONSE"
  | "SIGNAL_VERIFICATION_FAILED";

export class TelegraphClientError extends Error {
  constructor(
    readonly code: TelegraphClientErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "TelegraphClientError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

function endpoints(value: unknown): TelegraphMinerEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const path = boundedString(record?.path, 2_048);
    const method = boundedString(record?.method, 16);
    if (!record || !path || !method) return [];
    return [{
      path,
      method: method.toUpperCase(),
      ...(boundedString(record.description, 1_024) ? { description: boundedString(record.description, 1_024) as string } : {}),
    }];
  });
}

function jsonSchema(value: unknown): TelegraphJsonSchema | null {
  const record = asRecord(value);
  if (!record) return null;
  const propertiesRecord = asRecord(record.properties);
  const properties = propertiesRecord
    ? Object.fromEntries(Object.entries(propertiesRecord).flatMap(([key, property]) => {
      const parsed = asRecord(property);
      return parsed ? [[key, parsed]] : [];
    }))
    : undefined;
  return {
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(properties ? { properties } : {}),
    ...(Array.isArray(record.required) ? { required: strings(record.required) } : {}),
  };
}

function scores(value: unknown): TelegraphMinerScore[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || typeof record.intent_id !== "string" || typeof record.rank !== "number") return [];
    return [{
      intent_id: record.intent_id,
      rank: record.rank,
      ...(typeof record.score === "number" ? { score: record.score } : {}),
      ...(typeof record.epoch_id === "number" ? { epoch_id: record.epoch_id } : {}),
      ...(typeof record.scored_at === "string" ? { scored_at: record.scored_at } : {}),
    }];
  });
}

export function parseMinerCatalog(value: unknown): TelegraphMiner[] {
  if (!Array.isArray(value)) {
    throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph miner discovery did not return an array.");
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const id = boundedString(record?.id, 256);
    const slug = boundedString(record?.slug, 256);
    const name = boundedString(record?.name, 512);
    if (!record || !id || !slug || !name) {
      return [];
    }
    const mapping = asRecord(record.signal_mapping);
    return [{
      id,
      slug,
      name,
      ...(boundedString(record.description, 2_000) ? { description: boundedString(record.description, 2_000) as string } : {}),
      endpoints: endpoints(record.endpoints),
      input_schema: jsonSchema(record.input_schema),
      output_schema: jsonSchema(record.output_schema),
      signal_mapping: mapping ? {
        ...(boundedString(mapping.confidence_field, 512) ? { confidence_field: boundedString(mapping.confidence_field, 512) as string } : {}),
        ...(boundedString(mapping.label_field, 512) ? { label_field: boundedString(mapping.label_field, 512) as string } : {}),
        ...(boundedString(mapping.reason_field, 512) ? { reason_field: boundedString(mapping.reason_field, 512) as string } : {}),
      } : null,
      supported_intents: strings(record.supported_intents),
      activation_status: typeof record.activation_status === "string" ? record.activation_status : "unknown",
      ...(typeof record.min_price_usdc === "number" ? { min_price_usdc: record.min_price_usdc } : {}),
      scores: scores(record.scores),
    }];
  });
}

function textFieldFor(schema: TelegraphJsonSchema | null): string | null {
  if (!schema?.properties) return null;
  return TEXT_INPUT_FIELDS.find((field) => {
    const property = schema.properties?.[field];
    return property !== undefined && (property.type === "string" || property.type === undefined);
  }) ?? null;
}

function isSafeEndpointPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#")) {
    return false;
  }
  try {
    return !decodeURIComponent(path).split("/").some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}

export interface DirectRequestPlan {
  method: "GET" | "POST";
  endpoint: string;
  payload: Record<string, unknown>;
}

/** Returns null instead of guessing when a miner does not declare a safe text input. */
export function buildDirectRequest(miner: TelegraphMiner, query: string): DirectRequestPlan | null {
  const textField = textFieldFor(miner.input_schema);
  if (!textField) return null;
  const required = new Set(miner.input_schema?.required ?? []);
  if ([...required].some((field) => field !== textField)) return null;

  const endpoint = miner.endpoints.find((candidate) => {
    const method = candidate.method.toUpperCase();
    return (method === "GET" || method === "POST") && isSafeEndpointPath(candidate.path);
  });
  if (!endpoint) return null;

  const payload: Record<string, unknown> = { [textField]: query };
  const properties = miner.input_schema?.properties ?? {};
  if (properties.include_answer?.type === "boolean") payload.include_answer = true;
  if (properties.max_results?.type === "integer") payload.max_results = 8;

  return {
    method: endpoint.method.toUpperCase() as "GET" | "POST",
    endpoint: endpoint.path,
    payload,
  };
}

export function isViableMiner(miner: TelegraphMiner, intent: TelegraphIntent): boolean {
  return miner.activation_status.toLowerCase() === "active"
    && miner.supported_intents.includes(intent)
    && buildDirectRequest(miner, "viability check") !== null;
}

function rankFor(miner: TelegraphMiner, intent: TelegraphIntent): number {
  return miner.scores?.find((score) => score.intent_id === intent)?.rank ?? Number.MAX_SAFE_INTEGER;
}

export function selectDirectMiners(
  miners: TelegraphMiner[],
  excludedMinerIds: ReadonlySet<string>,
  limit = 2,
): Array<{ miner: TelegraphMiner; intent: TelegraphIntent }> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const selected: Array<{ miner: TelegraphMiner; intent: TelegraphIntent }> = [];
  const seen = new Set(excludedMinerIds);

  for (const intent of ["FACT_CHECK", "RESEARCH_SYNTHESIS"] as const) {
    const candidates = miners
      .filter((miner) => !seen.has(miner.id) && isViableMiner(miner, intent))
      .sort((left, right) => {
        const rankDelta = rankFor(left, intent) - rankFor(right, intent);
        if (rankDelta !== 0) return rankDelta;
        const priceDelta = (left.min_price_usdc ?? Number.MAX_SAFE_INTEGER) - (right.min_price_usdc ?? Number.MAX_SAFE_INTEGER);
        return priceDelta || left.slug.localeCompare(right.slug);
      });
    const candidate = candidates[0];
    if (candidate) {
      selected.push({ miner: candidate, intent });
      seen.add(candidate.id);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_EXTERNAL_BODY_BYTES) {
    throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph response exceeded the bounded response size.", response.status);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_EXTERNAL_BODY_BYTES) {
        await reader.cancel();
        throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph response exceeded the bounded response size.", response.status);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph returned invalid JSON.", response.status);
  }
}

function parseAskResult(value: unknown, paymentResponse: string | null): TelegraphAskResult {
  const record = asRecord(value);
  const minerId = boundedString(record?.miner_id, 256);
  const minerName = boundedString(record?.miner_name, 256);
  if (!record || !minerId || !minerName || !("result" in record)) {
    throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph ask response is missing required routing fields.");
  }
  return {
    miner_id: minerId,
    miner_name: minerName,
    ...(boundedString(record.endpoint, 2_048) ? { endpoint: boundedString(record.endpoint, 2_048) as string } : {}),
    result: record.result,
    ...(typeof record.cost_usd === "number" && Number.isFinite(record.cost_usd) && record.cost_usd >= 0 ? { cost_usd: record.cost_usd } : {}),
    ...(typeof record.duration_ms === "number" ? { duration_ms: record.duration_ms } : {}),
    ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
    ...(typeof record.reasoning === "string" ? { reasoning: record.reasoning } : {}),
    ...(typeof record.intent === "string" ? { intent: record.intent } : {}),
    ...(typeof record.signal_hash === "string" ? { signal_hash: record.signal_hash } : {}),
    ...(Array.isArray(record.warnings) ? { warnings: record.warnings } : {}),
    payment_response: paymentResponse,
  };
}

function normalizeNodeUrl(value: string | undefined): string {
  const parsed = new URL(value || DEFAULT_NODE_URL);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
    throw new TelegraphClientError("NOT_CONFIGURED", "TELEGRAPH_NODE_URL must use HTTPS outside local development.");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function selectCappedBaseSepoliaPayment(
  requirements: PaymentRequirements[],
  maximumMicros: bigint,
): PaymentRequirements {
  const accepted = requirements
    .filter((requirement) => requirement.scheme.toLowerCase() === "exact")
    .filter((requirement) => requirement.network === BASE_SEPOLIA)
    .filter((requirement) => requirement.asset.toLowerCase() === BASE_SEPOLIA_USDC)
    .filter((requirement) => {
      try {
        const amount = BigInt(requirement.amount);
        return amount > 0n && amount <= maximumMicros;
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const leftAmount = BigInt(left.amount);
      const rightAmount = BigInt(right.amount);
      return leftAmount < rightAmount ? -1 : leftAmount > rightAmount ? 1 : 0;
    });
  const selected = accepted[0];
  if (!selected) {
    throw new TelegraphClientError(
      "PAYMENT_FAILED",
      "No exact Base Sepolia USDC x402 option is within the configured per-call payment cap.",
    );
  }
  return selected;
}

function paymentCapSelector(maximumMicros: bigint) {
  return (_version: number, requirements: PaymentRequirements[]): PaymentRequirements => {
    return selectCappedBaseSepoliaPayment(requirements, maximumMicros);
  };
}

export interface TelegraphHttpClientOptions {
  nodeUrl?: string;
  privateKey?: string;
  maximumPaymentMicros?: bigint;
  fetchImpl?: typeof globalThis.fetch;
}

export class TelegraphHttpClient implements TelegraphClient {
  readonly configured: boolean;
  private readonly nodeUrl: string;
  private readonly plainFetch: typeof globalThis.fetch;
  private readonly paidFetch: typeof globalThis.fetch | null;

  constructor(options: TelegraphHttpClientOptions = {}) {
    this.nodeUrl = normalizeNodeUrl(options.nodeUrl ?? process.env.TELEGRAPH_NODE_URL);
    this.plainFetch = options.fetchImpl ?? globalThis.fetch;
    const privateKey = options.privateKey ?? process.env.TELEGRAPH_EVM_PRIVATE_KEY ?? "";
    this.configured = PRIVATE_KEY_PATTERN.test(privateKey);
    if (!this.configured) {
      this.paidFetch = null;
      return;
    }

    const maximumMicros = options.maximumPaymentMicros
      ?? BigInt(process.env.TELEGRAPH_MAX_PAYMENT_USDC_MICROS || "50000");
    if (maximumMicros < 1n || maximumMicros > ABSOLUTE_PAYMENT_CAP_USDC_MICROS) {
      throw new TelegraphClientError(
        "NOT_CONFIGURED",
        "The Telegraph payment cap must be between 1 and 100000 USDC micro-units.",
      );
    }
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const client = new x402Client(paymentCapSelector(maximumMicros));
    registerExactEvmScheme(client, { signer: account, networks: [BASE_SEPOLIA] });
    this.paidFetch = wrapFetchWithPayment(this.plainFetch, client);
  }

  async discoverMiners(options: { signal?: AbortSignal } = {}): Promise<TelegraphMiner[]> {
    const urls = (["FACT_CHECK", "RESEARCH_SYNTHESIS"] as const).map((intent) =>
      `${this.nodeUrl}/api/miners?intent=${intent}&status=active&limit=100`
    );
    try {
      const values = await Promise.all(urls.map(async (url) => {
        const response = await this.plainFetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: options.signal,
        });
        if (!response.ok) {
          throw new TelegraphClientError("DISCOVERY_FAILED", `Telegraph miner discovery returned HTTP ${response.status}.`, response.status);
        }
        return parseMinerCatalog(await readBoundedJson(response));
      }));
      const byId = new Map<string, TelegraphMiner>();
      for (const miner of values.flat()) byId.set(miner.id, miner);
      return [...byId.values()];
    } catch (error) {
      if (error instanceof TelegraphClientError) throw error;
      throw new TelegraphClientError("DISCOVERY_FAILED", "Telegraph miner discovery failed safely.");
    }
  }

  async askAuto(query: string, options: { signal?: AbortSignal } = {}): Promise<TelegraphAskResult> {
    return this.ask(`${this.nodeUrl}/engine/v1/ask`, { query }, options.signal);
  }

  async askDirect(
    miner: TelegraphMiner,
    _intent: TelegraphIntent,
    query: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TelegraphAskResult> {
    const plan = buildDirectRequest(miner, query);
    if (!plan) throw new TelegraphClientError("NO_VIABLE_MINER", `Miner ${miner.slug} has no safely constructible request.`);
    const result = await this.ask(`${this.nodeUrl}/engine/v1/ask/${encodeURIComponent(miner.id)}`, {
      method: plan.method,
      endpoint: plan.endpoint,
      payload: plan.payload,
    }, options.signal);
    if (result.miner_id !== miner.id) {
      throw new TelegraphClientError(
        "INVALID_RESPONSE",
        `Telegraph direct ask returned miner ${result.miner_id} instead of requested miner ${miner.id}.`,
      );
    }
    return result;
  }

  async verifySignal(signalHash: string, options: { signal?: AbortSignal } = {}): Promise<TelegraphSignalLookup> {
    if (!SIGNAL_HASH_PATTERN.test(signalHash)) {
      throw new TelegraphClientError("SIGNAL_VERIFICATION_FAILED", "Telegraph returned a malformed signal hash.");
    }
    try {
      const response = await this.plainFetch(
        `${this.nodeUrl}/engine/v1/signal/${encodeURIComponent(signalHash)}`,
        { method: "GET", headers: { Accept: "application/json" }, cache: "no-store", signal: options.signal },
      );
      if (!response.ok) {
        throw new TelegraphClientError("SIGNAL_VERIFICATION_FAILED", `Telegraph signal lookup returned HTTP ${response.status}.`, response.status);
      }
      const value = await readBoundedJson(response);
      const record = asRecord(value);
      if (!record) throw new TelegraphClientError("SIGNAL_VERIFICATION_FAILED", "Telegraph signal lookup was not an object.");
      return record as TelegraphSignalLookup;
    } catch (error) {
      if (error instanceof TelegraphClientError) throw error;
      throw new TelegraphClientError("SIGNAL_VERIFICATION_FAILED", "Telegraph signal lookup failed safely.");
    }
  }

  private async ask(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<TelegraphAskResult> {
    if (!this.paidFetch) {
      throw new TelegraphClientError("NOT_CONFIGURED", "TELEGRAPH_EVM_PRIVATE_KEY is not configured for x402 payments.");
    }
    let response: Response;
    try {
      response = await this.paidFetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (error instanceof TelegraphClientError) throw error;
      throw new TelegraphClientError("PAYMENT_FAILED", "Telegraph x402 payment or request execution failed safely.");
    }
    const paymentResponse = response.headers.get("payment-response");
    const value = await readBoundedJson(response);
    if (!response.ok) {
      const record = asRecord(value);
      const detail = typeof record?.error === "string" ? ` ${record.error}` : "";
      const code = response.status === 402 ? "PAYMENT_FAILED" : "REQUEST_FAILED";
      throw new TelegraphClientError(code, `Telegraph ask returned HTTP ${response.status}.${detail}`.slice(0, 300), response.status);
    }
    return parseAskResult(value, paymentResponse);
  }
}

export function createTelegraphClient(): TelegraphHttpClient {
  return new TelegraphHttpClient();
}
