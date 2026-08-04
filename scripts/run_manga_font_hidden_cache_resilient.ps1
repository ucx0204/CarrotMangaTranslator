param(
    [string]$OutputDir = "artifacts/manga-font-master-v3-siglip2-hidden-cache-v1",
    [ValidateRange(1, 50)]
    [int]$MaxAttempts = 12
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    [System.IO.Path]::GetFullPath($OutputDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDir))
}
$runner = Join-Path $PSScriptRoot "run_manga_font_hidden_cache_resilient.py"
$supervisorLog = "$resolvedOutput.supervisor.log"
$stdout = "$resolvedOutput.supervisor-resilient.stdout.log"
$stderr = "$resolvedOutput.supervisor-resilient.stderr.log"

$env:CUBLAS_WORKSPACE_CONFIG = ":4096:8"
$env:PYTHONUNBUFFERED = "1"
$env:MANGA_FONT_HIDDEN_CACHE_REPLACE_MAX_ATTEMPTS = [string]$MaxAttempts

$arguments = @(
    "-u",
    $runner,
    "build",
    "--output-dir",
    $resolvedOutput,
    "--device",
    "cuda",
    "--resume"
)
"resilient-run start=$([DateTimeOffset]::Now.ToString('o')) maxReplaceAttempts=$MaxAttempts" |
    Add-Content -LiteralPath $supervisorLog
$process = Start-Process `
    -FilePath "python" `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru `
    -Wait
$exitCode = $process.ExitCode
"resilient-run exit=$exitCode end=$([DateTimeOffset]::Now.ToString('o'))" |
    Add-Content -LiteralPath $supervisorLog
if ($exitCode -eq 0) {
    exit 0
}

throw "hidden-cache build failed; see $stderr"
