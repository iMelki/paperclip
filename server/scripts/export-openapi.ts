import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openapiSpec } from "../src/lib/openapi.js";

/**
 * Script to export the OpenAPI specification to a static JSON file.
 * Run with: tsx scripts/export-openapi.ts
 */

const outputDir = join(process.cwd(), 'docs');
const outputFile = join(outputDir, 'openapi.json');

try {
  // Ensure docs directory exists
  mkdirSync(outputDir, { recursive: true });

  // Write spec to file
  writeFileSync(outputFile, JSON.stringify(openapiSpec, null, 2));

  console.log(`✓ OpenAPI spec exported to ${outputFile}`);
} catch (error) {
  console.error(`✗ Failed to export OpenAPI spec: ${error}`);
  process.exit(1);
}
