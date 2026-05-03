import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="relative z-10 border-t border-rule bg-bg-soft/30 mt-24">
      <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col md:flex-row gap-6 items-start justify-between">
        <div className="flex flex-col gap-2 max-w-md">
          <div className="font-display text-[10px] text-amber tracking-widest mb-1">
            Tyrell Corporation Interpretability Division
          </div>
          <p className="text-text-dim text-xs italic font-prose leading-relaxed">
            More human than human is our motto. The reports here are stated-vs-computed
            coherence probes — they tell you what a language model{" "}
            <em>represents</em>, not what it experiences.
          </p>
        </div>

        <nav className="flex items-center gap-5 text-[10px] font-display tracking-widest">
          <Link href="/" className="text-text-dim hover:text-amber">
            reports
          </Link>
          <Link href="/about" className="text-text-dim hover:text-amber">
            about
          </Link>
          <a
            href="https://github.com/pj4533/cells-interlinked"
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-dim hover:text-cyan"
          >
            source ↗
          </a>
        </nav>
      </div>
      <div className="border-t border-rule/60">
        <div className="max-w-5xl mx-auto px-6 py-3 flex justify-between items-center text-[9px] font-mono text-text-deep tracking-widest">
          <span>RUN LOCALLY · M2 ULTRA · OFFLINE</span>
          <span>© TC 2019 — A SYSTEM OF CELLS INTERLINKED</span>
        </div>
      </div>
    </footer>
  );
}
