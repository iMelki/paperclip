import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import path from "node:path";

/**
 * Windows Job Object custody for test-owned process trees.
 *
 * A single "job warden" Windows PowerShell sidecar per test process holds one
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE Job Object per runtime-service child and
 * answers an NDJSON protocol over stdin/stdout. Kernel guarantees, layered:
 *
 * 1. stdin pipe-break — the warden's main loop blocks on Console.In.ReadLine;
 *    when the test process dies the OS breaks the pipe and the warden exits.
 * 2. a background .NET thread WaitForExit watchdog on the StartTime-verified
 *    parent pid (a blocking ReadLine never yields to the PowerShell event
 *    queue, so Register-ObjectEvent would be inert — the thread is not).
 * 3. the kernel itself — however the warden dies, its handles close, and
 *    closing the last handle of a KILL_ON_JOB_CLOSE job terminates every
 *    process ever assigned to it. Breakaway is never granted, so descendants
 *    cannot escape.
 *
 * confirmedStopped receipts are issued only from TerminateJobObject followed
 * by QueryInformationJobObject(BasicAccounting).ActiveProcesses === 0 — an
 * authoritative kernel statement, the variant the advisory snapshot receipts
 * in server/src/services/windows-process-tree.ts explicitly reserve. A dead
 * or timed-out warden always degrades to a fail-closed result, never a lie.
 */

export type WindowsJobObjectTerminationReceipt = {
  authority: "job_object_kernel";
  authoritative: true;
  serviceId: string;
  rootPid: number;
  jobPidsBeforeTerminate: number[];
  activeProcessesAfter: number;
  terminateError: string | null;
  waitMs: number;
};

export type WindowsTestJobCustodyTerminationResult =
  | { ok: true; receipt: WindowsJobObjectTerminationReceipt }
  | { ok: false; reason: string; activeProcesses: number | null };

export type WindowsTestJobCustody = {
  serviceId: string;
  rootPid: number;
  terminate(timeoutMs: number): Promise<WindowsTestJobCustodyTerminationResult>;
  listPids(): Promise<number[] | null>;
};

type WardenReply = {
  type: string;
  seq: number;
  ok?: boolean;
  reason?: string;
  win32Error?: number;
  wardenPid?: number;
  jobPids?: number[];
  activeProcesses?: number;
  waitMs?: number;
};

const WARDEN_READY_TIMEOUT_MS = 15_000; // Add-Type cold compile is slow
const WARDEN_OP_TIMEOUT_MS = 10_000;

// Embedded Windows PowerShell 5.1 script. Kept dependency-free and executed
// via -EncodedCommand so it works from built dist output with no file on disk.
const WARDEN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaperclipJobKernel {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfo);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfo, out uint lpReturnLength);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject);

  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }

  public const int ExtendedLimitInformationClass = 9;
  public const int BasicAccountingInformationClass = 1;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, buf, false);
      if (!SetInformationJobObject(job, ExtendedLimitInformationClass, buf, (uint)size)) {
        int err = Marshal.GetLastWin32Error();
        CloseHandle(job);
        throw new System.ComponentModel.Win32Exception(err);
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return job;
  }

  public static uint ActiveProcesses(IntPtr job) {
    int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      uint returned;
      if (!QueryInformationJobObject(job, BasicAccountingInformationClass, buf, (uint)size, out returned))
        throw new System.ComponentModel.Win32Exception();
      var acct = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buf, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      return acct.ActiveProcesses;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  // A blocking Console.In.ReadLine never yields to the PowerShell event queue,
  // so the parent watchdog must live on its own .NET thread.
  public static void WatchParent(int pid) {
    var proc = System.Diagnostics.Process.GetProcessById(pid);
    var t = new System.Threading.Thread(delegate() {
      try { proc.WaitForExit(); } catch {}
      Environment.Exit(3);
    });
    t.IsBackground = true;
    t.Start();
  }
}
'@

$jobs = @{}       # id -> @{ handle = IntPtr; rootPid = int; proc = Process }
$out = [Console]::Out

