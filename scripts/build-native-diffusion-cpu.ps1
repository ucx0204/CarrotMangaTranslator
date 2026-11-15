param(
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$BuildDirectory,
  [string]$CMake = "cmake",
  [switch]$Vulkan
)
$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$revision = git -C $source rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $revision -ne "3f8527a46c54ecf4cb4ed6003da8e8982283c73c") {
  throw "Use stable-diffusion.cpp master-929-3f8527a with its pinned submodules"
}
if (git -C $source status --porcelain) { throw "Source must be clean" }
$submodules = git -C $source submodule status --recursive
if ($LASTEXITCODE -ne 0 -or ($submodules | Where-Object { $_ -match "^[+-U]" })) {
  throw "Initialize the exact pinned submodules before building"
}
$vulkanBackend = if ($Vulkan) { "ON" } else { "OFF" }
& $CMake -S $source -B $BuildDirectory -G "Visual Studio 17 2022" -A x64 "-DSD_VULKAN=$vulkanBackend" -DSD_BUILD_SHARED_LIBS=ON -DSD_BUILD_EXAMPLES=OFF -DSD_WEBP=OFF -DSD_WEBM=OFF -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_AVX512=OFF -DGGML_AVX_VNNI=OFF
if ($LASTEXITCODE -ne 0) { throw "CMake configuration failed" }
& $CMake --build $BuildDirectory --config Release --target stable-diffusion --parallel 4
if ($LASTEXITCODE -ne 0) { throw "Native diffusion build failed" }
