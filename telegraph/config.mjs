import { createHash } from "node:crypto";

import { load } from "js-yaml";

export const TELEGRAPH_MINER_ID = 717190;
export const TELEGRAPH_MINER_SLUG = "qarinah-proofpack";
export const TELEGRAPH_TEMPLATE_TOKEN = "${PROOFPACK_PUBLIC_URL}";
export const TELEGRAPH_INTENTS = Object.freeze([
  "FACT_CHECK",
  "RESEARCH_SYNTHESIS",
]);

const REQUIRED_TOP_LEVEL = Object.freeze([
  "version",
  "kind",
  "id",
  "slug",
  "name",
  "base_url",
]);

const TOP_LEVEL_FIELDS = new Set([
  ...REQUIRED_TOP_LEVEL,
  "protocol",
  "description",
  "docs",
  "auth",
  "endpoints",
  "input_schema",
  "output_schema",
  "polling",
  "limitations",
  "errors",
  "semantics",
  "on_chain",
  "cache_ttl_sec",
  "rate_limit_per_sec",
  "circuit_threshold",
  "circuit_cooldown_seconds",
]);

const ENDPOINT_FIELDS = new Set([
  "path",
  "external_path",
  "method",
  "description",
  "intents",
  "params",
  "endpoint_base_url",
  "content_type",
  "multipart_fields",
  "param_map",
]);

const SIGNAL_FIELDS = new Set([
  "confidence_field",
  "label_field",
  "reason_field",
]);

const DOC_FIELDS = new Set([
  "website",
  "documentation",
  "repository",
  "twitter",
  "discord",
]);

const AUTH_FIELDS = new Set([
  "type",
  "env_var",
  "header_name",
  "value_prefix",
  "inject",
]);

const PARAM_LOCATIONS = new Set(["body", "query", "path", "header", "multipart"]);
const PARAM_GROUP_FIELDS = new Set(["required", "optional"]);
const PARAM_FIELDS = new Set([
  "name",
  "type",
  "intents",
  "description",
  "example",
  "default",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new TypeError(message);
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail(`${path} must be an object.`);
  return value;
}

function assertClosedSet(value, allowed, path) {
  const record = assertRecord(value, path);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}: unsupported field ${key}.`);
  }
  return record;
}

function assertNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path} must be a non-empty string.`);
  }
  return value;
}

function assertStringArray(value, path) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${path} must be an array of strings.`);
  }
  return value;
}

function assertExactStrings(value, expected, path) {
  const actual = assertStringArray(value, path);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    fail(`${path} must equal ${JSON.stringify(expected)}.`);
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets.every((octet) => octet === 0);
}

/** Validate and normalize the deployed, public HTTPS origin used in the YAML. */
export function validatePublicBaseUrl(value) {
  const raw = assertNonEmptyString(value, "PROOFPACK_PUBLIC_URL").trim();
  if (raw.includes(TELEGRAPH_TEMPLATE_TOKEN) || raw.includes("${")) {
    fail("PROOFPACK_PUBLIC_URL must be a deployed URL, not a substitution token.");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("PROOFPACK_PUBLIC_URL must be an absolute URL.");
  }

  if (url.protocol !== "https:") fail("PROOFPACK_PUBLIC_URL must use HTTPS.");
  if (url.username || url.password) fail("PROOFPACK_PUBLIC_URL must not contain credentials.");
  if (url.pathname !== "/" || url.search || url.hash) {
    fail("PROOFPACK_PUBLIC_URL must be an origin without a path, query, or fragment.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const reserved = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".example")
    || hostname.endsWith(".invalid")
    || hostname.endsWith(".test")
    || hostname === "example.com"
    || hostname === "example.org"
    || hostname === "example.net"
    || hostname === "::1"
    || hostname === "0:0:0:0:0:0:0:1"
    || isPrivateIpv4(hostname);
  if (reserved || !hostname.includes(".")) {
    fail("PROOFPACK_PUBLIC_URL must name a public host.");
  }

  return url.origin;
}

/** Replace the one deliberate token while refusing every unresolved token. */
export function renderMinerYaml(template, publicUrl) {
  assertNonEmptyString(template, "Telegraph YAML template");
  const occurrences = template.split(TELEGRAPH_TEMPLATE_TOKEN).length - 1;
  if (occurrences !== 1) {
    fail(`Telegraph YAML must contain ${TELEGRAPH_TEMPLATE_TOKEN} exactly once.`);
  }
  const rendered = template.replace(TELEGRAPH_TEMPLATE_TOKEN, validatePublicBaseUrl(publicUrl));
  if (/\$\{[^}]+\}/u.test(rendered)) fail("Rendered Telegraph YAML contains an unresolved token.");
  return rendered;
}

export function parseMinerYaml(yamlText) {
  assertNonEmptyString(yamlText, "Telegraph YAML");
  let parsed;
  try {
    parsed = load(yamlText, { json: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Telegraph YAML is not parseable: ${detail}`);
  }
  return assertRecord(parsed, "Telegraph YAML root");
}

