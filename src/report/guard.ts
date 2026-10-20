import { REDACTED, type Secret } from "../secret.js";

/** Minimum length for a value to be guarded (shorter values cause false positives). */
const MIN_GUARD_LEN = 8;

/**
 * Last line of defence: scans rendered output for any raw secret value and
 * redacts it. If anything had to be redacted, `leaked` is true and the CLI
 * exits with an internal error, so a bug can never ship a secret silently.
 */
export function guardOutput(text: string, secrets: readonly Secret[]): { text: string; leaked: boolean } {
  let out = text;
  let leaked = false;
  for (const s of secrets) {
    const v = s.reveal();
    if (v.length < MIN_GUARD_LEN) continue;
    const variants = new Set([v, JSON.stringify(v).slice(1, -1)]);
    for (const needle of variants) {
      if (out.includes(needle)) {
        leaked = true;
        out = out.split(needle).join(REDACTED);
      }
    }
  }
  return { text: out, leaked };
}
