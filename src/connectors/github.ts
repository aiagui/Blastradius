/**
 * GitHub connector.
 *
 * Detects GitHub tokens by their documented prefixes (`ghp_`, `gho_`, `ghu_`,
 * `ghs_`, `github_pat_`) in any env var, plus legacy 40-hex tokens in
 * `GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_PAT`.
 *
 * Live check (at most 2 GET requests per credential, both to api.github.com):
 *  1. `GET /user`: validates the token. For classic PATs, OAuth tokens and
 *     legacy tokens, GitHub returns the granted scopes in `X-OAuth-Scopes`.
 *  2. `GET /user/repos?visibility=private&per_page=1`: only for tokens without
 *     a scopes header (fine-grained PATs, GitHub App user tokens). Tells us
 *     whether it can read at least one private repository. Only the item count
 *     is used; nothing from the body is reported.
 *
 * Fine-grained and GitHub App tokens never expose their permissions, so their
 * write capability is always "unknown" and they are never reported green.
 *
 * Provider-side traces: each check is a normal authenticated API call. GitHub
 * updates the token's "last used" time, and organizations that log API
 * requests (Enterprise audit log streaming) may record it.
 */
import { SafeFetchError, type SafeResponse } from "../net/safeFetch.js";
import type { Secret } from "../secret.js";
import { detectSecrets } from "./detect.js";
import type { Capability, CheckContext, Connector, Finding, Level } from "./types.js";

const HOST = "api.github.com";
const API_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } as const;

/** Prefixed tokens. Current tokens are 40 chars; GitHub reserves room to grow, so lengths are generous. */
const PREFIXED = /^(?:gh[pous]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{36,244})$/;
const LEGACY = /^[0-9a-f]{40}$/;
const LEGACY_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"] as const;

export type GithubKind =
  | "classic PAT"
  | "OAuth token"
  | "GitHub App user token"
  | "GitHub App installation token"
  | "fine-grained PAT"
  | "legacy token";

export function githubKind(value: string): GithubKind {
  if (value.startsWith("github_pat_")) return "fine-grained PAT";
  if (value.startsWith("ghp_")) return "classic PAT";
  if (value.startsWith("gho_")) return "OAuth token";
  if (value.startsWith("ghu_")) return "GitHub App user token";
  if (value.startsWith("ghs_")) return "GitHub App installation token";
  return "legacy token";
}

/** Kinds whose granted scopes GitHub reports in `X-OAuth-Scopes`. */
const SCOPED_KINDS: ReadonlySet<string> = new Set<GithubKind>(["classic PAT", "OAuth token", "legacy token"]);

interface ScopeRisk {
  readonly level: Level;
  readonly capability: string;
}

/**
 * Risk of each classic OAuth scope. Red: can delete things, administer an org,
 * or write code/packages that ship to production (supply chain). Amber: can
 * read private data or make limited writes. Green: public or own-profile reads.
 * Parent scopes (e.g. `repo`) include their children, so children are only
 * listed for tokens that were granted the child alone.
 */
