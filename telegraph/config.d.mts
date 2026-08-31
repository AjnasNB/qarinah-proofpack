export const TELEGRAPH_MINER_ID: 717190;
export const TELEGRAPH_MINER_SLUG: "qarinah-proofpack";
export const TELEGRAPH_TEMPLATE_TOKEN: "${PROOFPACK_PUBLIC_URL}";
export const TELEGRAPH_INTENTS: readonly ["FACT_CHECK", "RESEARCH_SYNTHESIS"];

export interface TelegraphMinerConfig extends Record<string, unknown> {
  version: "1";
  kind: "miner";
  id: number;
  slug: string;
  base_url: string;
  endpoints: Array<Record<string, unknown>>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  semantics: Record<string, unknown>;
  on_chain: Record<string, unknown>;
}

export function validatePublicBaseUrl(value: unknown): string;
export function renderMinerYaml(template: unknown, publicUrl: unknown): string;
export function parseMinerYaml(yamlText: unknown): Record<string, unknown>;
export function validateMinerConfig(value: unknown): TelegraphMinerConfig;
export function sha256Yaml(yamlText: unknown): Readonly<{
  digest: string;
  prefixed: `0x${string}`;
  contentHash: `sha256:${string}`;
}>;
export function validateLiveIntents(
  response: unknown,
  expected?: readonly string[],
): Record<string, number>;
export function validateRegistryAvailability(
  response: unknown,
  config: Pick<TelegraphMinerConfig, "id" | "slug">,
): Readonly<{
  available: boolean;
  alreadyRegistered: boolean;
  minerCount: number;
}>;
