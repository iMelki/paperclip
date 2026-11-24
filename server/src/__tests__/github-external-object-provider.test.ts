import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeExternalObjectUrl } from "@paperclipai/shared/external-objects-server";
import { createGitHubExternalObjectProvider } from "../services/github-external-object-provider.js";

function issueObject() {
  const canonical = canonicalizeExternalObjectUrl("https://github.com/example/repo/issues/7");
  if (!canonical) throw new Error("expected canonical url");
  return {
    id: randomUUID(), companyId: "00000000-0000-4000-8000-000000000001", providerKey: "github", objectType: "issue",
    externalId: "example/repo#issues/7", sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
    canonicalIdentityHash: canonical.canonicalIdentityHash, displayTitle: "example/repo#7", statusKey: null, statusLabel: null,
    statusCategory: "unknown", statusTone: "neutral", liveness: "unknown", isTerminal: false, data: {}, remoteVersion: null, etag: null,
  } as never;
}

async function resolveIssue(body: Record<string, unknown>) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json", etag: '"etag-1"' },
  }));
  const provider = createGitHubExternalObjectProvider({} as never, { fetch, tokenProvider: null });
  const resolver = provider.resolvers.find(entry => entry.objectType === "issue")!;
  return resolver.resolve({ companyId: "00000000-0000-4000-8000-000000000001", object: issueObject() });
}

describe("GitHub issue snapshot data for the Project mirror", () => {
  it("keeps the issue title and a valid GraphQL node id", async () => {
    const result = await resolveIssue({ state: "open", title: "Synthetic title", node_id: "I_kwDOSynthetic", updated_at: "2026-01-01T00:00:00Z" });
    expect(result).toMatchObject({ ok: true, snapshot: { data: { issueTitle: "Synthetic title", nodeId: "I_kwDOSynthetic", state: "open" } } });
  });

  it("drops a node id that is not a safe identifier", async () => {
    const result = await resolveIssue({ state: "open", title: "Synthetic title", node_id: "bad id!", updated_at: "2026-01-01T00:00:00Z" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.data).not.toHaveProperty("nodeId");
  });

  it("omits the title when GitHub returns none", async () => {
    const result = await resolveIssue({ state: "closed", state_reason: "completed", node_id: "I_kwDOSynthetic", updated_at: "2026-01-01T00:00:00Z" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.data).not.toHaveProperty("issueTitle");
  });
});
