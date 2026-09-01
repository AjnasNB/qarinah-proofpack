import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client, type PaymentRequirements } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

import { hashText } from "@/lib/proof/canonical";

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
const MAX_EXTERNAL_JSON_DEPTH = 64;
const MAX_EXTERNAL_JSON_NODES = 20_000;
const MAX_EXTERNAL_JSON_KEYS = 20_000;
const MAX_EXTERNAL_STRING_CHARS = 1_000_000;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SIGNAL_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TEXT_INPUT_FIELDS = ["query", "question", "claim", "statement", "topic", "prompt", "text"] as const;
const EMPLOYMENT_ENDPOINT_PATTERN = /(?:^|[-_/])(job|jobs|career|careers|resume|cv|hiring|recruit|tailor)(?:$|[-_/])/i;
const EMPLOYMENT_CAPABILITY_PATTERNS = [
  /\bjob search\b/i,
  /\bjob boards?\b/i,
  /\bjob applications?\b/i,
  /\bcover letters?\b/i,
  /\bapplication writing\b/i,
  /\bwho is hiring\b/i,
] as const;
const EMPLOYMENT_QUERY_PATTERNS = [
  /\b(job|jobs|career|careers|hiring|hire|recruiter|recruiting|resume|cv|salary|salaries|compensation|vacancy|vacancies|employment)\b/i,
  /\bcover letters?\b/i,
  /\bjob applications?\b/i,
  /\b(open|available) roles?\b/i,
] as const;

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

const INTENT_ENDPOINT_HINTS: Record<TelegraphIntent, readonly RegExp[]> = {
  FACT_CHECK: [
    /(?:^|[-_/])fact[-_ ]?check(?:$|[-_/])/i,
    /\b(?:fact[- ]?check|check (?:a |the )?claim|verify (?:a |the )?claim)\b/i,
    /(?:^|[-_/])(?:claim[-_ ]?check|verify[-_ ]?claim|proof)(?:$|[-_/])/i,
    /(?:^|[-_/])search(?:$|[-_/])/i,
  ],
  RESEARCH_SYNTHESIS: [
    /(?:^|[-_/])research[-_ ]?synthesis(?:$|[-_/])/i,
    /\b(?:research synthesis|source[- ]?backed synthesis|evidence synthesis)\b/i,
    /(?:^|[-_/])(?:synthesis|research|proof)(?:$|[-_/])/i,
    /(?:^|[-_/])search(?:$|[-_/])/i,
  ],
};

