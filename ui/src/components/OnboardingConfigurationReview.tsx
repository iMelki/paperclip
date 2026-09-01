import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";

import { Badge } from "@/components/ui/badge";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import type { OnboardingAgentConfigReview } from "../lib/onboarding-agent-config";
import { cn } from "../lib/utils";

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
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-(length:--text-nano)",
        verified
          ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
          : pending
            ? "text-muted-foreground"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
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
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Adapter</dt>
          <dd className="font-medium">
            {getAdapterDisplay(savedConfig.persistedAdapterType).label}
          </dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono break-all">
            {savedConfig.persistedModel ?? "Adapter default"}
          </dd>
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
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          The saved adapter configuration does not match this onboarding
          setup. Go back and save the configuration again.
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
