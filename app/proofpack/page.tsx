import type { Metadata } from "next";
import {
  ArrowLeft,
  GithubLogo,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { ProofConsole } from "@/components/proof-console";

export const metadata: Metadata = {
  title: "Qarinah ProofPack Miner | ProofGate",
  description: "Build a hash-verifiable evidence pack with live sources, calculated confidence, contradictions, provenance, and explicit abstention.",
};

export default function ProofPackPage() {
  return (
    <main className="verify-page">
      <header className="site-header">
        <nav className="site-nav" aria-label="ProofPack navigation">
          <Link className="brand" href="/proofpack" aria-label="Qarinah ProofPack Miner home">
            <span className="brand-mark" aria-hidden="true">Q</span>
            <span>Qarinah ProofPack</span>
          </Link>
          <Link className="verify-back" href="/"><ArrowLeft size={16} weight="bold" /> Back to ProofGate</Link>
          <a className="nav-repo" href="https://github.com/AjnasNB/qarinah-proofpack">
            <GithubLogo size={18} weight="bold" aria-hidden="true" />
            Repository
          </a>
        </nav>
      </header>

      <section className="proof-stage">
        <div className="shell proof-stage-grid">
          <div className="section-intro">
            <p className="kicker">TELEGRAPH MINER SURFACE</p>
            <h1 className="proofpack-route-title">Evidence before action.</h1>
            <p>
              ProofPack turns live public research into a sealed response with source hashes, contradiction records, calculated confidence, and explicit abstention.
            </p>
            <div className="truth-note">
              <Warning size={22} weight="duotone" aria-hidden="true" />
              <p>
                A hash proves internal integrity, not source truth. Evidence quality and the Maqam policy decide whether a verdict can pass.
              </p>
            </div>
            <Link className="proofpack-verify-link" href="/verify">
              <ShieldCheck size={19} weight="duotone" aria-hidden="true" />
              Open the offline verifier
            </Link>
          </div>
          <ProofConsole />
        </div>
      </section>
    </main>
  );
}
