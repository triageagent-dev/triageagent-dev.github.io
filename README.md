# Triage Agent

Landing page for **Triage Agent** — self-aware infrastructure.

Always-on incident intelligence for the early detection and prevention of
production outages, cost anomalies and security breaches. Built on an agentic
memory substrate, Kahneman's dual-system thinking, the CoALA architecture and
the USE, RED and SIG signal frameworks.

Live at **<https://triageagent-dev.github.io>**

## Contents

| File | |
|------|--|
| `index.html` | The landing page |
| `whitepaper.html` | *Self-Aware Infrastructure* — the white paper behind the project |
| `agent.html` | The agent specification |
| `demo/` | The live devices section: the real TUI and mobile app (copied from `../ui/public` by `sync-demo.sh`) running against sample data (`fixtures.js`, `shim.js`), plus the interactive watch and tracker faces (`devices.js`) |
| `confirm.html` | Double opt-in landing page for the link in the confirmation email |
| `privacy.html`, `terms.html`, `subprocessors.html` | Legal pages. **Drafts**: fill the `[bracketed]` values and have a lawyer review before publishing |

The pricing section and its waitlist forms are removed for now; the accounts service (`../accounts`) is not wired to the page.

Run `./sync-demo.sh` after the TUI or the mobile app change. No build step. The landing page and the white paper are self-contained, with
no external assets or fonts to fetch; the agent specification loads its fonts
from Google Fonts and its code highlighting from a CDN.

## Local preview

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

---

Served by GitHub Pages from `main`.
