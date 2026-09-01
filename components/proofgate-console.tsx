"use client";

import {
  ArrowSquareOut,
  CheckCircle,
  DownloadSimple,
  HourglassMedium,
  Key,
  MinusCircle,
  Play,
  ShieldCheck,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { PreflightResponse } from "@/lib/proofgate/types";

const DEFAULT_POLICY = "Allow only when mapped provider confidence is at least 80%, at least two independent miners support the claim, and there is no material conflict. Otherwise escalate to human review.";

const examples = [
  {
    label: "Supported",
    action: "Publish the claim: The James Webb Space Telescope launched in 2021.",
  },
  {
    label: "Refuted",
    action: "Publish the claim: The James Webb Space Telescope launched in 2020.",
  },
  {
    label: "Current",
    action: "Publish the claim: OpenAI announced Qarinah ProofPack as an official product today.",
  },
];

function percent(value: number | null | undefined): string {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "Unavailable";
}

function money(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(3)}` : "$0.000";
}

function compactHash(value: string): string {
  return value.length > 24 ? `${value.slice(0, 13)}...${value.slice(-8)}` : value;
}

function decisionIcon(decision: PreflightResponse["decision"]) {
  if (decision === "ALLOW") return <ShieldCheck size={28} weight="fill" aria-hidden="true" />;
  if (decision === "BLOCK") return <XCircle size={28} weight="fill" aria-hidden="true" />;
  return <Warning size={28} weight="fill" aria-hidden="true" />;
}

type RuntimeMode = "checking" | "safety-mode" | "payer-locked" | "x402-ready";

interface HealthPayload {
  surfaces?: {
    preflight?: {
      runtime_mode?: RuntimeMode;
      access_required?: boolean;
      note?: string;
    };
  };
}

function ruleStatus(rule: PreflightResponse["rules"][number], result: PreflightResponse) {
  const alwaysRuns = new Set(["TELEGRAPH_CONFIGURED", "POLICY_FULLY_COMPILED"]);
  const notRun = (result.operational.paid_calls_attempted === 0 && !alwaysRuns.has(rule.id))
    || (rule.id === "MAQAM_AUTHORIZATION_BOUNDARY" && String(rule.actual).startsWith("not_"));
  return notRun ? "not-run" as const : rule.passed ? "passed" as const : "failed" as const;
}

export function ProofGateConsole() {
  const [action, setAction] = useState(examples[0].action);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [result, setResult] = useState<PreflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("checking");
  const [runtimeNote, setRuntimeNote] = useState("Checking paid-call readiness…");
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const requestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const controller = new AbortController();
    fetch("/health", { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<HealthPayload> : null)
      .then((health) => {
        const preflight = health?.surfaces?.preflight;
        setRuntimeMode(preflight?.runtime_mode ?? "safety-mode");
        setAccessRequired(preflight?.access_required === true);
        setRuntimeNote(preflight?.note ?? "Safety mode is active; paid calls are unavailable.");
      })
      .catch((caught: unknown) => {
        if ((caught as { name?: string })?.name !== "AbortError") {
          setRuntimeMode("safety-mode");
          setRuntimeNote("Readiness could not be confirmed, so ProofGate will fail closed.");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || action.trim().length < 8 || policy.trim().length < 8) return;
    setElapsed(0);
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const fingerprint = JSON.stringify([action.trim(), policy.trim()]);
      const requestId = requestRef.current?.fingerprint === fingerprint
        ? requestRef.current.id
        : crypto.randomUUID();
      requestRef.current = { fingerprint, id: requestId };
      const response = await fetch("/api/preflight", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
          ...(accessRequired && accessKey ? { "X-ProofGate-Key": accessKey } : {}),
        },
        body: JSON.stringify({ action: action.trim(), policy: policy.trim(), request_id: requestId }),
      });
      const payload = await response.json() as PreflightResponse | { error?: string | { message?: string } };
      if (!response.ok && !("schema_version" in payload)) {
        const candidate = "error" in payload ? payload.error : undefined;
        const message = typeof candidate === "string" ? candidate : candidate?.message;
        throw new Error(message || `Preflight failed with status ${response.status}.`);
      }
      setResult(payload as PreflightResponse);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The preflight could not be completed.");
    } finally {
      setLoading(false);
    }
  }

  function downloadReceipt() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${result.action_id}.proofgate.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <section className="pg-console" aria-label="ProofGate preflight">
      <div className="pg-console-bar">
        <span className={`pg-runtime pg-runtime-${runtimeMode}`}>
          {runtimeMode === "x402-ready" ? "GUARDED X402 READY" : runtimeMode === "payer-locked" ? "PAYER LOCKED" : runtimeMode === "checking" ? "CHECKING RUNTIME" : "SAFETY MODE"}
        </span>
        <code>POST /api/preflight</code>
      </div>
      <p className="pg-runtime-note">{runtimeNote}</p>

      <form className="pg-form" onSubmit={submit}>
        <div className="pg-field">
          <label htmlFor="agent-action">Proposed agent action</label>
          <p id="agent-action-help">Describe the external action and the factual claim that would justify it.</p>
          <textarea
            id="agent-action"
            aria-describedby="agent-action-help"
            value={action}
            onChange={(event) => setAction(event.target.value)}
            minLength={8}
            maxLength={4096}
            rows={3}
            required
          />
        </div>

        <div className="pg-examples" aria-label="Example actions">
          <span>Load example</span>
          {examples.map((example) => (
            <button key={example.label} type="button" onClick={() => setAction(example.action)}>
              {example.label}
            </button>
          ))}
        </div>

        <div className="pg-field">
          <label htmlFor="action-policy">Action policy</label>
          <p id="action-policy-help">Use confidence, independent Miner, conflict, and fallback rules.</p>
          <textarea
            id="action-policy"
            aria-describedby="action-policy-help"
            value={policy}
            onChange={(event) => setPolicy(event.target.value)}
            minLength={8}
            maxLength={4096}
            rows={3}
            required
          />
        </div>

        {accessRequired && (
          <div className="pg-access">
            <label htmlFor="proofgate-access"><Key size={15} aria-hidden="true" /> Tester access key</label>
            <input
              id="proofgate-access"
              type="password"
              autoComplete="off"
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              placeholder="pg_test_…"
              required
            />
            <p>Paid preflights are limited to approved testers and protected by a durable global budget.</p>
          </div>
        )}

        <div className="pg-submit-row">
          <button className="pg-run" type="submit" disabled={loading || action.trim().length < 8 || policy.trim().length < 8 || (accessRequired && accessKey.length < 16)}>
            {loading ? <HourglassMedium className="spin" size={20} aria-hidden="true" /> : <Play size={19} weight="fill" aria-hidden="true" />}
            {loading ? "Running preflight" : runtimeMode === "x402-ready" ? "Verify with Telegraph" : "Preview fail-closed behavior"}
          </button>
          <p>{runtimeMode === "x402-ready" ? "Up to 3 paid testnet calls; every request is budget-reserved and idempotent." : "No paid call can run in safety mode. The result must escalate without inventing evidence."}</p>
        </div>
      </form>

      <div className="pg-output" aria-live="polite">
        {!loading && !error && !result && (
          <div className="pg-empty">
            <ShieldCheck size={32} weight="duotone" aria-hidden="true" />
            <div>
              <strong>Authorization is not assumed</strong>
              <span>Run a preflight to collect real Telegraph signal receipts.</span>
            </div>
          </div>
        )}

        {loading && (
          <div className="pg-loading">
            <div className="pg-loading-head">
              <strong>Telegraph request in progress</strong>
              <code>{elapsed}s</code>
            </div>
            <div className="pg-skeleton" aria-hidden="true">
              <motion.i
                initial={reduceMotion ? false : { x: "-100%" }}
                animate={reduceMotion ? undefined : { x: "260%" }}
                transition={{ repeat: Infinity, duration: 1.8, ease: "linear" }}
              />
            </div>
            <p>Waiting for live routing, x402 settlement, Telegraph node attestation binding, ProofGate policy checks, Qarinah sealing, and the final Maqam authorization boundary.</p>
          </div>
        )}

        {error && (
          <div className="pg-error" role="alert">
            <Warning size={25} weight="fill" aria-hidden="true" />
            <div>
              <strong>Preflight stopped</strong>
              <span>{error}</span>
            </div>
          </div>
        )}

        <AnimatePresence mode="wait">
          {result && (
            <motion.div
              className={`pg-result pg-result-${result.decision.toLowerCase()}`}
              key={result.action_id}
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.28 }}
            >
              <div className="pg-decision">
                <div>
                  {decisionIcon(result.decision)}
                  <span>{result.authorization_issued ? "Preflight authorization issued" : result.decision === "BLOCK" ? "Authorization withheld" : "Human review required"}</span>
                </div>
                <strong>{result.decision}</strong>
              </div>

              <p className="pg-reason">{result.reason}</p>

              {result.reason_codes.length > 0 && result.decision !== "ALLOW" && (
                <div className="pg-blockers" aria-label="Blocking reasons">
                  <span>Blocking reasons</span>
                  <div>{result.reason_codes.slice(0, 4).map((code) => <code key={code}>{code}</code>)}</div>
                </div>
              )}

              <p className="pg-generated">Receipt generated {new Date(result.generated_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC</p>

              <div className="pg-metrics">
                <div><span>Mapped confidence mean</span><strong>{percent(result.aggregate.confidence)}</strong></div>
                <div><span>Telegraph-attested signals</span><strong>{result.aggregate.verified_signals}</strong></div>
                <div><span>Distinct miners</span><strong>{result.aggregate.distinct_miners}</strong></div>
                <div><span>Conflict score</span><strong>{percent(result.aggregate.conflict_score)}</strong></div>
                <div><span>Testnet cost</span><strong>{money(result.aggregate.total_cost_usd)}</strong></div>
              </div>

              <details className="pg-rule-audit">
                <summary>Deterministic policy audit <span>{result.rules.filter((rule) => ruleStatus(rule, result) === "failed").length} failed</span></summary>
                <div className="pg-rule-list" aria-label="ProofGate policy results">
                  {result.rules.map((rule) => {
                    const status = ruleStatus(rule, result);
                    return (
                      <div key={rule.id} className={status}>
                        {status === "passed" ? <CheckCircle size={18} weight="fill" aria-hidden="true" /> : status === "failed" ? <XCircle size={18} weight="fill" aria-hidden="true" /> : <MinusCircle size={18} weight="fill" aria-hidden="true" />}
                        <span>{rule.label}</span>
                        <code>{status === "not-run" ? "NOT RUN" : `${String(rule.actual)} / ${String(rule.required)}`}</code>
                      </div>
                    );
                  })}
                </div>
              </details>

              <details className="pg-signals" open>
                <summary>Telegraph signal attestations <span>{result.signals.length}</span></summary>
                <div>
                  {result.signals.map((signal) => (
                    <article key={`${signal.miner_id}-${signal.signal_hash}`}>
                      <header>
                        <div>
                          <strong>{signal.miner_name}</strong>
                          <code>Miner {signal.miner_id}</code>
                        </div>
                        <span>{signal.intent}</span>
                      </header>
                      <p>{signal.reason || "The provider did not publish a mapped reason."}</p>
                      <dl>
                        <div><dt>Stance</dt><dd>{signal.stance}</dd></div>
                        <div><dt>Provider confidence</dt><dd>{percent(signal.confidence)}</dd></div>
                        <div><dt>Route</dt><dd>{signal.route_mode}</dd></div>
                        <div><dt>Cost</dt><dd>{money(signal.cost_usd)}</dd></div>
                        <div><dt>Attestation</dt><dd>{signal.signal_verification.status}</dd></div>
                        <div><dt>Timestamp</dt><dd>{signal.timestamp ? new Date(signal.timestamp).toISOString().slice(0, 19) : "Unavailable"}</dd></div>
                      </dl>
                      <div className="pg-hash-line">
                        <code title={signal.signal_hash}>{compactHash(signal.signal_hash)}</code>
                        <a href={`https://devnode.telegraphprotocol.com/engine/v1/signal/${encodeURIComponent(signal.signal_hash)}`} target="_blank" rel="noreferrer">
                          Inspect <ArrowSquareOut size={14} aria-hidden="true" />
                        </a>
                      </div>
                      {signal.payment_settlement && (
                        <a className="pg-settlement" href={`https://sepolia.basescan.org/tx/${encodeURIComponent(signal.payment_settlement.transaction)}`} target="_blank" rel="noreferrer">
                          View x402 settlement <ArrowSquareOut size={13} aria-hidden="true" />
                        </a>
                      )}
                    </article>
                  ))}
                </div>
              </details>

              <div className="pg-receipt">
                <div>
                  <span>QARINAH INTEGRITY ROOT · UNSIGNED</span>
                  <code title={result.receipt.root_hash}>{compactHash(result.receipt.root_hash)}</code>
                </div>
                <button type="button" onClick={downloadReceipt}>
                  <DownloadSimple size={18} aria-hidden="true" />
                  Download receipt
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
