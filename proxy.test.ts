/**
 * Test suite for proxy.ts
 *
 * Run with: bun test
 *
 * No external packages required — uses bun:test built-ins.
 * External network calls (Yahoo Finance, CoinGecko) are intercepted by
 * replacing globalThis.fetch with a mock per test. Real fetch is used only
 * for integration tests making requests to localhost:8000.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	test,
} from "bun:test";

import {
	clearCache,
	fetchCryptoBatch,
	fetchStockQuote,
	getCache,
	handleQuotesBatch,
	type NormalizedQuote,
	server,
	setCache,
} from "./proxy";

// ─── Shared helpers ───────────────────────────────────────────────────────────

const BASE_URL = `http://localhost:${server.port}`;
const originalFetch = globalThis.fetch;

// Suppress console.error for the entire test run (expected error paths produce
// intentional server-side logs that would otherwise clutter the output).
const originalConsoleError = console.error;
beforeAll(() => {
	console.error = () => {};
});
afterAll(() => {
	console.error = originalConsoleError;
	server.stop(true);
});

/** Fake Yahoo Finance chart API response. */
function yahooResponse(
	price: number,
	previousClose: number | undefined,
	chartPreviousClose: number | undefined,
	currency: string,
): Response {
	const meta: Record<string, unknown> = { regularMarketPrice: price, currency };
	if (previousClose !== undefined) meta.previousClose = previousClose;
	if (chartPreviousClose !== undefined)
		meta.chartPreviousClose = chartPreviousClose;
	return new Response(JSON.stringify({ chart: { result: [{ meta }] } }), {
		headers: { "Content-Type": "application/json" },
	});
}

/** Fake CoinGecko simple price response. */
function coinGeckoResponse(
	data: Record<string, { eur: number; eur_24h_change: number }>,
): Response {
	return new Response(JSON.stringify(data), {
		headers: { "Content-Type": "application/json" },
	});
}

type YahooFixture = {
	price: number;
	prevClose?: number;
	chartPrevClose?: number;
	currency: string;
};

/**
 * Replace globalThis.fetch with a mock that intercepts Yahoo Finance and
 * CoinGecko URLs using the provided fixtures. All other URLs (e.g.
 * localhost:8000) are passed through to the real fetch.
 */
function mockExternalFetch(
	yahooFixtures: Record<string, YahooFixture> = {},
	coinGeckoFixtures: Record<
		string,
		{ eur: number; eur_24h_change: number }
	> = {},
): void {
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input.toString();

			if (url.includes("finance.yahoo.com")) {
				const match = url.match(/chart\/([^?]+)/);
				const ticker = match ? decodeURIComponent(match[1]) : "";
				const f = yahooFixtures[ticker];
				if (f) {
					return yahooResponse(
						f.price,
						f.prevClose,
						f.chartPrevClose,
						f.currency,
					);
				}
				return new Response(null, { status: 404 });
			}

			if (url.includes("coingecko.com")) {
				return coinGeckoResponse(coinGeckoFixtures);
			}

			// Integration tests: pass localhost requests through.
			return originalFetch(input, init);
		},
	) as typeof globalThis.fetch;
}

function restoreFetch(): void {
	globalThis.fetch = originalFetch;
}

// ─── Group 1: Cache ───────────────────────────────────────────────────────────

describe("Cache", () => {
	beforeEach(() => clearCache());
	afterEach(() => setSystemTime()); // reset fake clock

	test("miss — returns null for unknown key", () => {
		expect(getCache("nonexistent")).toBeNull();
	});

	test("hit — returns stored value", () => {
		setCache("k", { x: 42 });
		expect(getCache("k")).toEqual({ x: 42 });
	});

	test("expired entry — returns null after TTL elapses", () => {
		setCache("expire", "hello", 1_000);
		expect(getCache("expire")).toBe("hello");
		setSystemTime(new Date(Date.now() + 2_000));
		expect(getCache("expire")).toBeNull();
	});

	test("custom TTL — still valid just before expiry, null just after", () => {
		const now = Date.now();
		setSystemTime(new Date(now));
		setCache("short", "v", 500);

		setSystemTime(new Date(now + 400));
		expect(getCache("short")).toBe("v");

		setSystemTime(new Date(now + 600));
		expect(getCache("short")).toBeNull();
	});

	test("clearCache — previously set key becomes a miss", () => {
		setCache("c", 99);
		clearCache();
		expect(getCache("c")).toBeNull();
	});
});

// ─── Group 2: fetchStockQuote ─────────────────────────────────────────────────

