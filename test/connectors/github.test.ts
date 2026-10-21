import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { github, githubKind, parseScopes, scopesFinding } from "../../src/connectors/github.js";
import { parseEnv } from "../../src/env/parse.js";
import { createSafeFetch, SafeFetchError } from "../../src/net/safeFetch.js";
import type { Secret } from "../../src/secret.js";
import { mockFetch, type RecordedCall } from "../helpers.js";

afterEach(() => vi.unstubAllGlobals());

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/github/${name}`, import.meta.url), "utf8")) as unknown;
}

const T = {
  classic: "ghp_FAKEgithubCLASSIC0000000000000000001",
  oauth: "gho_FAKEgithubOAUTH000000000000000000001",
  user: "ghu_FAKEgithubAPPUSER0000000000000000001",
  install: "ghs_FAKEgithubINSTALL0000000000000000001",
  fine: "github_pat_FAKEgithubFINE00000000001_00000000000000000000000000000000000000000000000000000001",
  refresh: `ghr_${"R".repeat(40)}`,
  legacy: "0123456789abcdef0123456789abcdef01234567",
} as const;

const ctx = (offline: boolean) => ({ fetch: createSafeFetch(github.allowlist), offline });

function one(value: string, key = "GITHUB_TOKEN"): Secret {
  const found = github.detect(parseEnv(`${key}=${value}`, ".env"));
  expect(found).toHaveLength(1);
  return found[0]!;
}

function expectNoSecret(out: unknown, ...values: string[]): void {
  const text = JSON.stringify(out) + inspect(out, { depth: 10 });
  for (const v of values) expect(text).not.toContain(v);
}

/** Routes /user and /user/repos to canned responses. */
function api(user: { status: number; body?: unknown; headers?: Record<string, string> }, repos?: { status: number; body?: unknown }): RecordedCall[] {
  return mockFetch((call) => {
    const path = new URL(call.url).pathname;
    if (path === "/user") return user;
    if (path === "/user/repos" && repos !== undefined) return repos;
    return { status: 599 };
  });
}

describe("github: detection", () => {
  it("detects every documented prefix in any env var", () => {
    const env = parseEnv(
      [
        `GITHUB_TOKEN=${T.classic}`,
        `SOME_OAUTH=${T.oauth}`,
        `APP_USER=${T.user}`,
        `CI_INSTALL=${T.install}`,
        `GH_TOKEN=${T.fine}`,
        `GH_REFRESH=${T.refresh}`,
      ].join("\n"),
      ".env",
    );
    const kinds = github.detect(env).map((s) => [s.envKey, s.kind]);
    expect(kinds).toEqual([
      ["GITHUB_TOKEN", "classic PAT"],
      ["SOME_OAUTH", "OAuth token"],
      ["APP_USER", "GitHub App user token"],
      ["CI_INSTALL", "GitHub App installation token"],
      ["GH_TOKEN", "fine-grained PAT"],
      ["GH_REFRESH", "GitHub App refresh token"],
    ]);
  });

  it("does not send refresh tokens to the API", async () => {
    const calls = mockFetch();
    const findings = await github.check(one(T.refresh), ctx(false));
    expect(calls).toHaveLength(0);
    expect(findings[0]).toMatchObject({ level: "amber", confidence: "inferred" });
    expect(findings[0]!.message).toMatch(/refresh token/i);
    expect(findings[0]!.capabilities).toMatchObject({ read_private_repos: "unknown", write_repos: "unknown" });
  });

  it("detects legacy 40-hex tokens only under GitHub env names", () => {
    expect(one(T.legacy, "GH_TOKEN").kind).toBe("legacy token");
    expect(github.detect(parseEnv(`GIT_SHA=${T.legacy}`, ".env"))).toHaveLength(0);
  });

  it("ignores malformed values and other providers", () => {
    const env = parseEnv("GITHUB_TOKEN=ghp_short\nGH_TOKEN=not-a-token\nX=ghx_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nY=sk_live_abc", ".env");
    expect(github.detect(env)).toHaveLength(0);
  });

  it("binds every secret to api.github.com only and dedupes across files", () => {
    const env = [...parseEnv(`GITHUB_TOKEN=${T.classic}`, ".env"), ...parseEnv(`GITHUB_TOKEN=${T.classic}`, ".env.local")];
    const [s] = github.detect(env);
    expect(s!.allowedHosts).toEqual(["api.github.com"]);
    expect(s!.source).toBe(".env, .env.local");
  });

  it("githubKind falls back to legacy", () => {
    expect(githubKind("abc")).toBe("legacy token");
  });
});

describe("github: scopes", () => {
  it("parses the header and drops anything that is not a scope name", () => {
    expect(parseScopes("repo, read:org,  workflow")).toEqual(["repo", "read:org", "workflow"]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("repo, ghp_LEAK value")).toEqual(["repo"]);
  });

  it.each([
    ["delete_repo", "red", "delete_repos"],
    ["admin:org", "red", "admin_org"],
    ["repo", "red", "write_repos"],
    ["workflow", "red", "write_workflows"],
    ["write:packages", "red", "publish_packages"],
    ["admin:repo_hook", "red", "admin_repo_hooks"],
    ["gist", "amber", "write_gists"],
    ["read:org", "green", "read_org"],
    ["read:user", "green", "read_profile"],
  ] as const)("%s -> %s", (scope, level, cap) => {
    const f = scopesFinding([scope]);
    expect(f).toMatchObject({ level, confidence: "confirmed" });
    expect(f.capabilities?.[cap]).toBe(true);
  });

  it("takes the worst scope", () => {
    expect(scopesFinding(["read:org", "gist", "delete_repo"]).level).toBe("red");
  });

  it("no scopes is green and confirmed", () => {
    expect(scopesFinding([])).toMatchObject({ level: "green", confidence: "confirmed" });
  });

  it("an unrecognised scope is amber/unknown, never green", () => {
    expect(scopesFinding(["read:org", "brand_new_scope"])).toMatchObject({ level: "amber", confidence: "unknown" });
  });
});

describe("github: live checks (mocked)", () => {
  it("classic PAT with delete_repo + repo is red/confirmed with identity", async () => {
    const calls = api({ status: 200, body: fixture("user.json"), headers: { "x-oauth-scopes": "repo, delete_repo, read:org" } });
    const [f] = await github.check(one(T.classic), ctx(false));
    expect(f).toMatchObject({ level: "red", confidence: "confirmed", identity: "user octocat" });
    expect(f!.capabilities).toMatchObject({ delete_repos: true, write_repos: true, read_private_repos: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.github.com/user" });
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${T.classic}`);
    expectNoSecret(f, T.classic);
  });

  it("OAuth token with admin:org is red", async () => {
    api({ status: 200, body: fixture("user.json"), headers: { "x-oauth-scopes": "admin:org" } });
    expect((await github.check(one(T.oauth), ctx(false)))[0]).toMatchObject({ level: "red", confidence: "confirmed" });
  });

  it("classic PAT with only read scopes is green/confirmed", async () => {
    api({ status: 200, body: fixture("user.json"), headers: { "x-oauth-scopes": "read:user, read:org" } });
    expect((await github.check(one(T.classic), ctx(false)))[0]).toMatchObject({ level: "green", confidence: "confirmed" });
  });

  it("legacy token is checked like a classic PAT", async () => {
    api({ status: 200, body: fixture("user.json"), headers: { "x-oauth-scopes": "workflow" } });
    expect((await github.check(one(T.legacy), ctx(false)))[0]).toMatchObject({ level: "red", confidence: "confirmed" });
  });

  it("classic PAT without a scopes header stays amber/unknown", async () => {
    api({ status: 200, body: fixture("user.json") });
    expect((await github.check(one(T.classic), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("fine-grained PAT is never green, even with no private repos", async () => {
    const calls = api({ status: 200, body: fixture("user.json") }, { status: 200, body: fixture("repos-empty.json") });
    const [f] = await github.check(one(T.fine, "GH_TOKEN"), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown", identity: "user octocat" });
    expect(f!.capabilities).toEqual({ read_private_repos: "unknown", write_repos: "unknown" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/user/repos?visibility=private&per_page=1",
    ]);
  });

  it("fine-grained PAT that can read a private repo says so, write stays unknown", async () => {
    api({ status: 200, body: fixture("user.json"), headers: { "x-oauth-scopes": "repo" } }, { status: 200, body: fixture("repos-private.json") });
    const [f] = await github.check(one(T.fine, "GH_TOKEN"), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown" });
    expect(f!.capabilities).toEqual({ read_private_repos: true, write_repos: "unknown" });
    // Nothing from the repos body reaches the finding.
    expect(JSON.stringify(f)).not.toContain("secret-project");
  });

  it("GitHub App user token is amber/unknown", async () => {
    api({ status: 200, body: fixture("user.json") }, { status: 200, body: [] });
    expect((await github.check(one(T.user), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("installation token: 403 on /user stays amber/unknown", async () => {
    api({ status: 403, body: fixture("forbidden-integration.json") });
    expect((await github.check(one(T.install), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("fine-grained probe failing on the network still reports amber/unknown", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => (n++ === 0 ? Promise.resolve(new Response(JSON.stringify(fixture("user.json")), { status: 200 })) : Promise.reject(new Error("down")))),
    );
    const [f] = await github.check(one(T.fine, "GH_TOKEN"), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it.each(Object.entries(T).filter(([k]) => k !== "refresh"))("401 (%s) is green with confidence inferred, not confirmed (could be a GHES token)", async (_kind, value) => {
    const calls = api({ status: 401, body: fixture("bad-credentials.json") });
    const fs = await github.check(one(value), ctx(false));
    expect(fs).toHaveLength(1);
    expect(fs[0]!.level).toBe("green");
    expect(fs[0]!.confidence).toBe("inferred");
    expect(fs[0]!.message).toBe("api.github.com rejected this token: revoked, expired, or issued by a GitHub Enterprise Server instance.");
    expect(fs[0]!.advice).toContain("Developer settings");
    expect(fs[0]!.advice).toContain("GitHub Enterprise Server");
    // Stops after the rejection: no probe call.
    expect(calls).toHaveLength(1);
  });

  it.each([403, 404, 429, 500, 302])("status %i is amber/unknown, never green", async (status) => {
    api({ status, body: { message: "nope" } });
    const [f] = await github.check(one(T.classic), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("network failure and timeout are amber/unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error(`${T.classic} ECONNREFUSED`))));
    const [f] = await github.check(one(T.classic), ctx(false));
    expect(f).toMatchObject({ level: "amber", confidence: "unknown" });
    expectNoSecret(f, T.classic);
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(timeout)));
    expect((await github.check(one(T.classic), ctx(false)))[0]).toMatchObject({ level: "amber", confidence: "unknown" });
  });

  it("offline makes zero fetches and never reports green", async () => {
    const calls = mockFetch();
    for (const value of Object.values(T)) {
      const [f] = await github.check(one(value), ctx(true));
      expect(f).toMatchObject({ level: "amber", confidence: "inferred" });
      expectNoSecret(f, value);
    }
    expect(calls).toHaveLength(0);
  });

  it("a provider echoing the token as login does not put it in the finding", async () => {
    const echo = "ghp_CANARYGITHUB000000000000000000000001";
    api({ status: 200, body: fixture("user-echo-token.json"), headers: { "x-oauth-scopes": "repo" } });
    const [f] = await github.check(one(echo), ctx(false));
    expect(f!.identity).toBeUndefined();
    expectNoSecret(f, echo);
  });

  it("no finding ever contains the secret", async () => {
    for (const value of Object.values(T)) {
      api({ status: 200, body: fixture("user.json"), headers: { "x-oauth-scopes": "repo" } }, { status: 200, body: [] });
      expectNoSecret(await github.check(one(value), ctx(false)), value);
    }
  });
});

describe("github: allowlist", () => {
  const f = createSafeFetch(github.allowlist);

  it("only allows GET /user and GET /user/repos on api.github.com", () => {
    expect(github.allowlist.rules.every((r) => r.method === "GET" && r.host === "api.github.com")).toBe(true);
    expect(github.allowlist.rules.map((r) => r.path)).toEqual(["/user", "/user/repos"]);
  });

  it.each([
    ["GET", "https://api.github.com/user/emails", "not_allowlisted"],
    ["GET", "https://api.github.com/repos/octocat/hello", "not_allowlisted"],
    ["POST", "https://api.github.com/graphql", "not_allowlisted"],
    ["DELETE", "https://api.github.com/user", "method_not_allowed"],
    ["GET", "https://api.vercel.com/v2/user", "not_allowlisted"],
  ])("blocks %s %s before any network call", async (method, url, code) => {
    const calls = mockFetch();
    await expect(f({ method: method as "GET", url })).rejects.toMatchObject({ code });
    expect(calls).toHaveLength(0);
  });

  it("a GitHub token can never be sent to another host", async () => {
    const calls = mockFetch();
    const err = await f({ method: "GET", url: "https://evil.example/user", secret: one(T.classic) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).code).toBe("secret_host_mismatch");
    expect(calls).toHaveLength(0);
  });
});
