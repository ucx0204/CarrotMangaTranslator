param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [int]$IntervalMilliseconds = 1000,

  [int]$StopLlamaAtBoardMemoryMiB = 0,

  [int]$StopLlamaAtSharedMemoryMiB = 0
)

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

'timestamp_iso,memory_used_mib,memory_total_mib,utilization_percent,power_w,phase,llama_pids,flux_pids,llama_wddm_dedicated_mib,llama_wddm_shared_mib,flux_wddm_dedicated_mib,flux_wddm_shared_mib,guard_action' |
  Set-Content -LiteralPath $OutputPath -Encoding utf8

function Get-ProcessGpuMemoryMiB {
  param(
    [System.Diagnostics.PerformanceCounterCategory]$Category,
    [string[]]$InstanceNames,
    [int[]]$ProcessIds,
    [ValidateSet('Dedicated Usage', 'Shared Usage')]
    [string]$CounterName
  )

  if ($ProcessIds.Count -eq 0 -or $InstanceNames.Count -eq 0) {
    return 0
  }

  $totalBytes = 0.0
  foreach ($instanceName in $InstanceNames) {
    $matchesPid = ($ProcessIds | Where-Object {
      $instanceName -match ('^pid_' + $_ + '_')
    }).Count -gt 0
    if (-not $matchesPid) {
      continue
    }
    $counter = [System.Diagnostics.PerformanceCounter]::new(
      $Category.CategoryName,
      $CounterName,
      $instanceName,
      $true
    )
    try {
      $totalBytes += $counter.NextValue()
    } finally {
      $counter.Dispose()
    }
  }
  return [double]$totalBytes / 1MB
}

$gpuMemoryCategory = [System.Diagnostics.PerformanceCounterCategory]::new('GPU Process Memory')
# Prime the Windows performance-counter provider before the measured process starts.
$null = $gpuMemoryCategory.GetInstanceNames()

while ($true) {
  $gpu = (& nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,power.draw --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
  if ($gpu) {
    $parts = $gpu -split '\s*,\s*'
    $llamaPids = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $nativeFluxPids = @(Get-Process -Name 'mgt-flux-klein' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $pythonFluxPids = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and ($_.CommandLine -match 'flux|inpaint') -and $_.Name -match 'python'
    } | ForEach-Object { $_.ProcessId })
    $fluxPids = @($nativeFluxPids + $pythonFluxPids | Select-Object -Unique)
    $gpuMemoryInstanceNames = @($gpuMemoryCategory.GetInstanceNames())
    $llamaDedicatedMiB = Get-ProcessGpuMemoryMiB -Category $gpuMemoryCategory -InstanceNames $gpuMemoryInstanceNames -ProcessIds $llamaPids -CounterName 'Dedicated Usage'
    $llamaSharedMiB = Get-ProcessGpuMemoryMiB -Category $gpuMemoryCategory -InstanceNames $gpuMemoryInstanceNames -ProcessIds $llamaPids -CounterName 'Shared Usage'
    $fluxDedicatedMiB = Get-ProcessGpuMemoryMiB -Category $gpuMemoryCategory -InstanceNames $gpuMemoryInstanceNames -ProcessIds $fluxPids -CounterName 'Dedicated Usage'
    $fluxSharedMiB = Get-ProcessGpuMemoryMiB -Category $gpuMemoryCategory -InstanceNames $gpuMemoryInstanceNames -ProcessIds $fluxPids -CounterName 'Shared Usage'

    $phase = if ($llamaPids.Count -gt 0 -and $fluxPids.Count -gt 0) {
      'llama+flux'
    } elseif ($llamaPids.Count -gt 0) {
      'llama'
    } elseif ($fluxPids.Count -gt 0) {
      'flux'
    } else {
      'idle'
    }

    $guardReasons = @()
    if (
      $llamaPids.Count -gt 0 -and
      $StopLlamaAtBoardMemoryMiB -gt 0 -and
      [int][double]$parts[0] -ge $StopLlamaAtBoardMemoryMiB
    ) {
      $guardReasons += "board-memory-$([int][double]$parts[0])-mib"
    }
    if (
      $llamaPids.Count -gt 0 -and
      $StopLlamaAtSharedMemoryMiB -gt 0 -and
      $llamaSharedMiB -ge $StopLlamaAtSharedMemoryMiB
    ) {
      $guardReasons += "llama-shared-$([math]::Round($llamaSharedMiB, 2))-mib"
    }
    $guardAction = if ($guardReasons.Count -gt 0) {
      "stop-llama:$($guardReasons -join '+')"
    } else {
      ''
    }

    $row = [pscustomobject]@{
      timestamp_iso = [DateTime]::UtcNow.ToString('o')
      memory_used_mib = [int][double]$parts[0]
      memory_total_mib = [int][double]$parts[1]
      utilization_percent = [int][double]$parts[2]
      power_w = [double]$parts[3]
      phase = $phase
      llama_pids = ($llamaPids -join ';')
      flux_pids = ($fluxPids -join ';')
    }
    $escaped = @(
      '"' + $row.timestamp_iso + '"'
      $row.memory_used_mib
      $row.memory_total_mib
      $row.utilization_percent
      ('{0:F2}' -f $row.power_w)
      $row.phase
      '"' + $row.llama_pids + '"'
      '"' + $row.flux_pids + '"'
      ('{0:F2}' -f $llamaDedicatedMiB)
      ('{0:F2}' -f $llamaSharedMiB)
      ('{0:F2}' -f $fluxDedicatedMiB)
      ('{0:F2}' -f $fluxSharedMiB)
      '"' + $guardAction + '"'
    ) -join ','
    Add-Content -LiteralPath $OutputPath -Value $escaped -Encoding utf8
    if ($guardAction) {
      Get-Process -Id $llamaPids -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds $IntervalMilliseconds
}
