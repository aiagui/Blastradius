/**
 * Vercel connector.
 *
 * Detects Vercel tokens by their documented prefixes in any env var
 * (`vcp_` personal access token, `vci_` integration token, `vca_` app access
 * token, `vcr_` app refresh token; see
 * https://vercel.com/changelog/new-token-formats-and-secret-scanning), plus
 * legacy unprefixed 24-character tokens under VERCEL_TOKEN, VERCEL_ACCESS_TOKEN
 * and VERCEL_API_TOKEN. `vck_` AI Gateway keys are a different service and are
 * not handled here.
 *
 * Vercel tokens have no fine-grained permissions: what they can do is their
 * scope (full account, or one team, optionally narrowed to one project) times
 * the owner's role in that team.
 *
 * Live check (at most 5 GET requests per credential, all to api.vercel.com):
 *  1. `GET /v5/user/tokens/current`: token metadata (scopes, leakedAt).
 *  2. Full-account scope: `GET /v2/user` for the username only.
 *     Team scope: `GET /v2/teams/{teamId}` for each team (max 3) to read the
 *     caller's `membership.role`.
 * Refresh tokens (`vcr_`) are never sent anywhere: using them would rotate them.
 *
 * Provider-side traces: each check is a normal authenticated API call and
 * updates the token's "last active" time (`activeAt`) on Vercel.
 */
import { SafeFetchError, type SafeResponse } from "../net/safeFetch.js";
import type { Secret } from "../secret.js";
import { detectSecrets } from "./detect.js";
import type { Capability, CheckContext, Connector, Finding, Level } from "./types.js";

const HOST = "api.vercel.com";
const MAX_TEAMS = 3;