function validateEndpointParams(params, path) {
  const locations = assertClosedSet(params, PARAM_LOCATIONS, path);
  for (const [location, groupsValue] of Object.entries(locations)) {
    const groups = assertClosedSet(groupsValue, PARAM_GROUP_FIELDS, `${path}.${location}`);
    for (const [requirement, definitions] of Object.entries(groups)) {
      if (!Array.isArray(definitions)) fail(`${path}.${location}.${requirement} must be an array.`);
      definitions.forEach((definition, index) => {
        const definitionPath = `${path}.${location}.${requirement}.${index}`;
        const parameter = assertClosedSet(definition, PARAM_FIELDS, definitionPath);
        assertNonEmptyString(parameter.name, `${definitionPath}.name`);
        assertNonEmptyString(parameter.type, `${definitionPath}.type`);
        assertStringArray(parameter.intents, `${definitionPath}.intents`);
        if (parameter.description !== undefined) {
          assertNonEmptyString(parameter.description, `${definitionPath}.description`);
        }
      });
    }
  }
}

function schemaNodeAtPath(outputSchema, sourcePath) {
  let node = outputSchema;
  for (const segment of sourcePath.split(".")) {
    if (!isRecord(node.properties) || !isRecord(node.properties[segment])) return null;
    node = node.properties[segment];
  }
  return node;
}

function validateOnChainFields(onChain, outputSchema) {
  const fields = assertRecord(onChain.fields, "on_chain.fields");
  const allowedGroups = new Set(["strings", "integers", "bools"]);
  assertClosedSet(fields, allowedGroups, "on_chain.fields");

  const expectedTypes = {
    strings: new Set(["string"]),
    integers: new Set(["integer", "number"]),
    bools: new Set(["boolean"]),
  };
  const fieldKeys = new Set([
    "index",
    "name",
    "description",
    "source_path",
    "multiplier",
    "transform_rule",
  ]);

  for (const [group, definitions] of Object.entries(fields)) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
      fail(`on_chain.fields.${group} must be a non-empty array.`);
    }
    const indexes = new Set();
    definitions.forEach((definition, position) => {
      const path = `on_chain.fields.${group}.${position}`;
      const field = assertClosedSet(definition, fieldKeys, path);
      if (!Number.isInteger(field.index) || field.index < 0) fail(`${path}.index must be a non-negative integer.`);
      if (indexes.has(field.index)) fail(`${path}.index is duplicated.`);
      indexes.add(field.index);
      if (field.index !== position) fail(`${path}.index must be contiguous and equal ${position}.`);
      assertNonEmptyString(field.name, `${path}.name`);
      const sourcePath = assertNonEmptyString(field.source_path, `${path}.source_path`);
      const schemaNode = schemaNodeAtPath(outputSchema, sourcePath);
      if (!schemaNode) fail(`${path}.source_path does not exist in output_schema.`);
      if (!expectedTypes[group].has(schemaNode.type)) {
        fail(`${path}.source_path has incompatible output_schema type ${String(schemaNode.type)}.`);
      }
      if (group === "integers" && field.multiplier !== undefined) {
        if (!Number.isFinite(field.multiplier) || field.multiplier <= 0) {
          fail(`${path}.multiplier must be a positive number.`);
        }
      }
    });
  }
}

