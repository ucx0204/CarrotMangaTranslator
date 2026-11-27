import { parseRocmArch, resolveAmdRocmTargetFromInfo } from "../amdRocmTargets";
import type { DetectedGpuInfo } from "../gpuInfo";
import catalog from "../runtime/native-inference-manifest.json";

function packagedTargets(prefix: string) {
  return new Set(
    Object.keys(catalog.packages)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
}
const fluxTargets = packagedTargets("rocm-device-");
const qwenTargets = packagedTargets("qwen-rocm-device-");

/** Package availability only; the managed ROCm probe validates the selected GPU at launch. */
export function resolveNativeRocmGpuSupport(
  info: DetectedGpuInfo | null,
  model: "flux" | "qwen" = "flux",
): boolean | undefined {
  if (!info || info.vendor !== "amd") return undefined;
  const targets = model === "qwen" ? qwenTargets : fluxTargets;
  const arch = parseRocmArch(String(info.rocmArch ?? ""))?.match(
    /^gfx[0-9a-f]+/,
  )?.[0];
  if (arch) return targets.has(arch);
  const target = resolveAmdRocmTargetFromInfo(info);
  if (!target) return undefined;
  return [...targets].some((entry) =>
    target.endsWith("X")
      ? entry.startsWith(target.slice(0, -1))
      : entry === target,
  );
}
