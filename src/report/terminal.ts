import type { Level } from "../connectors/types.js";
import type { Report } from "./model.js";

export interface TerminalOptions {
  readonly color: boolean;
}

const ANSI = { red: "\x1b[31m", amber: "\x1b[33m", green: "\x1b[32m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" } as const;
const LABEL: Record<Level, string> = { red: "RED  ", amber: "AMBER", green: "GREEN" };
const DOT: Record<Level, string> = { red: "●", amber: "●", green: "●" };

export function renderTerminal(report: Report, opts: TerminalOptions): string {
  const c = (code: keyof typeof ANSI, s: string): string => (opts.color ? `${ANSI[code]}${s}${ANSI.reset}` : s);
  const lines: string[] = [];

  lines.push(c("bold", `blastradius ${report.version}`) + c("dim", `  ${report.directory}`));
  lines.push(
    c("dim", report.files.length > 0 ? `Scanned: ${report.files.join(", ")}` : "No .env files found.") +
      (report.offline ? c("dim", "  (offline: nothing was checked live)") : ""),
  );
  lines.push("");

  if (report.results.length === 0) {
    lines.push(report.files.length > 0 ? "No supported credentials found." : "Nothing to check.");
    return `${lines.join("\n")}\n`;
  }

  for (const r of report.results) {
    lines.push(
      `${c(r.level, `${DOT[r.level]} ${LABEL[r.level]}`)}  ${c("bold", r.connectorName)}  ${r.envKey}` +
        c("dim", `  ${r.hint}  in ${r.source}  [${r.confidence}]`),
    );
    for (const f of r.findings) {
      const who = f.identity !== undefined ? c("dim", ` (${f.identity})`) : "";
      lines.push(`         ${f.message}${who}`);
      if (f.capabilities !== undefined) {
        const caps = Object.entries(f.capabilities)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join("  ");
        if (caps !== "") lines.push(c("dim", `         ${caps}`));
      }
      if (f.advice !== undefined) lines.push(c("dim", `         → ${f.advice}`));
    }
    lines.push("");
  }

  const { counts, total } = report.summary;
  lines.push(
    `${String(total)} credential${total === 1 ? "" : "s"}: ` +
      [c("red", `${String(counts.red)} red`), c("amber", `${String(counts.amber)} amber`), c("green", `${String(counts.green)} green`)].join(", "),
  );
  return `${lines.join("\n")}\n`;
}
