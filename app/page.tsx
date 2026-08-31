import {
  ArrowRight,
  GithubLogo,
  GitCommit,
  Network,
  Scales,
  ShieldChevron,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { ProofGateConsole } from "@/components/proofgate-console";

const trustLayers = [
  {
    icon: Network,
    name: "Telegraph",
    role: "Routes paid requests to live ranked Miners",
  },
  {
    icon: GitCommit,
    name: "Qarinah",
    role: "Preserves signal identity, hashes, and lineage",
  },
  {
    icon: Scales,
    name: "Maqam",
    role: "Enforces the final authorization boundary before ALLOW",
  },
];

export default function Home() {
  return (
    <main className="proofgate-page">
      <header className="pg-header">
        <nav className="pg-nav" aria-label="Primary navigation">
          <Link className="pg-brand" href="/" aria-label="ProofGate home">
            <span aria-hidden="true"><ShieldChevron size={19} weight="fill" /></span>
            <strong>ProofGate</strong>
          </Link>
          <div className="pg-nav-links">
            <a href="#how-it-works">Trust stack</a>
            <Link href="/proofpack">ProofPack Miner</Link>
            <Link href="/verify">Verifier</Link>
          </div>
          <a className="pg-repo-link" href="https://github.com/AjnasNB/qarinah-proofpack">
            <GithubLogo size={18} weight="bold" aria-hidden="true" />
            Source
          </a>
        </nav>
      </header>

      <section className="pg-hero">
        <div className="pg-hero-copy">
          <p className="pg-track-label">TELEGRAPH TRACK 3 APPLICATION</p>
          <h1>No proof.<br />No action.</h1>
          <p className="pg-lede">A pre-action trust firewall that makes autonomous agents earn permission to act.</p>
          <div className="pg-outcomes" aria-label="Possible preflight outcomes">
            <span>ALLOW</span>
            <span>BLOCK</span>
            <span>ESCALATE</span>
          </div>
          <p className="pg-boundary-copy">
            ProofGate authorizes a proposed action. It never executes the action itself.
          </p>
        </div>
        <ProofGateConsole />
      </section>

      <section className="pg-stack" id="how-it-works">
        <div className="pg-section-heading">
          <h2>Trust is a sequence.</h2>
          <p>Every authorization keeps the live Miner receipts and policy checks that produced it.</p>
        </div>
        <div className="pg-layer-grid">
          {trustLayers.map(({ icon: Icon, name, role }, index) => (
            <article key={name}>
              <div className="pg-layer-icon"><Icon size={24} weight="duotone" aria-hidden="true" /></div>
              <div>
                <span>{index === 0 ? "INTELLIGENCE" : index === 1 ? "LINEAGE" : "POLICY"}</span>
                <h3>{name}</h3>
                <p>{role}</p>
              </div>
            </article>
          ))}
          <div className="pg-layer-decision">
            <ShieldChevron size={27} weight="fill" aria-hidden="true" />
            <div>
              <span>DECISION</span>
              <strong>ProofGate</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="pg-proofpack-callout">
        <div>
          <p>OPEN-SOURCE FOUNDATION</p>
          <h2>ProofPack remains the evidence engine.</h2>
          <span>Live web acquisition, source hashes, contradiction handling, abstention, and offline verification stay available as a separate Miner surface.</span>
        </div>
        <Link href="/proofpack">
          Inspect ProofPack <ArrowRight size={17} weight="bold" aria-hidden="true" />
        </Link>
      </section>

      <footer className="pg-footer">
        <div className="pg-footer-brand"><ShieldChevron size={18} weight="fill" aria-hidden="true" /> ProofGate</div>
        <p>Powered by Telegraph, Qarinah, Maqam, and Cockroach Crawler.</p>
        <div>
          <a href="https://github.com/AjnasNB/qarinah">Qarinah</a>
          <a href="https://github.com/AjnasNB/maqam">Maqam</a>
          <a href="https://github.com/AjnasNB/cockroach-crawler">Crawler</a>
          <a href="https://github.com/AjnasNB/cockroach-browser">Browser</a>
        </div>
      </footer>
    </main>
  );
}
