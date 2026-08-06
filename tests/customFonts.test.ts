import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCustomFontLibrary,
  type CustomFontLibrary,
} from "../src/main/customFonts";
import { resolveBundledFontFilePath } from "../src/main/bundledFontResolver";

// resolveBundledFontFilePath는 getAppPaths()를 통해 isPackaged/repoRoot를 읽는다.
// vitest 환경은 패키짭이 아니므로 isPackaged:false로 두면 dev 자산 경로(소스
// 트리 내 assets/fonts)로 해석된다(#53).
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "C:\\unused-app-data",
  },
}));

const tempDirs: string[] = [];

describe("custom font index validation", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps only UUID-backed basename font files inside the fonts directory", async () => {
    const rootDir = await createTempRoot();
    const fontsDir = join(rootDir, "fonts");
    await mkdir(fontsDir, { recursive: true });
    const validId = "11111111-1111-4111-8111-111111111111";
    const traversalId = "22222222-2222-4222-8222-222222222222";
    const outsidePath = join(rootDir, "outside.otf");
    await writeFile(join(fontsDir, `${validId}.ttf`), makeTinyTtfBytes());
    await writeFile(outsidePath, "outside");
    await writeFile(
      join(fontsDir, "index.json"),
      JSON.stringify([
        {
          id: validId,
          label: "Valid",
          family: `MGTUser-${validId}`,
          fileName: `${validId}.ttf`,
        },
        {
          id: traversalId,
          label: "Traversal",
          family: `MGTUser-${traversalId}`,
          fileName: "../outside.otf",
        },
        {
          id: "not-a-uuid",
          label: "Bad id",
          family: "MGTUser-not-a-uuid",
          fileName: "not-a-uuid.ttf",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          label: "Bad extension",
          family: "MGTUser-33333333-3333-4333-8333-333333333333",
          fileName: "33333333-3333-4333-8333-333333333333.woff",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          label: "Mismatched family",
          family: "InjectedFamily",
          fileName: "44444444-4444-4444-8444-444444444444.otf",
        },
      ]),
      "utf8",
    );
    const customFonts = await loadCustomFonts(rootDir);

    expect(customFonts.listCustomFonts()).toEqual([
      {
        id: validId,
        label: "Valid",
        family: `MGTUser-${validId}`,
        fileName: `${validId}.ttf`,
      },
    ]);
    expect(resolve(customFonts.resolveCustomFontFilePath(validId) ?? "")).toBe(
      resolve(join(fontsDir, `${validId}.ttf`)),
    );
    expect(customFonts.resolveCustomFontFilePath(traversalId)).toBeNull();
    expect(existsSync(outsidePath)).toBe(true);
  });

  it("does not delete outside files referenced by a tampered index entry", async () => {
    const rootDir = await createTempRoot();
    const fontsDir = join(rootDir, "fonts");
    await mkdir(fontsDir, { recursive: true });
    const traversalId = "55555555-5555-4555-8555-555555555555";
    const outsidePath = join(rootDir, "outside.otf");
    await writeFile(outsidePath, "outside");
    await writeFile(
      join(fontsDir, "index.json"),
      JSON.stringify([
        {
          id: traversalId,
          label: "Traversal",
          family: `MGTUser-${traversalId}`,
          fileName: "../outside.otf",
        },
      ]),
      "utf8",
    );
    const customFonts = await loadCustomFonts(rootDir);

    expect(customFonts.removeCustomFont(traversalId)).toEqual([]);
    expect(existsSync(outsidePath)).toBe(true);
  });

  it("normalizes known IDs, deduplicates entries, and saves preferences atomically", async () => {
    const rootDir = await createTempRoot();
    const fontsDir = join(rootDir, "fonts");
    await mkdir(fontsDir, { recursive: true });
    const customId = "66666666-6666-4666-8666-666666666666";
    await writeFile(join(fontsDir, `${customId}.ttf`), makeTinyTtfBytes());
    await writeFile(
      join(fontsDir, "index.json"),
      JSON.stringify([
        {
          id: customId,
          label: "Custom",
          family: `MGTUser-${customId}`,
          fileName: `${customId}.ttf`,
        },
      ]),
      "utf8",
    );
    await writeFile(
      join(fontsDir, "preferences.json"),
      JSON.stringify({
        favoriteIds: ["default", customId, "default", "unknown"],
        orderedIds: [customId, "kalam", customId, "unknown"],
        defaultFontId: customId,
      }),
      "utf8",
    );
    const customFonts = await loadCustomFonts(rootDir);

    expect(customFonts.readFontPreferences()).toEqual({
      favoriteIds: ["default", customId],
      orderedIds: [customId, "kalam"],
      defaultFontId: customId,
    });
    customFonts.saveFontPreferences({
      favoriteIds: ["kalam", "kalam", "missing"],
      orderedIds: ["default", "kalam", "missing"],
      defaultFontId: "missing",
    });

    expect(
      JSON.parse(await readFile(join(fontsDir, "preferences.json"), "utf8")),
    ).toEqual({
      favoriteIds: ["kalam"],
      orderedIds: ["default", "kalam"],
      defaultFontId: "default",
    });
    expect(
      (await readdir(fontsDir)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("normalizes retired Gugi preferences out of loaded and saved values", async () => {
    const rootDir = await createTempRoot();
    const fontsDir = join(rootDir, "fonts");
    await mkdir(fontsDir, { recursive: true });
    await writeFile(
      join(fontsDir, "preferences.json"),
      JSON.stringify({
        favoriteIds: ["gugi", "kalam"],
        orderedIds: ["gugi", "kalam"],
        defaultFontId: "gugi",
      }),
      "utf8",
    );
    const customFonts = await loadCustomFonts(rootDir);

    expect(customFonts.readFontPreferences()).toEqual({
      favoriteIds: ["kalam"],
      orderedIds: ["kalam"],
      defaultFontId: "default",
    });

    customFonts.saveFontPreferences({
      favoriteIds: ["gugi", "kalam"],
      orderedIds: ["gugi", "kalam"],
      defaultFontId: "gugi",
    });
    expect(
      JSON.parse(await readFile(join(fontsDir, "preferences.json"), "utf8")),
    ).toEqual({
      favoriteIds: ["kalam"],
      orderedIds: ["kalam"],
      defaultFontId: "default",
    });
  });

  it("removes a deleted custom font from favorites, ordering, and the global default", async () => {
    const rootDir = await createTempRoot();
    const fontsDir = join(rootDir, "fonts");
    await mkdir(fontsDir, { recursive: true });
    const customId = "77777777-7777-4777-8777-777777777777";
    await writeFile(join(fontsDir, `${customId}.ttf`), makeTinyTtfBytes());
    await writeFile(
      join(fontsDir, "index.json"),
      JSON.stringify([
        {
          id: customId,
          label: "Delete me",
          family: `MGTUser-${customId}`,
          fileName: `${customId}.ttf`,
        },
      ]),
      "utf8",
    );
    await writeFile(
      join(fontsDir, "preferences.json"),
      JSON.stringify({
        favoriteIds: [customId, "default"],
        orderedIds: [customId, "default"],
        defaultFontId: customId,
      }),
      "utf8",
    );
    const customFonts = await loadCustomFonts(rootDir);

    expect(customFonts.removeCustomFont(customId)).toEqual([]);
    expect(customFonts.readFontPreferences()).toEqual({
      favoriteIds: ["default"],
      orderedIds: ["default"],
      defaultFontId: "default",
    });
  });

  it("reports a corrupt index once and returns an empty catalog", async () => {
    const rootDir = await createTempRoot();
    const fontsDir = join(rootDir, "fonts");
    await mkdir(fontsDir, { recursive: true });
    await writeFile(join(fontsDir, "index.json"), "{broken", "utf8");
    const reportError = vi.fn();
    const customFonts = createTestCustomFonts(rootDir, reportError);

    expect(customFonts.listCustomFonts()).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      "Failed to read custom fonts index",
      expect.any(SyntaxError),
    );
  });
});

async function createTempRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-custom-fonts-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function loadCustomFonts(rootDir: string): Promise<CustomFontLibrary> {
  return Promise.resolve(createTestCustomFonts(rootDir, vi.fn()));
}

function createTestCustomFonts(
  rootDir: string,
  reportError: (message: string, error: unknown) => void,
): CustomFontLibrary {
  return createCustomFontLibrary({
    getFontsDirectory: () => join(rootDir, "fonts"),
    reportError,
  });
}

function makeTinyTtfBytes(): Buffer {
  return Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

describe("resolveBundledFontFilePath", () => {
  const repoRoot = resolve(__dirname, "..");
  const fontsDir = join(repoRoot, "src", "renderer", "src", "assets", "fonts");

  it("resolves an existing built-in font at the assets root", () => {
    expect(resolveBundledFontFilePath("mongtori.ttf")).toBe(
      join(fontsDir, "mongtori.ttf"),
    );
  });

  it("resolves built-in fonts nested under a locale subdirectory", () => {
    expect(resolveBundledFontFilePath("ko/dohyeon.ttf")).toBe(
      join(fontsDir, "ko", "dohyeon.ttf"),
    );
    expect(resolveBundledFontFilePath("zh-hant/cubic-11.ttf")).toBe(
      join(fontsDir, "zh-hant", "cubic-11.ttf"),
    );
  });

  it("returns null for a missing font", () => {
    expect(resolveBundledFontFilePath("does-not-exist.ttf")).toBeNull();
  });

  it("returns null for path traversal escapes", () => {
    expect(resolveBundledFontFilePath("../package.json")).toBeNull();
    expect(resolveBundledFontFilePath("../../package.json")).toBeNull();
  });

  it("returns null for an unsupported extension", () => {
    expect(resolveBundledFontFilePath("mongtori.txt")).toBeNull();
  });

  it("returns null for a nul-byte or empty rel", () => {
    expect(resolveBundledFontFilePath("")).toBeNull();
    expect(resolveBundledFontFilePath("mo\0ngtori.ttf")).toBeNull();
  });
});
