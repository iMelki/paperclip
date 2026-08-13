import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export const ACTION_REVIEW_TONES = ["default", "destructive"] as const;

export type ActionReviewTone = (typeof ACTION_REVIEW_TONES)[number];

/**
 * The four questions every consequential action must answer before the
 * operator confirms it (fleet UI/UX rubric section 1.7 / EUX-09). Sites fill
 * these as structured fields — the dialog never accepts a free-text blob.
 */
export interface ActionReviewConsequences {
  /** What happens immediately when the operator confirms. */
  immediateEffect: ReactNode;
  /** What backend change runs after confirmation. */
  confirmedEffect: ReactNode;
  /** Where the operator can see the result afterward. */
  resultLocation: ReactNode;
  /** What explicitly will NOT happen, so scope stays bounded. */
  willNotHappen: ReactNode;
}

export const ACTION_REVIEW_CONSEQUENCE_KEYS = [
  "immediateEffect",
  "confirmedEffect",
  "resultLocation",
  "willNotHappen",
] as const satisfies readonly (keyof ActionReviewConsequences)[];

export const ACTION_REVIEW_CONSEQUENCE_LABELS: Record<
  (typeof ACTION_REVIEW_CONSEQUENCE_KEYS)[number],
  string
> = {
  immediateEffect: "Happens now",
  confirmedEffect: "Runs after confirm",
  resultLocation: "Result appears in",
  willNotHappen: "Will not happen",
};

/**
 * True when the typed value unlocks the confirm button. Surrounding
 * whitespace is forgiven; visible characters must match exactly (case
 * sensitive). An empty expected value can never be satisfied, so a
 * misconfigured gate fails closed.
 */
export function isTypedConfirmationSatisfied(
  expectedValue: string,
  typedValue: string,
): boolean {
  const expected = expectedValue.trim();
  if (!expected) return false;
  return typedValue.trim() === expected;
}

export interface ActionReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Optional one-line context shown under the title. */
  description?: ReactNode;
  consequences: ActionReviewConsequences;
  /** `destructive` styles the confirm button for deletes/kills. */
  tone?: ActionReviewTone;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  /**
   * Gate irreversible actions: confirm stays disabled until the operator
   * types this value exactly. Reserve for actions that cannot be undone.
   */
  typedConfirmation?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

/**
 * Accessible review step for consequential actions. Replaces native
 * `window.confirm()` (issue #48 / EUX-09): composes the repo's AlertDialog
 * primitive (Radix focus trap, Escape, focus return) and renders the typed
 * four-question consequence contract wired into `aria-describedby`.
 *
 * Most call sites should use the `useConfirmDialog()` hook instead of
 * rendering this component directly.
 */
export function ActionReviewDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  tone = "default",
  confirmLabel,
  cancelLabel = "Cancel",
  typedConfirmation,
  onConfirm,
  onCancel,
}: ActionReviewDialogProps) {
  const descriptionId = useId();
  const consequencesId = useId();
  const typedInputId = useId();
  const [typedValue, setTypedValue] = useState("");
  const confirmedRef = useRef(false);

  useEffect(() => {
    if (open) {
      confirmedRef.current = false;
    } else {
      setTypedValue("");
    }
  }, [open]);

  const typedGateActive = typedConfirmation !== undefined;
  const confirmBlocked =
    typedGateActive && !isTypedConfirmationSatisfied(typedConfirmation, typedValue);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (!confirmedRef.current) onCancel?.();
          confirmedRef.current = false;
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent
        aria-describedby={
          description ? `${descriptionId} ${consequencesId}` : consequencesId
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? (
            <AlertDialogDescription id={descriptionId}>
              {description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <div
          id={consequencesId}
          className="rounded-md border border-border bg-muted/30 px-3 py-2.5"
        >
          <dl className="space-y-2">
            {ACTION_REVIEW_CONSEQUENCE_KEYS.map((key) => (
              <div
                key={key}
                className="grid grid-cols-(--gtc-action-review) gap-x-3 gap-y-0.5"
              >
                <dt className="text-xs text-muted-foreground pt-0.5">
                  {ACTION_REVIEW_CONSEQUENCE_LABELS[key]}
                </dt>
                <dd className="min-w-0 text-sm">{consequences[key]}</dd>
              </div>
            ))}
          </dl>
        </div>
        {typedGateActive ? (
          <div className="space-y-1.5">
            <Label htmlFor={typedInputId} className="text-xs">
              Type <span className="font-mono font-semibold">{typedConfirmation}</span> to
              confirm
            </Label>
            <Input
              id={typedInputId}
              value={typedValue}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTypedValue(event.target.value)}
            />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(
              tone === "destructive" && buttonVariants({ variant: "destructive" }),
            )}
            disabled={confirmBlocked}
            onClick={() => {
              confirmedRef.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
