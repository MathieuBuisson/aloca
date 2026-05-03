import { join } from "node:path";
import { serve } from "bun";

const isTest =
	process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test";
const PORT = isTest ? 0 : Number(process.env.ALOCA_PORT ?? 8000); // 0 = OS-assigned ephemeral port
const CACHE_TTL_MS = 60_000;
const FX_CACHE_TTL_MS = 300_000; // FX rates cached for 5 minutes
// Directory where portfolio.json lives — override with the PORTFOLIO_DIR env var.
const PORTFOLIO_DIR = process.env.PORTFOLIO_DIR ?? import.meta.dir;

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
	value: unknown;
	expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCache<T>(key: string): T | null {
	const entry = cache.get(key);
	if (!entry || Date.now() > entry.expiresAt) {
		if (entry) cache.delete(key);
		return null;
	}
	return entry.value as T;
}

export function setCache(
	key: string,
	value: unknown,
	ttl = CACHE_TTL_MS,
): void {
	cache.set(key, { value, expiresAt: Date.now() + ttl });
}

/** Removes all cache entries. Intended for use in tests. */
export function clearCache(): void {
	cache.clear();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Pause between Yahoo Finance requests to avoid rate-limiting
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const USER_AGENTS = [
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
];

const randomUA = () =>
	USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NormalizedQuote {
	ticker: string;
	priceEur: number;
	previousCloseEur: number;
	error?: string;
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────

interface YahooRaw {
	price: number;
	previousClose: number;
	currency: string;
}

interface YahooResponse {
	chart: {
		result?: Array<{
			meta: {
				regularMarketPrice: number;
				previousClose?: number;
				chartPreviousClose?: number;
				currency: string;
			};
		}>;
	};
}

async function fetchYahooRaw(ticker: string): Promise<YahooRaw> {
	const cacheKey = `yahoo:${ticker}`;
	const cached = getCache<YahooRaw>(cacheKey);
	if (cached) return cached;

	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
	const res = await fetch(url, {
		headers: {
			"User-Agent": randomUA(),
			Accept: "application/json,text/plain,*/*",
			"Accept-Language": "en-US,en;q=0.9",
			Referer: "https://finance.yahoo.com/",
		},
	});

	if (!res.ok) {
		throw new Error(`Yahoo Finance ${res.status} for "${ticker}"`);
	}

	const data = (await res.json()) as YahooResponse;
	const meta = data?.chart?.result?.[0]?.meta;
	if (!meta) throw new Error(`No data returned for "${ticker}"`);

	// Validate required numeric fields
	if (
		typeof meta.regularMarketPrice !== "number" ||
		!Number.isFinite(meta.regularMarketPrice)
	) {
		throw new Error(`Invalid price for "${ticker}"`);
	}
	if (typeof meta.currency !== "string" || !meta.currency) {
		throw new Error(`Invalid currency for "${ticker}"`);
	}

	const result: YahooRaw = {
		price: meta.regularMarketPrice,
		previousClose:
			meta.previousClose ?? meta.chartPreviousClose ?? meta.regularMarketPrice,
		currency: meta.currency,
	};

	setCache(cacheKey, result);
	return result;
}

async function fetchFxRateToEur(currency: string): Promise<number> {
	if (currency === "EUR") return 1;
	const cacheKey = `fx:${currency}EUR`;
	const cached = getCache<number>(cacheKey);
	if (cached !== null) return cached;

	const raw = await fetchYahooRaw(`${currency}EUR=X`);
	setCache(cacheKey, raw.price, FX_CACHE_TTL_MS);
	return raw.price;
}

export async function fetchStockQuote(
	ticker: string,
): Promise<NormalizedQuote> {
	try {
		let { price, previousClose, currency } = await fetchYahooRaw(ticker);

		// London Stock Exchange quotes in pence
		if (currency === "GBp") {
			price /= 100;
			previousClose /= 100;
			currency = "GBP";
		}

		const fx = await fetchFxRateToEur(currency);
		return {
			ticker,
			priceEur: price * fx,
			previousCloseEur: previousClose * fx,
		};
	} catch (err) {
		console.error(`[stock] ${ticker}:`, err);
		return { ticker, priceEur: 0, previousCloseEur: 0, error: String(err) };
	}
}

// ─── CoinGecko ────────────────────────────────────────────────────────────────

export async function fetchCryptoBatch(
	coinIds: string[],
): Promise<Map<string, NormalizedQuote>> {
	const sortedKey = [...coinIds].sort().join(",");
	const cacheKey = `coingecko:${sortedKey}`;
	const cached = getCache<Map<string, NormalizedQuote>>(cacheKey);
	if (cached) return cached;

	try {
		const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
			sortedKey,
		)}&vs_currencies=eur&include_24hr_change=true`;

		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) throw new Error(`CoinGecko ${res.status}`);

		const data = (await res.json()) as Record<
			string,
			{ eur: number; eur_24h_change: number }
		>;

		const result = new Map<string, NormalizedQuote>();
		for (const id of coinIds) {
			const v = data[id];
			if (!v) {
				result.set(id, {
					ticker: id,
					priceEur: 0,
					previousCloseEur: 0,
					error: `CoinGecko: "${id}" not found`,
				});
				continue;
			}
			if (typeof v.eur !== "number" || !Number.isFinite(v.eur)) {
				result.set(id, {
					ticker: id,
					priceEur: 0,
					previousCloseEur: 0,
					error: `Invalid price for "${id}"`,
				});
				continue;
			}
			const priceEur = v.eur;
			const change = (v.eur_24h_change ?? 0) / 100;
			// Reconstruct approximate previous price from rolling 24h change
			const previousCloseEur = priceEur / Math.max(1 + change, 1e-9);
			result.set(id, { ticker: id, priceEur, previousCloseEur });
		}

		setCache(cacheKey, result);
		return result;
	} catch (err) {
		console.error("[crypto] batch fetch failed:", err);
		// Return a Map with error objects for all requested coinIds
		const errorMap = new Map<string, NormalizedQuote>();
		for (const id of coinIds) {
			errorMap.set(id, {
				ticker: id,
				priceEur: 0,
				previousCloseEur: 0,
				error: String(err),
			});
		}
		return errorMap;
	}
}

// ─── Batch handler ────────────────────────────────────────────────────────────

export async function handleQuotesBatch(
	tickers: string[],
	types: string[],
): Promise<NormalizedQuote[]> {
	const cryptoIds = tickers.filter((_, i) => types[i] === "crypto");
	const stockTickers = tickers.filter((_, i) => types[i] !== "crypto");

	// Start crypto fetch without blocking - runs concurrently with stock loop
	const cryptoPromise =
		cryptoIds.length > 0
			? fetchCryptoBatch(cryptoIds)
			: Promise.resolve(new Map<string, NormalizedQuote>());

	// Sequential Yahoo Finance calls with jitter to avoid throttling
	// (runs in parallel with crypto fetch)
	const stockMap = new Map<string, NormalizedQuote>();
	for (let i = 0; i < stockTickers.length; i++) {
		if (i > 0) await sleep(150 + Math.random() * 100);
		const quote = await fetchStockQuote(stockTickers[i]);
		stockMap.set(stockTickers[i], quote);
	}

	// Wait for crypto to complete
	const cryptoMap = await cryptoPromise;

	// Reassemble in original order
	return tickers.map((ticker, i) => {
		if (types[i] === "crypto") {
			return (
				cryptoMap.get(ticker) ?? {
					ticker,
					priceEur: 0,
					previousCloseEur: 0,
					error: "Not found",
				}
			);
		}
		return (
			stockMap.get(ticker) ?? {
				ticker,
				priceEur: 0,
				previousCloseEur: 0,
				error: "Not found",
			}
		);
	});
}

// ─── Server ───────────────────────────────────────────────────────────────────

const JSON_HEADERS = {
	// Wildcard OK — local-only dashboard, no auth required
	"Access-Control-Allow-Origin": "*",
	"Content-Type": "application/json; charset=utf-8",
};

export const server = serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

		try {
			// Serve dashboard
			if (url.pathname === "/") {
				const html = await Bun.file(
					join(import.meta.dir, "dashboard.html"),
				).text();
				return new Response(html, {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			// Serve portfolio config
			if (url.pathname === "/portfolio") {
				const text = await Bun.file(
					join(PORTFOLIO_DIR, "portfolio.json"),
				).text();
				return new Response(text, { headers: JSON_HEADERS });
			}

			// Batch quotes endpoint
			// GET /quotes?tickers=VWCE.DE,bitcoin&types=etf,crypto
			if (url.pathname === "/quotes") {
				const tickersParam = url.searchParams.get("tickers") ?? "";
				const typesParam = url.searchParams.get("types") ?? "";

				if (!tickersParam) return json({ error: "missing tickers param" }, 400);
				if (!typesParam) return json({ error: "missing types param" }, 400);

				const tickers = tickersParam.split(",").map((t) => t.trim());
				const types = typesParam.split(",").map((t) => t.trim());

				if (types.length !== tickers.length) {
					return json({ error: "tickers/types length mismatch" }, 400);
				}

				const results = await handleQuotesBatch(tickers, types);
				return json(results);
			}

			return json({ error: "not found" }, 404);
		} catch (err) {
			console.error("[server error]", err);
			return json({ error: String(err) }, 500);
		}
	},
});

if (!isTest) {
	console.log(`
  ┌─────────────────────────────────────┐
  │  Portfolio Dashboard                │
  │  → http://localhost:${PORT}           │
  │                                     │
  │  Ctrl+C to stop                     │
  └─────────────────────────────────────┘
`);
}
