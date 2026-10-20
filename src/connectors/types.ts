import type { EnvEntry } from "../env/parse.js";
import type { Allowlist, SafeFetch } from "../net/safeFetch.js";
import type { Secret } from "../secret.js";

/** Traffic-light severity of what a credential can do. */
export type Level = "red" | "amber" | "green";

/**
 * How sure we are:
 *  - confirmed: verified live against the provider's API.
 *  - inferred:  deduced from the credential format or a partial check.
 *  - unknown:   we could not tell (offline, network error, expired, ambiguous 403...).
 */
export type Confidence = "confirmed" | "inferred" | "unknown";

/** A capability flag. "unknown" is a first-class answer, never coerced to false. */
export type Capability = boolean | "unknown";

export interface Finding {
  readonly level: Level;
  readonly confidence: Confidence;
  /** One line, human readable. MUST NOT contain the secret value. */
  readonly message: string;
  /** What to do about it. MUST NOT contain the secret value. */
  readonly advice?: string;
  /** Non-sensitive identity the credential belongs to (e.g. "user octocat", "team acme"). */
  readonly identity?: string;
  /** Machine-readable capabilities, e.g. { read_repos: true, move_money: false }. */
  readonly capabilities?: Readonly<Record<string, Capability>>;
}

export interface CheckContext {
  /** safeFetch already bound to this connector's allowlist. The only way to reach the network. */
  readonly fetch: SafeFetch;
  /** When true, connectors must not call `fetch` and should return inferred/unknown findings. */
  readonly offline: boolean;
}

/**
 * One connector per provider, one file per connector under src/connectors/.
 *
 * Contract:
 *  - `detect` is pure and synchronous: no I/O, no network, no logging.
 *  - `check` may only reach the network through `ctx.fetch`, and only with
 *    requests matching `allowlist`. Never mutate anything on the provider.
 *  - Never put secret values in findings. The CLI aborts the report if it does.
 *  - Unknown is a valid answer. Do not guess "green" when a check fails.
 */
export interface Connector {
  /** Stable lower-case id, e.g. "github". */
  readonly id: string;
  /** Display name, e.g. "GitHub". */
  readonly name: string;
  /** Every network call this connector may make. Reviewed in every PR that touches it. */
  readonly allowlist: Allowlist;
  /** Finds credentials for this provider in parsed env entries. */
  detect(env: readonly EnvEntry[]): Secret[];
  /** Checks one credential live (read-only) and reports what it can do. */
  check(secret: Secret, ctx: CheckContext): Promise<Finding[]>;
}
