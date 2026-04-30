# Portfolio Dashboard

A local portfolio dashboard with real-time prices from Yahoo Finance (ETFs) and CoinGecko (crypto). All values normalized to EUR.

## Prerequisites

[Bun](https://bun.sh) — install:
macOS & Linux:
```bash
curl -fsSL https://bun.sh/install | bash
```
Windows:
```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

## File structure

```
portfolio-dashboard/
├── proxy.ts         ← Bun server (serves dashboard + proxies price APIs)
├── dashboard.html   ← Frontend (served by the proxy)
├── portfolio.json   ← Your holdings — edit this
└── README.md
```

## Setup

### 1. Edit portfolio.json

Each asset needs:
| Field         | Description |
|---------------|-------------|
| `ticker`      | Yahoo Finance symbol for ETFs/stocks (e.g. `VWCE.DE`, `CSPX.L`); CoinGecko coin ID for crypto (e.g. `bitcoin`, `ethereum`, `solana`) |
| `name`        | Display name |
| `quantity`    | Units held |
| `asset_class` | One of: `Equities`, `Bonds`, `Real Estate`, `Crypto`, `Cash` (or any custom label) |
| `platform`    | Broker/exchange name (e.g. `DEGIRO`, `Coinbase`) |
| `geography`   | Manual exposure tag (e.g. `Global`, `US`, `Europe`, `Emerging Markets`) |

The `targets` object maps asset class → target portfolio weight (0–1, should sum to 1).

**Crypto auto-detection:** any asset with `asset_class: "Crypto"` is fetched from CoinGecko. All others are fetched from Yahoo Finance with automatic EUR conversion.

### 2. Run the proxy

```bash
bun run proxy.ts
```

### 3. Open the dashboard

→ http://localhost:8000

## Notes

- **Prices are cached for 60 seconds** — rapid refreshes won't re-hit the APIs
- **FX rates are cached for 5 minutes** (GBPEUR, USDEUR, etc. via Yahoo Finance)
- **Yahoo Finance jitter**: sequential stock requests are staggered by ~150–250ms to avoid throttling
- **GBp (pence) handling**: LSE-listed ETFs quoted in GBp are automatically converted to GBP
- **CoinGecko "previous close"**: crypto uses rolling 24h change (not EOD), so daily P&L is approximate

## Common Yahoo Finance ticker suffixes

| Exchange                | Suffix | Example       |
|-------------------------|--------|---------------|
| Xetra (Frankfurt)       | `.DE`  | `VWCE.DE`     |
| Euronext Amsterdam      | `.AS`  | `IWDA.AS`     |
| London Stock Exchange   | `.L`   | `CSPX.L`      |
| Borsa Italiana (Milan)  | `.MI`  | `AGGH.MI`     |
| SIX (Zurich)            | `.SW`  | `VWRL.SW`     |
| Euronext Paris          | `.PA`  | `CW8.PA`      |
