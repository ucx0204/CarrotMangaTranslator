"""Idempotent, branch-only source integration; remove once all checkpoints are integrated.

No code generation or unreviewed edits: each exact replacement below is reviewed
source text. Existing content must match, otherwise stop without changing it.
"""
from pathlib import Path
import os

assert os.environ.get("GITHUB_REF") == "refs/heads/feat/manual-redaction-workspace-20260910"


def replace_once(path, old, new):
    target = Path(path)
    source = target.read_text(encoding="utf-8")
    if new in source:
        return
    if source.count(old) != 1:
        raise RuntimeError(f"Unexpected integration context: {path}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_once(
    "src/shared/mangaApi.ts",
    "  getImageRedactionEnabled: () => Promise<boolean>;",
    '''  openRedactionWorkspace: (
    request: import("./imageRedactionWorkspace").OpenRedactionWorkspace,
  ) => Promise<import("./imageRedactionWorkspace").RedactionWorkspace>;
  saveRedactionWorkspace: (
    request: import("./imageRedactionWorkspace").SaveRedactionWorkspace,
  ) => Promise<number>;
  closeRedactionWorkspace: (sessionId: string) => Promise<boolean>;
  getRedactionWorkspacePreview: (
    request: import("./imageRedactionWorkspace").RedactionPreviewRequest,
  ) => Promise<string>;
  getImageRedactionEnabled: () => Promise<boolean>;''',
)
replace_once(
    "src/main/ipc/translationJobIpc.ts",
    'import { confirmImageRedaction } from "../jobs/imageRedactionReview";',
    'import { registerImageRedactionWorkspaceIpc } from "./imageRedactionWorkspaceIpc";\nimport { confirmImageRedaction } from "../jobs/imageRedactionReview";',
)
replace_once(
    "src/main/ipc/translationJobIpc.ts",
    "export function registerTranslationJobIpc(context: IpcContext): void {",
    "export function registerTranslationJobIpc(context: IpcContext): void {\n  registerImageRedactionWorkspaceIpc(context);",
)

# The preparation entrypoint uses the same bounded fingerprint preparation as jobs.
path = Path("src/main/imageRedactionWorkspacePreparation.ts")
text = path.read_text(encoding="utf-8")
start = text.index("export async function prepareRedactionWorkspace(")
end = text.index("\nasync function resolvePages", start)
new = '''export async function prepareRedactionWorkspace(request: Exclude<OpenRedactionWorkspace, { kind: "job" }>) {
  const pages = await resolvePages(request);
  const state = await readImageRedactionState();
  const prepared = await prepareImageRedactionPages(pages, state.pages);
  return openRedactionWorkspaceSession(prepared, randomUUID());
}
'''
text = text[:start] + new + text[end:]
text = text.replace('import type { ImageRedactionPage } from "../shared/imageRedaction";\n', '')
text = text.replace('import { imageFingerprint } from "./imageRedactionContext";', 'import { prepareImageRedactionPages } from "./imageRedactionPagePreparation";')
path.write_text(text, encoding="utf-8")

# A failed open has no live draft session; preserve the original error at the caller.
replace_once(
    "src/main/imageRedactionWorkspaceSessions.ts",
    "  if (pending) await pending;",
    '''  if (pending) {
    try {
      await pending;
    } catch (error) {
      console.error("Manual redaction session initialization failed during cleanup", error);
    }
  }''',
)
replace_once(
    "src/main/imageRedactionWorkspacePreview.ts",
    "  previews.set(key, url);\n  previewBytes += url.length;",
    "  previewBytes -= previews.get(key)?.length ?? 0;\n  previews.set(key, url);\n  previewBytes += url.length;",
)
