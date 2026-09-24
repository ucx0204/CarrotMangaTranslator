import type { McpOutputSyncResult } from "./mcpOutputSync";

/** Summarizes only recorded file states; it does not inspect destination paths. */
export function outputSyncPublicationState(
  files: McpOutputSyncResult["files"],
  maximum: number,
) {
  const registry = files.filter((file) => file.role === "registry");
  const mirror = files.find((file) => file.role === "mirror");
  const metadata = registry.some(
    (file) => file.state === "publication_unconfirmed",
  )
    ? ("publication_unconfirmed" as const)
    : registry.length === maximum &&
        registry.every((file) => file.state === "published")
      ? ("published" as const)
      : registry.some((file) => file.state === "published")
        ? ("partial" as const)
        : ("pending" as const);
  return {
    metadata,
    mirror:
      mirror?.state === "published"
        ? ("published" as const)
        : mirror?.state === "publication_unconfirmed"
          ? ("publication_unconfirmed" as const)
          : ("pending" as const),
  };
}
