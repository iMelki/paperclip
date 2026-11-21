import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { pluginJobStore } from "../services/plugin-job-store.js";

describe("persisted company job scope aliases", () => {
  it.each([
    [{ scope: "company" }, "company"],
    [{ dispatchScope: "company" }, "company"],
    [{ dispatchScope: "instance" }, "instance"],
    [{}, "instance"],
  ])("reads the persisted declaration %j as %s", async (declaration, expected) => {
    const db = { select: () => ({ from: () => ({ where: async () => [{ manifestJson: { jobs: [{ jobKey: "synthetic-job", ...declaration }] } }] }) }) } as unknown as Db;
    await expect(pluginJobStore(db).getJobDeclarationScope("plugin-1", "synthetic-job")).resolves.toBe(expected);
  });
});
