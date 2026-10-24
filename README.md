# Triage Agent

Landing page for **Triage Agent** — self-aware infrastructure.

Always-on incident intelligence for the early detection and prevention of
production outages, cost anomalies and security breaches. Built on an agentic
memory substrate, Kahneman's dual-system thinking, the CoALA architecture and
the USE, RED and SIG signal frameworks.

Live at **<https://triageagent.dev>**

## Contents

| File | |
|------|--|
| `index.html` | The landing page |
| `whitepaper.html` | *Self-Aware Infrastructure* — the white paper behind the project |
| `agent.html` | The agent specification |
| `demo/` | The live devices section: the real TUI and mobile app (copied from `../ui/public` by `sync-demo.sh`) running against sample data (`fixtures.js`, `shim.js`), plus the interactive watch and tracker faces (`devices.js`) |
| `confirm.html` | Double opt-in landing page for the link in the confirmation email |
| `404.html` | Served by GitHub Pages for unknown paths |
| `og.png` | Social preview card (1200×630) referenced by the `og:image` tag |
| `privacy.html`, `terms.html`, `subprocessors.html` | Legal pages. **Drafts**: the legal entity, address, governing law and jurisdiction are marked "soon"; have a lawyer review before publishing |

There is no pricing section or waitlist form on the page; early access is by invitation, and the accounts service (`../accounts`) is not wired to the site.

The footer of `index.html` shows the landing version (`vYYYY.MM.DD.N`), linked to the commit history; bump it with every push so the live page can be told apart from a cached one.

Run `./sync-demo.sh` after the TUI or the mobile app change. No build step. Every page is self-contained: system fonts, inline CSS and
SVG, no external assets to fetch.

## Local preview

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

---

Served by GitHub Pages from `main`.
