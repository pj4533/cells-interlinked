import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="text-center max-w-xl">
        <div className="font-display text-4xl text-amber amber-glow mb-4">404</div>
        <p className="text-amber italic font-mono text-sm leading-relaxed">
          You&apos;ve never been outside the wall.
          <br />
          There is nothing here for you.
        </p>
        <Link href="/" className="inline-block mt-8 text-cyan hover:text-cyan-dim text-xs underline">
          return inside
        </Link>
      </div>
    </div>
  );
}
