import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicReceipt({ outcome, exitCode, durationMs, version, packageSha256, outputSha256, error }) {
  return {
    schemaVersion: "paperclip.react-doctor-receipt.v1",
    tool: { name: "react-doctor", version, packageSha256 },
    scope: "staged",
    mutationIntent: "none",
    networkIntent: "none",
    outcome,
    exitCode,
    durationMs,
    outputSha256,
    ...(error ? { error } : {}),
  };
}

function writeReceipt(receipt) {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function fail(error, startedAt, version = null, packageSha256 = null, exitCode = 1) {
  const receipt = publicReceipt({
    outcome: "incomplete",
    exitCode,
    durationMs: Date.now() - startedAt,
    version,
    packageSha256,
    outputSha256: null,
    error,
  });
  writeReceipt(receipt);
  process.exit(exitCode);
}

const startedAt = Date.now();
let packagePath;
let packageJson;
let binaryPath;
let packageSha256;

try {
  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const declaredVersion = rootManifest.devDependencies?.["react-doctor"]
    || rootManifest.dependencies?.["react-doctor"];
  if (declaredVersion !== "0.7.8") {
    fail("pinned-package-missing", startedAt, null, null, 2);
  }
  const resolvedEntry = require.resolve("react-doctor", { paths: [repoRoot] });
  const packageRoot = path.resolve(path.dirname(resolvedEntry), "..");
  packagePath = path.join(packageRoot, "package.json");
  packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.version !== "0.7.8") {
    fail("pinned-version-mismatch", startedAt, packageJson.version);
  }
  const configuredBin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.["react-doctor"];
  binaryPath = path.resolve(packageRoot, configuredBin || "bin/react-doctor.js");
  if (!binaryPath.startsWith(`${packageRoot}${path.sep}`)) {
    fail("binary-outside-package", startedAt, packageJson.version);
  }
  const packageBytes = readFileSync(packagePath);
  const binaryBytes = readFileSync(binaryPath);
  packageSha256 = sha256(Buffer.concat([packageBytes, binaryBytes]));
} catch (error) {
  const reason = ["MODULE_NOT_FOUND", "ENOENT"].includes(error?.code)
    ? "pinned-package-missing"
    : "pinned-package-invalid";
  fail(reason, startedAt, null, null, reason === "pinned-package-missing" ? 2 : 1);
}

const childEnv = {
  PATH: process.env.PATH || "",
  SystemRoot: process.env.SystemRoot || "",
  TEMP: process.env.TEMP || "",
  TMP: process.env.TMP || "",
  GIT_DIR: process.env.GIT_DIR || path.join(repoRoot, ".git"),
  GIT_INDEX_FILE: process.env.GIT_INDEX_FILE || "",
  GIT_COMMON_DIR: process.env.GIT_COMMON_DIR || "",
  GIT_WORK_TREE: repoRoot,
  NODE_DISABLE_COMPILE_CACHE: "1",
  REACT_DOCTOR_NO_CACHE: "1",
  CI: "1",
};

const result = spawnSync(process.execPath, [
  binaryPath,
  "--staged",
  "--json",
  "--no-score",
  "--no-telemetry",
  "--no-supply-chain",
  "--no-parallel",
  "--no-color",
], {
  cwd: repoRoot,
  env: childEnv,
  encoding: "utf8",
  maxBuffer: MAX_BUFFER_BYTES,
  timeout: TIMEOUT_MS,
  killSignal: "SIGTERM",
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  windowsHide: true,
});

const output = `${result.stdout || ""}${result.stderr || ""}`;
const outputSha256 = sha256(Buffer.from(output, "utf8"));
const exitCode = typeof result.status === "number" ? result.status : 1;

if (result.error || result.signal || !result.stdout?.trim()) {
  const error = result.error
    ? "analyzer-start-failed"
    : result.signal
      ? "analyzer-terminated"
      : "empty-analyzer-output";
  fail(error, startedAt, packageJson.version, packageSha256);
}

if (/No staged source files found\./i.test(output)) {
  writeReceipt(publicReceipt({
    outcome: "skipped",
    exitCode: 0,
    durationMs: Date.now() - startedAt,
    version: packageJson.version,
    packageSha256,
    outputSha256,
  }));
  process.exit(0);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  fail("malformed-analyzer-json", startedAt, packageJson.version, packageSha256);
}

const outcome = exitCode === 0 && report && typeof report === "object" ? "passed" : "failed";
const receipt = publicReceipt({
  outcome,
  exitCode,
  durationMs: Date.now() - startedAt,
  version: packageJson.version,
  packageSha256,
  outputSha256,
  ...(outcome === "failed" ? { error: "analyzer-reported-failure" } : {}),
});
writeReceipt(receipt);
process.exit(exitCode);
