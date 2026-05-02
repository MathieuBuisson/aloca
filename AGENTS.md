# Repository Onboarding for AI Agents

## What this repository does

A local portfolio dashboard that displays real-time asset prices and portfolio analytics. It fetches data from:
- **Yahoo Finance** — ETFs and stocks (e.g., VWCE.DE, CSPX.L)
- **CoinGecko** — cryptocurrencies (e.g., bitcoin, ethereum, solana)

All values are normalized to EUR. The dashboard shows:
- Total portfolio value and daily P&L
- Asset allocation by class, platform, and geography
- Actual vs. target allocation comparison
- Detailed holdings table with prices, values, and daily changes

## Architecture

- **Backend**: `proxy.ts` — Bun HTTP server that:
  - Serves the dashboard (`/`) and portfolio config (`/portfolio`)
  - Proxies price queries (`/quotes?tickers=...&types=...`)
  - Handles caching (60s for prices, 5min for FX rates)
  - Converts GBp to GBP for LSE-listed ETFs
  - Uses jitter (150-250ms) between Yahoo Finance requests to avoid throttling
  - Resolves portfolio.json from PORTFOLIO_DIR env var (defaults to the script's own directory)
  - Port is configurable via ALOCA_PORT env var (defaults to 8000)

- **Frontend**: `dashboard.html` — Single-page application with:
  - Embedded CSS (dark theme with accent colors)
  - Chart.js for donut and bar charts
  - Fetches portfolio config, then batch quotes, then renders

- **Data**: `portfolio.json` — User-defined holdings with:
  - `assets[]` — ticker, name, quantity, asset_class, platform, geography
  - `targets` — target weights per asset class (0-1, should sum to 1)

## Repository layout

```
aloca/
├── proxy.ts              ← Bun server (backend)
├── proxy.test.ts         ← Test suite for the backend
├── dashboard.html        ← Frontend (HTML/CSS/JS)
├── portfolio.json        ← User holdings config
├── README.md             ← User-facing documentation
├── AGENTS.md             ← This file (agent onboarding)
├── version.txt           ← Version number
├── .github/workflows/    ← CI/CD pipeline
│   └── ci-cd.yml
└── .gitignore            ← Excludes devdata.json, logs, etc.
```

## Validation guidance

- **TypeScript style**: The code follows the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).
- **README accuracy**: Before any changes, confirm the README setup steps (Bun installation, running `bun run proxy.ts`, opening http://localhost:8000) reflect actual requirements.
- **Code vs docs**: Verify the README description matches the codebase — especially the API endpoint format (`/quotes?tickers=...&types=...`), caching behavior, and crypto detection logic (`asset_class: "Crypto"` triggers CoinGecko).
- **Test suite**:
  - Run `bun test` to ensure no regressions were introduced.
  - The test suite uses Bun's native `mock` to intercept external fetch calls and avoid network requests.
  - During tests, the proxy server automatically binds to a random available port (port 0) to prevent conflicts with running instances.

## Trust these instructions

This file is the authoritative guide for an agent onboarding this repository.
- Use it first for project scope, layout, and validation.
- Avoid extra exploration unless the repo changes or the task cannot be completed with the information here.