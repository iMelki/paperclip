import type { AgentPermissions } from "@paperclipai/shared";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getLowTrustBoundary,
  getTrustPreset,
  summarizeLowTrustBoundaryTarget,
  TRUST_PRESET_LABELS,
} from "../lib/trust-policy-ui";

const KNOWN_PERMISSION_FIELDS = new Set([
  "canCreateAgents",
  "canCreateSkills",
  "canAssignTasks",
  "trustPreset",
  "authorizationPolicy",
]);

const KNOWN_AUTHORIZATION_POLICY_FIELDS = new Set([
  "trustPreset",
  "reviewPreset",
  "trustBoundary",
  "assignmentPolicy",
  "protectedAgent",
]);

export interface HirePermissionSummaryProps {
  payload: Record<string, unknown>;
}

interface HirePermissionViewModel {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  trustPreset: ReturnType<typeof getTrustPreset>;
  lowTrustBoundary: ReturnType<typeof getLowTrustBoundary>;
  hasAuthorizationPolicy: boolean;
  additionalFieldCount: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PermissionStateBadge({
  allowed,
  elevated = false,
}: {
  allowed: boolean;
  elevated?: boolean;
}) {
  return (
    <Badge variant={allowed ? (elevated ? "destructive" : "secondary") : "outline"}>
      {allowed ? "Allowed" : "Not allowed"}
    </Badge>
  );
}

function buildHirePermissionViewModel(
  payload: Record<string, unknown>,
): HirePermissionViewModel {
  const permissions = (isPlainRecord(payload.permissions) ? payload.permissions : {}) as
    Partial<AgentPermissions>;
  const role = typeof payload.role === "string" ? payload.role.trim().toLowerCase() : "general";
  const canCreateAgents = typeof permissions.canCreateAgents === "boolean"
    ? permissions.canCreateAgents
    : role === "ceo";
  const canCreateSkills = typeof permissions.canCreateSkills === "boolean"
    ? permissions.canCreateSkills
    : true;
  const trustPreset = getTrustPreset(permissions);
  const lowTrustBoundary = getLowTrustBoundary(permissions);
  const authorizationPolicy = isPlainRecord(permissions.authorizationPolicy)
    ? permissions.authorizationPolicy
    : null;
  const additionalPermissionFieldCount = Object.keys(permissions)
    .filter((key) => !KNOWN_PERMISSION_FIELDS.has(key)).length;
  const additionalPolicyFieldCount = authorizationPolicy
    ? Object.keys(authorizationPolicy)
      .filter((key) => !KNOWN_AUTHORIZATION_POLICY_FIELDS.has(key)).length
    : 0;
  return {
    canCreateAgents,
    canCreateSkills,
    trustPreset,
    lowTrustBoundary,
    hasAuthorizationPolicy: Boolean(authorizationPolicy),
    additionalFieldCount: additionalPermissionFieldCount + additionalPolicyFieldCount,
  };
}

function PermissionRow({
  label,
  allowed,
  elevated = false,
}: {
  label: string;
  allowed: boolean;
  elevated?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd><PermissionStateBadge allowed={allowed} elevated={elevated} /></dd>
    </div>
  );
}

function TrustRows({ model }: { model: HirePermissionViewModel }) {
  const additionalFieldLabel = model.additionalFieldCount === 1 ? "field" : "fields";
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <dt className="text-muted-foreground">Trust</dt>
        <dd><Badge variant="secondary">{TRUST_PRESET_LABELS[model.trustPreset]}</Badge></dd>
      </div>
      {model.trustPreset === "low_trust_review" && (
        <div className="flex items-start justify-between gap-3">
          <dt className="text-muted-foreground">Containment</dt>
          <dd className="text-right text-foreground">
            {model.lowTrustBoundary
              ? summarizeLowTrustBoundaryTarget(model.lowTrustBoundary)
              : "Not configured"}
          </dd>
        </div>
      )}
      {(model.hasAuthorizationPolicy || model.additionalFieldCount > 0) && (
        <div className="flex items-start justify-between gap-3">
          <dt className="text-muted-foreground">Additional policy</dt>
          <dd className="max-w-xs text-right text-foreground">
            {model.additionalFieldCount > 0
              ? `${model.additionalFieldCount} additional permission or policy ${additionalFieldLabel} preserved`
              : model.trustPreset === "low_trust_review"
                ? "Low-trust policy included"
                : "Authorization policy included"}
          </dd>
        </div>
      )}
    </>
  );
}

export function HirePermissionSummary({ payload }: HirePermissionSummaryProps) {
  const model = buildHirePermissionViewModel(payload);

  return (
    <section
      aria-label="Permissions and trust"
      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-3"
    >
      <div className="mb-2 flex items-center gap-2">
        {model.canCreateAgents
          ? <ShieldAlert aria-hidden className="size-4 text-destructive" />
          : <ShieldCheck aria-hidden className="size-4 text-muted-foreground" />}
        <h4 className="text-xs font-medium text-foreground">Permissions &amp; trust</h4>
      </div>
      <dl className="space-y-2 text-xs">
        <PermissionRow label="Hire agents" allowed={model.canCreateAgents} elevated />
        <PermissionRow label="Create/import skills" allowed={model.canCreateSkills} />
        <TrustRows model={model} />
      </dl>
      {model.canCreateAgents && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Agent creation also grants task-assignment authority.
        </p>
      )}
    </section>
  );
}
