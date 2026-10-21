import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findEnvFiles, isPathInside, loadEnvDir, MAX_ENV_FILE_BYTES, parseEnv, readEnvFile } from "../src/env/parse.js";

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

  it("reads a file of exactly MAX_ENV_FILE_BYTES", async () => {
    const root = await mkdtemp(join(tmpdir(), "br-env-"));
    const body = "X=" + "y".repeat(MAX_ENV_FILE_BYTES - 3) + "\n";
    writeFileSync(join(root, ".env"), body);
    const { entries, skipped } = await loadEnvDir(root);
    expect(skipped).toEqual([]);
    expect(entries[0]?.value.length).toBe(MAX_ENV_FILE_BYTES - 3);
  });

  it("keeps reading after a short read", async () => {
    const root = await mkdtemp(join(tmpdir(), "br-env-"));
    const body = "A=1\n" + "B=" + "z".repeat(20_000) + "\nC=3\n";
    writeFileSync(join(root, ".env"), body);
    const probe = await open(join(root, ".env"), "r");
    const proto: { read: (...a: unknown[]) => Promise<unknown> } = Object.getPrototypeOf(probe) as never;
    await probe.close();
    const realRead = proto.read;
    // Simulate a filesystem that returns at most 4 KiB per read().
    const spy = vi.spyOn(proto, "read").mockImplementation(function (this: unknown, ...args: unknown[]) {
      const [buf, off, len, pos] = args;
      return realRead.call(this, buf, off, Math.min(Number(len), 4096), pos);
    });
    try {
      const { entries } = await loadEnvDir(root);
      expect(entries.map((e) => e.key)).toEqual(["A", "B", "C"]);
      expect(spy.mock.calls.length).toBeGreaterThan(2);
    } finally {
      spy.mockRestore();
    }
  });

  const canRace =
    process.platform === "linux" && spawnSync("python3", ["-c", "import ctypes; ctypes.CDLL(None).renameat2"]).status === 0;

  it.skipIf(!canRace)("does not read outside --dir when a parent directory is swapped", async () => {
    const base = realpathSync(await mkdtemp(join(tmpdir(), "br-race-")));
    mkdirSync(join(base, "a/sub"), { recursive: true });
    writeFileSync(join(base, "a/sub/.env"), "SAFE=1\n");
    mkdirSync(join(base, "evil/sub"), { recursive: true });
    writeFileSync(join(base, "evil/sub/.env"), "OUTSIDE=1\n");
    symlinkSync(join(base, "evil"), join(base, "b"));
    const dirReal = join(base, "a/sub"); // resolved while a/ is still real
    const racer = spawn(
      "python3",
      ["-c", "import ctypes,sys\nl=ctypes.CDLL(None)\nwhile True: l.renameat2(-100,sys.argv[1].encode(),-100,sys.argv[2].encode(),2)", join(base, "a"), join(base, "b")],
      { stdio: "ignore" },
    );
    let outside = 0;
    try {
      const end = Date.now() + 1500;
      while (Date.now() < end) {
        const r = await readEnvFile(dirReal, ".env");
        if ("content" in r && r.content.includes("OUTSIDE")) outside++;
      }
    } finally {
      racer.kill("SIGKILL");
    }
    expect(outside).toBe(0);
  });

  it("allows a symlink into a directory whose name starts with ..", async () => {
    const root = await mkdtemp(join(tmpdir(), "br-env-"));
    const odd = join(root, "..data");
    await writeFile(join(root, ".keep"), "");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(odd);
    writeFileSync(join(odd, "e"), "INSIDE=1\n");
    symlinkSync(join(odd, "e"), join(root, ".env"));
    const { entries, skipped } = await loadEnvDir(root);
    expect(skipped).toEqual([]);
    expect(entries.map((e) => e.key)).toEqual(["INSIDE"]);
  });
});

describe("isPathInside", () => {
  it("rejects .. segments but allows ..data", () => {
    expect(isPathInside("/app", "/app/..data/e")).toBe(true);
    expect(isPathInside("/app", "/app/sub/f")).toBe(true);
    expect(isPathInside("/app", "/app/../outside")).toBe(false);
    expect(isPathInside("/app", "/outside")).toBe(false);
    expect(isPathInside("/app", "/app")).toBe(false);
  });


});
