import { describe, expect, it } from "vitest";
import {
  ADAPTER_DEFAULT_TIMEOUT_SEC,
  DEFAULT_ADAPTER_TIMEOUT_SEC,
  PAPERCLIP_RUNNER_MAX_TIMEOUT_MS,
  resolveAdapterTimeoutSec,
  resolveHttpAdapterTimeout,
  resolvePaperclipRunnerTimeoutMs,
} from "./adapter-timeout.js";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe("resolveAdapterTimeoutSec", () => {
  it.each(Object.entries(ADAPTER_DEFAULT_TIMEOUT_SEC))(
    "uses the %s default when timeoutSec is missing, 0, or negative",
    (_adapter, defaultSec) => {
      for (const configured of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "", "0", "-5"]) {
        expect(
          resolveAdapterTimeoutSec({
            configured,
            adapterDefaultSec: defaultSec,
            env: EMPTY_ENV,
          }),
        ).toEqual({ timeoutSec: defaultSec, source: "adapter_default" });
      }
    },
  );

  it("honors a positive per-agent override, including fractional seconds and numeric strings", () => {
    expect(
      resolveAdapterTimeoutSec({
        configured: 90,
        adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.claude_local,
        env: EMPTY_ENV,
      }),
    ).toEqual({ timeoutSec: 90, source: "configured" });
    expect(
      resolveAdapterTimeoutSec({
        configured: 0.25,
        adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.process,
        env: { PAPERCLIP_ADAPTER_TIMEOUT_SEC: "30" },
      }),
    ).toEqual({ timeoutSec: 0.25, source: "configured" });
    expect(
      resolveAdapterTimeoutSec({
        configured: " 45 ",
        adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.http,
        env: EMPTY_ENV,
      }),
    ).toEqual({ timeoutSec: 45, source: "configured" });
  });

  it("lets a positive PAPERCLIP_ADAPTER_TIMEOUT_SEC replace the adapter default", () => {
    expect(
      resolveAdapterTimeoutSec({
        configured: 0,
        adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.codex_local,
        env: { PAPERCLIP_ADAPTER_TIMEOUT_SEC: "600" },
      }),
    ).toEqual({ timeoutSec: 600, source: "env" });
    expect(
      resolveAdapterTimeoutSec({
        configured: undefined,
        adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.hermes_local,
        env: { PAPERCLIP_ADAPTER_TIMEOUT_SEC: "0.2" },
      }),
    ).toEqual({ timeoutSec: 0.2, source: "env" });
  });

  it("ignores a non-positive env default and never resolves to zero", () => {
    for (const envValue of ["0", "-1", "nope", ""]) {
      const resolved = resolveAdapterTimeoutSec({
        configured: -5,
        adapterDefaultSec: ADAPTER_DEFAULT_TIMEOUT_SEC.openclaw_gateway,
        env: { PAPERCLIP_ADAPTER_TIMEOUT_SEC: envValue },
      });
      expect(resolved.timeoutSec).toBeGreaterThan(0);
      expect(resolved).toEqual({
        timeoutSec: ADAPTER_DEFAULT_TIMEOUT_SEC.openclaw_gateway,
        source: "adapter_default",
      });
    }
  });

  it("falls back to the shared default when the adapter default is not positive", () => {
    expect(
      resolveAdapterTimeoutSec({
        configured: 0,
        adapterDefaultSec: 0,
        env: EMPTY_ENV,
      }),
    ).toEqual({ timeoutSec: DEFAULT_ADAPTER_TIMEOUT_SEC, source: "adapter_default" });
  });
});

describe("resolveHttpAdapterTimeout", () => {
  it("uses 120s when timeoutSec and timeoutMs are missing, 0, or negative", () => {
    expect(
      resolveHttpAdapterTimeout({ timeoutSec: undefined, timeoutMs: 0, env: EMPTY_ENV }),
    ).toEqual({ timeoutMs: 120_000, source: "adapter_default" });
    expect(
      resolveHttpAdapterTimeout({ timeoutSec: -1, timeoutMs: -5, env: EMPTY_ENV }),
    ).toEqual({ timeoutMs: 120_000, source: "adapter_default" });
  });

  it("honors timeoutSec, then a legacy positive timeoutMs", () => {
    expect(
      resolveHttpAdapterTimeout({ timeoutSec: 15, timeoutMs: 1, env: EMPTY_ENV }),
    ).toEqual({ timeoutMs: 15_000, source: "configured" });
    expect(
      resolveHttpAdapterTimeout({ timeoutSec: 0, timeoutMs: 1, env: EMPTY_ENV }),
    ).toEqual({ timeoutMs: 1, source: "configured" });
  });
});

describe("resolvePaperclipRunnerTimeoutMs", () => {
  it("uses 1h for missing, 0, and negative timeoutSec", () => {
    for (const configured of [undefined, 0, -1]) {
      expect(resolvePaperclipRunnerTimeoutMs({ configured, env: EMPTY_ENV })).toBe(3_600_000);
    }
  });

  it("honors an override and clamps it to the runner window", () => {
    expect(resolvePaperclipRunnerTimeoutMs({ configured: 45, env: EMPTY_ENV })).toBe(45_000);
    expect(resolvePaperclipRunnerTimeoutMs({ configured: 0.2, env: EMPTY_ENV })).toBe(1_000);
    expect(resolvePaperclipRunnerTimeoutMs({ configured: 100_000, env: EMPTY_ENV })).toBe(
      PAPERCLIP_RUNNER_MAX_TIMEOUT_MS,
    );
  });
});
