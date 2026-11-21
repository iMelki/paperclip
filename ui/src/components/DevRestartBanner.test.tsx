// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevRestartBanner } from "./DevRestartBanner";

const mockHealthApi = vi.hoisted(() => ({
  requestDevServerRestart: vi.fn(),
}));

vi.mock("../api/health", () => ({
  healthApi: mockHealthApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const devServer = {
  enabled: true as const,
  restartRequired: true,
  reason: "backend_changes" as const,
  lastChangedAt: "2026-03-20T12:00:00.000Z",
  changedPathCount: 1,
  changedPathsSample: ["server/src/routes/health.ts"],
  pendingMigrations: [],
  autoRestartEnabled: true,
  activeRunCount: 1,
  waitingForIdle: true,
  lastRestartAt: "2026-03-20T11:30:00.000Z",
};

beforeEach(() => {
  vi.spyOn(window, "alert").mockImplementation(() => undefined);
  mockHealthApi.requestDevServerRestart.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockHealthApi.requestDevServerRestart.mockReset();
});

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DevRestartBanner devServer={devServer} />));
  return container;
}

function bannerRestartButton(node: HTMLElement) {
  return [...node.querySelectorAll("button")]
    .find((entry) => entry.textContent?.includes("Restart now")) as HTMLButtonElement | undefined;
}

function reviewDialog() {
  return document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
}

function dialogConfirmButton() {
  return document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]');
}

function dialogCancelButton() {
  return document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-cancel"]');
}

describe("DevRestartBanner", () => {
  it("reviews and requests an immediate restart while waiting for live runs", async () => {
    const node = render();
    const button = bannerRestartButton(node);

    expect(node.textContent).toContain("Waiting for 1 live run to finish");
    expect(button).toBeTruthy();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = reviewDialog();
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("Restart Paperclip now?");
    expect(dialog?.textContent).toContain("This may interrupt 1 live run.");
    expect(mockHealthApi.requestDevServerRestart).not.toHaveBeenCalled();

    await act(async () => {
      dialogConfirmButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockHealthApi.requestDevServerRestart).toHaveBeenCalledTimes(1);
    expect(node.textContent).toContain("Restart requested");
    expect(reviewDialog()).toBeNull();
  });

  it("does not request restart when the review is cancelled", async () => {
    const node = render();
    const button = bannerRestartButton(node);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(reviewDialog()).toBeTruthy();

    await act(async () => {
      dialogCancelButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockHealthApi.requestDevServerRestart).not.toHaveBeenCalled();
    expect(reviewDialog()).toBeNull();
  });

  it("re-enables the manual restart action when a request does not refresh the page", async () => {
    vi.useFakeTimers();
    const node = render();
    const button = bannerRestartButton(node);

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      dialogConfirmButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(button?.disabled).toBe(true);
    expect(node.textContent).toContain("Restart requested");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(button?.disabled).toBe(false);
    expect(node.textContent).toContain("Restart now");
  });
});
