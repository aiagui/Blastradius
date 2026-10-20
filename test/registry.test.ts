import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTORS_DIR, OUTPUT, discoverConnectors, isCandidateFile, renderRegistry } from "../scripts/gen-connectors.mjs";
import { connectors, getConnector } from "../src/connectors/index.js";

describe("connector registry", () => {
  it("registers exactly the real connectors, sorted by id", () => {
    expect(connectors.map((c) => c.id)).toEqual(["github", "stripe", "vercel"]);
  });

  it("has unique ids", () => {
    const ids = connectors.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not ship the example connector", () => {
    expect(connectors.map((c) => c.id)).not.toContain("example");
    expect(getConnector("example")).toBeUndefined();
  });

  it("each connector file name equals its id", () => {
    const ids = discoverConnectors();
    expect(connectors.map((c) => c.id)).toEqual(ids);
  });

  it("the generated registry is up to date", () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(renderRegistry(discoverConnectors()));
  });

  it("every candidate connector module exports `connector` (no file silently skipped)", () => {
    const files = readdirSync(CONNECTORS_DIR).filter((f) => isCandidateFile(f));
    expect(files.map((f) => f.slice(0, -3)).sort()).toEqual(discoverConnectors());
  });

  it("ignores helper, generated and excluded files on purpose", () => {
    for (const f of ["_http.ts", "registry.generated.ts", "types.ts", "index.ts", "detect.ts", "example.ts", "x.d.ts", "notes.md"]) {
      expect(isCandidateFile(f)).toBe(false);
    }
    expect(isCandidateFile("github.ts")).toBe(true);
  });
});
