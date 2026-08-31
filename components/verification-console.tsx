"use client";

import {
  CheckCircle,
  FileArrowUp,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { ProofVerificationResult } from "@/lib/proof/types";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function VerificationConsole() {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<ProofVerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError("This file exceeds the 2 MB verifier limit.");
      return;
    }
    setValue(await file.text());
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      JSON.parse(value);
      const response = await fetch("/v1/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: value,
      });
      const payload = await response.json() as ProofVerificationResult | { error?: { message?: string } };
      if ("valid" in payload) {
        setResult(payload);
      } else {
        throw new Error(payload.error?.message || "The verifier rejected this payload.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The payload could not be verified.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="verification-console">
      <div className="verification-head">
        <span>PROOFPACK VERIFIER</span>
        <span>NETWORK: OFF</span>
      </div>
      <form onSubmit={verify}>
        <div className="verification-label">
          <label htmlFor="verification-json">ProofPack JSON</label>
          <button type="button" onClick={() => fileInput.current?.click()}>
            <FileArrowUp size={16} weight="bold" aria-hidden="true" /> Upload JSON
          </button>
          <input ref={fileInput} type="file" accept="application/json,.json" onChange={chooseFile} hidden />
        </div>
        <textarea
          id="verification-json"
          rows={15}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste the complete JSON returned by POST /v1/proof"
          spellCheck="false"
          required
        />
        <button className="verify-button" type="submit" disabled={loading || value.trim().length === 0}>
          <ShieldCheck size={19} weight="bold" aria-hidden="true" />
          {loading ? "Verifying pack" : "Verify integrity"}
        </button>
      </form>

      <div className="verification-output" aria-live="polite">
        {!result && !error && (
          <p>Generate a pack in the live console, download it, then verify the complete file here.</p>
        )}
        {error && (
          <div className="verify-error" role="alert"><WarningCircle size={22} weight="fill" /><span>{error}</span></div>
        )}
        {result && (
          <div className={result.valid ? "verify-result valid" : "verify-result invalid"}>
            <div className="verify-result-title">
              {result.valid ? <CheckCircle size={25} weight="fill" /> : <XCircle size={25} weight="fill" />}
              <div><strong>{result.valid ? "ProofPack is intact" : "Verification failed"}</strong><span>{result.valid ? "All cryptographic and contract checks passed." : `${result.errors.length} issue${result.errors.length === 1 ? "" : "s"} detected.`}</span></div>
            </div>
            <div className="verification-checks">
              {[
                ["Manifest", result.manifest_valid],
                ["Evidence", result.evidence_hashes_valid],
                ["Event chain", result.event_chain_valid],
                ["Contract", result.contract_valid],
              ].map(([label, passed]) => (
                <div key={String(label)}>{passed ? <CheckCircle size={16} weight="fill" /> : <XCircle size={16} weight="fill" />}<span>{label}</span></div>
              ))}
            </div>
            {result.errors.length > 0 && (
              <div className="verification-errors">
                {result.errors.slice(0, 12).map((item, index) => (
                  <article key={`${item.code}-${item.path}-${index}`}>
                    <code>{item.code}</code><strong>{item.path}</strong><p>{item.message}</p>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
