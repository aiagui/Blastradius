import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leakedFinding, teamFinding, vercel, vercelKind } from "../../src/connectors/vercel.js";
import { rollUp } from "../../src/risk/aggregate.js";
import { parseEnv } from "../../src/env/parse.js";
import { createSafeFetch, SafeFetchError } from "../../src/net/safeFetch.js";
import type { Secret } from "../../src/secret.js";
import { mockFetch, type RecordedCall } from "../helpers.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/vercel/${name}`, import.meta.url), "utf8")) as unknown;
}

const T = {
  pat: "vcp_FAKEvercelPAT000000000000001",
  integration: "vci_FAKEvercelINTEGRATION0000001",
  app: "vca_FAKEvercelAPPACCESS00000000001",
  refresh: "vcr_FAKEvercelREFRESH000000000001",
  legacy: "FAKEvercelLEGACY00000001",
} as const;

const ctx = (offline: boolean) => ({ fetch: createSafeFetch(vercel.allowlist), offline });

function one(value: string, key = "VERCEL_TOKEN"): Secret {
  const found = vercel.detect(parseEnv(`${key}=${value}`, ".env"));
  expect(found).toHaveLength(1);
  return found[0]!;
}

function expectNoSecret(out: unknown, ...values: string[]): void {
  const text = JSON.stringify(out) + inspect(out, { depth: 10 });
  for (const v of values) expect(text).not.toContain(v);
}

type Canned = { status: number; body?: unknown };

/** Routes the three allowlisted endpoints to canned responses. */
function api(token: Canned, rest: { user?: Canned; team?: Canned } = {}): RecordedCall[] {
  return mockFetch((call) => {
    const path = new URL(call.url).pathname;
    if (path === "/v5/user/tokens/current") return token;
    if (path === "/v2/user" && rest.user) return rest.user;
    if (path.startsWith("/v2/teams/") && rest.team) return rest.team;
    return { status: 599 };
  });
}