function Send-Reply([hashtable]$reply) {
  $out.WriteLine((ConvertTo-Json -InputObject $reply -Compress -Depth 4))
  $out.Flush()
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $seq = -1
  try {
    $msg = ConvertFrom-Json -InputObject $line
    $seq = [int]$msg.seq
    switch ($msg.op) {
      'hello' {
        $parent = [System.Diagnostics.Process]::GetProcessById([int]$msg.parentPid)
        $expected = [DateTime]::Parse($msg.parentCreatedAtUtc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $actual = $parent.StartTime.ToUniversalTime()
        if ([Math]::Abs(($actual - $expected).TotalSeconds) -gt 2) {
          Send-Reply @{ type = 'ready'; seq = $seq; ok = $false; reason = 'parent_identity_mismatch' }
          exit 4
        }
        [PaperclipJobKernel]::WatchParent([int]$msg.parentPid)
        Send-Reply @{ type = 'ready'; seq = $seq; ok = $true; wardenPid = $PID }
      }
      'assign' {
        $target = $null
        try { $target = [System.Diagnostics.Process]::GetProcessById([int]$msg.pid) } catch {}
        if ($null -eq $target) {
          Send-Reply @{ type = 'assign_result'; seq = $seq; ok = $false; reason = 'target_not_found' }
          break
        }
        # Touching .Handle pins the kernel process object; the pid cannot be
        # recycled while this Process instance is referenced in $jobs.
        $targetHandle = $target.Handle
        $job = [PaperclipJobKernel]::CreateKillOnCloseJob()
        if (-not [PaperclipJobKernel]::AssignProcessToJobObject($job, $targetHandle)) {
          $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
          [PaperclipJobKernel]::CloseHandle($job) | Out-Null
          Send-Reply @{ type = 'assign_result'; seq = $seq; ok = $false; reason = 'assign_failed'; win32Error = $err }
          break
        }
        $jobs[[string]$msg.id] = @{ handle = $job; rootPid = [int]$msg.pid; proc = $target }
        Send-Reply @{ type = 'assign_result'; seq = $seq; ok = $true }
      }
      'list' {
        $entry = $jobs[[string]$msg.id]
        if ($null -eq $entry) {
          Send-Reply @{ type = 'list_result'; seq = $seq; ok = $false; reason = 'unknown_id' }
          break
        }
        $active = [PaperclipJobKernel]::ActiveProcesses($entry.handle)
        Send-Reply @{ type = 'list_result'; seq = $seq; ok = $true; activeProcesses = [int]$active }
      }
      'terminate' {
        $entry = $jobs[[string]$msg.id]
        if ($null -eq $entry) {
          Send-Reply @{ type = 'terminate_result'; seq = $seq; ok = $false; reason = 'unknown_id' }
          break
        }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $deadline = [Math]::Max(500, [int]$msg.timeoutMs)
        $terminateError = $null
        if (-not [PaperclipJobKernel]::TerminateJobObject($entry.handle, 1)) {
          $terminateError = "win32:" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        }
        $active = [PaperclipJobKernel]::ActiveProcesses($entry.handle)
        while ($active -gt 0 -and $sw.ElapsedMilliseconds -lt $deadline) {
          Start-Sleep -Milliseconds 25
          $active = [PaperclipJobKernel]::ActiveProcesses($entry.handle)
        }
        if ($active -eq 0) {
          [PaperclipJobKernel]::CloseHandle($entry.handle) | Out-Null
          $jobs.Remove([string]$msg.id)
          Send-Reply @{ type = 'terminate_result'; seq = $seq; ok = $true; activeProcesses = 0; waitMs = [int]$sw.ElapsedMilliseconds; reason = $terminateError }
        } else {
          # Keep the handle: the job still constrains the tree, and warden exit
          # (or test-process death) closes it, which kills the stragglers.
          Send-Reply @{ type = 'terminate_result'; seq = $seq; ok = $false; reason = 'active_processes_remain'; activeProcesses = [int]$active; waitMs = [int]$sw.ElapsedMilliseconds }
        }
      }
      'shutdown' {
        Send-Reply @{ type = 'shutdown_result'; seq = $seq; ok = $true }
        exit 0
      }
      default {
        Send-Reply @{ type = 'error'; seq = $seq; ok = $false; reason = 'unknown_op' }
      }
    }
  } catch {
    Send-Reply @{ type = 'error'; seq = $seq; ok = $false; reason = ('exception: ' + $_.Exception.Message) }
  }
}
exit 0
`;

type PendingReply = {
  resolve(reply: WardenReply): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type WardenState = {
  child: ChildProcess;
  reader: Interface;
  pending: Map<number, PendingReply>;
  nextSeq: number;
  ready: Promise<void>;
  dead: boolean;
  deadReason: string | null;
};

let wardenState: WardenState | null = null;
let wardenEverFailed = false;

function windowsPowerShellPath(): string {
  return path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function processCreatedAtUtcIso(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

function markWardenDead(state: WardenState, reason: string) {
  if (state.dead) return;
  state.dead = true;
  state.deadReason = reason;
  for (const [, pending] of state.pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`job warden dead: ${reason}`));
  }
  state.pending.clear();
}

function sendOp(
  state: WardenState,
  op: Record<string, unknown>,
  timeoutMs: number,
): Promise<WardenReply> {
  if (state.dead) {
    return Promise.reject(new Error(`job warden dead: ${state.deadReason ?? "unknown"}`));
  }
  const seq = state.nextSeq++;
  return new Promise<WardenReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(seq);
      reject(new Error(`job warden op timeout (${String(op.op)})`));
    }, timeoutMs);
    timer.unref?.();
    state.pending.set(seq, { resolve, reject, timer });
    const written = state.child.stdin?.write(`${JSON.stringify({ ...op, seq })}\n`);
    if (written === false || !state.child.stdin) {
      // Backpressure on a few-hundred-byte control line means the pipe is gone.
      clearTimeout(timer);
      state.pending.delete(seq);
      markWardenDead(state, "stdin_unwritable");
      reject(new Error("job warden dead: stdin_unwritable"));
    }
  });
}

function startWarden(): WardenState {
  const child = spawn(
    windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(WARDEN_SCRIPT, "utf16le").toString("base64"),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const reader = createInterface({ input: child.stdout! });
  const state: WardenState = {
    child,
    reader,
    pending: new Map(),
    nextSeq: 1,
    ready: Promise.resolve(),
    dead: false,
    deadReason: null,
  };
  reader.on("line", (line) => {
    let reply: WardenReply;
    try {
      reply = JSON.parse(line) as WardenReply;
    } catch {
      return; // non-protocol noise on stdout is ignored; diagnostics go to stderr
    }
    const pending = state.pending.get(reply.seq);
    if (!pending) return;
    state.pending.delete(reply.seq);
    clearTimeout(pending.timer);
    pending.resolve(reply);
  });
  child.on("exit", (code) => markWardenDead(state, `exited_${code ?? "signal"}`));
  child.on("error", (error) => markWardenDead(state, `spawn_error_${error.message}`));
  child.stdin?.on("error", () => markWardenDead(state, "stdin_error"));
  child.unref?.();
  state.ready = sendOp(
    state,
    { op: "hello", protocol: 1, parentPid: process.pid, parentCreatedAtUtc: processCreatedAtUtcIso() },
    WARDEN_READY_TIMEOUT_MS,
  ).then((reply) => {
    if (reply.ok !== true) {
      markWardenDead(state, reply.reason ?? "hello_rejected");
      throw new Error(`job warden hello rejected: ${reply.reason ?? "unknown"}`);
    }
  });
  return state;
}

function getWarden(): WardenState | null {
  if (process.platform !== "win32") return null;
  // Never respawn after a failure: a fresh warden knows nothing about the
  // previous warden's jobs, and pretending otherwise would let a stale id
  // produce a false confirmedStopped. Fail closed for the rest of the process.
  if (wardenEverFailed) return null;
  if (!wardenState || wardenState.dead) {
    if (wardenState?.dead) {
      wardenEverFailed = true;
      return null;
    }
    wardenState = startWarden();
  }
  return wardenState;
}

/**
 * Place a just-spawned test-owned child under kernel job custody.
 *
 * Returns null (fail-closed, caller must treat the spawn as uncontained) when
 * not on win32, the warden cannot be reached, the assign is refused, or the
 * child exited before/while custody was being established. The caller must
 * hold the child un-exec'd (stdin release-gate) until this resolves.
 */
export async function acquireWindowsTestJobCustody(
  serviceId: string,
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
): Promise<WindowsTestJobCustody | null> {
  if (process.platform !== "win32") return null;
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return null;
  const state = getWarden();
  if (!state) return null;
  try {
    await state.ready;
    const reply = await sendOp(state, { op: "assign", id: serviceId, pid }, WARDEN_OP_TIMEOUT_MS);
    if (reply.ok !== true) return null;
    // libuv retains the child's process handle while exitCode === null, so the
    // pid could not have been recycled between spawn and assign; re-checking
    // after the round-trip closes the exited-mid-assign window.
    if (child.exitCode !== null || child.signalCode !== null) return null;
  } catch {
    return null;
  }
  return {
    serviceId,
    rootPid: pid,
    async terminate(timeoutMs: number): Promise<WindowsTestJobCustodyTerminationResult> {
      const started = Date.now();
      let reply: WardenReply;
      try {
        await state.ready;
        reply = await sendOp(
          state,
          { op: "terminate", id: serviceId, timeoutMs },
          timeoutMs + WARDEN_OP_TIMEOUT_MS,
        );
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "warden_unreachable",
          activeProcesses: null,
        };
      }
      if (reply.ok === true) {
        return {
          ok: true,
          receipt: {
            authority: "job_object_kernel",
            authoritative: true,
            serviceId,
            rootPid: pid,
            jobPidsBeforeTerminate: reply.jobPids ?? [],
            activeProcessesAfter: 0,
            terminateError: reply.reason ?? null,
            waitMs: reply.waitMs ?? Date.now() - started,
          },
        };
      }
      return {
        ok: false,
        reason: reply.reason ?? "terminate_unconfirmed",
        activeProcesses: reply.activeProcesses ?? null,
      };
    },
    async listPids(): Promise<number[] | null> {
      try {
        await state.ready;
        const reply = await sendOp(state, { op: "list", id: serviceId }, WARDEN_OP_TIMEOUT_MS);
        return reply.ok === true ? reply.jobPids ?? [] : null;
      } catch {
        return null;
      }
    },
  };
}

/** Test-only: stop the warden and reset module state. */
export async function shutdownWindowsTestJobWardenForTests(): Promise<void> {
  const state = wardenState;
  wardenState = null;
  wardenEverFailed = false;
  if (!state || state.dead) return;
  try {
    await sendOp(state, { op: "shutdown" }, 2_000);
  } catch {
    // exit via pipe-break instead
  }
  state.child.stdin?.end();
  state.child.kill();
}
