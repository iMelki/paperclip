import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActionReviewDialog,
  type ActionReviewConsequences,
  type ActionReviewTone,
} from "@/components/ActionReviewDialog";

export interface ConfirmDialogRequest {
  title: ReactNode;
  /** Optional one-line context shown under the title. */
  description?: ReactNode;
  /** The four-question consequence contract (EUX-09). */
  consequences: ActionReviewConsequences;
  tone?: ActionReviewTone;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  /** Typed gate for irreversible actions only. */
  typedConfirmation?: string;
}

interface ActiveConfirmRequest {
  /**
   * Monotonic per-request id, used as the dialog's React `key`. See the
   * remount note in `confirm` below — this is a correctness gate, not cosmetics.
   */
  id: number;
  request: ConfirmDialogRequest;
  resolve: (confirmed: boolean) => void;
}

/**
 * Promise-based replacement for `window.confirm()` built on the repo's
 * ActionReviewDialog composite (issue #48 / EUX-09).
 *
 * Usage:
 *   const { confirm, confirmDialog } = useConfirmDialog();
 *   ...
 *   const ok = await confirm({ title, consequences, confirmLabel });
 *   if (!ok) return;
 *   mutation.mutate();
 *   ...
 *   return <>{content}{confirmDialog}</>;
 *
 * Cancel, Escape, and overlay dismissal resolve `false`. Opening a second
 * request while one is pending resolves the first as `false`. Unmounting
 * resolves any pending request as `false`.
 */
export function useConfirmDialog(): {
  confirm: (request: ConfirmDialogRequest) => Promise<boolean>;
  confirmDialog: ReactNode;
} {
  const [active, setActive] = useState<ActiveConfirmRequest | null>(null);
  const activeRef = useRef<ActiveConfirmRequest | null>(null);
  const requestIdRef = useRef(0);
  activeRef.current = active;

  useEffect(() => {
    return () => {
      activeRef.current?.resolve(false);
      activeRef.current = null;
    };
  }, []);

  const confirm = useCallback((request: ConfirmDialogRequest) => {
    return new Promise<boolean>((resolve) => {
      activeRef.current?.resolve(false);
      // A replacement request keeps ActionReviewDialog mounted with open={true}.
      // The dialog clears its internal `typedValue` only on an open->closed
      // transition, which never happens here, so without a fresh identity the
      // second request would inherit the first request's typed text — and an
      // irreversible action could be confirmed with no typed confirmation of
      // its own. The incrementing id is used as the dialog's `key` so React
      // remounts it and the typed gate re-arms. (#51)
      requestIdRef.current += 1;
      const next: ActiveConfirmRequest = { id: requestIdRef.current, request, resolve };
      activeRef.current = next;
      setActive(next);
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    setActive(null);
    current.resolve(confirmed);
  }, []);

  const confirmDialog = active ? (
    <ActionReviewDialog
      key={active.id}
      open
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      title={active.request.title}
      description={active.request.description}
      consequences={active.request.consequences}
      tone={active.request.tone}
      confirmLabel={active.request.confirmLabel}
      cancelLabel={active.request.cancelLabel}
      typedConfirmation={active.request.typedConfirmation}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { confirm, confirmDialog };
}