/** Enforce both the Telegraph closed sets and ProofPack's intended wire contract. */
export function validateMinerConfig(value) {
  const config = assertClosedSet(value, TOP_LEVEL_FIELDS, "root");
  for (const required of REQUIRED_TOP_LEVEL) {
    if (!(required in config)) fail(`root.${required} is required.`);
  }

  if (config.version !== "1") fail('root.version must be "1".');
  if (config.kind !== "miner") fail('root.kind must be "miner".');
  if (config.protocol !== "generic") fail('root.protocol must be "generic".');
  if (config.id !== TELEGRAPH_MINER_ID) fail(`root.id must be ${TELEGRAPH_MINER_ID}.`);
  if (config.slug !== TELEGRAPH_MINER_SLUG) fail(`root.slug must be ${TELEGRAPH_MINER_SLUG}.`);
  validatePublicBaseUrl(config.base_url);

  const docs = assertClosedSet(config.docs, DOC_FIELDS, "docs");
  if (docs.repository !== "https://github.com/AjnasNB/qarinah-proofpack") {
    fail("docs.repository must point to the public Qarinah ProofPack repository.");
  }

  const auth = assertClosedSet(config.auth, AUTH_FIELDS, "auth");
  if (auth.type !== "none" || Object.keys(auth).length !== 1) {
    fail('auth must contain only type: "none".');
  }

  if (!Array.isArray(config.endpoints) || config.endpoints.length !== 1) {
    fail("endpoints must contain exactly one endpoint.");
  }
  const endpoint = assertClosedSet(config.endpoints[0], ENDPOINT_FIELDS, "endpoints.0");
  if (endpoint.path !== "/v1/proof" || endpoint.external_path !== "/v1/proof") {
    fail("endpoints.0 must expose and forward /v1/proof.");
  }
  if (endpoint.method !== "POST") fail("endpoints.0.method must be POST.");
  if (endpoint.content_type !== "application/json") {
    fail("endpoints.0.content_type must be application/json.");
  }
  assertNonEmptyString(endpoint.description, "endpoints.0.description");
  assertExactStrings(endpoint.intents, TELEGRAPH_INTENTS, "endpoints.0.intents");
  validateEndpointParams(endpoint.params, "endpoints.0.params");
  const queryParam = endpoint.params?.body?.required?.find((item) => item?.name === "query");
  if (!queryParam || queryParam.type !== "string") {
    fail("endpoints.0.params must declare required string body parameter query.");
  }
  const intentParam = endpoint.params?.body?.optional?.find((item) => item?.name === "intent");
  if (intentParam?.type !== "string"
    || intentParam.intents?.length !== 1
    || intentParam.intents[0] !== "*") {
    fail("endpoints.0.params must declare an optional string intent body parameter.");
  }

  const inputSchema = assertRecord(config.input_schema, "input_schema");
  if (inputSchema.type !== "object" || inputSchema.additionalProperties !== false) {
    fail("input_schema must be a closed object schema.");
  }
  assertExactStrings(inputSchema.required, ["query"], "input_schema.required");
  if (inputSchema.properties?.query?.type !== "string"
    || inputSchema.properties.query.minLength !== 3
    || inputSchema.properties.query.maxLength !== 2048) {
    fail("input_schema.properties.query must be a string from 3 through 2048 characters.");
  }

  const outputSchema = assertRecord(config.output_schema, "output_schema");
  if (outputSchema.type !== "object" || outputSchema.additionalProperties !== false) {
    fail("output_schema must be a closed object schema.");
  }
  for (const required of [
    "verdict",
    "confidence",
    "answer",
    "coverage_score",
    "freshness_score",
    "conflict_score",
    "evidence",
    "contradictions",
    "qarinah",
    "abstained",
    "reason",
    "verification",
  ]) {
    if (!outputSchema.required?.includes(required) || !isRecord(outputSchema.properties?.[required])) {
      fail(`output_schema must require and describe ${required}.`);
    }
  }

  const semantics = assertClosedSet(
    config.semantics,
    new Set(["signal_mapping", "supported_intents"]),
    "semantics",
  );
  const mapping = assertClosedSet(semantics.signal_mapping, SIGNAL_FIELDS, "semantics.signal_mapping");
  if (Object.keys(mapping).length !== SIGNAL_FIELDS.size
    || mapping.confidence_field !== "confidence"
    || mapping.label_field !== "verdict"
    || mapping.reason_field !== "reason") {
    fail("semantics.signal_mapping must map confidence, verdict, and reason exactly.");
  }
  assertExactStrings(semantics.supported_intents, TELEGRAPH_INTENTS, "semantics.supported_intents");

  const onChain = assertClosedSet(
    config.on_chain,
    new Set(["description", "transform", "min_price_usdc", "prompt_template", "fields", "request"]),
    "on_chain",
  );
  if (onChain.transform !== "direct") fail("on_chain.transform must be direct.");
  if (onChain.min_price_usdc !== 0.01) fail("on_chain.min_price_usdc must be 0.01.");
  validateOnChainFields(onChain, outputSchema);
  if (!Array.isArray(onChain.request) || onChain.request.length !== 1) {
    fail("on_chain.request must contain exactly one request mapping.");
  }
  const request = assertClosedSet(
    onChain.request[0],
    new Set(["endpoint", "method", "query_params", "body", "content_type"]),
    "on_chain.request.0",
  );
  if (request.endpoint !== "proof" || request.method !== "POST") {
    fail("on_chain.request.0 must target proof with POST.");
  }
  if (request.body?.query?.source !== "strings.0"
    || request.body?.intent?.source !== "strings.1"
    || request.body?.intent?.optional !== true
    || Object.keys(request.body).length !== 2) {
    fail("on_chain.request.0.body must map query from strings.0 and optional intent from strings.1.");
  }

  return config;
}