const PREFIXED = /^vc[piar]_[A-Za-z0-9]{20,}$/;
const LEGACY = /^[A-Za-z0-9]{24}$/;
const LEGACY_KEYS = ["VERCEL_TOKEN", "VERCEL_ACCESS_TOKEN", "VERCEL_API_TOKEN"] as const;
const TEAM_ID = /^team_[A-Za-z0-9]{1,64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export type VercelKind = "personal access token" | "integration token" | "app access token" | "app refresh token" | "legacy token";

export function vercelKind(value: string): VercelKind {
  if (value.startsWith("vcp_")) return "personal access token";
  if (value.startsWith("vci_")) return "integration token";
  if (value.startsWith("vca_")) return "app access token";
  if (value.startsWith("vcr_")) return "app refresh token";
  return "legacy token";
}

const FULL_ACCESS: Readonly<Record<string, Capability>> = {
  deploy_production: true,
  delete_projects: true,
  manage_domains: true,
  read_env_vars: true,
};

interface RoleRisk {
  readonly level: Level;
  readonly what: string;
  readonly capabilities: Readonly<Record<string, Capability>>;
}

/**
 * Team roles, from https://vercel.com/docs/rbac/access-roles.
 * OWNER and MEMBER have full control over projects, production deployments and
 * production env vars: red. DEVELOPER deploys and manages non-production env
 * vars: amber (red if granted FullProductionDeployment or EnvVariableManager).
 * The Enterprise viewer can read logs, settings and env vars: amber. The Pro
 * viewer is limited read-only: green.
 */
export const ROLE_RISK: Readonly<Record<string, RoleRisk>> = {
  OWNER: { level: "red", what: "owner: full control of the team, its projects, domains and members", capabilities: { ...FULL_ACCESS, manage_members: true } },
  MEMBER: { level: "red", what: "member: full control of projects, production deployments and env vars", capabilities: { ...FULL_ACCESS, manage_members: false } },
  DEVELOPER: { level: "amber", what: "developer: can deploy and manage preview env vars", capabilities: { deploy_preview: true, deploy_production: "unknown", read_env_vars: "unknown", delete_projects: "unknown" } },
  CONTRIBUTOR: { level: "amber", what: "contributor: access depends on per-project roles", capabilities: { deploy_production: "unknown", read_env_vars: "unknown" } },
  SECURITY: { level: "amber", what: "security: can change firewall and deployment protection", capabilities: { manage_firewall: true, deploy_production: false } },
  BILLING: { level: "amber", what: "billing: can manage payment methods and read all projects", capabilities: { manage_billing: true, deploy_production: false } },
  VIEWER: { level: "amber", what: "viewer: read-only, including logs, settings and env vars", capabilities: { read_env_vars: true, deploy_production: false } },
  VIEWER_FOR_PLUS: { level: "green", what: "Pro viewer: limited read-only access", capabilities: { deploy_production: false } },
};

const ESCALATING_PERMISSIONS = ["FullProductionDeployment", "EnvVariableManager"] as const;

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Returns a display name from a provider response only if it matches `re` and
 * cannot be a Vercel token itself (a buggy or hostile API could echo it back).
 */
function str(v: unknown, re: RegExp): string | undefined {
  return typeof v === "string" && re.test(v) && !LEGACY.test(v) && !PREFIXED.test(v) ? v : undefined;
}

function inferred(kind: string | undefined): Finding {
  if (kind === "app refresh token") {
    return {
      level: "amber",
      confidence: "inferred",
      message: "App refresh token: can be exchanged for new access tokens for 30 days. Not checked live (that would rotate it).",
      advice: "Refresh tokens belong in encrypted server storage, not .env files. Revoke it from the app's settings.",
      capabilities: { mint_access_tokens: true },
    };
  }
  return {
    level: "amber",
    confidence: "inferred",
    message: "Vercel token: its scope is only known after a live check; a full-account token can delete projects and domains.",
    advice: "Run without --offline to see its scope, or replace it with a project-scoped token.",
    capabilities: { deploy_production: "unknown", delete_projects: "unknown", read_env_vars: "unknown" },
  };
}

/**
 * Vercel rejected the token. Green, but only "inferred": a rejection does not
 * prove the token is gone (e.g. a transient auth issue), so ask the user to
 * confirm it in the dashboard.
 */
const INVALID: Finding = {
  level: "green",
  confidence: "inferred",
  message: "Vercel rejected this token: revoked, expired or invalid.",
  advice: "Confirm in the Vercel dashboard (Account Settings > Tokens) that it is gone, then remove it from your .env files.",
};

function unknownFinding(base: Finding, why: string): Finding {
  return { ...base, level: "amber", confidence: "unknown", message: `${base.message} (${why})` };
}

function isNetworkFailure(err: unknown): boolean {
  return err instanceof SafeFetchError && (err.code === "network_error" || err.code === "timeout");
}

/** Vercel answers 403 with `error.invalidToken: true` for bad tokens. */
function isInvalid(res: SafeResponse): boolean {
  if (res.status === 401) return true;
  return res.status === 403 && obj(obj(res.json)?.["error"])?.["invalidToken"] === true;
}

export function leakedFinding(leakedAt: number): Finding {
  // new Date(x).toISOString() throws a RangeError outside the Date range (e.g. 1e20).
  const date = new Date(leakedAt);
  const when = Number.isFinite(date.getTime()) ? ` (on ${date.toISOString().slice(0, 10)})` : "";
  return {
    level: "red",
    confidence: "confirmed",
    message: `Vercel has flagged this token as leaked${when}.`,
    advice: "Revoke it now and check the account's activity log for deployments or changes you did not make.",
  };
}

/** Value-free reason for a failed request. Only SafeFetchError messages are known to be value-free. */
function failureReason(err: unknown): string {
  return err instanceof SafeFetchError ? err.message : "unexpected error";
}

export function teamFinding(json: unknown): Finding | undefined {
  const team = obj(json);
  const membership = obj(team?.["membership"]);
  const role = typeof membership?.["role"] === "string" ? membership["role"] : undefined;
  const slug = str(team?.["slug"], NAME);
  const identity = slug !== undefined ? `team ${slug}` : undefined;
  const risk = role !== undefined ? ROLE_RISK[role] : undefined;
  if (risk === undefined) return undefined;
  const perms = Array.isArray(membership?.["teamPermissions"]) ? (membership["teamPermissions"] as unknown[]) : [];
  const escalated = risk.level !== "red" && ESCALATING_PERMISSIONS.some((p) => perms.includes(p));
  const finding: Finding = {
    level: escalated ? "red" : risk.level,
    confidence: "confirmed",
    message: `Team-scoped token, role ${risk.what}${escalated ? ", plus production deploy or env var permissions" : ""}. It may be further limited to one project.`,
    advice:
      risk.level === "green" && !escalated
        ? "Low risk. Keep it out of git anyway."
        : "Use a project-scoped token for the one project this app needs, then revoke this one.",
    capabilities: escalated ? { ...risk.capabilities, deploy_production: true, read_env_vars: true } : risk.capabilities,
  };
  return identity !== undefined ? { ...finding, identity } : finding;
}

export const vercel: Connector = {
  id: "vercel",
  name: "Vercel",
  allowlist: {
    connector: "vercel",
    rules: [
      { method: "GET", host: HOST, path: "/v5/user/tokens/current" },
      { method: "GET", host: HOST, path: "/v2/user" },
      { method: "GET", host: HOST, path: "/v2/teams/*" },
    ],
  },

  detect(env) {
    const prefixed = detectSecrets(env, { connector: "vercel", valuePattern: PREFIXED, allowedHosts: [HOST], kind: vercelKind });
    const legacy = detectSecrets(env, {
      connector: "vercel",
      keys: LEGACY_KEYS,
      valuePattern: LEGACY,
      allowedHosts: [HOST],
      kind: vercelKind,
    });
    // Disjoint patterns (legacy values have no underscore), so no duplicates.
    return [...prefixed, ...legacy];
  },

  async check(secret: Secret, ctx: CheckContext): Promise<Finding[]> {
    const base = inferred(secret.kind);
    if (ctx.offline || secret.kind === "app refresh token") return [base];

    // Step 1: token metadata. Nothing is known yet, so a network failure is
    // simply "unknown"; other errors propagate and scan.ts reports them.
    let res: SafeResponse;
    try {
      res = await ctx.fetch({ method: "GET", url: `https://${HOST}/v5/user/tokens/current`, secret });
    } catch (err: unknown) {
      if (isNetworkFailure(err)) return [unknownFinding(base, `could not reach ${HOST}`)];
      throw err;
    }
    if (isInvalid(res)) return [INVALID];
    if (!res.ok) return [unknownFinding(base, `Vercel answered ${res.status}; it may be a team- or project-scoped token`)];

    const token = obj(obj(res.json)?.["token"]);
    if (token === undefined) return [unknownFinding(base, "unexpected token metadata")];

    // From here on, every step handles its own errors so that findings already
    // confirmed (e.g. the leak flag) are never dropped by a later failure.
    const out: Finding[] = [];
    const leakedAt = token["leakedAt"];
    if (typeof leakedAt === "number" && Number.isFinite(leakedAt)) out.push(leakedFinding(leakedAt));

    const scopes = Array.isArray(token["scopes"]) ? token["scopes"].map(obj) : [];
    if (scopes.some((s) => s?.["type"] === "user")) {
      let identity: string | undefined;
      try {
        const user = await ctx.fetch({ method: "GET", url: `https://${HOST}/v2/user`, secret });
        if (user.ok) identity = str(obj(obj(user.json)?.["user"])?.["username"], NAME);
      } catch {
        // The username is cosmetic: the scope is already confirmed.
      }
      const full: Finding = {
        level: "red",
        confidence: "confirmed",
        message: "Full-account token: can deploy, read env vars and delete projects and domains in your account and every team you belong to.",
        advice: "Replace it with a project-scoped token and revoke this one.",
        capabilities: FULL_ACCESS,
      };
      out.push(identity !== undefined ? { ...full, identity: `user ${identity}` } : full);
      return out;
    }

    const teamIds = scopes.map((s) => s?.["teamId"]).filter((id): id is string => typeof id === "string" && TEAM_ID.test(id));
    if (teamIds.length === 0) {
      out.push(unknownFinding(base, "Vercel did not report a recognised scope"));
      return out;
    }
    for (const [i, teamId] of teamIds.entries()) {
      if (i >= MAX_TEAMS) {
        out.push(unknownFinding(base, `${teamIds.length - MAX_TEAMS} more team scopes not checked`));
        break;
      }
      try {
        const team = await ctx.fetch({ method: "GET", url: `https://${HOST}/v2/teams/${teamId}`, secret });
        const f = team.ok ? teamFinding(team.json) : undefined;
        out.push(f ?? unknownFinding(base, team.ok ? "unrecognised team role" : `Vercel answered ${team.status} for the team`));
      } catch (err: unknown) {
        out.push(unknownFinding(base, isNetworkFailure(err) ? `could not reach ${HOST}` : `team lookup failed: ${failureReason(err)}`));
      }
    }
    return out;
  },
};

/** Registry entry, picked up by scripts/gen-connectors.mjs. */
export const connector: Connector = vercel;
