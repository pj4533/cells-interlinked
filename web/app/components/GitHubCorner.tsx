"use client";

/** GitHub corner — diagonal amber triangle in the top-right with the
 *  standard GitHub mark icon inside. Hover: triangle gets an amber
 *  drop-shadow glow and the icon rotates slightly, fitting the V-K
 *  terminal aesthetic better than the cartoony octocat wave.
 *
 *  Uses the canonical GitHub Octicon `mark-github` path (16x16, scaled
 *  to fit) — proven SVG, no chance of broken path data. */
export default function GitHubCorner() {
  return (
    <a
      href="https://github.com/pj4533/cells-interlinked"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View source on GitHub"
      className="github-corner fixed top-0 right-0 z-40"
    >
      <svg
        width="84"
        height="84"
        viewBox="0 0 84 84"
        aria-hidden="true"
        style={{ display: "block" }}
      >
        {/* Diagonal triangle filling the top-right corner */}
        <path
          d="M0,0 L84,0 L84,84 Z"
          fill="var(--amber)"
        />
        {/* GitHub mark — Octicon `mark-github`, 16x16. Translated and
            scaled to sit in the upper-right of the triangle. */}
        <g
          transform="translate(46, 14) scale(1.5)"
          fill="var(--bg)"
          className="github-corner__icon"
        >
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
        </g>
      </svg>
    </a>
  );
}
