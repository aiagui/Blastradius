import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAllowed,
  createSafeFetch,
  graphqlDoc,
  SafeFetchError,
  type Allowlist,
  type SafeRequest,
} from "../src/net/safeFetch.js";
import { Secret } from "../src/secret.js";
import { mockFetch } from "./helpers.js";

const VIEWER = graphqlDoc("query Viewer { viewer { login } }");

const list: Allowlist = {
  connector: "t",
  rules: [
    { method: "GET", host: "api.t.test", path: "/user" },
    { method: "GET", host: "api.t.test", path: "/repos/*/*" },
    { method: "GET", host: "api.t.test", path: "/v1/**" },
    { method: "HEAD", host: "api.t.test", path: "/ping" },
    { method: "POST", host: "api.t.test", path: "/graphql", graphql: [VIEWER] },
  ],
};

const secret = new Secret({
  connector: "t",
  envKey: "T_TOKEN",
  source: ".env",
  value: "tok_CANARYSAFEFETCH01",
  allowedHosts: ["api.t.test"],
});

function code(req: SafeRequest): string {
  try {
    assertAllowed(list, req);
    return "allowed";
  } catch (err) {
    if (err instanceof SafeFetchError) return err.code;
    throw err;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("safeFetch allowlist", () => {
  it("allows exact and wildcard GET paths", () => {
    expect(code({ method: "GET", url: "https://api.t.test/user" })).toBe("allowed");
    expect(code({ method: "GET", url: "https://api.t.test/repos/a/b?per_page=1" })).toBe("allowed");
    expect(code({ method: "GET", url: "https://api.t.test/v1/x/y/z" })).toBe("allowed");
    expect(code({ method: "HEAD", url: "https://api.t.test/ping" })).toBe("allowed");
  });

  it("rejects paths that do not match", () => {
    expect(code({ method: "GET", url: "https://api.t.test/user/emails" })).toBe("not_allowlisted");
    expect(code({ method: "GET", url: "https://api.t.test/repos/a" })).toBe("not_allowlisted");
    expect(code({ method: "GET", url: "https://api.t.test/repos/a/b/c" })).toBe("not_allowlisted");
    expect(code({ method: "GET", url: "https://api.t.test/v1" })).toBe("not_allowlisted");
    expect(code({ method: "HEAD", url: "https://api.t.test/user" })).toBe("not_allowlisted");
  });

  it.each(["PUT", "DELETE", "PATCH", "OPTIONS", "CONNECT", "TRACE", "put", "delete"])(
    "rejects %s even if forced past the type system",
    (method) => {
      expect(code({ method: method as "GET", url: "https://api.t.test/user" })).toBe("method_not_allowed");
    },
  );

  it("rejects POST without a GraphQL document", () => {
    expect(code({ method: "POST", url: "https://api.t.test/graphql" })).toBe("graphql_not_allowlisted");
    expect(code({ method: "POST", url: "https://api.t.test/user" })).toBe("not_allowlisted");
  });

  it("allows only the exact allowlisted GraphQL document", () => {
    expect(code({ method: "POST", url: "https://api.t.test/graphql", graphql: { query: VIEWER.query } })).toBe("allowed");
    expect(
      code({ method: "POST", url: "https://api.t.test/graphql", graphql: { query: `${VIEWER.query} ` } }),
    ).toBe("graphql_not_allowlisted");
    expect(
      code({
        method: "POST",
        url: "https://api.t.test/graphql",
        graphql: { query: "mutation { deleteRepository(input: {}) { clientMutationId } }" },
      }),
    ).toBe("graphql_not_allowlisted");
    expect(code({ method: "GET", url: "https://api.t.test/user", graphql: { query: VIEWER.query } })).toBe(
      "graphql_not_allowlisted",
    );
  });

  it("refuses to allowlist mutations or subscriptions", () => {
    expect(() => graphqlDoc("mutation X { a }")).toThrow();
    expect(() => graphqlDoc("  # c\n subscription { a }")).toThrow();
    expect(() => graphqlDoc("query A { a } mutation B { b }")).toThrow();
  });

  it("rejects wrong hosts, http, ports and userinfo", () => {
    expect(code({ method: "GET", url: "https://evil.test/user" })).toBe("not_allowlisted");
    expect(code({ method: "GET", url: "https://api.t.test.evil.test/user" })).toBe("not_allowlisted");
    expect(code({ method: "GET", url: "http://api.t.test/user" })).toBe("invalid_url");
    expect(code({ method: "GET", url: "https://api.t.test:8443/user" })).toBe("invalid_url");
    expect(code({ method: "GET", url: "https://u:p@api.t.test/user" })).toBe("invalid_url");
    expect(code({ method: "GET", url: "not a url" })).toBe("invalid_url");
  });

  it("rejects sending a secret to a host it is not bound to", () => {
    const otherList: Allowlist = { connector: "t", rules: [{ method: "GET", host: "other.test", path: "/user" }] };
    expect(() => assertAllowed(otherList, { method: "GET", url: "https://other.test/user", secret })).toThrow(
      expect.objectContaining({ code: "secret_host_mismatch" }) as Error,
    );
  });

  it("rejects secrets placed in the URL", () => {
    expect(code({ method: "GET", url: `https://api.t.test/v1/${secret.reveal()}`, secret })).toBe("secret_in_url");
  });

  it("rejects invalid allowlists at creation time", () => {
    const bad = (rules: unknown): (() => unknown) => () => createSafeFetch({ connector: "t", rules } as Allowlist);
    expect(bad([{ method: "DELETE", host: "a.test", path: "/x" }])).toThrow();
    expect(bad([{ method: "POST", host: "a.test", path: "/x" }])).toThrow();
    expect(bad([{ method: "POST", host: "a.test", path: "/x", graphql: [] }])).toThrow();
    expect(bad([{ method: "GET", host: "*.a.test", path: "/x" }])).toThrow();
    expect(bad([{ method: "GET", host: "A.test", path: "/x" }])).toThrow();
    expect(bad([{ method: "GET", host: "a.test", path: "x" }])).toThrow();
  });
});

describe("safeFetch requests", () => {
  it("throws before any connection when not allowed", async () => {
    const calls = mockFetch();
    const f = createSafeFetch(list);
    await expect(f({ method: "DELETE" as "GET", url: "https://api.t.test/user", secret })).rejects.toThrow(SafeFetchError);
    await expect(f({ method: "GET", url: "https://evil.test/user", secret })).rejects.toThrow(SafeFetchError);
    expect(calls).toHaveLength(0);
  });

  it("attaches auth, does not follow redirects and parses JSON", async () => {
    const calls = mockFetch(() => ({ status: 200, body: { login: "octo" }, headers: { "X-Scopes": "repo" } }));
    const res = await createSafeFetch(list)({ method: "GET", url: "https://api.t.test/user", secret });
    expect(res).toMatchObject({ status: 200, ok: true, json: { login: "octo" }, headers: { "x-scopes": "repo" } });
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${secret.reveal()}`);
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.redirect).toBe("manual");
  });

  it("supports basic and custom header auth", async () => {
    const calls = mockFetch();
    const f = createSafeFetch(list);
    await f({ method: "GET", url: "https://api.t.test/user", secret, auth: { type: "basic", as: "username" } });
    await f({ method: "GET", url: "https://api.t.test/user", secret, auth: { type: "header", name: "X-Key", prefix: "K " } });
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${Buffer.from(`${secret.reveal()}:`).toString("base64")}`);
    expect(calls[1]!.headers["x-key"]).toBe(`K ${secret.reveal()}`);
  });

  it("refuses caller-set authorization or cookie headers", async () => {
    mockFetch();
    const f = createSafeFetch(list);
    await expect(f({ method: "GET", url: "https://api.t.test/user", headers: { Authorization: "x" } })).rejects.toThrow();
    await expect(f({ method: "GET", url: "https://api.t.test/user", headers: { cookie: "x" } })).rejects.toThrow();
  });

  it("discardBody returns only status and headers", async () => {
    mockFetch(() => ({ status: 200, body: { email: "person@example.com" } }));
    const res = await createSafeFetch(list)({ method: "GET", url: "https://api.t.test/v1/customers", secret, discardBody: true });
    expect(res.json).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("person@example.com");
  });

  it("sends GraphQL as a JSON POST body built internally", async () => {
    const calls = mockFetch(() => ({ status: 200, body: { data: { viewer: { login: "o" } } } }));
    await createSafeFetch(list)({ method: "POST", url: "https://api.t.test/graphql", secret, graphql: { query: VIEWER.query } });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: VIEWER.query, variables: {} });
  });

  it("wraps network errors without leaking details", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error(`boom ${secret.reveal()}`))));
    const err = await createSafeFetch(list)({ method: "GET", url: "https://api.t.test/user", secret }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).code).toBe("network_error");
    expect((err as Error).message).not.toContain("CANARY");
  });

  it("rejects oversized bodies", async () => {
    mockFetch(() => ({ status: 200, body: "x".repeat(1024 * 1024 + 1) }));
    await expect(createSafeFetch(list)({ method: "GET", url: "https://api.t.test/user" })).rejects.toMatchObject({
      code: "body_too_large",
    });
  });
});
