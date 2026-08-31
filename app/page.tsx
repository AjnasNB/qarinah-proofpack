import {
  ArrowRight,
  BracketsCurly,
  CheckCircle,
  GithubLogo,
  GitCommit,
  GlobeHemisphereWest,
  LockKey,
  Scales,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import Image from "next/image";
import Link from "next/link";
import { ProofConsole } from "@/components/proof-console";

const repos = [
  {
    name: "Qarinah",
    role: "Provenance",
    description: "Creates the hash-linked event chain embedded in every sealed pack.",
    href: "https://github.com/AjnasNB/qarinah",
  },
  {
    name: "Cockroach Crawler",
    role: "Acquisition",
    description: "Fetches and extracts the public pages selected by governed search.",
    href: "https://github.com/AjnasNB/cockroach-crawler",
  },
  {
    name: "Maqam",
    role: "Policy",
    description: "Governs source access and applies the evidence threshold before a verdict ships.",
    href: "https://github.com/AjnasNB/maqam",
  },
  {
    name: "Cockroach Browser",
    role: "Optional sidecar",
    description: "Handles browser-based acquisition as a separately deployed AGPL service.",
    href: "https://github.com/AjnasNB/cockroach-browser",
  },
];

const flow = [
  { icon: GlobeHemisphereWest, label: "Acquire", copy: "Search and crawl live public evidence" },
  { icon: GitCommit, label: "Preserve", copy: "Canonicalize sources and chain evidence events" },
  { icon: Scales, label: "Decide", copy: "Score support, conflict, coverage, and freshness" },
  { icon: ShieldCheck, label: "Gate", copy: "Return a verdict or abstain before action" },
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <nav className="site-nav" aria-label="Primary navigation">
          <Link className="brand" href="/" aria-label="Qarinah ProofPack home">
            <span className="brand-mark" aria-hidden="true">Q</span>
            <span>Qarinah ProofPack</span>
          </Link>
          <div className="nav-links">
            <a href="#contract">Contract</a>
            <a href="#architecture">Architecture</a>
            <Link href="/verify">Verifier</Link>
            <a href="#open-source">Open source</a>
          </div>
          <a className="nav-repo" href="https://github.com/AjnasNB/qarinah-proofpack">
            <GithubLogo size={18} weight="bold" aria-hidden="true" />
            Repository
          </a>
        </nav>
      </header>

      <section className="hero shell">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" aria-hidden="true" />
            Telegraph FACT_CHECK Miner
          </div>
          <h1>Evidence<br />before action.</h1>
          <p className="hero-lede">
            Live research becomes a hash-verifiable proof pack with contradictions, confidence, provenance, and explicit abstention.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#try-it">
              Run a live proof
              <ArrowRight size={18} weight="bold" aria-hidden="true" />
            </a>
            <a className="button button-secondary" href="https://github.com/AjnasNB/qarinah-proofpack#api">
              Read the API contract
            </a>
          </div>
          <div className="intent-line" aria-label="Supported Telegraph intents">
            <span>SUPPORTED INTENTS</span>
            <code>FACT_CHECK</code>
            <code>RESEARCH_SYNTHESIS</code>
          </div>
        </div>

        <div className="hero-visual" aria-label="Abstract evidence provenance artwork">
          <Image
            src="/images/proofpack-provenance.webp"
            alt="Layered evidence records converging on a verified green alignment line"
            fill
            priority
            sizes="(max-width: 900px) 100vw, 48vw"
          />
          <div className="visual-caption">
            <LockKey size={18} weight="fill" aria-hidden="true" />
            <div>
              <strong>Integrity sealed</strong>
              <span>SHA-256 manifest and Qarinah chain</span>
            </div>
          </div>
          <div className="visual-note">PROVENANCE / 01</div>
        </div>
      </section>

      <section className="proof-stage" id="try-it">
        <div className="shell proof-stage-grid">
          <div className="section-intro">
            <p className="kicker">LIVE PROOF CONSOLE</p>
            <h2>Ask one claim. Inspect every reason.</h2>
            <p>
              The console calls the same public endpoint exposed to Telegraph. Results are acquired, scored, policy-checked, sealed, and verified on request.
            </p>
            <div className="truth-note">
              <Warning size={22} weight="duotone" aria-hidden="true" />
              <p>
                The seal checks internal consistency and chain continuity. Compare its manifest hash with a trusted Telegraph commitment to establish integrity across systems; evidence quality and policy determine the verdict.
              </p>
            </div>
          </div>
          <ProofConsole />
        </div>
      </section>

      <section className="contract-section shell" id="contract">
        <div className="contract-heading">
          <p className="kicker">THE EVIDENCE CONTRACT</p>
          <h2>A confidence score an agent can audit.</h2>
        </div>
        <div className="formula-card">
          <div className="formula-line">
            <span>confidence</span>
            <span>=</span>
            <strong>.35 entailment</strong>
            <span>+</span>
            <strong>.20 diversity</strong>
            <span>+</span>
            <strong>.20 coverage</strong>
            <span>+</span>
            <strong>.15 freshness</strong>
            <span>+</span>
            <strong>.10 agreement</strong>
          </div>
          <p>Deterministic components are calculated from the evidence set. The language model never chooses its own confidence.</p>
        </div>
        <div className="contract-grid">
          <article>
            <BracketsCurly size={25} weight="duotone" aria-hidden="true" />
            <h3>Structured by default</h3>
            <p>Verdict, answer, claims, evidence IDs, hashes, contradictions, score components, policy, and verification metadata.</p>
          </article>
          <article>
            <Scales size={25} weight="duotone" aria-hidden="true" />
            <h3>Policy before prose</h3>
            <p>Maqam checks coverage, independence, confidence, and conflict before the final answer can pass.</p>
          </article>
          <article>
            <ShieldCheck size={25} weight="duotone" aria-hidden="true" />
            <h3>Fail closed</h3>
            <p>Weak, singular, or conflicting evidence produces INSUFFICIENT_EVIDENCE instead of confident filler.</p>
          </article>
        </div>
      </section>

      <section className="evidence-section">
        <div className="shell evidence-grid">
          <div className="evidence-image">
            <Image
              src="/images/proofpack-contradictions.webp"
              alt="Two conflicting evidence trails arranged on an archival research table"
              fill
              sizes="(max-width: 900px) 100vw, 52vw"
            />
            <div className="image-index">CONTRADICTIONS / 02</div>
          </div>
          <div className="evidence-copy">
            <p className="kicker">CONTRADICTION NATIVE</p>
            <h2>Disagreement is signal, not cleanup.</h2>
            <p>
              Supporting and refuting passages stay linked to the claim. When credible sources collide, ProofPack raises conflict and can stop the downstream agent.
            </p>
            <ul className="check-list">
              <li><CheckCircle size={19} weight="fill" aria-hidden="true" /> Canonical URLs and independent domains</li>
              <li><CheckCircle size={19} weight="fill" aria-hidden="true" /> Source content and evidence-record hashes</li>
              <li><CheckCircle size={19} weight="fill" aria-hidden="true" /> Explicit support, refute, mixed, and neutral stances</li>
              <li><CheckCircle size={19} weight="fill" aria-hidden="true" /> Automatic abstention on unresolved conflict</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="architecture-section shell" id="architecture">
        <div className="section-title-row">
          <div>
            <p className="kicker">OPEN PIPELINE</p>
            <h2>Four trust boundaries. One response.</h2>
          </div>
          <p>Each layer has a narrow job and leaves inspectable output for the next.</p>
        </div>
        <div className="flow-grid">
          {flow.map(({ icon: Icon, label, copy }, index) => (
            <article key={label}>
              <div className="flow-number">0{index + 1}</div>
              <Icon size={26} weight="duotone" aria-hidden="true" />
              <h3>{label}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
        <div className="decision-panel">
          <div className="decision-image">
            <Image
              src="/images/proofpack-decision-gate.webp"
              alt="A physical evidence gate allowing a complete proof record to pass"
              fill
              sizes="(max-width: 900px) 100vw, 46vw"
            />
          </div>
          <div className="decision-copy">
            <p className="kicker">THE MONEY SHOT</p>
            <h2>Sometimes the correct answer is no answer.</h2>
            <p>
              Autonomous systems need a safe stopping condition. ProofPack blocks decisive output when evidence coverage falls below 0.50, confidence stays below 0.55, or independence is too weak.
            </p>
            <code className="decision-code">INSUFFICIENT_EVIDENCE · abstained: true</code>
          </div>
        </div>
      </section>

      <section className="open-source-section" id="open-source">
        <div className="shell">
          <div className="section-title-row">
            <div>
              <p className="kicker">BUILT IN THE OPEN</p>
              <h2>A new Miner, composed from our public work.</h2>
            </div>
            <p>ProofPack is a standalone project. It consumes released packages and does not modify the upstream repositories.</p>
          </div>
          <div className="repo-grid">
            {repos.map((repo) => (
              <a href={repo.href} key={repo.name} className="repo-card">
                <div>
                  <span>{repo.role}</span>
                  <GithubLogo size={21} weight="bold" aria-hidden="true" />
                </div>
                <h3>{repo.name}</h3>
                <p>{repo.description}</p>
                <strong>View public repository <ArrowRight size={16} weight="bold" aria-hidden="true" /></strong>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="closing shell">
        <p className="kicker">QARINAH PROOFPACK</p>
        <h2>Autonomous agents should act on evidence, not plausible prose.</h2>
        <div className="hero-actions">
          <a className="button button-primary" href="#try-it">Run a proof <ArrowRight size={18} weight="bold" aria-hidden="true" /></a>
          <a className="button button-secondary" href="https://github.com/AjnasNB/qarinah-proofpack">Inspect the source</a>
        </div>
      </section>

      <footer>
        <div className="shell footer-grid">
          <div className="brand footer-brand"><span className="brand-mark" aria-hidden="true">Q</span><span>Qarinah ProofPack</span></div>
          <p>Evidence-backed intelligence for autonomous agents.</p>
          <div className="footer-links">
            <a href="/health">Health</a>
            <Link href="/verify">Verify</Link>
            <a href="https://github.com/AjnasNB/qarinah-proofpack#api">API</a>
            <a href="https://telegraphprotocol.com/">Telegraph</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
