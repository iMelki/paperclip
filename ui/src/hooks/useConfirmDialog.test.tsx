// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useConfirmDialog, type ConfirmDialogRequest } from "./useConfirmDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const request: ConfirmDialogRequest = {
  title: "Restart Paperclip now?",
  consequences: {
    immediateEffect: "A restart is requested.",
    confirmedEffect: "The dev server restarts.",
    resultLocation: "This banner.",
    willNotHappen: "No data is deleted.",
  },
  confirmLabel: "Restart now",
};

let confirmFn: ((req: ConfirmDialogRequest) => Promise<boolean>) | null = null;

function Harness() {
  const { confirm, confirmDialog } = useConfirmDialog();
  confirmFn = confirm;
  return <div>{confirmDialog}</div>;
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  confirmFn = null;
});

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  ) as HTMLButtonElement | undefined;
}

/**
 * React installs its own `value` setter on the input prototype, so assigning
 * `input.value` directly is invisible to onChange. Go through the native setter
 * and then dispatch, which is what React's own test utils do.
 */
function typeInto(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("useConfirmDialog", () => {
  it("resolves true when the operator confirms", async () => {
    render();
    let promise: Promise<boolean>;
    act(() => {
      promise = confirmFn!(request);
    });

    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeTruthy();

    await act(async () => findButton("Restart now")?.click());
    await expect(promise!).resolves.toBe(true);
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });

  it("resolves false when the operator cancels", async () => {
    render();
    let promise: Promise<boolean>;
    act(() => {
      promise = confirmFn!(request);
    });

    await act(async () => findButton("Cancel")?.click());
    await expect(promise!).resolves.toBe(false);
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });

  it("resolves an earlier pending request as false when a new one opens", async () => {
    render();
    let first: Promise<boolean>;
    let second: Promise<boolean>;
    act(() => {
      first = confirmFn!(request);
    });
    act(() => {
      second = confirmFn!({ ...request, title: "Second request?" });
    });

    await expect(first!).resolves.toBe(false);

    await act(async () => findButton("Restart now")?.click());
    await expect(second!).resolves.toBe(true);
  });

  it("re-arms the typed gate when a pending request is replaced", async () => {
    // Regression guard (#51). A replacement keeps ActionReviewDialog mounted with
    // open={true}; the dialog only clears its internal typedValue on an
    // open->closed transition. Without a fresh key the second request inherits the
    // first request's typed text, and an irreversible action can be confirmed with
    // no typed confirmation of its own.
    const typedRequest: ConfirmDialogRequest = { ...request, typedConfirmation: "delete-me" };
    render();

    let first: Promise<boolean>;
    act(() => {
      first = confirmFn!(typedRequest);
    });

    // Gate starts closed.
    expect(findButton("Restart now")?.disabled).toBe(true);

    // Satisfy it for the FIRST request.
    await act(async () => {
      typeInto(document.querySelector("input") as HTMLInputElement, "delete-me");
    });
    expect(findButton("Restart now")?.disabled).toBe(false);

    // Replace the request. The gate must close again.
    let second: Promise<boolean>;
    act(() => {
      second = confirmFn!({ ...typedRequest, title: "Delete a different thing?" });
    });
    await expect(first!).resolves.toBe(false);

    expect((document.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(findButton("Restart now")?.disabled).toBe(true);

    // And it can still be satisfied afresh.
    await act(async () => {
      typeInto(document.querySelector("input") as HTMLInputElement, "delete-me");
    });
    expect(findButton("Restart now")?.disabled).toBe(false);
    await act(async () => findButton("Restart now")?.click());
    await expect(second!).resolves.toBe(true);
  });

  it("resolves false when the owner unmounts mid-request", async () => {
    render();
    let promise: Promise<boolean>;
    act(() => {
      promise = confirmFn!(request);
    });

    act(() => root?.unmount());
    root = null;
    await expect(promise!).resolves.toBe(false);
  });
});
