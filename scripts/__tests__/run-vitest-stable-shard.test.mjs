import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  defaultSuiteWeight,
  loadShardDurations,
  partitionGeneralServerSuites,
} from "../general-server-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "general-server-shard-durations.json");

function runScript(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function dryRun(args) {
  return runScript([...args, "--dry-run"]);
}

function dryRunJson(args) {
  const result = dryRun(args);
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const SHARD_COUNT = 5;
const SERIALIZED_SHARD_COUNT = 5;


test("the serialized shards form a complete, non-overlapping partition", () => {
  const shards = Array.from({ length: SERIALIZED_SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "serialized", "--shard-index", String(index), "--shard-count", String(SERIALIZED_SHARD_COUNT)]),
  );

  const total = shards[0].serializedSuiteCount;
  const selected = shards.flatMap((shard) => shard.selectedSerializedSuites);
  assert.equal(selected.length, total, "every serialized suite must be selected exactly once");
  assert.equal(new Set(selected).size, total, "serialized shards must not overlap");
});

test("the general-server shards form a complete, non-overlapping partition", () => {
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const total = shards[0].generalServerSuiteCount;
  assert.ok(total > 0, "expected a non-empty general-server suite set");

  const seen = new Set();
  let selectedTotal = 0;
  for (const shard of shards) {
    assert.equal(shard.generalServerSuiteCount, total, "suite count must be stable across shards");
    for (const file of shard.selectedGeneralServerSuites) {
      assert.ok(!seen.has(file), `suite assigned to more than one shard: ${file}`);
      seen.add(file);
      selectedTotal += 1;
    }
  }

  // Every suite runs exactly once: union covers the whole set with no overlap.
  assert.equal(selectedTotal, total, "every suite must be selected exactly once");
  assert.equal(seen.size, total, "union of shards must cover the whole suite set");
});

test("a route/authz suite never leaks into the general-server shards", () => {
  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", SHARD_COUNT.toString()]);
  for (const file of shard.selectedGeneralServerSuites) {
    assert.ok(
      !/[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/.test(file),
      `route/authz suite must stay in the serialized lane, not general-server: ${file}`,
    );
  }
});

test("the unsharded general-server lane transports exclusions outside Windows argv", () => {
  const plan = dryRunJson(["--mode", "general", "--group", "general-server"]);
  assert.deepEqual(plan.generalServerExclusionTransport, {
    kind: "config-file",
    excludeCount: plan.serializedSuiteCount,
    commandArgs: [
      "--project",
      "@paperclipai/server",
      "--no-file-parallelism",
      "--maxWorkers=1",
    ],
  });
  assert.ok(plan.serializedSuiteCount > 100, "fixture must cover the large exclusion set");
  assert.equal(
    plan.generalServerExclusionTransport.commandArgs.includes("--exclude"),
    false,
    "individual excluded paths must not be serialized onto the command line",
  );
});

test("shard flags are rejected for the parallel workspace groups", () => {
  const result = dryRun(["--mode", "general", "--group", "general-workspaces-a", "--shard-index", "0", "--shard-count", "3"]);
  assert.notEqual(result.status, 0, "workspace groups must not accept shard flags");
});

test("shard count alone is rejected for related and exact-file modes", () => {
  for (const args of [
    ["--related", "server/src/probe.ts", "--shard-count", "3"],
    ["--files", "server/src/probe.test.ts", "--shard-count", "3"],
  ]) {
    const result = runScript(args);
    assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
    assert.match(result.stderr, /cannot be combined with --mode\/--group\/--shard-\*\/--dry-run/);
  }
});

test("related selections dispatch every selected suite through an independent Vitest process", () => {
  const source = readFileSync(script, "utf8");
  const relatedSuitesBody = source.slice(
    source.indexOf("async function runRelatedSuites"),
    source.indexOf("function runRelatedFilesIndependently"),
  );
  const relatedDispatcherBody = source.slice(
    source.indexOf("function runRelatedFilesIndependently"),
    source.indexOf("function runExactSuites"),
  );

  assert.match(
    relatedSuitesBody,
    /if \(cap === 0\) \{[\s\S]*?runRelatedFilesIndependently\(\s*selected,/,
    "the uncapped path must isolate every resolved suite",
  );
  assert.match(
    relatedSuitesBody,
    /if \(selected\.length <= cap\) \{[\s\S]*?runRelatedFilesIndependently\(\s*selected,/,
    "the within-cap path must isolate every resolved suite",
  );
  assert.match(
    relatedSuitesBody,
    /const subset =[\s\S]*?runRelatedFilesIndependently\(\s*subset,/,
    "the representative subset path must isolate every selected suite",
  );
  assert.doesNotMatch(
    relatedSuitesBody,
    /runVitest\(|subcommand:\s*["']related["']/,
    "related selection must never launch a batched Vitest coordinator directly",
  );
  assert.match(
    relatedDispatcherBody,
    /forEachExactVitestFile\(files,[\s\S]*?serializedServerVitestArgs,[\s\S]*?file/,
    "the related dispatcher must launch exactly one selected file per invocation",
  );
});

test("duration-aware partition balances skewed weights better than round-robin", () => {
  // Round-robin puts all three heavy suites on shard 0 (indexes 0, 3, 6).
  const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const durations = { a: 30000, d: 30000, g: 30000, b: 100, c: 100, e: 100, f: 100, h: 100, i: 100 };

  const shards = partitionGeneralServerSuites(files, 3, durations);
  const totals = shards.map((shard) => shard.totalWeight);
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  assert.ok(
    maxTotal - minTotal <= 200,
    `expected near-even shard weights, got ${totals.join(", ")}`,
  );
  assert.equal(
    shards.flatMap((shard) => shard.files).sort().join(","),
    files.join(","),
    "partition must cover every file exactly once",
  );
});

test("the partition is deterministic for identical inputs", () => {
  const files = Array.from({ length: 50 }, (_, index) => `suite-${index}.test.ts`);
  const durations = Object.fromEntries(files.map((file, index) => [file, (index * 37) % 5000]));

  const first = partitionGeneralServerSuites(files, 3, durations);
  const second = partitionGeneralServerSuites(files, 3, durations);
  assert.deepEqual(first, second, "same inputs must always produce the same partition");
});

test("suites missing from the manifest get the median weight", () => {
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 900 }), 300);
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 500, d: 900 }), 400);
  assert.equal(defaultSuiteWeight({}), 1000, "empty manifest falls back to a fixed weight");
});

test("a missing or malformed manifest degrades to uniform weights", () => {
  assert.deepEqual(loadShardDurations(path.join(repoRoot, "scripts", "no-such-manifest.json")), {});

  const files = ["a", "b", "c", "d"];
  const shards = partitionGeneralServerSuites(files, 2, {});
  assert.equal(shards[0].files.length + shards[1].files.length, files.length);
  assert.equal(Math.abs(shards[0].files.length - shards[1].files.length), 0);
});

test("the checked-in manifest loads and covers most of the current suite set", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "manifest must parse to a non-empty duration map");

  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const currentFiles = shard.selectedGeneralServerSuites;
  const known = currentFiles.filter((file) => durations[file] !== undefined).length;
  assert.ok(
    known / currentFiles.length >= 0.5,
    `manifest is stale: only ${known} of ${currentFiles.length} suites have recorded durations — regenerate it from a recent PR run (see the manifest's $comment)`,
  );
});

test("the real shard partition is duration-balanced", () => {
  const durations = loadShardDurations(durationsManifest);
  const fallback = defaultSuiteWeight(durations);
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const totals = shards.map((shard) =>
    shard.selectedGeneralServerSuites.reduce((sum, file) => sum + (durations[file] ?? fallback), 0),
  );
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  // LPT keeps the spread within the heaviest single suite; use that as the bound.
  const heaviest = Math.max(...Object.values(durations));
  assert.ok(
    maxTotal - minTotal <= heaviest,
    `shard weight spread ${maxTotal - minTotal}ms exceeds heaviest suite ${heaviest}ms: ${totals.join(", ")}`,
  );
});
