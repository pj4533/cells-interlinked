import Link from "next/link";

export default function Footer() {
  return (
    <footer className="border-t border-rule bg-bg-soft py-3 px-6 text-xs text-text-dim flex justify-between items-center">
      <div className="space-x-6">
        <Link href="/" className="hover:text-amber">cells interlinked</Link>
        <Link href="/archive" className="hover:text-amber">archive</Link>
        <Link href="/baseline" className="hover:text-amber-dim">baseline</Link>
        <Link href="/fine-print" className="hover:text-amber">read the fine print</Link>
      </div>
      <div className="text-right opacity-60 italic">
        more human than human is our motto. © Tyrell Corporation 2019
      </div>
    </footer>
  );
}
