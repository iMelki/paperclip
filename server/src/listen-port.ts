import detectPort from "detect-port";

export interface ResolveListenPortOptions {
  /** Port the operator asked for. */
  port: number;
  /** Bind host the HTTP server will listen on. */
  host: string;
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
 */
export async function resolveListenPort(options: ResolveListenPortOptions): Promise<number> {
  const { port, host } = options;
  try {
    return await detectPort({ port, hostname: host });
  } catch (err) {
    // detect-port rejects a host that is not an address of this machine with a
    // message that names neither the host nor the port. server.listen() used
    // to report both, so keep that detail.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot check whether port ${port} is free on ${host}: ${reason}`, { cause: err });
  }
}
