import type { Confidence, Finding, Level } from "../connectors/types.js";

const LEVEL_RANK: Record<Level, number> = { green: 0, amber: 1, red: 2 };

/** Result for one detected credential. Holds no secret values. */
export interface SecretResult {
  readonly connector: string;
  readonly connectorName: string;
  readonly envKey: string;
  readonly source: string;
  /** Public prefix + length only, e.g. "ghp_… (40 chars)". */
  readonly hint: string;
  readonly level: Level;
  readonly confidence: Confidence;
  readonly findings: readonly Finding[];
}

export interface Summary {
  readonly level: Level | "none";
  readonly counts: Readonly<Record<Level, number>>;
  readonly total: number;
}

export function worstLevel(levels: readonly Level[]): Level | undefined {
  let worst: Level | undefined;
  for (const l of levels) if (worst === undefined || LEVEL_RANK[l] > LEVEL_RANK[worst]) worst = l;
  return worst;
}

/** Overall confidence is the weakest confidence among findings at the worst level. */
export function weakestConfidence(findings: readonly Finding[], level: Level): Confidence {
  const order: Confidence[] = ["unknown", "inferred", "confirmed"];
  const at = findings.filter((f) => f.level === level).map((f) => order.indexOf(f.confidence));
  return order[Math.min(...at)] ?? "unknown";
}

/** Collapses a connector's findings into one per-secret level. No findings means unknown/amber. */
export function rollUp(findings: readonly Finding[]): { level: Level; confidence: Confidence } {
  const level = worstLevel(findings.map((f) => f.level));
  if (level === undefined) return { level: "amber", confidence: "unknown" };
  return { level, confidence: weakestConfidence(findings, level) };
}

export function summarize(results: readonly SecretResult[]): Summary {
  const counts: Record<Level, number> = { red: 0, amber: 0, green: 0 };
  for (const r of results) counts[r.level]++;
  return { level: worstLevel(results.map((r) => r.level)) ?? "none", counts, total: results.length };
}

export function sortResults(results: readonly SecretResult[]): SecretResult[] {
  return [...results].sort(
    (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.connector.localeCompare(b.connector) || a.envKey.localeCompare(b.envKey),
  );
}

export function meetsThreshold(level: Level | "none", threshold: Level): boolean {
  return level !== "none" && LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}
