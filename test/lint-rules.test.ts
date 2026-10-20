/**
 * Proves the ESLint config makes safeFetch the only network primitive:
 * any direct fetch/http/https/undici use outside src/net/safeFetch.ts fails lint.
 */
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).map((m) => m.ruleId ?? "fatal");
}

const CONNECTOR = "src/connectors/example.ts";

describe("network lint rules", () => {
  it.each([
    ['import https from "node:https"; export const x = https;', "no-restricted-imports"],
    ['import http from "http"; export const x = http;', "no-restricted-imports"],
    ['import { request } from "undici"; export const x = request;', "no-restricted-imports"],
    ['import net from "node:net"; export const x = net;', "no-restricted-imports"],
    ['export const p = fetch("https://api.stripe.com/v1/charges", { method: "POST" });', "no-restricted-globals"],
    ['export const p = globalThis.fetch("https://x.test");', "no-restricted-properties"],
  ])("rejects %s in a connector", async (code, rule) => {
    expect(await ruleIds(code, CONNECTOR)).toContain(rule);
  }, 30_000);

  it("allows fetch inside src/net/safeFetch.ts", async () => {
    const ids = await ruleIds('export const p = (u: string): Promise<Response> => fetch(u);', "src/net/safeFetch.ts");
    expect(ids).not.toContain("no-restricted-globals");
  }, 30_000);
});
