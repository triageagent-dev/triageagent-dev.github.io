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
| `ego/spec.html` | The public ego specification, copied from `../ego/docs/spec.html` (without its web-font link); copy it again when the spec changes |
| `spot/spec.html` | The public spot specification, copied from the spot repository (`docs/spec.html`, without its web-font link); copy it again when the spec changes |
| `zoom.js` | Scales every page up on screens 2200px wide or more (CSS zoom, set from the window size, `--z` for the `vh` rules); below that nothing changes |
| `connectors.png` | The connectors strip (infra events, monitoring, cloud, messengers, MCP IDE) at the top of the agent section's diagram |
| `triage/spec.html` | The public core specification, copied from `../core/docs/spec.html` (without its web-font link and the Prism scripts, so no page loads a third-party resource); copy it again when the spec changes |
| `xray/spec.html` | The public xray specification, copied from `../x-ray/docs/spec.html` (same removals as the core spec); copy it again when the spec changes |
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