describe("fetchStockQuote", () => {
	beforeEach(() => clearCache());
	afterEach(restoreFetch);

	test("EUR asset — price returned unchanged", async () => {
		mockExternalFetch({
			"VWCE.DE": { price: 120, prevClose: 118, currency: "EUR" },
		});
		const q = await fetchStockQuote("VWCE.DE");
		expect(q.error).toBeUndefined();
		expect(q.priceEur).toBeCloseTo(120);
		expect(q.previousCloseEur).toBeCloseTo(118);
	});

	test("GBp asset — divides price by 100 then applies GBP→EUR FX", async () => {
		// 9000 GBp → 90 GBP → 90 × 1.17 = 105.30 EUR
		mockExternalFetch({
			"CSPX.L": { price: 9000, prevClose: 8900, currency: "GBp" },
			"GBPEUR=X": { price: 1.17, currency: "EUR" },
		});
		const q = await fetchStockQuote("CSPX.L");
		expect(q.error).toBeUndefined();
		expect(q.priceEur).toBeCloseTo(90 * 1.17, 4);
		expect(q.previousCloseEur).toBeCloseTo(89 * 1.17, 4);
	});

	test("USD asset — USD→EUR FX rate applied", async () => {
		mockExternalFetch({
			AAPL: { price: 200, prevClose: 195, currency: "USD" },
			"USDEUR=X": { price: 0.93, currency: "EUR" },
		});
		const q = await fetchStockQuote("AAPL");
		expect(q.error).toBeUndefined();
		expect(q.priceEur).toBeCloseTo(200 * 0.93, 4);
		expect(q.previousCloseEur).toBeCloseTo(195 * 0.93, 4);
	});

	test("HTTP error from Yahoo — returns zeroed quote with error field", async () => {
		globalThis.fetch = mock(
			async () => new Response(null, { status: 429 }),
		) as typeof globalThis.fetch;
		const q = await fetchStockQuote("FAIL.DE");
		expect(q.priceEur).toBe(0);
		expect(q.previousCloseEur).toBe(0);
		expect(q.error).toContain("429");
	});

	test("null result in response — returns zeroed quote with error field", async () => {
		globalThis.fetch = mock(
			async () => new Response(JSON.stringify({ chart: { result: null } })),
		) as typeof globalThis.fetch;
		const q = await fetchStockQuote("NULL.DE");
		expect(q.priceEur).toBe(0);
		expect(q.error).toBeDefined();
	});

	test("previousClose falls back to chartPreviousClose", async () => {
		mockExternalFetch({
			"CHART.DE": { price: 50, chartPrevClose: 48, currency: "EUR" },
		});
		const q = await fetchStockQuote("CHART.DE");
		expect(q.previousCloseEur).toBeCloseTo(48);
	});

	test("previousClose falls back to current price when both fields absent", async () => {
		mockExternalFetch({
			"NOPREV.DE": { price: 55, currency: "EUR" },
		});
		const q = await fetchStockQuote("NOPREV.DE");
		expect(q.previousCloseEur).toBeCloseTo(55);
	});
});

// ─── Group 3: fetchCryptoBatch ────────────────────────────────────────────────

describe("fetchCryptoBatch", () => {
	beforeEach(() => clearCache());
	afterEach(restoreFetch);

	test("previousClose reconstructed from positive 24h change", async () => {
		// price=110, change=+10% → prevClose = 110 / 1.10 ≈ 100
		mockExternalFetch({}, { bitcoin: { eur: 110, eur_24h_change: 10 } });
		const result = await fetchCryptoBatch(["bitcoin"]);
		const btc = result.get("bitcoin");
		expect(btc?.priceEur).toBeCloseTo(110);
		expect(btc?.previousCloseEur).toBeCloseTo(100, 3);
	});

	test("previousClose equals price when 24h change is zero", async () => {
		mockExternalFetch({}, { ethereum: { eur: 3000, eur_24h_change: 0 } });
		const result = await fetchCryptoBatch(["ethereum"]);
		expect(result.get("ethereum")?.previousCloseEur).toBeCloseTo(3000);
	});

	test("previousClose reconstructed from negative 24h change", async () => {
		// price=50, change=-50% → prevClose = 50 / 0.50 = 100
		mockExternalFetch({}, { solana: { eur: 50, eur_24h_change: -50 } });
		const result = await fetchCryptoBatch(["solana"]);
		expect(result.get("solana")?.previousCloseEur).toBeCloseTo(100, 3);
	});

	test("unknown coin ID — entry has error field and zero prices", async () => {
		mockExternalFetch({}, {}); // empty CoinGecko response
		const result = await fetchCryptoBatch(["fakecoin"]);
		const coin = result.get("fakecoin");
		expect(coin?.priceEur).toBe(0);
		expect(coin?.previousCloseEur).toBe(0);
		expect(coin?.error).toContain("fakecoin");
	});

	test("HTTP error from CoinGecko — throws", async () => {
		globalThis.fetch = mock(
			async () => new Response(null, { status: 429 }),
		) as typeof globalThis.fetch;
		expect(fetchCryptoBatch(["bitcoin"])).rejects.toThrow("429");
	});

	test("cache key is order-independent — second call is served from cache", async () => {
		mockExternalFetch(
			{},
			{
				bitcoin: { eur: 60000, eur_24h_change: 1 },
				ethereum: { eur: 3000, eur_24h_change: 2 },
			},
		);
		await fetchCryptoBatch(["bitcoin", "ethereum"]);
		const callsAfterFirst = (globalThis.fetch as ReturnType<typeof mock>).mock
			.calls.length;

		// Reversed order — same sorted cache key, should NOT make a new request.
		await fetchCryptoBatch(["ethereum", "bitcoin"]);
		expect(
			(globalThis.fetch as ReturnType<typeof mock>).mock.calls.length,
		).toBe(callsAfterFirst);
	});
});