function endpointForIntent(
  miner: TelegraphMiner,
  intent: TelegraphIntent,
): TelegraphMinerEndpoint | null {
  const safe = miner.endpoints.filter((candidate) => {
    const method = candidate.method.toUpperCase();
    return (method === "GET" || method === "POST") && isSafeEndpointPath(candidate.path);
  });
  if (safe.length === 1) return safe[0];

  const ranked = safe
    .map((endpoint) => {
      const text = `${endpoint.path}\n${endpoint.description ?? ""}`;
      const firstMatch = INTENT_ENDPOINT_HINTS[intent].findIndex((pattern) => pattern.test(text));
      return { endpoint, score: firstMatch === -1 ? 0 : INTENT_ENDPOINT_HINTS[intent].length - firstMatch };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.endpoint.path.localeCompare(right.endpoint.path));

  const best = ranked[0];
  const runnerUp = ranked[1];
  // Multiple declared operations are not interchangeable. If their intent fit
  // is tied, fail closed instead of paying for a guessed operation.
  return best && best.score !== runnerUp?.score ? best.endpoint : null;
}

/** Returns null instead of guessing when a miner does not declare a safe text input. */
export function buildDirectRequest(
  miner: TelegraphMiner,
  intent: TelegraphIntent,
  query: string,
): DirectRequestPlan | null {
  const textField = textFieldFor(miner.input_schema);
  if (!textField) return null;
  const required = new Set(miner.input_schema?.required ?? []);
  if ([...required].some((field) => field !== textField)) return null;

  const endpoint = endpointForIntent(miner, intent);
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
    && buildDirectRequest(miner, intent, "viability check") !== null;
}

/**
 * Telegraph intents are intentionally broad. Respect a Miner's declared vertical
 * scope before paying it for corroboration rather than treating the intent label
 * alone as proof that the provider can answer the user's claim.
 */
function isRelevantMiner(miner: TelegraphMiner, query: string): boolean {
  const capabilityText = [
    miner.name,
    miner.slug,
    miner.description ?? "",
    ...miner.endpoints.flatMap((endpoint) => [endpoint.path, endpoint.description ?? ""]),
  ].join("\n");
  const employmentEndpoint = miner.endpoints.some((endpoint) => EMPLOYMENT_ENDPOINT_PATTERN.test(endpoint.path));
  const employmentMarkers = EMPLOYMENT_CAPABILITY_PATTERNS
    .filter((pattern) => pattern.test(capabilityText))
    .length;
  const employmentOnly = employmentEndpoint || employmentMarkers >= 2;
  return !employmentOnly || EMPLOYMENT_QUERY_PATTERNS.some((pattern) => pattern.test(query));
}

function mapsConfidence(miner: TelegraphMiner): boolean {
  return typeof miner.signal_mapping?.confidence_field === "string"
    && miner.signal_mapping.confidence_field.length > 0;
}

function rankFor(miner: TelegraphMiner, intent: TelegraphIntent): number {
  return miner.scores?.find((score) => score.intent_id === intent)?.rank ?? Number.MAX_SAFE_INTEGER;
}

export function selectDirectMiners(
  miners: TelegraphMiner[],
  excludedMinerIds: ReadonlySet<string>,
  query: string,
  limit = 2,
): Array<{ miner: TelegraphMiner; intent: TelegraphIntent }> {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const selected: Array<{ miner: TelegraphMiner; intent: TelegraphIntent }> = [];
  const seen = new Set(excludedMinerIds);

  for (const intent of ["FACT_CHECK", "RESEARCH_SYNTHESIS"] as const) {
    const candidates = miners
      .filter((miner) => !seen.has(miner.id) && isViableMiner(miner, intent) && isRelevantMiner(miner, query))
      .sort((left, right) => {
        const confidenceMappingDelta = Number(mapsConfidence(right)) - Number(mapsConfidence(left));
        if (confidenceMappingDelta !== 0) return confidenceMappingDelta;
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
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertExternalJsonComplexity(parsed);
    return parsed;
  } catch {
    throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph returned invalid JSON.", response.status);
  }
}

function assertExternalJsonComplexity(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let keys = 0;
  let stringChars = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_EXTERNAL_JSON_NODES || current.depth > MAX_EXTERNAL_JSON_DEPTH) {
      throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph JSON exceeded structural complexity limits.");
    }
    if (typeof current.value === "string") {
      stringChars += current.value.length;
      if (stringChars > MAX_EXTERNAL_STRING_CHARS) {
        throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph JSON exceeded string complexity limits.");
      }
    } else if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else {
      const record = asRecord(current.value);
      if (!record) continue;
      const entries = Object.entries(record);
      keys += entries.length;
      if (keys > MAX_EXTERNAL_JSON_KEYS) {
        throw new TelegraphClientError("INVALID_RESPONSE", "Telegraph JSON exceeded key complexity limits.");
      }
      for (const [key, child] of entries) {
        stringChars += key.length;
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

type PaymentSettlement = NonNullable<TelegraphAskResult["payment_settlement"]>;

export function validatePaymentSettlement(
  paymentResponse: string,
  expectedPayer: string,
  maximumMicros: bigint,
  expectedMicros?: bigint,
): PaymentSettlement {
  let decoded: unknown;
  try {
    decoded = decodePaymentResponseHeader(paymentResponse);
  } catch {
    throw new TelegraphClientError("PAYMENT_FAILED", "Telegraph returned a malformed x402 settlement header.");
  }
  const record = asRecord(decoded);
  const payer = boundedString(record?.payer, 64);
  const transaction = boundedString(record?.transaction, 128);
  if (!record
    || record.success !== true
    || record.network !== BASE_SEPOLIA
    || !payer
    || !ADDRESS_PATTERN.test(payer)
    || payer.toLowerCase() !== expectedPayer.toLowerCase()
    || !transaction
    || !TRANSACTION_HASH_PATTERN.test(transaction)) {
    throw new TelegraphClientError("PAYMENT_FAILED", "Telegraph did not return a valid successful Base Sepolia x402 settlement.");
  }
  let settledAmount: bigint | null = null;
  if (record.amount !== undefined) {
    try {
      const amount = BigInt(String(record.amount));
      if (amount < 1n || amount > maximumMicros || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("out of range");
      settledAmount = amount;
    } catch {
      throw new TelegraphClientError("PAYMENT_FAILED", "Telegraph returned an invalid x402 settlement amount.");
    }
  }
  if (expectedMicros !== undefined && settledAmount !== null && settledAmount !== expectedMicros) {
    throw new TelegraphClientError("PAYMENT_FAILED", "Telegraph settlement amount did not match the accepted x402 challenge.");
  }
  const authoritativeAmount = settledAmount ?? expectedMicros ?? null;
  return {
    network: BASE_SEPOLIA,
    transaction: transaction.toLowerCase() as `0x${string}`,
    payer_hash: hashText(payer.toLowerCase()),
    amount_micros: authoritativeAmount === null ? null : Number(authoritativeAmount),
  };
}

function parseAskResult(
  value: unknown,
  paymentResponse: string,
  paymentSettlement: PaymentSettlement,
): TelegraphAskResult {
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
    payment_settlement: paymentSettlement,
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
  const officialOrigin = new URL(DEFAULT_NODE_URL).origin;
  if (process.env.NODE_ENV === "production"
    && parsed.origin !== officialOrigin
    && process.env.TELEGRAPH_ALLOW_CUSTOM_NODE !== "true") {
    throw new TelegraphClientError("NOT_CONFIGURED", "Production Telegraph calls are pinned to the official node origin.");
  }
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
  private readonly payerAddress: string | null;
  private readonly maximumPaymentMicros: bigint;
  private pendingPaymentMicros: bigint | null = null;

  constructor(options: TelegraphHttpClientOptions = {}) {
    this.nodeUrl = normalizeNodeUrl(options.nodeUrl ?? process.env.TELEGRAPH_NODE_URL);
    this.plainFetch = options.fetchImpl ?? globalThis.fetch;
    const privateKey = options.privateKey ?? process.env.TELEGRAPH_EVM_PRIVATE_KEY ?? "";
    this.configured = PRIVATE_KEY_PATTERN.test(privateKey);
    this.payerAddress = null;
    this.maximumPaymentMicros = 0n;
    if (!this.configured) {
      this.paidFetch = null;
      return;
    }

    const maximumMicros = options.maximumPaymentMicros
      ?? BigInt(process.env.TELEGRAPH_MAX_PAYMENT_USDC_MICROS || "50000");
    this.maximumPaymentMicros = maximumMicros;
    if (maximumMicros < 1n || maximumMicros > ABSOLUTE_PAYMENT_CAP_USDC_MICROS) {
      throw new TelegraphClientError(
        "NOT_CONFIGURED",
        "The Telegraph payment cap must be between 1 and 100000 USDC micro-units.",
      );
    }
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    this.payerAddress = account.address;
    const client = new x402Client((_version, requirements) => {
      const selected = selectCappedBaseSepoliaPayment(requirements, maximumMicros);
      this.pendingPaymentMicros = BigInt(selected.amount);
      return selected;
    });
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
    intent: TelegraphIntent,
    query: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TelegraphAskResult> {
    const plan = buildDirectRequest(miner, intent, query);
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
      this.pendingPaymentMicros = null;
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
    const paymentResponse = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
    const value = await readBoundedJson(response);
    if (!response.ok) {
      const record = asRecord(value);
      const detail = typeof record?.error === "string" ? ` ${record.error}` : "";
      const code = response.status === 402 ? "PAYMENT_FAILED" : "REQUEST_FAILED";
      throw new TelegraphClientError(code, `Telegraph ask returned HTTP ${response.status}.${detail}`.slice(0, 300), response.status);
    }
    if (!paymentResponse || !this.payerAddress || this.pendingPaymentMicros === null) {
      throw new TelegraphClientError("PAYMENT_FAILED", "Telegraph returned success without a verifiable x402 settlement header.", response.status);
    }
    return parseAskResult(
      value,
      paymentResponse,
      validatePaymentSettlement(paymentResponse, this.payerAddress, this.maximumPaymentMicros, this.pendingPaymentMicros),
    );
  }
}

export function createTelegraphClient(): TelegraphHttpClient {
  return new TelegraphHttpClient();
}
