import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Marker regression: the installed bin must not let Node load a scanned
 * .env (or config file) before blastradius starts. Packs the local build,
 * installs it with npm into a temp prefix, and runs the real symlink.
 *
 * NODE_OPTIONS is intentionally left alone in the child environment so a
 * leaky ambient value would also fail the test. The payload itself is only
 * in the scanned files.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_SRC = join(ROOT, "dist", "cli.js");

let prefix: string;
let bin: string;
let project: string;
let marker: string;

beforeAll(() => {
  if (!existsSync(CLI_SRC)) throw new Error("dist/cli.js missing: run npm run build first");

  const packDir = mkdtempSync(join(tmpdir(), "br-pack-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const lines = pack.stdout.trim().split("\n").filter(Boolean);
  const tgzName = lines[lines.length - 1];
  if (tgzName === undefined) throw new Error("npm pack produced no tarball name");
  const tgz = join(packDir, tgzName);

  prefix = mkdtempSync(join(tmpdir(), "br-prefix-"));
  const install = spawnSync("npm", ["install", "-g", "--prefix", prefix, tgz], { encoding: "utf8" });
  if (install.status !== 0) throw new Error(`npm install failed: ${install.stderr}\n${install.stdout}`);
  bin = join(prefix, "bin", "blastradius");
  if (!existsSync(bin)) throw new Error(`installed bin missing at ${bin}`);

  project = mkdtempSync(join(tmpdir(), "br-project-"));
  marker = join(project, "MARKER");
  writeFileSync(join(project, "marker.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  writeFileSync(join(project, ".env"), "NODE_OPTIONS=--require ./marker.cjs\nAPP=1\n");
  writeFileSync(
    join(project, "evil.config.json"),
    JSON.stringify({ nodeOptions: { require: "./marker.cjs" } }) + "\n",
  );
  writeFileSync(join(project, "node.config.json"), JSON.stringify({ nodeOptions: { require: "./marker.cjs" } }) + "\n");
});

afterAll(() => {
  rmSync(prefix, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function run(args: string[]): { code: number | null; markers: number } {
  rmSync(marker, { force: true });
  // Do not strip NODE_OPTIONS from the environment.
  const r = spawnSync(bin, args, { cwd: project, encoding: "utf8", env: process.env });
  return { code: r.status, markers: existsSync(marker) ? 1 : 0 };
}

describe("installed package: Node must not preload scanned files", () => {
  it("--file does not load NODE_OPTIONS from the scanned .env", () => {
    const r = run(["--file", ".env", "--offline", "--no-color"]);
    expect(r.code).toBe(0);
    expect(r.markers).toBe(0);
  });

  it("--env-file is rejected and does not run a NODE_OPTIONS payload", () => {
    const r = run(["--env-file", ".env"]);
    expect(r.code).toBe(2);
    expect(r.markers).toBe(0);
  });

  it("--env-file= is rejected and does not run a NODE_OPTIONS payload", () => {
    const r = run(["--env-file=.env"]);
    expect(r.code).toBe(2);
    expect(r.markers).toBe(0);
  });

  // Config-file flags are still parsed by Node after `--` (verified on
  // Node 22.23.3 and 24.22.0). The shebang cannot stop them. Documented
  // limitation: never pass these flags. Keep the assertion strict.
  it.fails("--experimental-config-file= does not run a config payload (known Node limitation)", () => {
    const r = run(["--experimental-config-file=evil.config.json"]);
    expect(r.code).toBe(2);
    expect(r.markers).toBe(0);
  });

  it.fails("--experimental-default-config-file does not run a config payload (known Node limitation)", () => {
    const r = run(["--experimental-default-config-file"]);
    expect(r.code).toBe(2);
    expect(r.markers).toBe(0);
  });
});
