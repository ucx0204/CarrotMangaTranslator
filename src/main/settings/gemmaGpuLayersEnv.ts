export function readOptionalGpuLayersEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | "fit" | "all" | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "fit") return "fit";
  if (normalized === "all") return "all";
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}
