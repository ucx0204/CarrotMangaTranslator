import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tempDirs: string[] = [];

describe("custom font index validation", () => {
  afterEach(async () => {
    vi.resetModules();
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
    await writeFile(join(fontsDir, `${validId}.ttf`), "font");
    await writeFile(outsidePath, "outside");
    await writeFile(
      join(fontsDir, "index.json"),
      JSON.stringify([
        {
          id: validId,
          label: "Valid",
          family: `MGTUser-${validId}`,
          fileName: `${validId}.ttf`
        },
        {
          id: traversalId,
          label: "Traversal",
          family: `MGTUser-${traversalId}`,
          fileName: "../outside.otf"
        },
        {
          id: "not-a-uuid",
          label: "Bad id",
          family: "MGTUser-not-a-uuid",
          fileName: "not-a-uuid.ttf"
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          label: "Bad extension",
          family: "MGTUser-33333333-3333-4333-8333-333333333333",
          fileName: "33333333-3333-4333-8333-333333333333.woff"
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          label: "Mismatched family",
          family: "InjectedFamily",
          fileName: "44444444-4444-4444-8444-444444444444.otf"
        }
      ]),
      "utf8"
    );
    const customFonts = await loadCustomFonts(rootDir);

    expect(customFonts.listCustomFonts()).toEqual([
      {
        id: validId,
        label: "Valid",
        family: `MGTUser-${validId}`,
        fileName: `${validId}.ttf`
      }
    ]);
    expect(resolve(customFonts.resolveCustomFontFilePath(validId) ?? "")).toBe(resolve(join(fontsDir, `${validId}.ttf`)));
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
          fileName: "../outside.otf"
        }
      ]),
      "utf8"
    );
    const customFonts = await loadCustomFonts(rootDir);

    expect(customFonts.removeCustomFont(traversalId)).toEqual([]);
    expect(existsSync(outsidePath)).toBe(true);
  });
});

async function createTempRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-custom-fonts-"));
  tempDirs.push(rootDir);
  return rootDir;
}

async function loadCustomFonts(rootDir: string): Promise<typeof import("../src/main/customFonts")> {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      fontsDir: join(rootDir, "fonts")
    })
  }));
  vi.doMock("../src/main/logger", () => ({
    logError: vi.fn()
  }));
  return import("../src/main/customFonts");
}
