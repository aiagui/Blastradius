import { writeRegistry } from "../scripts/gen-connectors.mjs";

/**
 * Regenerates src/connectors/registry.generated.ts before any test file is
 * loaded, so `npm test`, `npm run test:watch`, `npx vitest` and IDE runners all
 * work in a clean clone.
 */
export default function setup(): void {
  writeRegistry();
}
