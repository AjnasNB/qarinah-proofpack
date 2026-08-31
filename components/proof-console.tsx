"use client";

import {
  ArrowSquareOut,
  Check,
  Clipboard,
  DownloadSimple,
  Flask,
  HourglassMedium,
  MagnifyingGlass,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { FormEvent } from "react";
import type { ProofIntent, ProofPack } from "@/lib/proof/types";

const examples = [
  { label: "Supported", query: "Did the James Webb Space Telescope launch in 2021?" },
  { label: "Refuted", query: "Did the James Webb Space Telescope launch in 2020?" },
  { label: "Abstain", query: "Did OpenAI announce Qarinah ProofPack as an official product on August 31, 2026?" },
];

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function shortHash(value: string) {
  if (value.length < 25) return value;
  return `${value.slice(0, 15)}…${value.slice(-8)}`;
}

export function ProofConsole() {
  const [query, setQuery] = useState(examples[0].query);
  const [intent, setIntent] = useState<ProofIntent>("FACT_CHECK");
  const [pack, setPack] = useState<ProofPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const reduceMotion = useReducedMotion();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setPack(null);

    try {
      const response = await fetch("/v1/proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), intent }),
      });
      const payload = await response.json() as ProofPack | { error?: { message?: string } | string };
      if (!response.ok) {
        const candidate = "error" in payload ? payload.error : undefined;
        const message = typeof candidate === "string" ? candidate : candidate?.message;
        throw new Error(message || `Proof request failed with status ${response.status}.`);
      }
      setPack(payload as ProofPack);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The proof request could not be completed.");
    } finally {
      setLoading(false);
    }
  }

  async function copyHash() {
    if (!pack) return;
    await navigator.clipboard.writeText(pack.verification.manifest_hash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadPack() {
    if (!pack) return;
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${pack.pack_id}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="proof-console">
      <div className="console-topbar">
        <div className="console-dots" aria-hidden="true"><i /><i /><i /></div>
        <span>POST /v1/proof</span>
        <span className="console-live"><i aria-hidden="true" /> LIVE</span>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="proof-query">Claim or research question</label>
        <textarea
          id="proof-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          minLength={3}
          maxLength={8192}
          rows={4}
          required
          spellCheck="true"
        />
        <div className="example-row" aria-label="Example claims">
          <span>Examples:</span>
          {examples.map((example) => (
            <button key={example.label} type="button" onClick={() => setQuery(example.query)} title={example.query}>
              {example.label}
            </button>
          ))}
        </div>
        <div className="console-controls">
          <div className="intent-toggle" aria-label="Proof intent">
            {(["FACT_CHECK", "RESEARCH_SYNTHESIS"] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={intent === value ? "active" : undefined}
                aria-pressed={intent === value}
                onClick={() => setIntent(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <button className="run-button" type="submit" disabled={loading || query.trim().length < 3}>
            {loading ? <HourglassMedium size={19} className="spin" aria-hidden="true" /> : <MagnifyingGlass size={19} weight="bold" aria-hidden="true" />}
            {loading ? "Building proof" : "Run proof"}
          </button>
        </div>
        <p className="latency-note">Live acquisition usually takes 20 to 40 seconds.</p>
      </form>

      <div className="console-output" aria-live="polite">
        {!loading && !error && !pack && (
          <div className="console-empty">
            <Flask size={30} weight="duotone" aria-hidden="true" />
            <div><strong>Ready for evidence</strong><span>Your sealed ProofPack will appear here.</span></div>
          </div>
        )}
        {loading && (
          <div className="research-progress">
            <div className="progress-head"><span>ACQUISITION IN PROGRESS</span><span>LIVE WEB</span></div>
            <div className="progress-track"><motion.i initial={{ width: "4%" }} animate={{ width: "82%" }} transition={{ duration: reduceMotion ? 0 : 18, ease: "easeOut" }} /></div>
            <p>Searching, crawling, extracting, scoring, applying policy, and sealing provenance.</p>
          </div>
        )}
        {error && (
          <div className="console-error" role="alert">
            <WarningCircle size={25} weight="fill" aria-hidden="true" />
            <div><strong>Proof request stopped</strong><span>{error}</span></div>
          </div>
        )}
        <AnimatePresence mode="wait">
          {pack && (
            <motion.div
              className="proof-result"
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              key={pack.pack_id}
            >
              <div className={`verdict verdict-${pack.verdict.toLowerCase()}`}>
                <div>
                  {pack.abstained ? <WarningCircle size={22} weight="fill" aria-hidden="true" /> : <ShieldCheck size={22} weight="fill" aria-hidden="true" />}
                  <span>{pack.verdict}</span>
                </div>
                <strong>{percent(pack.confidence)}</strong>
              </div>
              <p className="result-answer">{pack.answer}</p>
              <div className="metric-grid">
                <div><span>Coverage</span><strong>{percent(pack.coverage_score)}</strong></div>
                <div><span>Freshness</span><strong>{percent(pack.freshness_score)}</strong></div>
                <div><span>Conflict</span><strong>{percent(pack.conflict_score)}</strong></div>
                <div><span>Sources</span><strong>{pack.policy.independent_sources}</strong></div>
              </div>
              <p className="result-reason">{pack.reason}</p>

              <details className="evidence-details" open>
                <summary>Evidence records <span>{pack.evidence.length}</span></summary>
                <div className="evidence-records">
                  {pack.evidence.slice(0, 4).map((item) => (
                    <article key={item.id}>
                      <div><code>{item.id}</code><span className={`stance stance-${item.stance.toLowerCase()}`}>{item.stance}</span></div>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.title || item.source_domain}
                        <ArrowSquareOut size={14} aria-hidden="true" />
                      </a>
                      <p>{item.excerpt}</p>
                      <code title={item.content_hash}>{shortHash(item.content_hash)}</code>
                    </article>
                  ))}
                </div>
              </details>

              <div className="seal-row">
                <div>
                  <span>MANIFEST SEAL</span>
                  <code title={pack.verification.manifest_hash}>{shortHash(pack.verification.manifest_hash)}</code>
                </div>
                <button type="button" onClick={copyHash} title="Copy manifest hash" aria-label="Copy manifest hash">
                  {copied ? <Check size={18} weight="bold" /> : <Clipboard size={18} />}
                </button>
                <button type="button" onClick={downloadPack} title="Download ProofPack JSON" aria-label="Download ProofPack JSON">
                  <DownloadSimple size={18} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
