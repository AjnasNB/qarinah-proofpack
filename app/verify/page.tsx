import type { Metadata } from "next";
import { ArrowLeft, GithubLogo, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { VerificationConsole } from "@/components/verification-console";

export const metadata: Metadata = {
  title: "Verify a ProofPack | Qarinah ProofPack",
  description: "Verify a ProofPack manifest, evidence hashes, contract, and Qarinah event chain without network access.",
};

export default function VerifyPage() {
  return (
    <main className="verify-page">
      <header className="site-header">
        <nav className="site-nav" aria-label="Verifier navigation">
          <Link className="brand" href="/" aria-label="Qarinah ProofPack home">
            <span className="brand-mark" aria-hidden="true">Q</span>
            <span>Qarinah ProofPack</span>
          </Link>
          <Link className="verify-back" href="/"><ArrowLeft size={16} weight="bold" /> Back to live console</Link>
          <a className="nav-repo" href="https://github.com/AjnasNB/qarinah-proofpack">
            <GithubLogo size={18} weight="bold" aria-hidden="true" />
            Repository
          </a>
        </nav>
      </header>

      <section className="verify-shell shell">
        <div className="verify-intro">
          <p className="kicker">OFFLINE VERIFICATION</p>
          <h1>Trust the seal.<br />Inspect the chain.</h1>
          <p>
            Paste or upload any ProofPack. The verifier checks its closed contract, manifest, evidence records, references, policy invariants, and Qarinah continuity without fetching a source.
          </p>
          <div className="verify-boundary">
            <ShieldCheck size={21} weight="duotone" aria-hidden="true" />
            <span>Verification makes no network requests and cannot certify source truthfulness.</span>
          </div>
        </div>
        <VerificationConsole />
      </section>
    </main>
  );
}
