import type { SecretResult, Summary } from "../risk/aggregate.js";

export interface Report {
  readonly tool: "blastradius";
  readonly version: string;
  readonly generatedAt: string;
  readonly directory: string;
  readonly files: readonly string[];
  readonly offline: boolean;
  readonly summary: Summary;
  readonly results: readonly SecretResult[];
}
