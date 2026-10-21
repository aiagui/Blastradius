/**
 * Minimal dotenv parser. Never logs, prints or throws with values in messages.
 *
 * Supported:
 *   KEY=value            KEY="double quoted\nwith escapes"
 *   export KEY=value     KEY='single quoted, literal'
 *   KEY=value # comment  multi-line values inside double or single quotes
 * Not supported (on purpose): variable expansion (${OTHER}), command substitution.
 */
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface EnvEntry {
  readonly key: string;
  readonly value: string;
  /** File the entry came from (basename). */
  readonly source: string;
  /** 1-based line number where the key appears. */
  readonly line: number;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseEnv(content: string, source = ".env"): EnvEntry[] {
  const out: EnvEntry[] = [];
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const len = text.length;
  let i = 0;
  let line = 1;

  const skipToEol = (): void => {
    while (i < len && text[i] !== "\n") i++;
  };

  while (i < len) {
    // skip leading whitespace (not newlines)
    while (i < len && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= len) break;
    if (text[i] === "\n") {
      i++;
      line++;
      continue;
    }
    if (text[i] === "#") {
      skipToEol();
      continue;
    }

    const startLine = line;
    // read key up to '='
    let eq = i;
    while (eq < len && text[eq] !== "=" && text[eq] !== "\n") eq++;
    if (eq >= len || text[eq] !== "=") {
      // malformed line: ignore silently (do not echo it, it may contain a secret)
      i = eq;
      continue;
    }
    let key = text.slice(i, eq).trim();
    if (key.startsWith("export ") || key.startsWith("export\t")) key = key.slice(7).trim();
    i = eq + 1;
    while (i < len && (text[i] === " " || text[i] === "\t")) i++;

    let value: string;
    const q = text[i];
    if (q === '"' || q === "'" || q === "`") {
      i++;
      let buf = "";
      let closed = false;
      while (i < len) {
        const c = text[i] as string;
        if (c === "\\" && q === '"' && i + 1 < len) {
          const n = text[i + 1] as string;
          buf += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
          i += 2;
          continue;
        }
        if (c === q) {
          closed = true;
          i++;
          break;
        }
        if (c === "\n") line++;
        buf += c;
        i++;
      }
      value = closed ? buf : buf.split("\n")[0] ?? "";
      skipToEol();
    } else {
      let end = i;
      while (end < len && text[end] !== "\n") end++;
      let raw = text.slice(i, end);
      const hash = raw.search(/\s#/);
      if (hash !== -1) raw = raw.slice(0, hash);
      value = raw.trim();
      i = end;
    }

    if (KEY_RE.test(key)) out.push({ key, value, source, line: startLine });
  }
  return out;
}

/** Files read by default, in precedence order (later entries win on duplicate keys). */
export const DEFAULT_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.test",
  ".env.test.local",
  ".env.production",
  ".env.production.local",
] as const;

const ENV_FILE_RE = /^\.env(\.[A-Za-z0-9_-]+)*$/;
const SKIP_SUFFIXES = [".example", ".sample", ".template", ".dist"];

/** Lists .env* files in `dir` (not recursive), skipping example/template files. */
export async function findEnvFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const found = names.filter(
    (n) => ENV_FILE_RE.test(n) && !SKIP_SUFFIXES.some((s) => n.endsWith(s)),
  );
  const order = (n: string): number => {
    const idx = (DEFAULT_ENV_FILES as readonly string[]).indexOf(n);
    return idx === -1 ? DEFAULT_ENV_FILES.length : idx;
  };
  return found.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
}

/** Cap on a single .env file. Larger files are skipped (finding F3). */
export const MAX_ENV_FILE_BYTES = 1_048_576;

export type EnvSkipReason = "not_regular" | "symlink_outside" | "too_large" | "unreadable";

export interface EnvSkip {
  readonly name: string;
  readonly reason: EnvSkipReason;
}

/**
 * Reads one env file under `dir` after rejecting unsafe targets.
 * Symlinks are followed only when the resolved path stays inside `dir`.
 * Returns null when the file should be skipped (missing or unsafe).
 */
export async function readEnvFile(
  dir: string,
  name: string,
): Promise<{ content: string } | { skip: EnvSkipReason }> {
  const path = join(dir, name);
  let link;
  try {
    link = await lstat(path);
  } catch {
    return { skip: "unreadable" };
  }

  if (link.isSymbolicLink()) {
    let target: string;
    let dirReal: string;
    try {
      target = await realpath(path);
      dirReal = await realpath(dir);
    } catch {
      return { skip: "unreadable" };
    }
    const rel = relative(dirReal, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { skip: "symlink_outside" };
    }
    let targetStat;
    try {
      targetStat = await stat(target);
    } catch {
      return { skip: "unreadable" };
    }
    if (!targetStat.isFile()) return { skip: "not_regular" };
    if (targetStat.size > MAX_ENV_FILE_BYTES) return { skip: "too_large" };
    try {
      return { content: await readFile(target, "utf8") };
    } catch {
      return { skip: "unreadable" };
    }
  }

  if (!link.isFile()) return { skip: "not_regular" };
  if (link.size > MAX_ENV_FILE_BYTES) return { skip: "too_large" };
  try {
    return { content: await readFile(path, "utf8") };
  } catch {
    return { skip: "unreadable" };
  }
}

/** Reads and parses every .env* file in `dir`. All entries are kept (connectors dedupe). */
export async function loadEnvDir(
  dir: string,
  files?: readonly string[],
): Promise<{ entries: EnvEntry[]; skipped: EnvSkip[] }> {
  const list = files ?? (await findEnvFiles(dir));
  const entries: EnvEntry[] = [];
  const skipped: EnvSkip[] = [];
  // Resolve once so symlink checks are against the real scan root.
  const root = resolve(dir);
  for (const name of list) {
    const result = await readEnvFile(root, name);
    if ("skip" in result) {
      // Missing files stay silent (same as before). Everything else is recorded.
      if (result.skip !== "unreadable") skipped.push({ name, reason: result.skip });
      continue;
    }
    entries.push(...parseEnv(result.content, name));
  }
  return { entries, skipped };
}
