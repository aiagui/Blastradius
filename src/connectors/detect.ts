import type { EnvEntry } from "../env/parse.js";
import { Secret } from "../secret.js";

export interface DetectSpec {
  readonly connector: string;
  /** Env var names to consider (exact match). */
  readonly keys?: readonly string[];
  /** Or env var names matching this pattern. */
  readonly keyPattern?: RegExp;
  /** Value must match this pattern (e.g. /^ghp_[A-Za-z0-9]{36}$/). */
  readonly valuePattern?: RegExp;
  readonly allowedHosts: readonly string[];
  /** Optional label derived from the value, e.g. "classic PAT". Must not include the value. */
  readonly kind?: (value: string) => string | undefined;
}

/**
 * Shared detection helper: picks env entries matching a spec and wraps them
 * as Secrets. Duplicate values (same token in .env and .env.local) are merged.
 */
export function detectSecrets(env: readonly EnvEntry[], spec: DetectSpec): Secret[] {
  if (spec.keys === undefined && spec.keyPattern === undefined && spec.valuePattern === undefined) {
    throw new Error(`detectSecrets(${spec.connector}): give keys, keyPattern or valuePattern`);
  }
  const byValue = new Map<string, { entry: EnvEntry; sources: string[] }>();
  for (const entry of env) {
    if (entry.value === "") continue;
    const keyFilter = spec.keys !== undefined || spec.keyPattern !== undefined;
    const keyOk =
      !keyFilter || (spec.keys?.includes(entry.key) ?? false) || (spec.keyPattern?.test(entry.key) ?? false);
    const valueOk = spec.valuePattern?.test(entry.value) ?? true;
    const matches = keyOk && valueOk;
    if (!matches) continue;
    const seen = byValue.get(entry.value);
    if (seen) {
      if (!seen.sources.includes(entry.source)) seen.sources.push(entry.source);
    } else {
      byValue.set(entry.value, { entry, sources: [entry.source] });
    }
  }
  return [...byValue.values()].map(({ entry, sources }) => {
    const kind = spec.kind?.(entry.value);
    return new Secret({
      connector: spec.connector,
      envKey: entry.key,
      source: sources.join(", "),
      value: entry.value,
      allowedHosts: spec.allowedHosts,
      ...(kind !== undefined ? { kind } : {}),
    });
  });
}
