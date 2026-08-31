"use client";

import {
  ArrowSquareOut,
  CheckCircle,
  DownloadSimple,
  HourglassMedium,
  Play,
  ShieldCheck,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
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

export function ProofGateConsole() {
  const [action, setAction] = useState(examples[0].action);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [result, setResult] = useState<PreflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const reduceMotion = useReducedMotion();

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
      const response = await fetch("/api/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action.trim(), policy: policy.trim() }),
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
    <section className="pg-console" aria-label="ProofGate live preflight">
      <div className="pg-console-bar">
        <span>LIVE PREFLIGHT</span>
        <code>POST /api/preflight</code>
      </div>

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

        <div className="pg-submit-row">
          <button className="pg-run" type="submit" disabled={loading || action.trim().length < 8 || policy.trim().length < 8}>
            {loading ? <HourglassMedium className="spin" size={20} aria-hidden="true" /> : <Play size={19} weight="fill" aria-hidden="true" />}
            {loading ? "Running live preflight" : "Verify with Telegraph"}
          </button>
          <p>Up to 3 paid testnet calls; prices come from x402. Missing compatible mappings always escalates.</p>
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
            <p>Waiting for live routing, paid Miner responses, receipt verification, ProofGate policy checks, Qarinah sealing, and the final Maqam authorization boundary.</p>
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

              <div className="pg-metrics">
                <div><span>Mapped confidence mean</span><strong>{percent(result.aggregate.confidence)}</strong></div>
                <div><span>Verified signals</span><strong>{result.aggregate.verified_signals}</strong></div>
                <div><span>Distinct miners</span><strong>{result.aggregate.distinct_miners}</strong></div>
                <div><span>Conflict score</span><strong>{percent(result.aggregate.conflict_score)}</strong></div>
                <div><span>Testnet cost</span><strong>{money(result.aggregate.total_cost_usd)}</strong></div>
              </div>

              <div className="pg-rule-list" aria-label="ProofGate policy results">
                {result.rules.map((rule) => (
                  <div key={rule.id} className={rule.passed ? "passed" : "failed"}>
                    {rule.passed ? <CheckCircle size={18} weight="fill" aria-hidden="true" /> : <XCircle size={18} weight="fill" aria-hidden="true" />}
                    <span>{rule.label}</span>
                    <code>{String(rule.actual)} / {String(rule.required)}</code>
                  </div>
                ))}
              </div>

              <details className="pg-signals" open>
                <summary>Telegraph signal receipts <span>{result.signals.length}</span></summary>
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
                      </dl>
                      <div className="pg-hash-line">
                        <code title={signal.signal_hash}>{compactHash(signal.signal_hash)}</code>
                        <a href={`https://devnode.telegraphprotocol.com/engine/v1/signal/${encodeURIComponent(signal.signal_hash)}`} target="_blank" rel="noreferrer">
                          Verify <ArrowSquareOut size={14} aria-hidden="true" />
                        </a>
                      </div>
                    </article>
                  ))}
                </div>
              </details>

              <div className="pg-receipt">
                <div>
                  <span>QARINAH RECEIPT ROOT</span>
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
