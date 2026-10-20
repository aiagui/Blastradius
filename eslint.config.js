// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const NETWORK_MODULES = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "undici",
  "node-fetch",
  "axios",
  "got",
];

const networkImportBan = {
  paths: NETWORK_MODULES.flatMap((name) => [
    { name, message: "Network access is only allowed through src/net/safeFetch.ts." },
    { name: `node:${name}`, message: "Network access is only allowed through src/net/safeFetch.ts." },
  ]),
};

const networkGlobalBan = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({
  name,
  message: "Use safeFetch from src/net/safeFetch.ts. It is the only allowed network primitive.",
}));

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js", "scripts/*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    rules: {
      "no-restricted-imports": ["error", networkImportBan],
      "no-restricted-globals": ["error", ...networkGlobalBan],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: "Use safeFetch." },
        { object: "global", property: "fetch", message: "Use safeFetch." },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    // The single place allowed to touch the network.
    files: ["src/net/safeFetch.ts"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
  {
    // Tests may stub globals (never perform real requests: fetch is mocked).
    files: ["test/**/*.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