const SCOPE_RISK: Readonly<Record<string, ScopeRisk>> = {
  delete_repo: { level: "red", capability: "delete_repos" },
  "admin:org": { level: "red", capability: "admin_org" },
  "admin:enterprise": { level: "red", capability: "admin_enterprise" },
  "manage_runners:enterprise": { level: "red", capability: "admin_enterprise" },
  "manage_billing:enterprise": { level: "red", capability: "admin_enterprise" },
  site_admin: { level: "red", capability: "site_admin" },
  repo: { level: "red", capability: "write_repos" },
  public_repo: { level: "red", capability: "write_public_repos" },
  workflow: { level: "red", capability: "write_workflows" },
  "write:packages": { level: "red", capability: "publish_packages" },
  "delete:packages": { level: "red", capability: "delete_packages" },
  "admin:repo_hook": { level: "red", capability: "admin_repo_hooks" },
  "admin:org_hook": { level: "red", capability: "admin_org_hooks" },
  "admin:public_key": { level: "red", capability: "add_ssh_keys" },
  "write:public_key": { level: "red", capability: "add_ssh_keys" },
  codespace: { level: "red", capability: "codespaces" },
  "write:org": { level: "amber", capability: "write_org" },
  "write:repo_hook": { level: "amber", capability: "write_repo_hooks" },
  "repo:status": { level: "amber", capability: "write_commit_statuses" },
  repo_deployment: { level: "amber", capability: "write_deployments" },
  "repo:invite": { level: "amber", capability: "repo_invites" },
  security_events: { level: "amber", capability: "security_events" },
  gist: { level: "amber", capability: "write_gists" },
  notifications: { level: "amber", capability: "read_notifications" },
  user: { level: "amber", capability: "write_profile" },
  project: { level: "amber", capability: "write_projects" },
  "admin:gpg_key": { level: "amber", capability: "admin_gpg_keys" },
  "write:gpg_key": { level: "amber", capability: "admin_gpg_keys" },
  "admin:ssh_signing_key": { level: "amber", capability: "admin_signing_keys" },
  "write:discussion": { level: "amber", capability: "write_discussions" },
  "read:audit_log": { level: "amber", capability: "read_audit_log" },
  "read:enterprise": { level: "amber", capability: "read_enterprise" },
  copilot: { level: "amber", capability: "copilot" },
  "read:org": { level: "green", capability: "read_org" },
  "read:user": { level: "green", capability: "read_profile" },
  "user:email": { level: "green", capability: "read_email" },
  "user:follow": { level: "green", capability: "follow_users" },
  "read:packages": { level: "green", capability: "read_packages" },
  "read:discussion": { level: "green", capability: "read_discussions" },
  "read:project": { level: "green", capability: "read_projects" },
  "read:public_key": { level: "green", capability: "read_ssh_keys" },
  "read:repo_hook": { level: "green", capability: "read_repo_hooks" },
  "read:gpg_key": { level: "green", capability: "read_gpg_keys" },
  "read:ssh_signing_key": { level: "green", capability: "read_signing_keys" },
};

const LEVEL_RANK: Record<Level, number> = { green: 0, amber: 1, red: 2 };

/** Scope names are public identifiers; anything else is dropped before it can reach output. */
const SCOPE_NAME = /^[a-z_]+(?::[a-z_]+)?$/;

export function parseScopes(header: string): string[] {
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => SCOPE_NAME.test(s));
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function identityFrom(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const login = (json as Record<string, unknown>)["login"];
  return typeof login === "string" && LOGIN.test(login) ? `user ${login}` : undefined;
}

function withIdentity(f: Finding, identity: string | undefined): Finding {
  return identity === undefined ? f : { ...f, identity };
}

export function scopesFinding(scopes: readonly string[]): Finding {
  if (scopes.length === 0) {
    return {
      level: "green",
      confidence: "confirmed",
      message: "Token has no scopes: it can only read public information.",
      advice: "If nothing uses it, remove it anyway.",
      capabilities: { read_private_repos: false, write_repos: false },
    };
  }
  let level: Level = "green";
  let unknownScope = false;
  const caps: Record<string, Capability> = {};
  for (const scope of scopes) {
    const risk = SCOPE_RISK[scope];
    if (risk === undefined) {
      unknownScope = true;
      if (LEVEL_RANK.amber > LEVEL_RANK[level]) level = "amber";
      continue;
    }
    caps[risk.capability] = true;
    if (LEVEL_RANK[risk.level] > LEVEL_RANK[level]) level = risk.level;
  }
  if (scopes.includes("repo")) caps["read_private_repos"] = true;
  const list = scopes.join(", ");
  const message =
    level === "red"
      ? `Classic scopes allow destructive or production writes: ${list}.`
      : level === "amber"
        ? `Classic scopes allow reading private data or limited writes: ${list}.`
        : `Read-only scopes: ${list}.`;
  const advice =
    level === "green"
      ? "Low risk. Keep it out of git anyway."
      : "Replace it with a fine-grained token limited to the repositories and permissions this app needs, then revoke this one.";
  return {
    level,
    confidence: unknownScope && level !== "red" ? "unknown" : "confirmed",
    message: unknownScope ? `${message} Some scopes are not recognised.` : message,
    advice,
    capabilities: caps,
  };
}

