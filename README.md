# triageagent-dev.github.io

Landing page for the [Triage X-Ray](https://github.com/triageagent-dev) organisation —
a static port of the page the core HTTP API serves at `/`
(`core/docs/landing.html`), with the server-rendered slots
(`{{VERSION}}`, `{{AUTH}}`, `{{ONBOARDING}}`) replaced by static public links.

| File | Source |
|------|--------|
| `index.html` | `core/docs/landing.html` |
| `whitepaper.html` | `core/docs/whitepaper.html` (verbatim, self-contained) |

Served by GitHub Pages from `main`. `.nojekyll` keeps Jekyll out of the way.

When the landing page changes in core, regenerate rather than hand-editing, so the
two stay in step.
