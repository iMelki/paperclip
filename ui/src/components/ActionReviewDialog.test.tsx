// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_REVIEW_CONSEQUENCE_LABELS,
  ActionReviewDialog,
  isTypedConfirmationSatisfied,
  type ActionReviewConsequences,
} from "./ActionReviewDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const consequences: ActionReviewConsequences = {
  immediateEffect: "The file is removed from the list.",
  confirmedEffect: "The server deletes the file.",
  resultLocation: "The file tree refreshes.",
  willNotHappen: "Other files are not touched.",
};

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function render(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function dialogElement(): HTMLElement | null {
  return document.querySelector('[data-slot="alert-dialog-content"]');
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  ) as HTMLButtonElement | undefined;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("isTypedConfirmationSatisfied", () => {
  it("requires an exact, case-sensitive match with surrounding whitespace forgiven", () => {
    expect(isTypedConfirmationSatisfied("Agent Alpha", "Agent Alpha")).toBe(true);
    expect(isTypedConfirmationSatisfied("Agent Alpha", "  Agent Alpha  ")).toBe(true);
    expect(isTypedConfirmationSatisfied("Agent Alpha", "agent alpha")).toBe(false);
    expect(isTypedConfirmationSatisfied("Agent Alpha", "")).toBe(false);
  });

  it("fails closed when the expected value is empty", () => {
    expect(isTypedConfirmationSatisfied("", "")).toBe(false);
    expect(isTypedConfirmationSatisfied("   ", "   ")).toBe(false);
  });
});

describe("ActionReviewDialog", () => {
  it("renders the four consequence questions with their answers", () => {
    render(
      <ActionReviewDialog
        open
        onOpenChange={() => {}}
        title="Delete file?"
        consequences={consequences}
        confirmLabel="Delete"
        onConfirm={() => {}}
      />,
    );

    const dialog = dialogElement();
    expect(dialog).toBeTruthy();
    for (const label of Object.values(ACTION_REVIEW_CONSEQUENCE_LABELS)) {
      expect(dialog?.textContent).toContain(label);
    }
    expect(dialog?.textContent).toContain("The server deletes the file.");
    expect(dialog?.textContent).toContain("Other files are not touched.");
  });

  it("points aria-describedby at the consequence block", () => {
    render(
      <ActionReviewDialog
        open
        onOpenChange={() => {}}
        title="Delete file?"
        description="This cannot be undone."
        consequences={consequences}
        confirmLabel="Delete"
        onConfirm={() => {}}
      />,
    );

    const dialog = dialogElement();
    const describedBy = dialog?.getAttribute("aria-describedby") ?? "";
    const ids = describedBy.split(/\s+/).filter(Boolean);
    expect(ids.length).toBe(2);
    for (const id of ids) {
      expect(document.getElementById(id)).toBeTruthy();
    }
  });

  it("fires onConfirm on confirm and onCancel on cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ActionReviewDialog
        open
        onOpenChange={onOpenChange}
        title="Archive company?"
        consequences={consequences}
        confirmLabel="Archive"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    act(() => findButton("Archive")?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    act(() => findButton("Cancel")?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("styles the confirm button destructively for the destructive tone", () => {
    render(
      <ActionReviewDialog
        open
        onOpenChange={() => {}}
        title="Delete agent?"
        consequences={consequences}
        tone="destructive"
        confirmLabel="Delete agent"
        onConfirm={() => {}}
      />,
    );

    const confirm = findButton("Delete agent");
    expect(confirm?.className).toContain("bg-destructive");
  });

  it("keeps confirm disabled until the typed gate is satisfied", () => {
    const onConfirm = vi.fn();
    render(
      <ActionReviewDialog
        open
        onOpenChange={() => {}}
        title="Delete agent?"
        consequences={consequences}
        tone="destructive"
        confirmLabel="Delete agent"
        typedConfirmation="Agent Alpha"
        onConfirm={onConfirm}
      />,
    );

    const confirm = findButton("Delete agent");
    expect(confirm?.disabled).toBe(true);

    const input = dialogElement()?.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();

    typeInto(input, "wrong name");
    expect(findButton("Delete agent")?.disabled).toBe(true);

    typeInto(input, "Agent Alpha");
    expect(findButton("Delete agent")?.disabled).toBe(false);

    act(() => findButton("Delete agent")?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
