import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import type { CSSProperties } from "react";

import { Badge } from "@/components/ui/badge";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import type { OnboardingAgentConfigReview } from "../lib/onboarding-agent-config";
import { taskStatusVar } from "../lib/status-colors";
import { StatusGlyph } from "./StatusGlyph";

interface OnboardingConfigurationReviewProps {
  savedConfig: OnboardingAgentConfigReview | null;
  savedConfigVerified: boolean;
  savedConfigPending: boolean;
  savedConfigError: string | null;
  environmentRequired: boolean;
  environmentResult: AdapterEnvironmentTestResult | null;
  environmentLoading: boolean;
  environmentError: string | null;
}

type SavedConfigurationCardProps = Pick<
  OnboardingConfigurationReviewProps,
  "savedConfig" | "savedConfigVerified" | "savedConfigPending" | "savedConfigError"
>;
type EnvironmentProbeCardProps = Pick<
  OnboardingConfigurationReviewProps,
  "environmentRequired" | "environmentResult" | "environmentLoading" | "environmentError"
>;

function SavedConfigStatusBadge({
  verified,
  pending,
}: {
  verified: boolean;
  pending: boolean;
}) {
  const status = verified ? "done" : pending ? "backlog" : "todo";
  const style = {
    "--sc": `var(${taskStatusVar[status]})`,
  } as CSSProperties;

  return (
    <Badge
      variant="outline"
      className="status-chip gap-1.5 text-(length:--text-nano)"
      style={style}
    >
      <StatusGlyph status={status} size="sm" />
      {verified ? "Verified" : pending ? "Reading..." : "Needs attention"}
    </Badge>
  );
}

function SavedConfigurationCard({
  savedConfig,
  savedConfigVerified,
  savedConfigPending,
  savedConfigError,
}: SavedConfigurationCardProps) {
  return (
    <div
      className="rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 space-y-2"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium">Saved configuration</p>
        <SavedConfigStatusBadge
          verified={savedConfigVerified}
          pending={savedConfigPending}
        />
      </div>

      {savedConfig && (
        <dl className="space-y-1 text-xs">
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted-foreground">Adapter</dt>
            <dd className="min-w-0 font-medium">
              {getAdapterDisplay(savedConfig.persistedAdapterType).label}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 shrink-0 text-muted-foreground">Model</dt>
            <dd className="min-w-0 break-all font-mono">
              {savedConfig.persistedModel ?? "Adapter default"}
            </dd>
          </div>
        </dl>
      )}

      {savedConfigError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive"
        >
          Saved readback failed: {savedConfigError}
        </div>
      ) : savedConfig && !savedConfig.matches ? (
        <div
          role="alert"
          className="status-chip flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs"
          style={{ "--sc": `var(${taskStatusVar.todo})` } as CSSProperties}
        >
          <StatusGlyph status="todo" size="sm" className="mt-0.5 shrink-0" />
          <span>
            The saved adapter configuration does not match this onboarding
            setup. Go back and save the configuration again.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function EnvironmentProbeCard({
  environmentRequired,
  environmentResult,
  environmentLoading,
  environmentError,
}: EnvironmentProbeCardProps) {
  return (
    <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 space-y-1">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium">Environment probe</p>
        <Badge variant="outline" className="text-(length:--text-nano)">
          {environmentLoading
            ? "Testing..."
            : environmentResult?.status ??
              (environmentRequired ? "Not run" : "Not required")}
        </Badge>
      </div>
      <p className="text-(length:--text-micro) text-muted-foreground">
        This live CLI check is separate from the saved configuration readback
        above.
      </p>
      {environmentError && (
        <p className="text-xs text-destructive">{environmentError}</p>
      )}
    </div>
  );
}

export function OnboardingConfigurationReview(
  props: OnboardingConfigurationReviewProps,
) {
  return (
    <div className="space-y-3">
      <SavedConfigurationCard
        savedConfig={props.savedConfig}
        savedConfigVerified={props.savedConfigVerified}
        savedConfigPending={props.savedConfigPending}
        savedConfigError={props.savedConfigError}
      />
      <EnvironmentProbeCard
        environmentRequired={props.environmentRequired}
        environmentResult={props.environmentResult}
        environmentLoading={props.environmentLoading}
        environmentError={props.environmentError}
      />
    </div>
  );
}
