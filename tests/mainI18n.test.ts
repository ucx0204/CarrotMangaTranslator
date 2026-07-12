import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMainLocale,
  initializeMainLocaleFromSettings,
  setMainLocale,
  tMain,
  tMainCommon,
} from "../src/main/i18n";

const tempDirs: string[] = [];

afterEach(async () => {
  setMainLocale("ko");
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("main-process i18n", () => {
  it("switches native UI translations synchronously", () => {
    setMainLocale("en");
    expect(getMainLocale()).toBe("en");
    expect(tMain("dialogs.openImages")).toBe("Open Images");
    expect(tMainCommon("panel.editorTitle")).toBe("Block Editor");
    expect(tMain("dialogs.filters.images")).toBe("Image files");
    expect(tMain("import.defaultWorkTitle")).toBe("Untitled Work");
  });

  it("loads a saved locale without loading the full settings stack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mgt-i18n-"));
    tempDirs.push(dir);
    const settingsPath = join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ ui: { locale: "zh-Hant" } }),
      "utf8",
    );
    await initializeMainLocaleFromSettings(settingsPath, "en-US");
    expect(getMainLocale()).toBe("zh-Hant");
    expect(tMain("dialogs.saveText")).toBe("儲存文字");
  });

  it("uses the Windows locale when settings have no locale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mgt-i18n-"));
    tempDirs.push(dir);
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, "{}", "utf8");
    await initializeMainLocaleFromSettings(settingsPath, "ja-JP");
    expect(getMainLocale()).toBe("ja");
  });
});
