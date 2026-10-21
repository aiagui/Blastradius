/**
 * Minimal dotenv parser. Never logs, prints or throws with values in messages.
 *
 * Supported:
 *   KEY=value            KEY="double quoted\nwith escapes"
 *   export KEY=value     KEY='single quoted, literal'
 *   KEY=value # comment  multi-line values inside double or single quotes
 * Not supported (on purpose): variable expansion (${OTHER}), command substitution.
 */
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * True when `target` is a path strictly inside `root` (after both are resolved).
 * Uses a path-segment check so a directory named `..data` is not treated as `..`.
 */
export function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || isAbsolute(rel)) return false;
  if (rel === "..") return false;
  // relative() uses the platform separator; also accept the other one.
  if (rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) return false;
  return true;
}

const OPEN_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0) |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);


function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null || !("code" in err)) return "";
  const code: unknown = Reflect.get(err, "code");
  return typeof code === "string" || typeof code === "number" ? String(code) : "";
}

const HAS_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0;

/**
 * Reads one env file under `dir` after rejecting unsafe targets.
 *
 * On platforms with O_NOFOLLOW (Linux, macOS): open the path once with
 * O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fstat the fd, require a regular file within
 * the size cap, confirm the opened path's realpath stays inside `--dir`, then
 * read at most MAX+1 bytes from the fd. Symlinks to a file inside `--dir` are
 * opened via their realpath (also with O_NOFOLLOW). This closes the TOCTOU
 * window where a racer could swap in a symlink or FIFO between lstat and read.
 *
 * Residual: a symlink in a *directory component* of the path can still point
 * the final open outside `--dir` until we check realpath after open; we reject
 * that case. A replace of the file after open with a hardlink is not prevented
 * (same inode). Windows has no O_NOFOLLOW, so we fall back to realpath + open.
 */
export async function readEnvFile(
  dir: string,
  name: string,
): Promise<{ content: string } | { skip: EnvSkipReason }> {
  const path = join(dir, name);
  let dirReal: string;
  try {
    dirReal = await realpath(dir);
  } catch {
    return { skip: "unreadable" };
  }

  if (!HAS_NOFOLLOW) {
    return readEnvFileFallback(dirReal, path);
  }

  try {
    return await readFromOpenPath(path, dirReal);
  } catch (err: unknown) {
    const code = errorCode(err);
    // ELOOP: path is a symlink and O_NOFOLLOW refused it. Allow only if the
    // resolved target stays inside --dir, then open that target with O_NOFOLLOW.
    if (code === "ELOOP" || code === "EMLINK") {
      let target: string;
      try {
        target = await realpath(path);
      } catch {
        return { skip: "unreadable" };
      }
      if (!isPathInside(dirReal, target)) return { skip: "symlink_outside" };
      try {
        return await readFromOpenPath(target, dirReal);
      } catch {
        return { skip: "unreadable" };
      }
    }
    if (code === "ENOENT") return { skip: "unreadable" };
    // EISDIR, ENXIO (fifo on some systems after NONBLOCK), etc.
    if (code === "EISDIR" || code === "ENXIO" || code === "EAGAIN") return { skip: "not_regular" };
    return { skip: "unreadable" };
  }
}

async function readFromOpenPath(
  path: string,
  dirReal: string,
): Promise<{ content: string } | { skip: EnvSkipReason }> {
  const fh = await open(path, OPEN_FLAGS);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { skip: "not_regular" };
    if (st.size > MAX_ENV_FILE_BYTES) return { skip: "too_large" };

    let openedReal: string;
    try {
      openedReal = await realpath(path);
    } catch {
      return { skip: "unreadable" };
    }
    if (!isPathInside(dirReal, openedReal)) return { skip: "symlink_outside" };

    const buf = Buffer.allocUnsafe(MAX_ENV_FILE_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, MAX_ENV_FILE_BYTES + 1, 0);
    if (bytesRead > MAX_ENV_FILE_BYTES) return { skip: "too_large" };
    return { content: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Windows / platforms without O_NOFOLLOW: realpath then open the resolved path. */
async function readEnvFileFallback(
  dirReal: string,
  path: string,
): Promise<{ content: string } | { skip: EnvSkipReason }> {
  let target: string;
  try {
    target = await realpath(path);
  } catch {
    return { skip: "unreadable" };
  }
  if (!isPathInside(dirReal, target)) return { skip: "symlink_outside" };
  try {
    return await readFromOpenPath(target, dirReal);
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === "EISDIR" || code === "ENXIO" || code === "EAGAIN") return { skip: "not_regular" };
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
