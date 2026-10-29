/** Source-only proposal. Adopt under server/src/__tests__ before qualification. */
import { describe, expect, it, vi } from "vitest";
import { plugins } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";

const original = {
  id: "plugin-fixture-1",
  pluginKey: "paperclip.path_persistence_fixture",
  packageName: "paperclip-plugin-path-fixture",
  packagePath: "C:/synthetic/old-artifact",
  version: "1.0.0",
  status: "disabled",
};

function makeRegistryFixture(found = true) {
  const updates: Record<string, unknown>[] = [];
  const selected = vi.fn().mockResolvedValue(found ? [{ ...original }] : []);
  const returning = vi.fn(async () => [{ ...original, ...updates.at(-1) }]);
  const db = {
    select: vi.fn(() => ({ from: () => ({ where: selected }) })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => ({ returning }) };
      },
    })),
    insert: vi.fn(() => { throw new Error("Unexpected insert"); }),
    delete: vi.fn(() => { throw new Error("Unexpected delete"); }),
  };
  return { db, updates, registry: pluginRegistryService(db as never) };
}

describe("plugin registry packagePath persistence", () => {
  it("sets the exact local pointer on the existing UUID without changing lifecycle", async () => {
    const fixture = makeRegistryFixture();
    const exactPath = "C:/synthetic/pinned-artifact-a1b2";
    const updated = await fixture.registry.update(original.id, {
      packagePath: exactPath,
      version: "1.0.1",
    });

    expect(updated).toMatchObject({ ...original, packagePath: exactPath, version: "1.0.1" });
    expect(fixture.db.update).toHaveBeenCalledTimes(1);
    expect(fixture.db.update).toHaveBeenCalledWith(plugins);
    expect(fixture.updates[0]).toEqual({ packagePath: exactPath, version: "1.0.1", updatedAt: expect.any(Date) });
    expect(fixture.db.insert).not.toHaveBeenCalled();
    expect(fixture.db.delete).not.toHaveBeenCalled();
  });

  it("preserves the existing local pointer when packagePath is omitted", async () => {
    const fixture = makeRegistryFixture();
    const updated = await fixture.registry.update(original.id, { version: "1.0.2" });
    expect(updated?.packagePath).toBe(original.packagePath);
    expect(fixture.updates[0]).not.toHaveProperty("packagePath");
  });

  it("clears a local override explicitly with null for registry-backed mode", async () => {
    const fixture = makeRegistryFixture();
    const updated = await fixture.registry.update(original.id, { packagePath: null });
    expect(updated?.packagePath).toBeNull();
    expect(fixture.updates[0]).toEqual({ packagePath: null, updatedAt: expect.any(Date) });
  });

  it("refuses a missing UUID before writing any table", async () => {
    const fixture = makeRegistryFixture(false);
    await expect(fixture.registry.update(original.id, { packagePath: "C:/synthetic/new" }))
      .rejects.toThrow("Plugin not found");
    expect(fixture.db.update).not.toHaveBeenCalled();
    expect(fixture.db.insert).not.toHaveBeenCalled();
    expect(fixture.db.delete).not.toHaveBeenCalled();
  });
});
