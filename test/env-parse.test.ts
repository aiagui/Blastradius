import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEnvFiles, loadEnvDir, MAX_ENV_FILE_BYTES, parseEnv } from "../src/env/parse.js";

const kv = (s: string): Record<string, string> => Object.fromEntries(parseEnv(s).map((e) => [e.key, e.value]));

describe("parseEnv", () => {
  it("parses plain, quoted and exported values", () => {
    expect(
      kv(`A=1
export B=two
C="three four"
D='five # not a comment'
E=six # comment
F=
  G = spaced
`),
    ).toEqual({ A: "1", B: "two", C: "three four", D: "five # not a comment", E: "six", F: "", G: "spaced" });
  });

  it("keeps # inside unquoted values without leading whitespace", () => {
    expect(kv("URL=https://x.test/#frag")).toEqual({ URL: "https://x.test/#frag" });
  });

  it("handles escapes in double quotes and literal single quotes", () => {
    expect(kv(`A="a\\nb\\"c"\nB='a\\nb'`)).toEqual({ A: 'a\nb"c', B: "a\\nb" });
  });

  it("supports multi-line quoted values and tracks line numbers", () => {
    const entries = parseEnv(`KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1\n`);
    expect(entries.map((e) => [e.key, e.line])).toEqual([
      ["KEY", 1],
      ["NEXT", 4],
    ]);
    expect(entries[0]!.value).toBe("-----BEGIN-----\nabc\n-----END-----");
  });

  it("handles CRLF, BOM and comments", () => {
    expect(kv("\uFEFF# c\r\nA=1\r\n\r\n#B=2\r\nC=3")).toEqual({ A: "1", C: "3" });
  });

  it("ignores malformed lines without throwing or echoing them", () => {
    expect(kv("this is not valid\nsk_live_garbage\nA=1\n1BAD=2")).toEqual({ A: "1" });
  });

  it("does not expand variables", () => {
    expect(kv("A=1\nB=${A}")).toEqual({ A: "1", B: "${A}" });
  });

  it("records the source file", () => {
    expect(parseEnv("A=1", ".env.local")[0]!.source).toBe(".env.local");
  });
});

describe("findEnvFiles / loadEnvDir", () => {
  it("finds .env* files in precedence order and skips examples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "br-env-"));
    for (const n of [".env.local", ".env", ".env.example", ".env.production", ".envrc", "env", ".env.staging"]) {
      await writeFile(join(dir, n), `FROM=${n}\n`);
    }
    expect(await findEnvFiles(dir)).toEqual([".env", ".env.local", ".env.production", ".env.staging"]);
    const { entries } = await loadEnvDir(dir);
    expect(entries.map((e) => e.source)).toEqual([".env", ".env.local", ".env.production", ".env.staging"]);
  });

  it("returns nothing for a missing directory", async () => {
    expect(await findEnvFiles(join(tmpdir(), "does-not-exist-br"))).toEqual([]);
  });
});

describe("loadEnvDir safety", () => {
  it("skips symlinks that resolve outside the scanned directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "br-env-"));
    const outside = await mkdtemp(join(tmpdir(), "br-out-"));
    writeFileSync(join(outside, "secret.env"), "GITHUB_TOKEN=ghp_OUTSIDE00000000000000000000000001\n");
    writeFileSync(join(root, ".env"), "A=1\n");
    symlinkSync(join(outside, "secret.env"), join(root, ".env.local"));
    const { entries, skipped } = await loadEnvDir(root);
    expect(entries.map((e) => e.key)).toEqual(["A"]);
    expect(skipped).toEqual([{ name: ".env.local", reason: "symlink_outside" }]);
  });

  it("reads a symlink that stays inside --dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "br-env-"));
    writeFileSync(join(root, "real.env"), "INSIDE=1\n");
    symlinkSync(join(root, "real.env"), join(root, ".env"));
    const { entries, skipped } = await loadEnvDir(root);
    expect(entries.map((e) => [e.key, e.value])).toEqual([["INSIDE", "1"]]);
    expect(skipped).toEqual([]);
  });

  it("skips FIFOs", async () => {
    const root = await mkdtemp(join(tmpdir(), "br-env-"));
    execFileSync("mkfifo", [join(root, ".env")]);
    const { entries, skipped } = await loadEnvDir(root);
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ name: ".env", reason: "not_regular" }]);
  });

  it("skips files larger than MAX_ENV_FILE_BYTES", async () => {
    const root = await mkdtemp(join(tmpdir(), "br-env-"));
    writeFileSync(join(root, ".env"), "X=" + "y".repeat(MAX_ENV_FILE_BYTES) + "\n");
    const { entries, skipped } = await loadEnvDir(root);
    expect(entries).toEqual([]);
    expect(skipped).toEqual([{ name: ".env", reason: "too_large" }]);
  });
});
