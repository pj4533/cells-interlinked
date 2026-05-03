import Link from "next/link";

/**
 * Top header strip — looks like a station identifier on a 1980s
 * lab terminal. Three rows on the left (call sign + classification
 * + station ID), navigation on the right.
 *
 * Important: NOT sticky. We want it to scroll away during long-form
 * reading; the long-form is the point, the chrome is decoration.
 */
export default function SiteHeader() {
  return (
    <header className="relative z-20 border-b border-rule bg-bg-soft/40 backdrop-blur-[2px]">
      <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-6">
        <Link href="/" className="group flex items-baseline gap-3">
          <span className="font-display text-base text-amber group-hover:amber-glow tracking-widest">
            Cells Interlinked
          </span>
          <span className="hidden sm:inline font-mono text-[9px] text-text-dim tracking-widest">
            ./field-notes
          </span>
        </Link>

        <nav className="flex items-center gap-5 text-[10px] font-display tracking-widest">
          <Link
            href="/"
            className="text-text-dim hover:text-amber transition-colors"
          >
            reports
          </Link>
          <Link
            href="/about"
            className="text-text-dim hover:text-amber transition-colors"
          >
            about
          </Link>
          <a
            href="https://github.com/pj4533/cells-interlinked"
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-dim hover:text-cyan transition-colors"
          >
            source ↗
          </a>
        </nav>
      </div>
      <div
        className="h-[1px] bg-gradient-to-r from-transparent via-amber-dim/60 to-transparent line-grow"
        aria-hidden
      />
    </header>
  );
}