export function sha256Yaml(yamlText) {
  assertNonEmptyString(yamlText, "Rendered Telegraph YAML");
  const digest = createHash("sha256").update(yamlText, "utf8").digest("hex");
  return Object.freeze({
    digest,
    prefixed: `0x${digest}`,
    contentHash: `sha256:${digest}`,
  });
}

/** Verify canonical intents against /engine/v1/intents. */
export function validateLiveIntents(response, expected = TELEGRAPH_INTENTS) {
  const intents = Array.isArray(response) ? response : response?.intents;
  if (!Array.isArray(intents)) fail("Telegraph intents response is malformed.");
  const canonical = new Map(
    intents
      .filter((item) => item?.canonical !== false)
      .map((item) => [String(item.intent_id ?? item.intent_name ?? ""), item]),
  );
  for (const intent of expected) {
    if (!canonical.has(intent)) fail(`Telegraph does not currently list ${intent} as canonical.`);
  }
  return Object.fromEntries(expected.map((intent) => [intent, Number(canonical.get(intent)?.miner_count ?? 0)]));
}

/** Detect live ID/slug collisions while allowing the already-registered same Miner. */
export function validateRegistryAvailability(response, config) {
  const miners = Array.isArray(response) ? response : response?.miners;
  if (!Array.isArray(miners)) fail("Telegraph miner registry response is malformed.");
  const id = String(config.id);
  const idMatch = miners.find((miner) => String(miner?.id) === id);
  const slugMatch = miners.find((miner) => String(miner?.slug) === config.slug);

  if (idMatch && String(idMatch.slug) !== config.slug) {
    fail(`Telegraph Miner ID ${id} is already used by ${String(idMatch.slug)}.`);
  }
  if (slugMatch && String(slugMatch.id) !== id) {
    fail(`Telegraph Miner slug ${config.slug} is already registered with ID ${String(slugMatch.id)}.`);
  }

  return Object.freeze({
    available: !idMatch && !slugMatch,
    alreadyRegistered: Boolean(idMatch && slugMatch),
    minerCount: miners.length,
  });
}
