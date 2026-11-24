import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { externalObjectsApi } from "../../api/externalObjects";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "../ui/button";
import type { IssueExternalObjectGroup } from "../../hooks/useIssueExternalObjects";
import {
  externalObjectDisplayStatusLabel,
  externalObjectDisplayLabel,
  externalObjectIconForKey,
  externalObjectProviderLabel,
  externalObjectToneSeverity,
  externalObjectTypeLabel,
} from "../../lib/external-objects";
import {
  externalObjectStatusIcon,
  externalObjectStatusIconDefault,
} from "../../lib/status-colors";
import { cn } from "../../lib/utils";
import { ExternalObjectStatusIcon } from "../ExternalObjectStatusIcon";
import { PropertyRow } from "./primitives";
import { ExpandRelationListButton } from "./relation-controls";
import { GitHubIssueProjectAccess } from "./GitHubIssueProjectAccess";

const EXTERNAL_OBJECT_PROPERTY_PREVIEW_COUNT = 5;

function sortExternalObjectGroups(groups: IssueExternalObjectGroup[]) {
  return [...groups].sort((a, b) => {
    const aTone = externalObjectToneSeverity(a.group.object?.statusTone);
    const bTone = externalObjectToneSeverity(b.group.object?.statusTone);
    return bTone - aTone;
  });
}

function externalObjectRowDisplayKey(group: IssueExternalObjectGroup): string {
  const { pill } = group;
  const displayKey = pill.displayKey?.trim();
  if (displayKey) return displayKey;
  if (pill.providerKey === "github") {
    if (pill.objectType === "pull_request") return "Github PR";
    if (pill.objectType === "issue") return "Github Issue";
  }
  return externalObjectDisplayLabel(pill.providerKey, pill.objectType);
}

function externalObjectRowLabel(group: IssueExternalObjectGroup): ReactNode {
  const { pill } = group;
  const displayKey = externalObjectRowDisplayKey(group);
  const Icon = externalObjectIconForKey(pill.iconKey);
  return (
    <span className="inline-flex min-w-0 items-start gap-1" title={displayKey}>
      {Icon ? <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 mt-0.5" /> : null}
      <span className="truncate">{displayKey}</span>
    </span>
  );
}

function githubObjectPropertyValue(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const [, owner, repo, kind, number] = parsed.pathname.split("/");
    if (!owner || !repo || !number) return null;
    if (kind === "pull") return `PR ${number}`;
    if (kind === "issues") return `Issue ${number}`;
    return null;
  } catch {
    return null;
  }
}

function externalObjectPropertyStatusLabel(group: IssueExternalObjectGroup): string {
  return externalObjectDisplayStatusLabel(group.pill);
}

function externalObjectPropertyValue(group: IssueExternalObjectGroup): string {
  const { pill } = group;
  const statusLabel = externalObjectPropertyStatusLabel(group);
  const githubLabel = pill.providerKey === "github" ? githubObjectPropertyValue(pill.url) : null;
  const base = githubLabel ?? pill.displayTitle?.trim() ?? externalObjectRowDisplayKey(group);
  return statusLabel ? `${base} - ${statusLabel}` : base;
}

function isMergedExternalObject(group: IssueExternalObjectGroup): boolean {
  const statusLabel = externalObjectPropertyStatusLabel(group);
  return group.pill.statusIconKey === "git-merge" || statusLabel.toLowerCase() === "merged";
}

function externalObjectPropertyTone(group: IssueExternalObjectGroup): string {
  const tone = isMergedExternalObject(group)
    ? externalObjectStatusIcon.merged
    : externalObjectStatusIcon[group.pill.statusCategory] ?? externalObjectStatusIconDefault;
  return tone.split(" ").filter((c) => c.startsWith("text-")).join(" ");
}

function externalObjectPropertyStatusIconKey(group: IssueExternalObjectGroup): string | null | undefined {
  if (isMergedExternalObject(group)) return group.pill.statusIconKey ?? "git-merge";
  return group.pill.statusIconKey;
}

function externalObjectPropertyTitle(group: IssueExternalObjectGroup): string {
  const { pill, sourceLabels } = group;
  const base = pill.displayTitle ?? externalObjectPropertyValue(group);
  return sourceLabels.length > 0 ? `${base} - ${sourceLabels.join(", ")}` : base;
}

function ExternalObjectPropertyValue({ group }: { group: IssueExternalObjectGroup }) {
  const { pill } = group;
  const statusLabel = externalObjectPropertyStatusLabel(group);
  const providerLabel = externalObjectProviderLabel(pill.providerKey);
  const typeLabel = externalObjectTypeLabel(pill.objectType);
  const value = externalObjectPropertyValue(group);
  const content = (
    <>
      <ExternalObjectStatusIcon
        category={pill.statusCategory}
        liveness={pill.liveness}
        statusIconKey={externalObjectPropertyStatusIconKey(group)}
        sizeClassName="h-3.5 w-3.5"
        label={`${providerLabel}: ${statusLabel}`}
      />
      <span className="min-w-0 truncate">{value}</span>
    </>
  );
  const className = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm no-underline",
    externalObjectPropertyTone(group),
    pill.url ? "hover:underline focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring" : "",
  );

  if (pill.url) {
    return (
      <a
        href={pill.url}
        target="_blank"
        rel="noopener noreferrer"
        data-mention-kind="external-object"
        data-external-status={pill.statusCategory}
        data-external-liveness={pill.liveness}
        className={className}
        title={externalObjectPropertyTitle(group)}
        aria-label={`${providerLabel} ${typeLabel} - ${statusLabel}: ${pill.displayTitle ?? value}`}
      >
        {content}
      </a>
    );
  }

  return (
    <span
      data-mention-kind="external-object"
      data-external-status={pill.statusCategory}
      data-external-liveness={pill.liveness}
      className={className}
      title={externalObjectPropertyTitle(group)}
      aria-label={`${providerLabel} ${typeLabel} - ${statusLabel}: ${pill.displayTitle ?? value}`}
    >
      {content}
    </span>
  );
}

