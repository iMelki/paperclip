import { createRequire } from "node:module";
import net, { type AddressInfo } from "node:net";
import detectPort from "detect-port";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveListenPort } from "../listen-port.js";

// These tests use real sockets and the real detect-port package. Do not mock
// detect-port in this file: the tests observe what it does with a busy address.
// detect-port without a hostname probes five addresses, one of them by name
// ("localhost"), so on a loaded machine it can take longer than the default
// five-second test timeout.
vi.setConfig({ testTimeout: 30_000 });

// detect-port 2.1.0 probes the first non-127 IPv4 address of the machine as its
// last check. Ask the same helper package that detect-port uses, resolved from
// detect-port's own location, so the test holds exactly the address that
// detect-port will probe.
function firstNonLoopbackIPv4(): string | undefined {
  const requireFromTest = createRequire(import.meta.url);
  const requireFromDetectPort = createRequire(requireFromTest.resolve("detect-port"));
  const { ip } = requireFromDetectPort("address") as { ip(): string | undefined };
  const address = ip();
  return address && !address.startsWith("127.") ? address : undefined;
}

function listenOn(host: string, port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Hold an operating-system chosen port on `address`. The scenario needs the same
// port to be free on loopback, so try again if it is not.
async function holdEphemeralPort(address: string): Promise<{ holder: net.Server; port: number }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const holder = await listenOn(address, 0);
    const port = (holder.address() as AddressInfo).port;
    try {
      await close(await listenOn("127.0.0.1", port));
      return { holder, port };
    } catch {
      await close(holder);
    }
  }
  throw new Error("Could not find a port that is free on loopback and busy on the other address");
}

const otherAddress = firstNonLoopbackIPv4();

describe.skipIf(!otherAddress)("listen port selection while another address of the machine is busy", () => {
  let holder: net.Server;
  let port: number;

  beforeEach(async () => {
    ({ holder, port } = await holdEphemeralPort(otherAddress!));
  });

  afterEach(async () => {
    await close(holder);
  });

  it("detect-port without a hostname moves off a port that is busy on the first non-loopback address", async () => {
    // Control for the next test. If this stops moving, the next test cannot fail
    // without the fix, so it would prove nothing.
    expect(await detectPort(port)).not.toBe(port);
  });

  it("keeps the requested port when only another address of the machine is busy", async () => {
    expect(await resolveListenPort({ port, host: "127.0.0.1" })).toBe(port);
  });

  it("moves off the requested port when the configured host itself is busy", async () => {
    expect(await resolveListenPort({ port, host: otherAddress! })).not.toBe(port);
  });
});

describe("listen port selection with a host that is not an address of this machine", () => {
  it("names the host and the port in the error", async () => {
    // 203.0.113.0/24 is reserved for documentation (RFC 5737) and is never assigned.
    await expect(resolveListenPort({ port: 3100, host: "203.0.113.1" })).rejects.toThrow(
      /port 3100.*203\.0\.113\.1/,
    );
  });
});
