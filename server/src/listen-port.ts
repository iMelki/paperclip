import detectPort from "detect-port";

export interface ResolveListenPortOptions {
  /** Port the operator asked for. */
  port: number;
  /** Bind host the HTTP server will listen on. */
  host: string;
  /**
   * Fail when `port` is busy on `host` instead of moving to another port.
   * Off by default. Set with PAPERCLIP_STRICT_PORT=true.
   */
  strictPort?: boolean;
}

/**
 * Pick the port the HTTP server will listen on.
 *
 * detect-port is told the bind host so that it probes exactly the address the
 * server will bind. Without a host, detect-port probes five addresses,
 * including the first non-loopback IPv4 address of the machine, and moves to
 * the next port when any of them is busy. That moved a server bound to
 * loopback away from a free port because another program held the same port
 * on a different address.
 *
 * By default a busy port still moves the server to the next free port. With
 * `strictPort` the call throws instead, so a caller that publishes a fixed
 * port (a reverse proxy route, for example) never ends up on a different one.
 */
export async function resolveListenPort(options: ResolveListenPortOptions): Promise<number> {
  const { port, host, strictPort = false } = options;
  let selectedPort: number;
  try {
    selectedPort = await detectPort({ port, hostname: host });
  } catch (err) {
    // detect-port rejects a host that is not an address of this machine with a
    // message that names neither the host nor the port. server.listen() used
    // to report both, so keep that detail.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot check whether port ${port} is free on ${host}: ${reason}`, { cause: err });
  }
  // Port 0 asks for any free port, so detect-port always "moves" it.
  if (strictPort && port !== 0 && selectedPort !== port) {
    throw new Error(
      `Port ${port} is busy on ${host} and PAPERCLIP_STRICT_PORT is set, so the server will not use another port. ` +
        "Stop the program that holds the port or unset PAPERCLIP_STRICT_PORT.",
    );
  }
  return selectedPort;
}
