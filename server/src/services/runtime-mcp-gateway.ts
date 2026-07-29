import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  toolAccessAuditEvents,
  toolCatalogEntries,
  toolConnections,
  toolMcpGateways,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
} from "@paperclipai/db";
import type { ToolCatalogEntry } from "@paperclipai/shared";
import { conflict } from "../errors.js";

type RuntimeGatewayContext = {
  issueId: string | null;
  projectId: string | null;
  routineId: string | null;
  taskRevisionHash: string | null;
  configHash: string | null;
  installHash: string | null;
};

type RuntimeGatewaySourceProfile = {
  id: string;
  updatedAt: Date | string;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function generatedMetadata(value: unknown): value is {
  source: "managed_runtime_exact";
  managedRuntimeAgentId: string;
  managedRuntimeConnectionId: string;
  effectiveCapabilitySha256: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return (
    metadata.source === "managed_runtime_exact"
    && typeof metadata.managedRuntimeAgentId === "string"
    && typeof metadata.managedRuntimeConnectionId === "string"
    && typeof metadata.effectiveCapabilitySha256 === "string"
  );
}

export function isGeneratedRuntimeMcpGateway(
  metadata: Record<string, unknown> | null | undefined,
) {
  return generatedMetadata(metadata);
}

function runtimeGatewayConflict(
  message: string,
  details: Record<string, unknown>,
) {
  return conflict(message, {
    code: "runtime_mcp_gateway_precondition_failed",
    ...details,
  });
}

export async function ensureExactRuntimeMcpGateway(input: {
  db: Db;
  companyId: string;
  agentId: string;
  connection: Pick<
    typeof toolConnections.$inferSelect,
    "id" | "companyId" | "name"
  >;
  runContext: RuntimeGatewayContext;
  sourceProfiles: RuntimeGatewaySourceProfile[];
  expectedTools: ToolCatalogEntry[];
}) {
  if (input.expectedTools.length === 0) {
    throw runtimeGatewayConflict(
      "An exact runtime gateway requires at least one permitted catalog entry.",
      { connectionId: input.connection.id, agentId: input.agentId },
    );
  }
  const expectedIds = [...new Set(input.expectedTools.map((tool) => tool.id))].sort();
  if (expectedIds.length !== input.expectedTools.length) {
    throw runtimeGatewayConflict(
      "Exact runtime gateway tools must not contain duplicate catalog entries.",
      { connectionId: input.connection.id, agentId: input.agentId },
    );
  }
  const expectedById = new Map(input.expectedTools.map((tool) => [tool.id, tool]));

  return input.db.transaction(async (tx) => {
    const [connection] = await tx
      .select()
      .from(toolConnections)
      .where(and(
        eq(toolConnections.companyId, input.companyId),
        eq(toolConnections.id, input.connection.id),
      ))
      .limit(1)
      .for("update");
    if (
      !connection
      || connection.status !== "active"
      || !connection.enabled
      || connection.transport !== "mcp_remote"
      || !["ok", "healthy"].includes(connection.healthStatus)
    ) {
      throw runtimeGatewayConflict(
        "Runtime MCP connection is no longer active, enabled, healthy, and remote.",
        {
          connectionId: input.connection.id,
          status: connection?.status ?? null,
          enabled: connection?.enabled ?? null,
          transport: connection?.transport ?? null,
          healthStatus: connection?.healthStatus ?? null,
        },
      );
    }

    const catalog = await tx
      .select()
      .from(toolCatalogEntries)
      .where(and(
        eq(toolCatalogEntries.companyId, input.companyId),
        eq(toolCatalogEntries.connectionId, connection.id),
        inArray(toolCatalogEntries.id, expectedIds),
      ))
      .for("update");
    if (catalog.length !== expectedIds.length) {
      throw runtimeGatewayConflict(
        "Runtime MCP catalog changed while the exact gateway was being materialized.",
        {
          connectionId: connection.id,
          expectedCount: expectedIds.length,
          actualCount: catalog.length,
        },
      );
    }
    const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
    const drift = expectedIds.flatMap((catalogEntryId) => {
      const expected = expectedById.get(catalogEntryId)!;
      const current = catalogById.get(catalogEntryId)!;
      if (
        current.status === "active"
        && current.quarantinedAt === null
        && current.versionHash === expected.versionHash
        && current.schemaHash === expected.schemaHash
      ) {
        return [];
      }
      return [{
        catalogEntryId,
        expectedVersionHash: expected.versionHash,
        actualVersionHash: current.versionHash,
        expectedSchemaHash: expected.schemaHash,
        actualSchemaHash: current.schemaHash,
        status: current.status,
        quarantinedAt: current.quarantinedAt?.toISOString() ?? null,
      }];
    });
    if (drift.length > 0) {
      throw runtimeGatewayConflict(
        "Runtime MCP catalog hashes or activation state changed.",
        { connectionId: connection.id, drift },
      );
    }

    const sourceProfiles = input.sourceProfiles
      .map((profile) => ({
        id: profile.id,
        updatedAt:
          profile.updatedAt instanceof Date
            ? profile.updatedAt.toISOString()
            : new Date(profile.updatedAt).toISOString(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const catalogFingerprint = expectedIds.map((catalogEntryId) => {
      const current = catalogById.get(catalogEntryId)!;
      return {
        id: current.id,
        versionHash: current.versionHash,
        schemaHash: current.schemaHash,
      };
    });
    const effectiveCapabilitySha256 = sha256({
      version: 1,
      companyId: input.companyId,
      agentId: input.agentId,
      connectionId: connection.id,
      runContext: input.runContext,
      sourceProfiles,
      catalog: catalogFingerprint,
    });
    const profileKey =
      `runtime:${input.agentId}:${connection.id}:${effectiveCapabilitySha256.slice(0, 24)}`;
    const shortAgentId = input.agentId.replaceAll("-", "").slice(0, 12);
    const shortConnectionId = connection.id.replaceAll("-", "").slice(0, 12);
    const shortCapability = effectiveCapabilitySha256.slice(0, 16);
    const gatewaySlug =
      `runtime-${shortAgentId}-${shortConnectionId}-${shortCapability}`;
    const gatewayName =
      `Runtime ${connection.name} ${shortAgentId} ${shortCapability}`;
    const metadata = {
      source: "managed_runtime_exact" as const,
      managedRuntimeAgentId: input.agentId,
      managedRuntimeConnectionId: connection.id,
      effectiveCapabilitySha256,
      issueId: input.runContext.issueId,
      projectId: input.runContext.projectId,
      routineId: input.runContext.routineId,
      taskRevisionHash: input.runContext.taskRevisionHash,
      configHash: input.runContext.configHash,
      installHash: input.runContext.installHash,
      sourceProfileIds: sourceProfiles.map((profile) => profile.id),
      catalogEntryIds: expectedIds,
    };

    let [profile] = await tx
      .select()
      .from(toolProfiles)
      .where(and(
        eq(toolProfiles.companyId, input.companyId),
        eq(toolProfiles.profileKey, profileKey),
      ))
      .limit(1);
    let createdProfile = false;
    if (!profile) {
      [profile] = await tx
        .insert(toolProfiles)
        .values({
          companyId: input.companyId,
          profileKey,
          name: gatewayName,
          description:
            `Immutable exact runtime capability for ${connection.name}.`,
          status: "active",
          defaultAction: "deny",
          metadata,
        })
        .returning();
      createdProfile = true;
    } else if (
      profile.status !== "active"
      || profile.defaultAction !== "deny"
      || !generatedMetadata(profile.metadata)
      || profile.metadata.effectiveCapabilitySha256
        !== effectiveCapabilitySha256
    ) {
      throw runtimeGatewayConflict(
        "Existing immutable runtime profile no longer matches its capability hash.",
        { profileId: profile.id, profileKey },
      );
    }

    const existingEntries = await tx
      .select()
      .from(toolProfileEntries)
      .where(and(
        eq(toolProfileEntries.companyId, input.companyId),
        eq(toolProfileEntries.profileId, profile.id),
      ));
    if (createdProfile) {
      await tx.insert(toolProfileEntries).values(
        expectedIds.map((catalogEntryId) => ({
          companyId: input.companyId,
          profileId: profile.id,
          selectorType: "catalog_entry" as const,
          effect: "include" as const,
          applicationId: catalogById.get(catalogEntryId)!.applicationId,
          connectionId: connection.id,
          catalogEntryId,
        })),
      );
    } else {
      const existingCatalogIds = existingEntries
        .filter((entry) =>
          entry.selectorType === "catalog_entry"
          && entry.effect === "include"
          && entry.connectionId === connection.id
          && entry.catalogEntryId
        )
        .map((entry) => entry.catalogEntryId!)
        .sort();
      const hasUnexpectedEntry =
        existingEntries.length !== existingCatalogIds.length
        || existingCatalogIds.length !== expectedIds.length
        || existingCatalogIds.some((id, index) => id !== expectedIds[index]);
      if (hasUnexpectedEntry) {
        throw runtimeGatewayConflict(
          "Existing immutable runtime profile entries no longer match its capability hash.",
          { profileId: profile.id, expectedIds, existingCatalogIds },
        );
      }
    }

    let [gateway] = await tx
      .select()
      .from(toolMcpGateways)
      .where(and(
        eq(toolMcpGateways.companyId, input.companyId),
        eq(toolMcpGateways.slug, gatewaySlug),
      ))
      .limit(1);
    let createdGateway = false;
    const contextScopeType = input.runContext.issueId
      ? "issue"
      : input.runContext.routineId
        ? "routine"
        : input.runContext.projectId
          ? "project"
          : "agent";
    const contextScopeId =
      input.runContext.issueId
      ?? input.runContext.routineId
      ?? input.runContext.projectId
      ?? input.agentId;
    if (!gateway) {
      [gateway] = await tx
        .insert(toolMcpGateways)
        .values({
          companyId: input.companyId,
          name: gatewayName,
          slug: gatewaySlug,
          displaySlug: gatewaySlug,
          description:
            `Paperclip-managed immutable runtime gateway for ${connection.name}.`,
          status: "active",
          profileId: profile.id,
          defaultProfileMode: "gateway_only",
          contextScopeType,
          contextScopeId,
          agentId: input.agentId,
          projectId: input.runContext.projectId,
          issueId: input.runContext.issueId,
          metadata,
          createdByAgentId: input.agentId,
        })
        .returning();
      createdGateway = true;
    } else if (
      gateway.status !== "active"
      || gateway.archivedAt !== null
      || gateway.profileId !== profile.id
      || gateway.agentId !== input.agentId
      || !generatedMetadata(gateway.metadata)
      || gateway.metadata.effectiveCapabilitySha256
        !== effectiveCapabilitySha256
    ) {
      throw runtimeGatewayConflict(
        "Existing immutable runtime gateway no longer matches its capability hash.",
        { gatewayId: gateway.id, gatewaySlug },
      );
    }

    await tx
      .insert(toolProfileBindings)
      .values({
        companyId: input.companyId,
        profileId: profile.id,
        targetType: "gateway",
        targetId: gateway.id,
        priority: 10,
        metadata: {
          source: "managed_runtime_exact",
          effectiveCapabilitySha256,
        },
        createdByAgentId: input.agentId,
      })
      .onConflictDoNothing();
    await tx.insert(toolAccessAuditEvents).values({
      companyId: input.companyId,
      gatewayId: gateway.id,
      connectionId: connection.id,
      actorType: "agent",
      actorId: input.agentId,
      action: "tool_gateway.runtime_exact_materialized",
      outcome: "success",
      reasonCode:
        createdGateway || createdProfile
          ? "runtime_exact_gateway_created"
          : "runtime_exact_gateway_reused",
      details: {
        effectiveCapabilitySha256,
        profileId: profile.id,
        catalogEntryCount: expectedIds.length,
        createdProfile,
        createdGateway,
      },
    });

    return {
      gateway,
      profile,
      effectiveCapabilitySha256,
      createdProfile,
      createdGateway,
    };
  });
}