describe("vercel: detection", () => {
  it("detects documented prefixes in any env var", () => {
    const env = parseEnv([`A=${T.pat}`, `B=${T.integration}`, `C=${T.app}`, `D=${T.refresh}`].join("\n"), ".env");
    expect(vercel.detect(env).map((s) => s.kind)).toEqual([
      "personal access token",
      "integration token",
      "app access token",
      "app refresh token",
    ]);
  });

  it("detects legacy 24-char tokens only under Vercel env names", () => {
    expect(one(T.legacy, "VERCEL_TOKEN").kind).toBe("legacy token");
    expect(one(T.legacy, "VERCEL_ACCESS_TOKEN").kind).toBe("legacy token");
    expect(vercel.detect(parseEnv(`RANDOM_ID=${T.legacy}`, ".env"))).toHaveLength(0);
  });

  it("ignores AI Gateway keys, short values and other providers", () => {
    const env = parseEnv("VERCEL_TOKEN=short\nX=vck_FAKEvercelAIGATEWAY00000001\nY=vcp_short\nZ=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ".env");
    expect(vercel.detect(env)).toHaveLength(0);
  });

  it("binds every secret to api.vercel.com only and prints only the public prefix", () => {
    const s = one(T.pat);
    expect(s.allowedHosts).toEqual(["api.vercel.com"]);
    expect(s.hint()).toBe(`vcp_… (${String(T.pat.length)} chars)`);
    expect(one(T.legacy).hint()).toBe("… (24 chars)");
  });

  it("vercelKind falls back to legacy", () => {
    expect(vercelKind("abc")).toBe("legacy token");
  });
});

describe("vercel: team roles", () => {
  it.each([
    ["team-owner.json", "red"],
    ["team-member.json", "red"],
    ["team-developer.json", "amber"],
    ["team-developer-fullprod.json", "red"],
    ["team-billing.json", "amber"],
    ["team-viewer.json", "amber"],
    ["team-viewer-for-plus.json", "green"],
  ] as const)("%s -> %s", (file, level) => {
    expect(teamFinding(fixture(file))).toMatchObject({ level, confidence: "confirmed", identity: "team acme" });
  });

  it("an unknown role or shape is not rated", () => {
    expect(teamFinding(fixture("team-unknown-role.json"))).toBeUndefined();
    expect(teamFinding({})).toBeUndefined();
    expect(teamFinding(null)).toBeUndefined();
  });
});

describe("vercel: live checks (mocked)", () => {
  it("full-account token is red/confirmed with the username", async () => {
    const calls = api({ status: 200, body: fixture("token-user-scope.json") }, { user: { status: 200, body: fixture("user.json") } });
    const fs = await vercel.check(one(T.pat), ctx(false));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ level: "red", confidence: "confirmed", identity: "user jdoe" });
    expect(fs[0]!.capabilities).toMatchObject({ delete_projects: true, deploy_production: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.vercel.com/v5/user/tokens/current",
      "GET https://api.vercel.com/v2/user",
    ]);
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${T.pat}`);
    // Token suffix and email from the fixtures never reach findings.
    expect(JSON.stringify(fs)).not.toMatch(/abc123|me@example\.com/);
  });

  it("full-account token stays red if /v2/user fails", async () => {
    api({ status: 200, body: fixture("token-user-scope.json") }, { user: { status: 500 } });
    const [f] = await vercel.check(one(T.pat), ctx(false));
    expect(f).toMatchObject({ level: "red", confidence: "confirmed" });
    expect(f!.identity).toBeUndefined();
  });

  it.each([
    ["team-owner.json", "red"],
    ["team-member.json", "red"],
    ["team-developer.json", "amber"],
    ["team-viewer-for-plus.json", "green"],
  ] as const)("team-scoped token with %s -> %s", async (file, level) => {
    const calls = api({ status: 200, body: fixture("token-team-scope.json") }, { team: { status: 200, body: fixture(file) } });
    const fs = await vercel.check(one(T.integration), ctx(false));
    expect(fs).toEqual([expect.objectContaining({ level, confidence: "confirmed", identity: "team acme" })]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.vercel.com/v5/user/tokens/current",
      "https://api.vercel.com/v2/teams/team_acme123",
    ]);
  });

  it("team with unknown role or failed team lookup is amber/unknown", async () => {
    api({ status: 200, body: fixture("token-team-scope.json") }, { team: { status: 200, body: fixture("team-unknown-role.json") } });
    expect((await vercel.check(one(T.pat), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
    api({ status: 200, body: fixture("token-team-scope.json") }, { team: { status: 403, body: fixture("forbidden.json") } });
    expect((await vercel.check(one(T.pat), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("checks at most 3 teams (<= 4 calls) and reports the rest as unknown", async () => {
    const scopes = ["a", "b", "c", "d", "e"].map((x) => ({ type: "team", teamId: `team_${x}`, createdAt: 1 }));
    const calls = api({ status: 200, body: { token: { id: "t", scopes } } }, { team: { status: 200, body: fixture("team-viewer-for-plus.json") } });
    const fs = await vercel.check(one(T.pat), ctx(false));
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls).toHaveLength(4);
    expect(fs.at(-1)).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("team ids that are not well-formed are never put in a URL", async () => {
    const calls = api({ status: 200, body: { token: { id: "t", scopes: [{ type: "team", teamId: "../../v9/projects", createdAt: 1 }] } } });
    const fs = await vercel.check(one(T.pat), ctx(false));
    expect(calls).toHaveLength(1);
    expect(fs[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("leakedAt adds a separate red finding; leakedUrl is not reported", async () => {
    api({ status: 200, body: fixture("token-leaked.json") }, { user: { status: 200, body: fixture("user.json") } });
    const fs = await vercel.check(one(T.pat), ctx(false));
    expect(fs).toHaveLength(2);
    expect(fs[0]).toMatchObject({ level: "red", confidence: "confirmed", message: expect.stringContaining("leaked (on 2025-10-01)") as unknown });
    expect(JSON.stringify(fs)).not.toContain("someone/repo");
  });

  it("leak flag survives a network failure on a later call", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        n++ === 0
          ? Promise.resolve(new Response(JSON.stringify({ token: { id: "t", leakedAt: 1759276800000, scopes: [{ type: "team", teamId: "team_x", createdAt: 1 }] } }), { status: 200 }))
          : Promise.reject(new Error("down")),
      ),
    );
    const fs = await vercel.check(one(T.pat), ctx(false));
    expect(fs.map((f) => [f.level, f.confidence])).toEqual([
      ["red", "confirmed"],
      ["amber", "unknown"],
    ]);
  });

  describe("a confirmed leak survives any later team-lookup failure", () => {
    const LEAKED_TEAM = { token: { id: "t", leakedAt: 1759276800000, scopes: [{ type: "team", teamId: "team_acme123", createdAt: 1 }] } };
    const huge = "x".repeat(1024 * 1024 + 10);

    it.each([
      ["non-2xx (500)", { status: 500 }],
      ["redirect (302)", { status: 302 }],
      ["unexpected body", { status: 200, body: { nope: true } }],
      ["body over 1 MB (SafeFetchError body_too_large)", { status: 200, body: huge }],
    ] as const)("%s", async (_name, team) => {
      api({ status: 200, body: LEAKED_TEAM }, { team });
      const fs = await vercel.check(one(T.pat), ctx(false));
      expect(fs[0]).toMatchObject({ level: "red", confidence: "confirmed", message: expect.stringContaining("leaked") as unknown });
      expect(fs[1]).toMatchObject({ level: "amber", confidence: "unknown" });
      expect(rollUp(fs)).toEqual({ level: "red", confidence: "confirmed" });
    });

    it("a non-network SafeFetchError thrown by the team probe is caught, not rethrown", async () => {
      let n = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          n++ === 0
            ? Promise.resolve(new Response(JSON.stringify(LEAKED_TEAM), { status: 200 }))
            : Promise.resolve(new Response(huge, { status: 200 })),
        ),
      );
      const fs = await vercel.check(one(T.pat), ctx(false));
      expect(fs.map((f) => [f.level, f.confidence])).toEqual([
        ["red", "confirmed"],
        ["amber", "unknown"],
      ]);
      expect(fs[1]!.message).toContain("team lookup failed");
      expect(rollUp(fs).level).toBe("red");
    });

    it("a failing /v2/user call never drops the full-account red or the leak", async () => {
      api({ status: 200, body: fixture("token-leaked.json") }, { user: { status: 200, body: huge } });
      const fs = await vercel.check(one(T.pat), ctx(false));
      expect(fs.map((f) => [f.level, f.confidence])).toEqual([
        ["red", "confirmed"],
        ["red", "confirmed"],
      ]);
    });
  });

  describe("leakedAt dates", () => {
    it.each([1e20, -1e20, 8.64e15 + 1])("out-of-range %d still yields a red leak finding without a date", (value) => {
      expect(() => leakedFinding(value)).not.toThrow();
      expect(leakedFinding(value)).toMatchObject({ level: "red", confidence: "confirmed", message: "Vercel has flagged this token as leaked." });
    });

    it("a valid timestamp includes the day", () => {
      expect(leakedFinding(1759276800000).message).toBe("Vercel has flagged this token as leaked (on 2025-10-01).");
    });

    it("an out-of-range leakedAt from the API does not break the check", async () => {
      api({ status: 200, body: { token: { id: "t", leakedAt: 1e20, scopes: [{ type: "user", createdAt: 1 }] } } }, { user: { status: 200, body: fixture("user.json") } });
      const fs = await vercel.check(one(T.pat), ctx(false));
      expect(fs[0]).toMatchObject({ level: "red", confidence: "confirmed", message: "Vercel has flagged this token as leaked." });
      expect(fs[1]).toMatchObject({ level: "red", confidence: "confirmed", identity: "user jdoe" });
    });
  });

  it("no recognised scope is amber/unknown", async () => {
    api({ status: 200, body: fixture("token-no-scopes.json") });
    expect((await vercel.check(one(T.pat), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
    api({ status: 200, body: { unexpected: true } });
    expect((await vercel.check(one(T.pat), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it.each([
    ["401", { status: 401 }],
    ["403 with invalidToken", { status: 403, body: fixture("invalid-token.json") }],
  ] as const)("%s means rejected: green with confidence inferred, not confirmed", async (_name, res) => {
    for (const value of [T.pat, T.legacy]) {
      api(res);
      const fs = await vercel.check(one(value), ctx(false));
      expect(fs).toHaveLength(1);
      expect(fs[0]!.level).toBe("green");
      expect(fs[0]!.confidence).toBe("inferred");
      expect(fs[0]!.message).toBe("Vercel rejected this token: revoked, expired or invalid.");
      expect(fs[0]!.advice).toContain("Account Settings > Tokens");
    }
  });

  it.each([403, 404, 429, 500, 302])("status %i (without invalidToken) is amber/unknown", async (status) => {
    api({ status, body: fixture("forbidden.json") });
    expect((await vercel.check(one(T.pat), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("network failure and timeout are amber/unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error(`${T.pat} ECONNREFUSED`))));
    const [f] = await vercel.check(one(T.pat), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown" });
    expectNoSecret(f, T.pat);
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(timeout)));
    expect((await vercel.check(one(T.pat), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("refresh tokens are never sent, even online", async () => {
    const calls = mockFetch();
    const [f] = await vercel.check(one(T.refresh), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "inferred" });
    expect(calls).toHaveLength(0);
  });

  it("offline makes zero fetches and never reports green", async () => {
    const calls = mockFetch();
    for (const value of Object.values(T)) {
      const [f] = await vercel.check(one(value), ctx(true));
      expect(f).toMatchObject({ level: "amber", confidence: "inferred" });
      expectNoSecret(f, value);
    }
    expect(calls).toHaveLength(0);
  });

  it("a provider echoing the token as username or slug does not put it in a finding", async () => {
    for (const value of [T.legacy, T.pat]) {
      api({ status: 200, body: fixture("token-user-scope.json") }, { user: { status: 200, body: { user: { username: value } } } });
      const fs = await vercel.check(one(value), ctx(false));
      expect(fs[0]!.identity).toBeUndefined();
      expectNoSecret(fs, value);
    }
    api({ status: 200, body: fixture("token-team-scope.json") }, { team: { status: 200, body: { slug: T.legacy, membership: { role: "OWNER" } } } });
    const fs = await vercel.check(one(T.legacy), ctx(false));
    expect(fs[0]!.identity).toBeUndefined();
    expectNoSecret(fs, T.legacy);
  });

  it("no finding ever contains the secret", async () => {
    for (const value of Object.values(T)) {
      api({ status: 200, body: fixture("token-leaked.json") }, { user: { status: 200, body: fixture("user.json") } });
      expectNoSecret(await vercel.check(one(value), ctx(false)), value);
    }
  });
});

describe("vercel: allowlist", () => {
  const f = createSafeFetch(vercel.allowlist);

  it("only GET rules on api.vercel.com", () => {
    expect(vercel.allowlist.rules.every((r) => r.method === "GET" && r.host === "api.vercel.com")).toBe(true);
    expect(vercel.allowlist.rules.map((r) => r.path)).toEqual(["/v5/user/tokens/current", "/v2/user", "/v2/teams/*"]);
  });

  it.each([
    ["GET", "https://api.vercel.com/v9/projects", "not_allowlisted"],
    ["GET", "https://api.vercel.com/v5/user/tokens", "not_allowlisted"],
    ["GET", "https://api.vercel.com/v2/teams/team_x/members", "not_allowlisted"],
    ["DELETE", "https://api.vercel.com/v5/user/tokens/current", "method_not_allowed"],
    ["PATCH", "https://api.vercel.com/v2/teams/team_x", "method_not_allowed"],
    ["POST", "https://api.vercel.com/v2/user", "not_allowlisted"],
    ["GET", "https://api.github.com/user", "not_allowlisted"],
  ])("blocks %s %s before any network call", async (method, url, code) => {
    const calls = mockFetch();
    await expect(f({ method: method as "GET", url })).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(0);
  });

  it("a Vercel token can never be sent to another host", async () => {
    const calls = mockFetch();
    const err = await f({ method: "GET", url: "https://evil.example/v2/user", secret: one(T.pat) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).code).toBe("secret_host_mismatch");
    expect(calls).toHaveLength(0);
  });
});
