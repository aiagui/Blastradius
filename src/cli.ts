#!/usr/bin/env -S node --
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Level } from "./connectors/types.js";
import { meetsThreshold } from "./risk/aggregate.js";
import { guardOutput } from "./report/guard.js";
import { renderJson } from "./report/json.js";
import { renderTerminal } from "./report/terminal.js";
import { scan, type ScanOptions } from "./scan.js";
import { redactSecrets } from "./redact.js";
import { VERSION } from "./version.js";

export interface Io {
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly cwd: string;
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const EXIT = { ok: 0, threshold: 1, usage: 2, internal: 70 } as const;


function redactArgError(err: unknown, argv: readonly string[]): string {
  if (!(err instanceof Error)) return "invalid arguments";
  // parseArgs splits a short-option group (-v<token>) and names the first
  // unknown character, which would echo one character of the token. If the
  // option it names is not an argument the user typed, do not repeat it.
  const unknown = /Unknown option '([^']*)'/.exec(err.message)?.[1];
  if (unknown !== undefined && !argv.some((a) => a === unknown || a.startsWith(`${unknown}=`))) {
    return "Unknown option in a combined short-option group. Pass each option separately.";
  }
  return redactSecrets(err.message);
}

function skipReasonText(reason: string): string {
  switch (reason) {
    case "not_regular":
      return "not a regular file";
    case "symlink_outside":
      return "symlink points outside the scanned directory";
    case "too_large":
      return "larger than 1 MiB";
    default:
      return "could not be read";
  }
}

const HELP = `Usage: blastradius [options]

Reads .env files in the current directory, finds credentials for supported
services and checks live, read-only, what each one can do.

Options:
  -d, --dir <path>        Directory to scan (default: current directory)
  -f, --file <name>       Only read this file inside --dir (repeatable). Default: all .env* files
      --offline           Do not call any API; report what can be inferred
      --json              Print the report as JSON
      --fail-on <level>   Exit 1 if any credential is at least red|amber
      --no-color          Disable colors (also honours NO_COLOR)
  -h, --help              Show this help
  -v, --version           Show version

Secrets are never printed, logged or sent anywhere except the API that issued them.
`;

/**
 * Node itself treats these as its own options even after the script name
 * (nodejs/node#54232) and reads the file (an env file or a config file)
 * before this code runs, so the only
 * real protection is that blastradius never asks for them. Rejecting them
 * here makes sure nobody relies on them by accident.
 */
const NODE_OWNED_FLAGS = [
  "--env-file",
  "--env-file-if-exists",
  "--experimental-config-file",
  "--experimental-default-config-file",
] as const;

function nodeOwnedFlag(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    for (const flag of NODE_OWNED_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`)) return flag;
    }
  }
  return undefined;
}

function isLevel(s: string): s is Level {
  return s === "red" || s === "amber" || s === "green";
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const owned = nodeOwnedFlag(argv);
  if (owned !== undefined) {
    io.stderr(
      `blastradius: ${owned} is a Node.js option, not a blastradius option.\n` +
        "Use -f/--file <name> to pick which file in --dir to scan.\n" +
        "Note: if you run node dist/cli.js (or pass this flag to npx without --), Node may still load that file before blastradius starts.\n",
    );
    return EXIT.usage;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        dir: { type: "string", short: "d" },
        file: { type: "string", short: "f", multiple: true },
        offline: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "fail-on": { type: "string" },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err: unknown) {
    // parseArgs echoes the offending argument. A token passed by mistake
    // (blastradius $GITHUB_TOKEN) must not appear on stderr.
    io.stderr(`blastradius: ${redactArgError(err, argv)}\n\n${HELP}`);
    return EXIT.usage;
  }
  const v = parsed.values;
  if (v.help) {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (v.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  const failOn = v["fail-on"];
  if (failOn !== undefined && (!isLevel(failOn) || failOn === "green")) {
    io.stderr("blastradius: --fail-on must be red or amber\n");
    return EXIT.usage;
  }
  const envFiles = v.file;
  if (envFiles?.some((f) => f.includes("/") || f.includes("\\"))) {
    io.stderr("blastradius: --file takes a file name inside --dir, not a path\n");
    return EXIT.usage;
  }

  const opts: ScanOptions = {
    dir: resolve(io.cwd, v.dir ?? "."),
    offline: v.offline,
    ...(envFiles !== undefined ? { files: envFiles } : {}),
  };

  let result;
  try {
    result = await scan(opts);
  } catch {
    // Do not print the error: it could contain file contents.
    io.stderr("blastradius: internal error while scanning\n");
    return EXIT.internal;
  }

  for (const skip of result.skipped) {
    io.stderr(`blastradius: skipped ${redactSecrets(skip.name)}: ${skipReasonText(skip.reason)}\n`);
  }

  const color = !v["no-color"] && io.isTTY && io.env["NO_COLOR"] === undefined;
  const rendered = v.json ? renderJson(result.report) : renderTerminal(result.report, { color });
  const guarded = guardOutput(rendered, result.secrets);
  if (guarded.leaked) {
    io.stderr("blastradius: internal error: a secret value reached the report and was blocked. Please file a bug.\n");
    return EXIT.internal;
  }
  io.stdout(guarded.text);

  if (failOn !== undefined && meetsThreshold(result.report.summary.level, failOn)) return EXIT.threshold;
  return EXIT.ok;
}

function isEntrypoint(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const code = await main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    isTTY: process.stdout.isTTY,
    env: process.env,
  });
  process.exitCode = code;
}
