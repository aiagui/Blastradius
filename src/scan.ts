import { connectors as defaultConnectors } from "./connectors/index.js";
import type { Connector, Finding } from "./connectors/types.js";
import { findEnvFiles, loadEnvDir } from "./env/parse.js";
import { createSafeFetch, SafeFetchError } from "./net/safeFetch.js";
import { rollUp, sortResults, summarize, type SecretResult } from "./risk/aggregate.js";
import type { Report } from "./report/model.js";
import type { Secret } from "./secret.js";
import { redactSecrets } from "./redact.js";
import { VERSION } from "./version.js";

export interface ScanOptions {
  readonly dir: string;
  /** Explicit env file names (relative to dir). Defaults to every .env* file in dir. */
  readonly files?: readonly string[];
  readonly offline: boolean;
  readonly connectors?: readonly Connector[];
  readonly now?: () => Date;
}

export interface ScanResult {
  readonly report: Report;
  /** Every secret value seen, for the output leak guard. Never serialized. */
  readonly secrets: readonly Secret[];
  /** .env files that were found but not read (symlink, size, type). */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

function failureFinding(err: unknown): Finding {
  // Only SafeFetchError messages are known to be value-free; anything else is summarized.
  const why = err instanceof SafeFetchError ? err.message : "unexpected connector error";
  return {
    level: "amber",
    confidence: "unknown",
    message: `Check failed: ${why}`,
    advice: "Treat this credential as risky until it can be checked.",
  };
}

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const list = opts.connectors ?? defaultConnectors;
  const ids = new Set<string>();
  for (const c of list) {
    if (ids.has(c.id)) throw new Error(`Duplicate connector id: ${c.id}`);
    if (c.allowlist.connector !== c.id) throw new Error(`Connector ${c.id} has an allowlist for ${c.allowlist.connector}`);
    ids.add(c.id);
  }

  const files = opts.files ?? (await findEnvFiles(opts.dir));
  const { entries: env, skipped } = await loadEnvDir(opts.dir, files);
  const results: SecretResult[] = [];
  const allSecrets: Secret[] = [];

  for (const connector of list) {
    const ctx = { fetch: createSafeFetch(connector.allowlist), offline: opts.offline };
    const secrets = connector.detect(env);
    allSecrets.push(...secrets);
    const checked = await Promise.all(
      secrets.map(async (secret) => {
        let findings: Finding[];
        try {
          findings = await connector.check(secret, ctx);
        } catch (err: unknown) {
          findings = [failureFinding(err)];
        }
        const { level, confidence } = rollUp(findings);
        const result: SecretResult = {
          connector: connector.id,
          connectorName: connector.name,
          envKey: secret.envKey,
          source: secret.source,
          hint: secret.hint(),
          level,
          confidence,
          findings,
        };
        return result;
      }),
    );
    results.push(...checked);
  }

  const sorted = sortResults(results);
  const report: Report = {
    tool: "blastradius",
    version: VERSION,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    directory: redactSecrets(opts.dir),
    files: files.map((f) => redactSecrets(f)),
    offline: opts.offline,
    summary: summarize(sorted),
    results: sorted,
  };
  return { report, secrets: allSecrets, skipped };
}
