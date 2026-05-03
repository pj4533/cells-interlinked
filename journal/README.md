# Cells Interlinked — Journal

Public-facing site for the Cells Interlinked interpretability project.
Static, built from local report data, deployed to Vercel.

## How a report gets here

Reports live at `data/reports/{slug}/`:
```
data/reports/{slug}/
  report.json    # metadata (title, summary, range, top features)
  body.md        # the markdown body
```

The `journal` page in the local app (`web/app/journal`) writes new
reports here automatically when the user clicks **Publish**, then
git-pushes the change. Vercel rebuilds on push.

## Local dev

```bash
npm install
npm run dev    # http://localhost:3002
```

## Production build (what Vercel runs)

```bash
npm run build
```

The build statically pre-renders one HTML file per report slug.

## Adding a report by hand

1. Create `data/reports/your-slug/report.json` matching the shape of
   the existing samples.
2. Drop your `body.md` next to it.
3. Commit + push.

## Stack

- Next.js 16 (app router, `output: "export"` for static)
- Tailwind v4
- React 19
- react-markdown + remark-gfm for prose
- Three Google Fonts: Orbitron (display), JetBrains Mono (data),
  EB Garamond (long-form prose).

No tracking. No external requests at runtime. The entire site ships
as static HTML, CSS, and a small amount of client JS.
