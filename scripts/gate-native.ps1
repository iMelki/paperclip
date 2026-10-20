# Native launch transport for the PowerShell 7 hook. The caller's Job/supervisor
# owns descendants, aggregate limits, whole-run deadline and final cleanup proof.
Set-StrictMode -Version Latest

function Resolve-GateExecutable {
  param([Parameter(Mandatory)][string]$Command)
  $application = Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $file = Get-Item -LiteralPath $application.Source -ErrorAction Stop
  # HardLink is a normal file identity, not a symbolic reparse target.
  if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    $file = $file.ResolveLinkTarget($true)
  }
  if ($null -eq $file -or $file -isnot [IO.FileInfo] -or -not $file.Exists -or
      -not [IO.Path]::IsPathRooted($file.FullName) -or ($IsWindows -and $file.Extension -ne '.exe')) {
    throw 'A gate command must resolve to a native executable, not a command shim.'
  }
  return $file.FullName
}

function Invoke-GateNative {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [string]$NativeLogPath,
    [switch]$Capture,
    [ValidateRange(1,1800000)][int]$TimeoutMs = 1800000,
    [ValidateRange(1,131072)][int]$MaxCaptureBytes = 131072
  )
  if (-not [IO.Path]::IsPathRooted($FilePath)) { throw 'Gate executable must be absolute.' }
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FilePath
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WorkingDirectory = $WorkingDirectory
  foreach ($argument in $ArgumentList) { $psi.ArgumentList.Add($argument) }
  $child = [Diagnostics.Process]::new()
  $child.StartInfo = $psi
  $sinks = @()
  $completed = $false
  $started = $false
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    if (-not $child.Start()) { throw 'Gate native child could not start.' }
    $started = $true
    $child.StandardInput.Close()
    $streams = @($child.StandardOutput.BaseStream, $child.StandardError.BaseStream)
    $buffers = @([byte[]]::new(8192), [byte[]]::new(8192))
    $captures = @([IO.MemoryStream]::new(), [IO.MemoryStream]::new())
    $consoleSinks = @([Console]::OpenStandardOutput(), [Console]::OpenStandardError())
    if ($NativeLogPath) {
      foreach ($suffix in @('stdout', 'stderr')) {
        $sinks += [IO.FileStream]::new("$NativeLogPath.$suffix.log", [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      }
    }
    $reads = @($streams[0].ReadAsync($buffers[0],0,$buffers[0].Length), $streams[1].ReadAsync($buffers[1],0,$buffers[1].Length))
    $eof = @($false, $false)
    $captureSize = 0
    while (-not ($eof[0] -and $eof[1] -and $child.HasExited)) {
      if ($clock.ElapsedMilliseconds -ge $TimeoutMs) { throw 'Gate native child deadline exceeded.' }
      for ($streamIndex=0; $streamIndex -lt 2; $streamIndex++) {
        if ($eof[$streamIndex] -or -not $reads[$streamIndex].IsCompleted) { continue }
        $count = $reads[$streamIndex].GetAwaiter().GetResult()
        if ($count -eq 0) { $eof[$streamIndex] = $true; continue }
        if ($sinks.Count) { $sinks[$streamIndex].Write($buffers[$streamIndex],0,$count); $sinks[$streamIndex].Flush($true) }
        if ($Capture) {
          $captureSize += $count
          if ($captureSize -gt $MaxCaptureBytes) { throw 'Gate native capture exceeded its finite bound.' }
          $captures[$streamIndex].Write($buffers[$streamIndex],0,$count)
        }
        if (-not $Capture -or -not $NativeLogPath) {
          $consoleSinks[$streamIndex].Write($buffers[$streamIndex],0,$count)
          $consoleSinks[$streamIndex].Flush()
        }
        $reads[$streamIndex] = $streams[$streamIndex].ReadAsync($buffers[$streamIndex],0,$buffers[$streamIndex].Length)
      }
      # Polling avoids a blocking read on one pipe starving the other pipe.
      [Threading.Thread]::Sleep(10)
    }
    if (-not $child.WaitForExit(15000)) { throw 'Exited child did not complete its final wait.' }
    $completed = $true
    return [pscustomobject]@{
      ExitCode=$child.ExitCode
      Stdout=[Text.Encoding]::UTF8.GetString($captures[0].ToArray())
      Stderr=[Text.Encoding]::UTF8.GetString($captures[1].ToArray())
    }
  } finally {
    $cleanupError = $null
    if (-not $completed -and $started) {
      try {
        if (-not $child.HasExited) { $child.Kill() }
        if (-not $child.WaitForExit(15000)) { $cleanupError = 'Gate native direct-child cleanup unresolved; supervisor tree cleanup required.' }
      } catch { $cleanupError = 'Gate native direct-child cleanup failed; supervisor tree cleanup required.' }
    }
    foreach ($sink in $sinks) { $sink.Dispose() }
    if (Get-Variable captures -ErrorAction SilentlyContinue) { foreach ($captureStream in $captures) { $captureStream.Dispose() } }
    $child.Dispose()
    if ($cleanupError) { throw $cleanupError }
  }
}
