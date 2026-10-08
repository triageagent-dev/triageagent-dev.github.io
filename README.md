# Triage Agent

Landing page for **Triage Agent** — self-aware infrastructure.

Predictive incident intelligence for the early detection and prevention of
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

No build step. The landing page and the white paper are self-contained, with
no external assets or fonts to fetch; the agent specification loads its fonts
from Google Fonts and its code highlighting from a CDN.

## Local preview

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

---

Served by GitHub Pages from `main`.
