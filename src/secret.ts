import { inspect } from "node:util";

const REDACTED = "[REDACTED]";

/** Public, documented token prefixes. Only these may ever be printed. */
const KNOWN_PREFIXES = [
  "github_pat_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "rk_test_",
  "pk_live_",
  "pk_test_",
  "whsec_",
  "vcp_",
  "vci_",
  "vca_",
  "vcr_",
] as const;

/** Values held privately so they never appear in enumerable fields. */
const values = new WeakMap<Secret, string>();

export interface SecretInit {
  /** Connector that owns this secret, e.g. "github". */
  readonly connector: string;
  /** Name of the env var it came from, e.g. "GITHUB_TOKEN". */
  readonly envKey: string;
  /** File it was found in, relative to the scanned directory. */
  readonly source: string;
  /** The raw credential value. Never printed, logged or serialized. */
  readonly value: string;
  /** Exact hostnames this secret may be sent to. safeFetch enforces this. */
  readonly allowedHosts: readonly string[];
  /** Optional non-sensitive label the connector derived (e.g. "classic PAT"). */
  readonly kind?: string;
}

/**
 * Wraps a credential so it cannot leak by accident: toString, toJSON and
 * util.inspect all return a redacted marker. The raw value is only reachable
 * through `reveal()`, which only safeFetch should call.
 */
export class Secret {
  readonly connector: string;
  readonly envKey: string;
  readonly source: string;
  readonly allowedHosts: readonly string[];
  readonly kind: string | undefined;

  constructor(init: SecretInit) {
    if (init.allowedHosts.length === 0) {
      throw new Error(`Secret ${init.envKey} must declare at least one allowed host`);
    }
    this.connector = init.connector;
    this.envKey = init.envKey;
    this.source = init.source;
    this.allowedHosts = Object.freeze(init.allowedHosts.map((h) => h.toLowerCase()));
    this.kind = init.kind;
    values.set(this, init.value);
    Object.freeze(this);
  }

  /** True if this secret may be sent to `host` (exact, case-insensitive match). */
  allowedHost(host: string): boolean {
    return this.allowedHosts.includes(host.toLowerCase());
  }

  /** Returns the raw value. Only safeFetch and connector detection helpers may call this. */
  reveal(): string {
    const v = values.get(this);
    if (v === undefined) throw new Error("Secret value missing");
    return v;
  }

  /**
   * A short hint that is safe to print: a well-known public prefix (e.g. "ghp_",
   * "sk_live_") plus the length. Never includes any random part of the value.
   */
  hint(): string {
    const v = this.reveal();
    const prefix = KNOWN_PREFIXES.find((p) => v.startsWith(p)) ?? "";
    return `${prefix}… (${v.length} chars)`;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): Record<string, unknown> {
    return { connector: this.connector, envKey: this.envKey, source: this.source, value: REDACTED };
  }

  [inspect.custom](): string {
    return `Secret(${this.connector}:${this.envKey} ${REDACTED})`;
  }
}

export { REDACTED };
