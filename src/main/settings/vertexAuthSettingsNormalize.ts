import type { AppSettings } from "../../shared/settingsTypes";

export function normalizeVertexAuthSettings(
  api: Record<string, unknown> | null,
): Pick<AppSettings["api"], "vertexAuthMode" | "vertexServiceAccountPath"> {
  const vertexAuthMode =
    api?.vertexAuthMode === "service-account"
      ? "service-account"
      : "access-token";
  const vertexServiceAccountPath =
    typeof api?.vertexServiceAccountPath === "string"
      ? api.vertexServiceAccountPath.trim()
      : "";
  return {
    ...(api?.vertexAuthMode !== undefined || vertexServiceAccountPath
      ? { vertexAuthMode }
      : {}),
    ...(vertexServiceAccountPath ? { vertexServiceAccountPath } : {}),
  };
}