// ─── Group 4: handleQuotesBatch ───────────────────────────────────────────────

describe("handleQuotesBatch", () => {
	beforeEach(() => clearCache());
	afterEach(restoreFetch);

	test("preserves original order for mixed crypto + stock", async () => {
		mockExternalFetch(
			{ "VWCE.DE": { price: 100, prevClose: 98, currency: "EUR" } },
			{ bitcoin: { eur: 60000, eur_24h_change: 1 } },
		);
		const results = await handleQuotesBatch(
			["bitcoin", "VWCE.DE"],
			["crypto", "etf"],
		);
		expect(results[0].ticker).toBe("bitcoin");
		expect(results[1].ticker).toBe("VWCE.DE");
	});

	test("all crypto — no Yahoo Finance requests made", async () => {
		mockExternalFetch(
			{},
			{
				bitcoin: { eur: 60000, eur_24h_change: 0 },
				ethereum: { eur: 3000, eur_24h_change: 0 },
			},
		);
		await handleQuotesBatch(["bitcoin", "ethereum"], ["crypto", "crypto"]);
		const calls = (globalThis.fetch as ReturnType<typeof mock>).mock.calls;
		const yahooHit = calls.some(([url]) =>
			url.toString().includes("finance.yahoo.com"),
		);
		expect(yahooHit).toBe(false);
	});

	test("all stocks — no CoinGecko requests made", async () => {
		mockExternalFetch({
			"VWCE.DE": { price: 100, prevClose: 99, currency: "EUR" },
		});
		await handleQuotesBatch(["VWCE.DE"], ["etf"]);
		const calls = (globalThis.fetch as ReturnType<typeof mock>).mock.calls;
		const geckoHit = calls.some(([url]) =>
			url.toString().includes("coingecko.com"),
		);
		expect(geckoHit).toBe(false);
	});

	test("unknown stock — fallback error quote returned in correct position", async () => {
		// No fixtures → Yahoo returns 404 → fetchStockQuote catches and returns error quote.
		mockExternalFetch({});
		const results = await handleQuotesBatch(["UNKNOWN.DE"], ["etf"]);
		expect(results[0].ticker).toBe("UNKNOWN.DE");
		expect(results[0].priceEur).toBe(0);
		expect(results[0].error).toBeDefined();
	});

	test("unknown crypto — fallback error quote returned in correct position", async () => {
		mockExternalFetch({}, {}); // coin absent from CoinGecko response
		const results = await handleQuotesBatch(["ghostcoin"], ["crypto"]);
		expect(results[0].ticker).toBe("ghostcoin");
		expect(results[0].priceEur).toBe(0);
		expect(results[0].error).toBeDefined();
	});
});

// ─── Group 5: HTTP routes (integration) ──────────────────────────────────────

describe("HTTP routes", () => {
	beforeEach(() => clearCache());
	afterEach(restoreFetch);

	test("GET / → 200 with Content-Type text/html", async () => {
		const res = await originalFetch(`${BASE_URL}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
	});

	test("GET /portfolio → 200 with JSON containing assets array", async () => {
		const res = await originalFetch(`${BASE_URL}/portfolio`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { assets: unknown[] };
		expect(Array.isArray(body.assets)).toBe(true);
	});

	test("GET /quotes — missing tickers param → 400", async () => {
		const res = await originalFetch(`${BASE_URL}/quotes`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("missing tickers");
	});

	test("GET /quotes — tickers/types length mismatch → 400", async () => {
		const res = await originalFetch(
			`${BASE_URL}/quotes?tickers=VWCE.DE,bitcoin&types=etf`,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("mismatch");
	});

	test("GET /quotes — valid ETF ticker → 200 with NormalizedQuote[]", async () => {
		mockExternalFetch({
			"VWCE.DE": { price: 120, prevClose: 118, currency: "EUR" },
		});
		const res = await originalFetch(
			`${BASE_URL}/quotes?tickers=VWCE.DE&types=etf`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as NormalizedQuote[];
		expect(Array.isArray(body)).toBe(true);
		expect(body[0].ticker).toBe("VWCE.DE");
		expect(body[0].priceEur).toBeGreaterThan(0);
	});

	test("GET /quotes — valid crypto ticker → 200 with NormalizedQuote[]", async () => {
		mockExternalFetch({}, { bitcoin: { eur: 60000, eur_24h_change: 2 } });
		const res = await originalFetch(
			`${BASE_URL}/quotes?tickers=bitcoin&types=crypto`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as NormalizedQuote[];
		expect(body[0].ticker).toBe("bitcoin");
		expect(body[0].priceEur).toBeGreaterThan(0);
	});

	test("GET /unknown → 404", async () => {
		const res = await originalFetch(`${BASE_URL}/this-does-not-exist`);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("not found");
	});
});
