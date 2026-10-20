import { afterEach, describe, expect, it, vi } from "vitest";
import { stripeKey } from "../../scripts/make-fixture.mjs";
import { stripe } from "../../src/connectors/stripe.js";
import type { CheckContext } from "../../src/connectors/types.js";
import { parseEnv } from "../../src/env/parse.js";
import { createSafeFetch, SafeFetchError, type SafeRequest } from "../../src/net/safeFetch.js";
import { Secret } from "../../src/secret.js";
import { mockFetch } from "../helpers.js";

afterEach(() => vi.unstubAllGlobals());

/** Context whose fetch is the real safeFetch, wrapped to record every request it is asked to make. */
function ctx(offline: boolean): CheckContext & { requests: SafeRequest[] } {
  const real = createSafeFetch(stripe.allowlist);
  const requests: SafeRequest[] = [];
  return {
    offline,
    requests,
    fetch: (req) => {
      requests.push(req);
      return real(req);
    },
  };
}

const key = (value: string): Secret => {
  const found = stripe.detect(parseEnv(`STRIPE_KEY=${value}`, ".env"));
  expect(found).toHaveLength(1);
  return found[0]!;
};

const SK_LIVE = stripeKey("sk", "live", "FAKEFAKEFAKEFAKE0001");
const SK_TEST = stripeKey("sk", "test", "FAKEFAKEFAKEFAKE0002");
const RK_LIVE = stripeKey("rk", "live", "FAKEFAKEFAKEFAKE0003");
const RK_TEST = stripeKey("rk", "test", "FAKEFAKEFAKEFAKE0004");
const PK_LIVE = stripeKey("pk", "live", "FAKEFAKEFAKEFAKE0005");
const PK_TEST = stripeKey("pk", "test", "FAKEFAKEFAKEFAKE0006");

const byPath = (map: Record<string, number | "neterr">) =>
  vi.stubGlobal(
    "fetch",
    vi.fn((input: URL | string) => {
      const r = map[new URL(String(input)).pathname] ?? 500;
      return r === "neterr" ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve(new Response("", { status: r }));
    }),
  );

describe("stripe connector: detect", () => {
  it("detects sk, rk and pk keys by value, under any env var name", () => {
    const env = parseEnv(
      [`A=${SK_LIVE}`, `B=${SK_TEST}`, `C=${RK_LIVE}`, `D=${RK_TEST}`, `E=${PK_LIVE}`, `F=${PK_TEST}`].join("\n"),
      ".env",
    );
    expect(stripe.detect(env).map((s) => s.kind)).toEqual([
      "secret live key",
      "secret test key",
      "restricted live key",
      "restricted test key",
      "publishable live key",
      "publishable test key",
    ]);
  });

  it("ignores look-alikes and webhook secrets", () => {
    const env = parseEnv(
      `A=sk_live_short\nB=${["sk", "prod", "FAKEFAKEFAKEFAKE"].join("_")}\nC=whsec_FAKEFAKEFAKEFAKE\nD=x${stripeKey("sk", "live", "FAKEFAKEFAKEFAKE")}`,
      ".env",
    );
    expect(stripe.detect(env)).toHaveLength(0);
  });

  it("binds every key to api.stripe.com only", () => {
    expect(key(SK_LIVE).allowedHosts).toEqual(["api.stripe.com"]);
  });
});

