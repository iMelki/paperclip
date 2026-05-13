import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MIN_SCORE = 95;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(__dirname, "..", "ui");

console.log("Running React Doctor for Paperclip UI...");

const result = spawnSync("npx", ["-y", "react-doctor@latest", "--staged"], {
  cwd: uiDir,
  maxBuffer: MAX_BUFFER_BYTES,
  stdio: ["inherit", "pipe", "pipe"],
  shell: true,
});

if (result.error) {
  console.error("Failed to start React Doctor:", result.error);
  process.exit(1);
}

const stdout = result.stdout ? result.stdout.toString() : "";
const stderr = result.stderr ? result.stderr.toString() : "";
const output = [stdout, stderr].filter(Boolean).join("\n");
const normalizedOutput = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

process.stdout.write(stdout);
process.stderr.write(stderr);

if (/No staged source files found\./i.test(normalizedOutput)) {
  console.log("\nReact Doctor skipped: no staged UI source files.");
  process.exit(0);
}

const scoreMatch = normalizedOutput.match(/(\d+)\s*\/\s*100/);
if (!scoreMatch) {
  console.error("\nCould not determine React Doctor score from output.");
  process.exit(1);
}

const score = parseInt(scoreMatch[1], 10);
console.log(`\nReact Doctor Score: ${score}/100`);

if (score < MIN_SCORE) {
  console.error(`\nReact Doctor score is too low (${score} < ${MIN_SCORE}).`);
  console.error("Please fix the reported issues before committing.");
  process.exit(1);
}

if (result.status === null) {
  const reason = result.signal ? `signal ${result.signal}` : "unknown termination";
  console.error(`\nReact Doctor exited unexpectedly (${reason}).`);
  process.exit(1);
}

process.exit(result.status ?? 1);