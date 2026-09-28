import { expect, test } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { resolveHermesCommand } from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  // Node is an inert cross-platform executable with a stable --version flag.
  const result = await testEnvironment({
    companyId: "company-test",
    adapterType: "hermes_local",
    config: { command: process.execPath },
  });

  expect(result.status).not.toBe("fail");
  expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
  expect(result.checks.some(
    (check) => check.code === "hermes_version" && check.message.includes(process.version),
  )).toBe(true);
});