describe("stripe connector: allowlist", () => {
  it("is GET-only on api.stripe.com", () => {
    for (const rule of stripe.allowlist.rules) {
      expect(rule).toMatchObject({ method: "GET", host: "api.stripe.com" });
    }
  });

  it("rejects anything that could write, before any connection is opened", async () => {
    const fetch = createSafeFetch(stripe.allowlist);
    const s = key(SK_LIVE);
    const calls = mockFetch();
    await expect(fetch({ method: "POST", url: "https://api.stripe.com/v1/refunds", secret: s })).rejects.toBeInstanceOf(
      SafeFetchError,
    );
    await expect(fetch({ method: "GET", url: "https://api.stripe.com/v1/payouts", secret: s })).rejects.toMatchObject({
      code: "not_allowlisted",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("stripe connector: every request", () => {
  it.each([SK_LIVE, SK_TEST, RK_LIVE, RK_TEST])("%s: GET, api.stripe.com, body discarded", async (v) => {
    mockFetch(() => ({ status: 200 }));
    const c = ctx(false);
    await stripe.check(key(v), c);
    expect(c.requests.length).toBeGreaterThan(0);
    for (const r of c.requests) {
      expect(r).toMatchObject({ method: "GET", discardBody: true });
      expect(new URL(r.url).hostname).toBe("api.stripe.com");
    }
  });
});

describe("stripe connector: secret keys", () => {
  it("offline: live is red and test is amber, without network", async () => {
    const calls = mockFetch();
    expect((await stripe.check(key(SK_LIVE), ctx(true)))[0]).toMatchObject({ level: "red", confidence: "inferred" });
    expect((await stripe.check(key(SK_TEST), ctx(true)))[0]).toMatchObject({
      level: "amber",
      capabilities: { move_money: false },
    });
    expect(calls).toHaveLength(0);
  });

  it("confirms a live key with one GET to /v1/balance (no query string)", async () => {
    const calls = mockFetch(() => ({ status: 200, body: { available: [{ amount: 123 }] } }));
    const [f] = await stripe.check(key(SK_LIVE), ctx(false));
    expect(f).toMatchObject({ level: "red", confidence: "confirmed", capabilities: { move_money: true } });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "https://api.stripe.com/v1/balance"]]);
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SK_LIVE}`);
  });

  it("confirms a test key online as amber", async () => {
    mockFetch(() => ({ status: 200 }));
    expect((await stripe.check(key(SK_TEST), ctx(false)))[0]).toMatchObject({
      level: "amber",
      confidence: "confirmed",
      capabilities: { move_money: false },
    });
  });

  it("401 is never a confirmed green: live stays amber/unknown, test is green/inferred", async () => {
    mockFetch(() => ({ status: 401 }));
    expect((await stripe.check(key(SK_LIVE), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
    expect((await stripe.check(key(SK_TEST), ctx(false)))[0]).toMatchObject({ level: "green", confidence: "inferred" });
  });

  it("stays red but unknown on rate limits, server errors and network failures", async () => {
    for (const status of [429, 500]) {
      mockFetch(() => ({ status }));
      expect((await stripe.check(key(SK_LIVE), ctx(false)))[0]).toMatchObject({ level: "red", confidence: "unknown" });
    }
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNRESET"))));
    expect((await stripe.check(key(SK_LIVE), ctx(false)))[0]).toMatchObject({ level: "red", confidence: "unknown" });
  });

  it("a blocked request keeps the format-based level instead of downgrading it", async () => {
    const calls = mockFetch();
    const blocked: CheckContext = {
      offline: false,
      fetch: createSafeFetch({ connector: "stripe", rules: [] }),
    };
    expect((await stripe.check(key(SK_LIVE), blocked))[0]).toMatchObject({ level: "red", confidence: "unknown" });
    expect(calls).toHaveLength(0);
  });
});

describe("stripe connector: restricted keys", () => {
  it("offline: amber and unknown", async () => {
    const calls = mockFetch();
    expect((await stripe.check(key(RK_LIVE), ctx(true)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
    expect(calls).toHaveLength(0);
  });

  it("probes balance without params and the list endpoints with limit=1", async () => {
    const calls = mockFetch(() => ({ status: 403 }));
    await stripe.check(key(RK_LIVE), ctx(false));
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.stripe.com/v1/balance",
      "https://api.stripe.com/v1/charges?limit=1",
      "https://api.stripe.com/v1/customers?limit=1",
    ]);
  });

  it("live key with any read access is red/confirmed, and write is always unknown", async () => {
    byPath({ "/v1/balance": 403, "/v1/charges": 200, "/v1/customers": 403 });
    const [f] = await stripe.check(key(RK_LIVE), ctx(false));
    expect(f).toMatchObject({
      level: "red",
      confidence: "confirmed",
      capabilities: { read: true, read_balance: false, read_charges: true, read_customers: false, write: "unknown" },
    });
  });

  it("all 403 is NOT green: the key may be write-only", async () => {
    byPath({ "/v1/balance": 403, "/v1/charges": 403, "/v1/customers": 403 });
    const [f] = await stripe.check(key(RK_LIVE), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown", capabilities: { read: false, write: "unknown" } });
  });

  it.each([429, 500])("%s on every probe: amber/unknown, read unknown", async (status) => {
    mockFetch(() => ({ status }));
    const [f] = await stripe.check(key(RK_LIVE), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown", capabilities: { read: "unknown" } });
    expect(f!.message).toContain(`Some read probes failed (Stripe answered ${status})`);
  });

  it("a blocked probe says so instead of looking like a network failure", async () => {
    const calls = mockFetch();
    const blocked: CheckContext = { offline: false, fetch: createSafeFetch({ connector: "stripe", rules: [] }) };
    const [f] = await stripe.check(key(RK_LIVE), blocked);
    expect(f).toMatchObject({ level: "amber", confidence: "unknown", capabilities: { read: "unknown" } });
    expect(f!.message).toContain("Some read probes failed (check blocked)");
    expect(f!.message).not.toContain("could not reach");
    expect(calls).toHaveLength(0);
  });

  it("network failure on every probe: amber/unknown", async () => {
    byPath({ "/v1/balance": "neterr", "/v1/charges": "neterr", "/v1/customers": "neterr" });
    expect((await stripe.check(key(RK_LIVE), ctx(false)))[0]).toMatchObject({
      level: "amber",
      confidence: "unknown",
      capabilities: { read: "unknown" },
    });
  });

  it("partial failure keeps a read that already succeeded", async () => {
    byPath({ "/v1/balance": 200, "/v1/charges": "neterr", "/v1/customers": 401 });
    const [f] = await stripe.check(key(RK_LIVE), ctx(false));
    expect(f).toMatchObject({
      level: "red",
      capabilities: { read: true, read_balance: true, read_charges: "unknown", read_customers: "unknown" },
    });
  });

  it("test key with read access is amber with no real money", async () => {
    mockFetch(() => ({ status: 200 }));
    expect((await stripe.check(key(RK_TEST), ctx(false)))[0]).toMatchObject({
      level: "amber",
      confidence: "confirmed",
      capabilities: { move_money: false },
    });
  });

  it("401 on the first probe stops probing and is not a confirmed green", async () => {
    const calls = mockFetch(() => ({ status: 401 }));
    expect((await stripe.check(key(RK_LIVE), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
    expect(calls).toHaveLength(1);
  });
});

describe("stripe connector: publishable keys", () => {
  it.each([PK_LIVE, PK_TEST])("%s is green and never touches the network", async (v) => {
    const calls = mockFetch();
    expect((await stripe.check(key(v), ctx(false)))[0]).toMatchObject({ level: "green" });
    expect(calls).toHaveLength(0);
  });
});

describe("stripe connector: unrecognised kind", () => {
  it("is amber/unknown and makes no calls", async () => {
    const calls = mockFetch();
    const s = new Secret({ connector: "stripe", envKey: "K", source: ".env", value: "x", allowedHosts: ["api.stripe.com"] });
    expect((await stripe.check(s, ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
    expect(calls).toHaveLength(0);
  });
});

describe("stripe connector: findings never contain the key", () => {
  it.each([SK_LIVE, SK_TEST, RK_LIVE, RK_TEST, PK_LIVE])("%s", async (v) => {
    for (const status of [200, 401, 403, 500]) {
      mockFetch(() => ({ status, body: { echoed: v } }));
      const findings = await stripe.check(key(v), ctx(false));
      expect(JSON.stringify(findings)).not.toContain("FAKEFAKE");
    }
  });
});
