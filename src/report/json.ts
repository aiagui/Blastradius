import type { Report } from "./model.js";

/** Stable JSON output for scripts and CI. Contains no secret values by construction. */
export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
