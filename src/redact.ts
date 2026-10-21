/**
 * Token-shaped substrings that must never appear in CLI text or report fields.
 * Includes unprefixed 24-char alphanumerics (legacy Vercel tokens).
 */
export const SECRETISH =
  /(?:gh[pousr]_|github_pat_|[srp]k_(?:live|test)_|whsec_|vc[piar]_)[A-Za-z0-9_\-/+]{8,}|\b[0-9a-f]{40}\b|\b[A-Za-z0-9]{24}\b/gi;

/** Redact secret-shaped spans in a string (paths, messages, report fields). */
export function redactSecrets(text: string): string {
  return text.replace(SECRETISH, "[REDACTED]");
}
