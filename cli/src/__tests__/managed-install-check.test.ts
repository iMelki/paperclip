import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedInstallChecks } from "../checks/managed-install-check.js";
import {
  MANAGED_STORE_MARKER,
  buildNextManifest,
  flipCurrent,
  resolveInstallStorePaths,
  writeInstallManifestAtomic,
  writeManagedShim,
} from "../install-store.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("managed install doctor checks", () => {
  it("passes for a consistent store, manifest, current link, shim, and PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    const payloadPath = path.join(paths.installsRoot, "npm", "1.2.3");
    fs.mkdirSync(path.join(payloadPath, "dist"), { recursive: true });
    const manifest = buildNextManifest(
      {
        source: "npm",
        version: "1.2.3",
        channel: "latest",
        payloadPath,
        installedAt: "2026-07-22T00:00:00.000Z",
      },
      null,
    );
    flipCurrent(payloadPath, paths);
    writeInstallManifestAtomic(manifest, paths);
    writeManagedShim(paths);
    process.env.PATH = `${path.dirname(paths.shimPath)}${path.delimiter}${originalPath ?? ""}`;

    expect(managedInstallChecks(paths).every((result) => result.status === "pass")).toBe(true);
  });

  it("names the stranded state and the exact recovery when current is missing after an interrupted flip", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    const payloadPath = path.join(paths.installsRoot, "npm", "1.2.3");
    fs.mkdirSync(path.join(payloadPath, "dist"), { recursive: true });
    flipCurrent(payloadPath, paths);
    writeInstallManifestAtomic(buildNextManifest({
      source: "npm",
      version: "1.2.3",
      channel: "latest",
      payloadPath,
      installedAt: "2026-07-22T00:00:00.000Z",
    }, null), paths);
    // The on-disk state a crash between rename-aside steps 2 and 3 leaves.
    const prevPath = path.join(paths.cliRoot, "current.prev-12345-crashed");
    fs.renameSync(paths.currentPath, prevPath);

    const stranded = managedInstallChecks(paths).find(
      (result) => result.name === "Managed install current link",
    );
    expect(stranded).toMatchObject({ status: "fail" });
    expect(stranded?.message).toContain(paths.currentPath);
    expect(stranded?.message).toContain(prevPath);
    expect(stranded?.repairHint).toContain(prevPath);
    expect(stranded?.repairHint).toMatch(/Rename-Item|mv /);
  });

  it("warns about a leftover previous link while current is healthy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    const payloadPath = path.join(paths.installsRoot, "npm", "1.2.3");
    fs.mkdirSync(path.join(payloadPath, "dist"), { recursive: true });
    flipCurrent(payloadPath, paths);
    writeInstallManifestAtomic(buildNextManifest({
      source: "npm",
      version: "1.2.3",
      channel: "latest",
      payloadPath,
      installedAt: "2026-07-22T00:00:00.000Z",
    }, null), paths);
    fs.symlinkSync(
      path.relative(paths.cliRoot, payloadPath),
      path.join(paths.cliRoot, "current.prev-leftover"),
      "dir",
    );

    expect(managedInstallChecks(paths)).toContainEqual(
      expect.objectContaining({ name: "Managed install current link", status: "warn" }),
    );
  });

  it("fails when managed artifacts exist without a manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.writeFileSync(paths.markerPath, MANAGED_STORE_MARKER);

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install manifest", status: "fail" }),
    ]);
  });

  it("ignores the shared CLI directory when it only contains update notice state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.cliRoot, { recursive: true });
    fs.writeFileSync(path.join(paths.cliRoot, "update-check.json"), "{}\n");

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install", status: "pass" }),
    ]);
  });

  it("ignores an empty installs directory left by a harmless lock lifecycle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-doctor-"));
    const paths = resolveInstallStorePaths({
      paperclipHome: path.join(root, ".paperclip"),
      homeDir: root,
    });
    fs.mkdirSync(paths.installsRoot, { recursive: true });

    expect(managedInstallChecks(paths)).toEqual([
      expect.objectContaining({ name: "Managed install", status: "pass" }),
    ]);
  });
});
