import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { stripeKey } from "../scripts/make-fixture.mjs";
import { Secret } from "../src/secret.js";

const make = (value: string): Secret =>
  new Secret({ connector: "x", envKey: "X_KEY", source: ".env", value, allowedHosts: ["API.x.test"] });

describe("Secret", () => {
  const value = stripeKey("sk", "live", "CANARYSECRET123456");
  const s = make(value);

  it("never exposes the value through string conversion, JSON or inspect", () => {
    expect(String(s)).toBe("[REDACTED]");
    expect(`key=${String(s)}`).toBe("key=[REDACTED]");
    expect(JSON.stringify({ s })).not.toContain("CANARY");
    expect(inspect(s)).not.toContain("CANARY");
    expect(inspect({ nested: [s] }, { depth: 10 })).not.toContain("CANARY");
    expect(Object.values(s).join(" ")).not.toContain("CANARY");
  });

  it("reveals the value explicitly", () => {
    expect(s.reveal()).toBe(value);
  });

  it("checks allowed hosts exactly and case-insensitively", () => {
    expect(s.allowedHost("api.x.test")).toBe(true);
    expect(s.allowedHost("API.X.TEST")).toBe(true);
    expect(s.allowedHost("evil.api.x.test")).toBe(false);
    expect(s.allowedHost("api.x.test.evil")).toBe(false);
  });

  it("hints with known public prefixes only", () => {
    expect(s.hint()).toBe("sk_live_… (26 chars)");
    expect(make("abcd_efgh_secretpart").hint()).toBe("… (20 chars)");
  });

  it("requires at least one allowed host and is frozen", () => {
    expect(() => new Secret({ connector: "x", envKey: "K", source: ".env", value: "v", allowedHosts: [] })).toThrow();
    expect(Object.isFrozen(s)).toBe(true);
  });
});
