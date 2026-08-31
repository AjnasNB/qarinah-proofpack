import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-7xl flex-col justify-center px-5 py-16 md:px-10">
      <p className="mb-6 font-[family-name:var(--font-geist-mono)] text-xs font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">
        Telegraph FACT_CHECK Miner
      </p>
      <h1 className="max-w-4xl text-5xl font-semibold leading-[0.96] tracking-[-0.055em] md:text-7xl">
        Evidence before action.
      </h1>
      <p className="mt-7 max-w-xl text-lg leading-8 text-[var(--muted)]">
        Qarinah ProofPack turns live web research into hash-verifiable evidence packs with explicit abstention.
      </p>
      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/health"
          className="rounded-xl bg-[var(--accent)] px-5 py-3 font-semibold text-[var(--accent-ink)] transition-transform active:translate-y-px"
        >
          Check service
        </Link>
        <a
          href="https://github.com/AjnasNB/qarinah"
          className="rounded-xl border border-[var(--line)] px-5 py-3 font-semibold transition-colors hover:bg-[var(--surface)] active:translate-y-px"
        >
          View Qarinah
        </a>
      </div>
    </main>
  );
}
