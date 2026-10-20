/**
 * safeFetch: the ONLY network primitive in Blastradius.
 *
 * Every request is checked against the calling connector's allowlist BEFORE any
 * connection is opened. ESLint forbids `fetch`, `http`, `https`, `undici`, etc.
 * everywhere else in the codebase, so this file is the single choke point.
 *
 * Guarantees:
 *  - Only GET/HEAD, plus POST for GraphQL documents whose SHA-256 is allowlisted.
 *    PUT/PATCH/DELETE and any other method are rejected, even if someone adds a rule.
 *  - https only, no userinfo, no custom ports, exact host match.
 *  - A secret is only attached if the target host is in `secret.allowedHosts`.
 *  - The secret value is never placed in the URL and never in error messages.
 *  - Redirects are not followed (a 3xx is returned as-is), so credentials
 *    cannot be forwarded to another host.
 *  - `discardBody: true` cancels the body stream and returns only status/headers,
 *    for probes whose responses may contain personal data.
 */
import { createHash } from "node:crypto";
import type { Secret } from "../secret.js";

export type ReadOnlyMethod = "GET" | "HEAD";
export type AllowedMethod = ReadOnlyMethod | "POST";

const ALLOWED_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST"]);

/** A constant GraphQL query document, identified by the SHA-256 of its exact text. */
export interface GraphqlDoc {
  readonly hash: string;
  readonly query: string;
}

/** Returns the hex SHA-256 of a GraphQL document's exact text. */
export function hashGraphql(query: string): string {
  return createHash("sha256").update(query, "utf8").digest("hex");
}

/**
 * Declares a constant, read-only GraphQL document. Throws on mutations and
 * subscriptions, so they can never be allowlisted.
 */
export function graphqlDoc(query: string): GraphqlDoc {
  const stripped = query.replace(/#[^\n]*/g, "").trim();
  // Conservative: the keywords may not appear anywhere in an allowlisted document.
  if (/\b(mutation|subscription)\b/.test(stripped)) {
    throw new Error("graphqlDoc: only read-only query documents may be allowlisted");
  }
  return Object.freeze({ query, hash: hashGraphql(query) });
}

export interface GetRule {
  readonly method: ReadOnlyMethod;
  readonly host: string;
  /**
   * Path pattern. Exact match, except `*` matches exactly one non-empty
   * path segment and a trailing `/**` matches one or more remaining segments.
   */
  readonly path: string;
}

export interface GraphqlRule {
  readonly method: "POST";
  readonly host: string;
  readonly path: string;
  /** POST is only allowed for these exact documents. Required and non-empty. */
  readonly graphql: readonly GraphqlDoc[];
}

export type AllowRule = GetRule | GraphqlRule;

export interface Allowlist {
  readonly connector: string;
  readonly rules: readonly AllowRule[];
}

export type AuthScheme =
  | { readonly type: "bearer" }
  | { readonly type: "basic"; readonly as: "username" | "password" }
  | { readonly type: "header"; readonly name: string; readonly prefix?: string };

export interface SafeRequest {
  readonly method: AllowedMethod;
  readonly url: string;
  /** Credential to attach. Its allowedHosts must include the URL host. */
  readonly secret?: Secret;
  /** How to attach the secret. Defaults to bearer. */
  readonly auth?: AuthScheme;
  /** Extra non-sensitive headers (e.g. Accept, API version). */
  readonly headers?: Readonly<Record<string, string>>;
  /** For POST rules: the GraphQL document and variables. Body is built here. */
  readonly graphql?: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> };
  /** Cancel the body and return only status + headers. */
  readonly discardBody?: boolean;
  readonly timeoutMs?: number;
}

export interface SafeResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Lower-cased response headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body, or undefined if discarded, empty or not JSON. */
  readonly json: unknown;
}

export type SafeFetchErrorCode =
  | "method_not_allowed"
  | "invalid_url"
  | "not_allowlisted"
  | "graphql_not_allowlisted"
  | "secret_host_mismatch"
  | "secret_in_url"
  | "network_error"
  | "timeout"
  | "body_too_large";

export class SafeFetchError extends Error {
  override readonly name = "SafeFetchError";
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type SafeFetch = (req: SafeRequest) => Promise<SafeResponse>;

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "blastradius (read-only credential checker)";

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiles a path pattern into an anchored RegExp. */
export function compilePathPattern(pattern: string): RegExp {
  if (!pattern.startsWith("/")) throw new Error(`Path pattern must start with "/": ${pattern}`);
  let tail = "";
  let body = pattern;
  if (body.endsWith("/**")) {
    body = body.slice(0, -3);
    tail = "(?:/[^/]+)+";
  }
  const src = body
    .split("/")
    .map((seg) => (seg === "*" ? "[^/]+" : escapeRegex(seg)))
    .join("/");
  return new RegExp(`^${src}${tail}$`);
}

function validateAllowlist(list: Allowlist): void {
  for (const rule of list.rules) {
    if (!ALLOWED_METHODS.has(rule.method)) {
      throw new Error(`Allowlist for ${list.connector}: method ${rule.method as string} can never be allowed`);
    }
    if (rule.method === "POST" && (!("graphql" in rule) || rule.graphql.length === 0)) {
      throw new Error(`Allowlist for ${list.connector}: POST rules require a non-empty graphql list`);
    }
    if (rule.host !== rule.host.toLowerCase() || rule.host.includes("*") || rule.host.includes(":")) {
      throw new Error(`Allowlist for ${list.connector}: host must be an exact lower-case hostname`);
    }
    compilePathPattern(rule.path);
  }
}

function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", "safeFetch: invalid URL");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("invalid_url", "safeFetch: only https is allowed");
  if (url.username !== "" || url.password !== "") {
    throw new SafeFetchError("invalid_url", "safeFetch: credentials in URL are not allowed");
  }
  if (url.port !== "") throw new SafeFetchError("invalid_url", "safeFetch: custom ports are not allowed");
  return url;
}