function inferred(kind: string | undefined): Finding {
  switch (kind) {
    case "fine-grained PAT":
      return {
        level: "amber",
        confidence: "inferred",
        message: "Fine-grained token: GitHub does not expose its permissions, so write access cannot be ruled out.",
        advice: "Check its repository and permission settings on GitHub; keep it limited to what this app needs.",
        capabilities: { read_private_repos: "unknown", write_repos: "unknown" },
      };
    case "GitHub App installation token":
      return {
        level: "amber",
        confidence: "inferred",
        message: "GitHub App installation token: permissions are set by the app and are not exposed.",
        advice: "These expire after an hour; if it is in a .env file, something is persisting it. Remove it.",
        capabilities: { read_private_repos: "unknown", write_repos: "unknown" },
      };
    case "GitHub App user token":
      return {
        level: "amber",
        confidence: "inferred",
        message: "GitHub App user token: acts as a user within the app's permissions, which are not exposed.",
        advice: "Do not store user tokens in .env files; revoke it from the app's settings.",
        capabilities: { read_private_repos: "unknown", write_repos: "unknown" },
      };
    default:
      return {
        level: "amber",
        confidence: "inferred",
        message: `${kind === "OAuth token" ? "OAuth token" : "Classic token"}: scopes are only known after a live check; it may be able to write to or delete repositories.`,
        advice: "Run without --offline to see its scopes, or replace it with a fine-grained token.",
        capabilities: { read_private_repos: "unknown", write_repos: "unknown" },
      };
  }
}

/**
 * api.github.com rejected the token. Green, but only "inferred": GitHub
 * Enterprise Server tokens use the same prefixes and are always rejected here,
 * so a 401 does not prove the token is dead.
 */
const INVALID: Finding = {
  level: "green",
  confidence: "inferred",
  message: "api.github.com rejected this token: revoked, expired, or issued by a GitHub Enterprise Server instance.",
  advice:
    "Check where it came from: github.com Settings > Developer settings, or your GitHub Enterprise Server instance. If it is still valid there, treat it as risky and rotate it; otherwise remove it from your .env files.",
};

function unknownFinding(base: Finding, why: string): Finding {
  return { ...base, level: "amber", confidence: "unknown", message: `${base.message} (${why})` };
}

function isNetworkFailure(err: unknown): boolean {
  return err instanceof SafeFetchError && (err.code === "network_error" || err.code === "timeout");
}

export const github: Connector = {
  id: "github",
  name: "GitHub",
  allowlist: {
    connector: "github",
    rules: [
      { method: "GET", host: HOST, path: "/user" },
      { method: "GET", host: HOST, path: "/user/repos" },
    ],
  },

  detect(env) {
    const prefixed = detectSecrets(env, {
      connector: "github",
      valuePattern: PREFIXED,
      allowedHosts: [HOST],
      kind: githubKind,
    });
    const legacy = detectSecrets(env, {
      connector: "github",
      keys: LEGACY_KEYS,
      valuePattern: LEGACY,
      allowedHosts: [HOST],
      kind: githubKind,
    });
    // The two patterns are disjoint, so no value can appear in both lists.
    return [...prefixed, ...legacy];
  },

  async check(secret: Secret, ctx: CheckContext): Promise<Finding[]> {
    const base = inferred(secret.kind);
    if (ctx.offline) return [base];

    let user: SafeResponse;
    try {
      user = await ctx.fetch({ method: "GET", url: `https://${HOST}/user`, secret, headers: API_HEADERS });
    } catch (err: unknown) {
      if (isNetworkFailure(err)) return [unknownFinding(base, `could not reach ${HOST}`)];
      throw err;
    }

    if (user.status === 401) return [INVALID];
    if (!user.ok) return [unknownFinding(base, `GitHub answered ${user.status}`)];
    const identity = identityFrom(user.json);

    const scopesHeader = user.headers["x-oauth-scopes"];
    if (secret.kind !== undefined && SCOPED_KINDS.has(secret.kind)) {
      if (scopesHeader === undefined) {
        return [withIdentity(unknownFinding(base, "GitHub did not report the token's scopes"), identity)];
      }
      return [withIdentity(scopesFinding(parseScopes(scopesHeader)), identity)];
    }

    // Fine-grained PATs and GitHub App tokens: permissions are not exposed.
    // Probe read access to private repositories; write stays unknown.
    let readPrivate: Capability = "unknown";
    try {
      const repos = await ctx.fetch({
        method: "GET",
        url: `https://${HOST}/user/repos?visibility=private&per_page=1`,
        secret,
        headers: API_HEADERS,
      });
      if (repos.ok && Array.isArray(repos.json) && repos.json.length > 0) readPrivate = true;
    } catch (err: unknown) {
      if (!isNetworkFailure(err)) throw err;
    }
    const message =
      readPrivate === true
        ? `${base.message} It can read at least one private repository.`
        : base.message;
    return [
      withIdentity(
        {
          ...base,
          level: "amber",
          confidence: "unknown",
          message,
          capabilities: { read_private_repos: readPrivate, write_repos: "unknown" },
        },
        identity,
      ),
    ];
  },
};

/** Registry entry, picked up by scripts/gen-connectors.mjs. */
export const connector: Connector = github;
