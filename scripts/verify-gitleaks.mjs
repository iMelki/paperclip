#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const expectedVersion = "8.30.1";
const args = new Set(process.argv.slice(2));
const staged = args.has("--staged");
const history = args.has("--history");

if (staged === history) {
  console.error("Specify exactly one scan mode: --staged or --history.");
  process.exit(3);
}

const binary =
  process.env.PAPERCLIP_GITLEAKS_BIN?.trim() ||
  (process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
let binaryPrefix = [];
if (process.env.PAPERCLIP_GITLEAKS_BIN_ARGS_JSON) {
  try {
    const parsed = JSON.parse(process.env.PAPERCLIP_GITLEAKS_BIN_ARGS_JSON);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("expected a JSON string array");
    }
    binaryPrefix = parsed;
  } catch (error) {
    console.error(`Invalid PAPERCLIP_GITLEAKS_BIN_ARGS_JSON: ${error.message}`);
    process.exit(3);
  }
}

function run(commandArgs, stdio = "pipe") {
  return spawnSync(binary, [...binaryPrefix, ...commandArgs], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio,
    windowsHide: true,
  });
}

const versionResult = run(["version"]);
if (versionResult.error) {
  console.error(
    `Gitleaks ${expectedVersion} is required but could not be started from ${binary}: ${versionResult.error.message}`,
  );
  process.exit(3);
}
if (versionResult.status !== 0) {
  console.error(
    `Gitleaks version check failed with exit ${versionResult.status ?? "unknown"}.`,
  );
  process.exit(3);
}

const reportedVersion = `${versionResult.stdout ?? ""} ${versionResult.stderr ?? ""}`.trim();
if (!new RegExp(`(^|\\s)${expectedVersion.replaceAll(".", "\\.")}($|\\s)`).test(reportedVersion)) {
  console.error(
    `Gitleaks version mismatch: expected ${expectedVersion}, received ${reportedVersion || "no version output"}.`,
  );
  process.exit(3);
}

const scanArgs = ["git", "--redact", "--verbose", "--exit-code", "2"];
if (staged) {
  scanArgs.push("--pre-commit", "--staged");
} else {
  scanArgs.push("--log-opts=--all");
}
scanArgs.push(".");

const scanResult = run(scanArgs, "inherit");
if (scanResult.error) {
  console.error(`Gitleaks scan could not start: ${scanResult.error.message}`);
  process.exit(3);
}
if (scanResult.status === 0) {
  console.log(`Gitleaks ${expectedVersion} ${staged ? "staged" : "history"} scan passed.`);
  process.exit(0);
}
if (scanResult.status === 2) {
  console.error("Gitleaks found potential secrets; commit or CI execution is blocked.");
  process.exit(2);
}

console.error(
  `Gitleaks scan failed as a tool/runtime error (exit ${scanResult.status ?? "unknown"}); execution is blocked.`,
);
process.exit(3);