function authHeaders(secret: Secret, auth: AuthScheme): Record<string, string> {
  const v = secret.reveal();
  switch (auth.type) {
    case "bearer":
      return { authorization: `Bearer ${v}` };
    case "basic": {
      const pair = auth.as === "username" ? `${v}:` : `:${v}`;
      return { authorization: `Basic ${Buffer.from(pair, "utf8").toString("base64")}` };
    }
    case "header":
      return { [auth.name.toLowerCase()]: `${auth.prefix ?? ""}${v}` };
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Throwing inside for-await cancels the underlying stream.
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new SafeFetchError("body_too_large", "safeFetch: response body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Checks a request against an allowlist without performing it. Throws
 * SafeFetchError if the request is not allowed. Exported for tests and for
 * `--dry-run` style tooling.
 */
export function assertAllowed(list: Allowlist, req: SafeRequest): URL {
  // Runtime check too: callers may bypass the type system with casts.
  const method = (req.method as string).toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new SafeFetchError("method_not_allowed", `safeFetch: method ${method} is never allowed`);
  }
  const url = parseTarget(req.url);
  const host = url.hostname.toLowerCase();

  if (req.secret !== undefined) {
    if (!req.secret.allowedHost(host)) {
      throw new SafeFetchError(
        "secret_host_mismatch",
        `safeFetch: ${req.secret.envKey} may not be sent to ${host}`,
      );
    }
    if (req.url.includes(req.secret.reveal()) || decodeURIComponent(req.url).includes(req.secret.reveal())) {
      throw new SafeFetchError("secret_in_url", "safeFetch: secrets must never be placed in URLs");
    }
  }

  const candidates = list.rules.filter(
    (r) => r.method === method && r.host === host && compilePathPattern(r.path).test(url.pathname),
  );
  if (candidates.length === 0) {
    throw new SafeFetchError(
      "not_allowlisted",
      `safeFetch: ${method} https://${host}${url.pathname} is not allowlisted for ${list.connector}`,
    );
  }

  if (method === "POST") {
    if (req.graphql === undefined) {
      throw new SafeFetchError("graphql_not_allowlisted", "safeFetch: POST is only allowed for GraphQL documents");
    }
    const hash = hashGraphql(req.graphql.query);
    const ok = candidates.some((r) => "graphql" in r && r.graphql.some((d) => d.hash === hash));
    if (!ok) {
      throw new SafeFetchError(
        "graphql_not_allowlisted",
        `safeFetch: GraphQL document ${hash.slice(0, 12)} is not allowlisted for ${list.connector}`,
      );
    }
  } else if (req.graphql !== undefined) {
    throw new SafeFetchError("graphql_not_allowlisted", "safeFetch: GraphQL documents must be sent with POST");
  }
  return url;
}

/**
 * Creates a fetch function bound to one connector's allowlist. Connectors only
 * ever receive the bound function through their CheckContext.
 */
export function createSafeFetch(list: Allowlist): SafeFetch {
  validateAllowlist(list);
  const frozen: Allowlist = Object.freeze({ connector: list.connector, rules: Object.freeze([...list.rules]) });

  return async function safeFetch(req: SafeRequest): Promise<SafeResponse> {
    const url = assertAllowed(frozen, req);
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "application/json",
    };
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lk = k.toLowerCase();
      if (lk === "authorization" || lk === "cookie" || lk === "host") {
        throw new SafeFetchError("not_allowlisted", `safeFetch: header ${lk} may not be set directly`);
      }
      headers[lk] = v;
    }
    if (req.secret !== undefined) Object.assign(headers, authHeaders(req.secret, req.auth ?? { type: "bearer" }));

    let body: string | undefined;
    if (req.graphql !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ query: req.graphql.query, variables: req.graphql.variables ?? {} });
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err: unknown) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      // Never include the original error: it may echo request details.
      throw new SafeFetchError(
        timeout ? "timeout" : "network_error",
        `safeFetch: ${timeout ? "timed out" : "network error"} calling ${url.hostname}`,
      );
    }

    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });

    if (req.discardBody === true || req.method === "HEAD") {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, ok: res.ok, headers: outHeaders, json: undefined };
    }

    const text = await readCapped(res);
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, ok: res.ok, headers: outHeaders, json };
  };
}