function linkedGitHubIssueId(row: IssueExternalObjectGroup) {
  const object = row.group.object;
  return object?.providerKey === "github" && object.objectType === "issue" ? object.id : null;
}

function describeGitHubRefresh(
  objectId: string,
  results: Awaited<ReturnType<typeof externalObjectsApi.refreshIssueObjects>>["refreshed"],
) {
  const result = results.find((entry) => entry.object.id === objectId);
  switch (result?.reason) {
    case "resolved": return "GitHub details checked.";
    case "backoff": return "The existing snapshot is still current or a retry is delayed.";
    case "refresh_in_progress": return "A refresh is already running.";
    case "refresh_superseded": return "Another check finished first. Showing the latest saved details.";
    default: return "GitHub details could not be refreshed. The saved details are still shown.";
  }
}

export function ExternalObjectRows({
  issueId,
  externalObjects,
  externalObjectsLoading,
  externalObjectsError,
  onRetryExternalObjects,
}: {
  issueId: string;
  externalObjects?: IssueExternalObjectGroup[];
  externalObjectsLoading?: boolean;
  externalObjectsError?: boolean;
  onRetryExternalObjects?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const refreshGitHub = useMutation({
    retry: false,
    mutationFn: async (objectId: string) => {
      const response = await externalObjectsApi.refreshIssueObjects(issueId, { objectIds: [objectId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.externalObjects.byIssue(issueId), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.externalObjects.issueSummary(issueId), exact: true }),
      ]);
      return describeGitHubRefresh(objectId, response.refreshed);
    },
  });

  const projectMirror = useMutation({ retry: false, mutationFn: (objectId: string) =>
    externalObjectsApi.refreshGitHubProjectMirror(issueId, objectId) });

  useEffect(() => {
    setExpanded(false);
  }, [externalObjects]);

  if (externalObjectsError) {
    return (
      <PropertyRow label="External objects">
        <span className="text-xs text-muted-foreground">
          Couldn't load external objects.
          {onRetryExternalObjects ? (
            <>
              {" "}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={onRetryExternalObjects}
              >
                Retry
              </button>
            </>
          ) : null}
        </span>
      </PropertyRow>
    );
  }

  if (externalObjectsLoading) {
    return (
      <PropertyRow label="External objects">
        <span className="h-4 w-24 animate-pulse rounded bg-muted/40" />
      </PropertyRow>
    );
  }

  if (!externalObjects || externalObjects.length === 0) return null;

  const sortedExternalObjects = sortExternalObjectGroups(externalObjects);
  const visibleExternalObjects = expanded
    ? sortedExternalObjects
    : sortedExternalObjects.slice(0, EXTERNAL_OBJECT_PROPERTY_PREVIEW_COUNT);
  const hiddenExternalObjectCount = sortedExternalObjects.length - visibleExternalObjects.length;

  return (
    <>
      {visibleExternalObjects
        .map((externalObject) => {
          const { pill, group } = externalObject;
          const githubIssueId = linkedGitHubIssueId(externalObject);
          return (
            <PropertyRow
              key={group.object?.id ?? `${pill.providerKey}:${pill.objectType}:${pill.url ?? "anon"}`}
              label={externalObjectRowLabel(externalObject)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <ExternalObjectPropertyValue group={externalObject} />
                {githubIssueId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    aria-label={pill.displayKey ? "Refresh GitHub issue " + pill.displayKey : "Refresh linked GitHub issue"}
                    disabled={refreshGitHub.isPending}
                    onClick={() => refreshGitHub.mutate(githubIssueId)}
                  >
                    {refreshGitHub.isPending && refreshGitHub.variables === githubIssueId
                      ? "Refreshing…"
                      : "Refresh"}
                  </Button>
                ) : null}
                {githubIssueId ? (
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs"
                    disabled={projectMirror.isPending}
                    onClick={() => projectMirror.mutate(githubIssueId)}>
                    {projectMirror.isPending && projectMirror.variables === githubIssueId ? "Checking…" : "Projects"}
                  </Button>
                ) : null}
                {githubIssueId && refreshGitHub.variables === githubIssueId ? (
                  <span className="text-xs text-muted-foreground" role="status">
                    {refreshGitHub.isError ? "GitHub details could not be refreshed." : refreshGitHub.data}
                  </span>
                ) : null}
              </div>
              {githubIssueId && projectMirror.variables === githubIssueId ? (
                <>
                  {projectMirror.isError ? <p className="text-xs text-muted-foreground" role="status">
                    GitHub Project details could not be read.
                  </p> : null}
                  <GitHubIssueProjectAccess key={issueId + ":" + githubIssueId} issueId={issueId} objectId={githubIssueId}
                  read={projectMirror.isSuccess ? projectMirror.data : undefined}
                  refresh={() => projectMirror.mutate(githubIssueId)} />
                </>
              ) : null}
            </PropertyRow>
          );
        })}
      {expanded || hiddenExternalObjectCount > 0 ? (
        <PropertyRow label="References">
          <ExpandRelationListButton
            hiddenCount={hiddenExternalObjectCount}
            expanded={expanded}
            onClick={() => setExpanded((next) => !next)}
          />
        </PropertyRow>
      ) : null}
    </>
  );
}
