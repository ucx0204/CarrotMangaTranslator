"""Read-only feature audit. No releases, credentials, user libraries or binaries."""
import json
import os
import subprocess
import zipfile
from pathlib import Path

BRANCH = "refs/heads/feat/manual-redaction-workspace-20260910"
assert os.environ.get("GITHUB_REF") == BRANCH
ROOT = Path.cwd()
OUT = ROOT / ".tmp/manual-redaction-audit"
OUT.mkdir(parents=True, exist_ok=True)


def command(args, timeout=1200):
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return result.returncode, result.stdout + result.stderr


QA = r'''import React from "react";
import { createRoot } from "react-dom/client";
import { initializeAppI18n } from "./appI18n";
import { AppI18nProvider } from "./i18n";
import { ManualRedactionWorkspace } from "./components/imageRedaction/ManualRedactionWorkspace";
import { DEFAULT_REDACTION_VIEW, DEFAULT_REDACTION_PREFERENCES, type RedactionWorkspace } from "../../shared/imageRedactionWorkspace";
import "./styles.css";

async function start() {
  await initializeAppI18n("ko");
  // Extend, never replace, the QA tool's complete injected bridge.
  const sample = await window.mangaApi.getPageImageDataUrl("manual-redaction-qa");
  Object.assign(window.mangaApi, {
    getRedactionWorkspacePreview: async () => sample,
    saveRedactionWorkspace: async (request: { expectedRevision: number }) => request.expectedRevision + 1,
    closeRedactionWorkspace: async () => true,
  });
  const query = new URLSearchParams(location.search);
  const workspace: RedactionWorkspace = {
    sessionId: "11111111-1111-4111-8111-111111111111", revision: 0,
    pages: Array.from({ length: 100 }, (_, index) => ({
      id: `p${index}`, name: `${String(index + 1).padStart(3, "0")}.png`,
      imagePath: `qa-page-${index}.png`, fingerprint: "a".repeat(64),
      width: 1200, height: 1600,
      decision: index < 67 ? "reviewed" : index === 75 ? "deferred" : "unreviewed",
      strokes: index % 3 === 0 ? [{ shape: "rectangle", size: 40, points: [{ x: 680, y: 260 }, { x: 1000, y: 550 }] }] : [],
    })),
    view: { ...DEFAULT_REDACTION_VIEW, currentId: "p36", selectedIds: ["p36", "p37"], mode: query.get("mode") === "grid" ? "grid" : "edit", pageViews: {} },
    preferences: { ...DEFAULT_REDACTION_PREFERENCES }, presets: [],
  };
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing QA root");
  createRoot(root).render(<React.StrictMode><AppI18nProvider>
    <ManualRedactionWorkspace workspace={workspace} onClose={() => {}} />
  </AppI18nProvider></React.StrictMode>);
  setTimeout(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("Manual workspace did not render");
    const rect = dialog.getBoundingClientRect();
    if (rect.left < -1 || rect.right > innerWidth + 1 || rect.top < -1 || rect.bottom > innerHeight + 1)
      throw new Error("Manual workspace exceeds the viewport");
    if (document.documentElement.scrollWidth > innerWidth + 1)
      throw new Error("Unexpected horizontal page overflow");
    if (query.has("help")) {
      const info = dialog.querySelector<HTMLButtonElement>('button[aria-label="가리기 안내"]');
      if (!info) throw new Error("Missing scoped help control");
      info.focus();
    }
  }, 1800);
}
void start();
'''

html = ROOT / "src/renderer/manual-redaction-qa.html"
entry = ROOT / "src/renderer/src/manual-redaction-qa.tsx"
assert not html.exists() and not entry.exists(), "Refusing to overwrite an existing QA entry"
checks = []
try:
    html.write_text('<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/manual-redaction-qa.tsx"></script></body></html>', encoding="utf-8")
    entry.write_text(QA, encoding="utf-8")
    for name, width, height, query in [
        ("edit-wide", 1600, 980, ""),
        ("edit-narrow", 1240, 760, ""),
        ("grid-wide", 1600, 980, "?mode=grid"),
        ("help-narrow", 1240, 760, "?help=1"),
    ]:
        args = ["node", "scripts/ui-qa.mjs", "--entry", "manual-redaction-qa.html" + query, "--build-channel", "stable", "--width", str(width), "--height", str(height), "--wait", "2800", "--output", str(OUT / (name + ".png"))]
        try:
            code, text = command(args, 180)
        except subprocess.TimeoutExpired:
            code, text = 124, "UI QA timed out"
        checks.append({"name": name, "exit_code": code})
        print(name + ": " + str(code), flush=True)
        print(text[-10000:], flush=True)
finally:
    html.unlink(missing_ok=True)
    entry.unlink(missing_ok=True)

_, source = command(["git", "rev-parse", "HEAD"])
report = {"source": source.strip(), "run_id": os.environ["GITHUB_RUN_ID"], "ui_checks": checks}
(OUT / "audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

# Only tracked source/config text and npm JavaScript/type declarations are copied.
# No .git directory, credential files, environment files, browser profiles or native tools.
_, listing = command(["git", "ls-files"])
source_extensions = {".ts", ".tsx", ".js", ".cjs", ".mjs", ".json", ".css", ".html", ".md", ".yml", ".yaml", ".py", ".svg"}
package_extensions = {".js", ".cjs", ".mjs", ".json", ".ts", ".map", ".css", ".html"}
with zipfile.ZipFile(OUT / "audit-source.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=4) as archive:
    for raw in listing.splitlines():
        path = ROOT / raw
        if path.suffix not in source_extensions or path.is_symlink() or not path.is_file():
            continue
        if path.stat().st_size > 32 * 1024 * 1024:
            continue
        archive.write(path, "source/" + raw)
    for directory, dirs, files in os.walk(ROOT / "node_modules", followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink() and not (Path(directory) / name).is_junction() and name not in {".cache", ".bin"}]
        for name in files:
            path = Path(directory) / name
            if path.suffix not in package_extensions or path.is_symlink() or path.stat().st_size > 32 * 1024 * 1024:
                continue
            archive.write(path, "source/" + path.relative_to(ROOT).as_posix())
    for name in ["result.json", "eslint.json"]:
        path = ROOT / ".tmp/manual-redaction-check" / name
        if path.exists():
            archive.write(path, "diagnostics/" + name)
print("AUDIT=" + json.dumps(report), flush=True)
raise SystemExit(any(item["exit_code"] for item in checks))
