import { join } from "node:path";
import {
  readRedactionSnapshot,
  writeRedactionSnapshot,
} from "../imageRedactionWorkspaceSnapshot";
import { readBackupJson, exists } from "./files";
import { portableLibraryPath } from "./library";
import { writeJsonFile } from "../libraryStore/storage";

function convertDraftKey(path: string, destination?: string): string {
  if (path.startsWith("external/"))
    return destination
      ? Buffer.from(path.slice(9), "base64url").toString("utf8")
      : path;
  const normalized = path.replace(/\\/g, "/");
  if (
    !normalized.includes("/library/works/") &&
    !normalized.startsWith("library/works/")
  )
    return `external/${Buffer.from(path).toString("base64url")}`;
  const relative = portableLibraryPath(path);
  return destination ? join(destination, relative) : relative;
}

export async function relocateBackupRedaction(
  root: string,
  destination?: string,
): Promise<void> {
  const snapshot = await readRedactionSnapshot(root);
  snapshot.state.pages = Object.fromEntries(
    Object.entries(snapshot.state.pages).map(([path, draft]) => [
      convertDraftKey(path, destination),
      draft,
    ]),
  );
  // View scopes hash sets of absolute paths; retain masks/decisions, reset only viewport caches.
  snapshot.state.views = {};
  await writeRedactionSnapshot(root, { state: snapshot.state });
  const path = join(root, "image-redactions.json");
  if (!(await exists(path))) return;
  const raw = (await readBackupJson(path)) as {
    enabled: boolean;
    pages: Record<string, unknown>;
  };
  if (!raw.pages || typeof raw.enabled !== "boolean")
    throw new Error("Invalid redaction state.");
  await writeJsonFile(path, {
    ...raw,
    pages: Object.fromEntries(
      Object.entries(raw.pages).map(([key, value]) => [
        convertDraftKey(key, destination),
        value,
      ]),
    ),
  });
}
