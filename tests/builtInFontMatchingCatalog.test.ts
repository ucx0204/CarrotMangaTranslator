import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadBuiltInFontMatchingCandidates,
  loadBuiltInFontMatchingCandidatesWith,
  type BuiltInFontMatchingCatalogDependencies,
} from "../src/main/builtInFontMatchingCatalog";
import { type CustomFontInspection } from "../src/main/customFontInspection";
import { fontCandidateSupportsText } from "../src/main/fontCoverage";
import { fontCandidateSupportsBodyLocale } from "../src/main/pipeline/automaticFontBodyCoverage";
import {
  BUILT_IN_BLOCK_FONTS,
  isRetiredBuiltInBlockFontId,
} from "../src/shared/blockFontCatalog";
import type { UiLocale } from "../src/shared/uiLocales";

const tempDirs: string[] = [];
const TEST_INSPECTION: CustomFontInspection = {
  supportedLocales: ["en"],
  unicodeRanges: [[0x20, 0x7e]],
  weight: 500,
  width: 4,
  italic: false,
  serif: false,
};

describe("built-in font matching catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (path) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  it("inspects only the requested locale and emits deterministic metadata", () => {
    const root = makeTempDir();
    writeLocaleAssets(root, "en", false);
    const dependencies = makeDependencies(root);

    const candidates = loadBuiltInFontMatchingCandidatesWith(
      "en",
      dependencies,
    );

    expect(candidates.map((candidate) => candidate.fontId)).toEqual([
      "comic-neue",
      "kalam",
      "bangers",
      "luckiest-guy",
      "permanent-marker",
      "freckle-face",
    ]);
    expect(candidates.map((candidate) => candidate.preferenceRank)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(candidates[0]).toMatchObject({
      source: "built-in",
      label: "Comic Neue",
      supportedLocales: ["en"],
      weight: 500,
      width: 4,
      favorite: false,
      defaultFont: false,
    });
    expect(dependencies.inspectFontBuffer).toHaveBeenCalledTimes(6);
    expect(dependencies.reportWarning).not.toHaveBeenCalled();
  });

  it("falls back from a missing source root to flattened hashed assets", () => {
    const missingRoot = makeTempDir();
    const packagedRoot = makeTempDir();
    writeLocaleAssets(packagedRoot, "ja", true);
    const dependencies = makeDependencies(packagedRoot, [
      join(missingRoot, "not-present"),
      packagedRoot,
    ]);

    const candidates = loadBuiltInFontMatchingCandidatesWith(
      "ja",
      dependencies,
    );

    expect(candidates).toHaveLength(6);
    expect(candidates.map((candidate) => candidate.fontId)).toEqual([
      "yusei-magic",
      "mochiy-pop-one",
      "hachi-maru-pop",
      "dela-gothic-one",
      "reggae-one",
      "dot-gothic-16",
    ]);
    expect(dependencies.readFontFile).toHaveBeenCalledWith(
      expect.stringMatching(/yusei-magic-TestHash\.ttf$/),
    );
    expect(dependencies.reportWarning).not.toHaveBeenCalled();
  });

  it("maps every catalog entry to the regular source-tree asset", () => {
    const sourceRoot = resolve(__dirname, "../src/renderer/src/assets/fonts");
    const dependencies = makeDependencies(sourceRoot);
    vi.mocked(dependencies.readFontFile).mockReturnValue(Buffer.alloc(12));
    const locales: readonly UiLocale[] = [
      "ko",
      "en",
      "ja",
      "zh-Hans",
      "zh-Hant",
    ];

    const candidates = locales.flatMap((locale) =>
      loadBuiltInFontMatchingCandidatesWith(locale, dependencies),
    );

    expect(candidates.map((candidate) => candidate.fontId)).toEqual(
      BUILT_IN_BLOCK_FONTS.filter(
        (font) => !isRetiredBuiltInBlockFontId(font.id),
      ).map((font) => font.id),
    );
    expect(dependencies.reportWarning).not.toHaveBeenCalled();
  });

  it("warns for a corrupt font and continues inspecting its siblings", () => {
    const root = makeTempDir();
    const written = writeLocaleAssets(root, "zh-Hant", false);
    const corruptPath = written.get("iansui");
    expect(corruptPath).toBeDefined();
    const dependencies = makeDependencies(root);
    vi.mocked(dependencies.inspectFontBuffer).mockImplementation((buffer) => {
      if (buffer.toString("utf8").includes("iansui")) {
        throw new Error("corrupt cmap");
      }
      return TEST_INSPECTION;
    });

    const candidates = loadBuiltInFontMatchingCandidatesWith(
      "zh-Hant",
      dependencies,
    );

    expect(candidates).toHaveLength(5);
    expect(candidates.some((candidate) => candidate.fontId === "iansui")).toBe(
      false,
    );
    expect(dependencies.reportWarning).toHaveBeenCalledTimes(1);
    expect(dependencies.reportWarning).toHaveBeenCalledWith(
      "Built-in font auto-match inspection failed",
      expect.objectContaining({
        fontId: "iansui",
        label: "Iansui",
        locale: "zh-Hant",
        error: expect.any(Error),
      }),
    );
  });

  it("reuses in-memory inspections until the resolved file stat changes", () => {
    const root = makeTempDir();
    const written = writeLocaleAssets(root, "zh-Hans", false);
    const dependencies = makeDependencies(root);

    loadBuiltInFontMatchingCandidatesWith("zh-Hans", dependencies);
    loadBuiltInFontMatchingCandidatesWith("zh-Hans", dependencies);

    expect(dependencies.inspectFontBuffer).toHaveBeenCalledTimes(6);

    const changedPath = written.get("long-cang");
    if (!changedPath) {
      throw new Error("Expected long-cang test asset.");
    }
    writeFileSync(changedPath, Buffer.from("long-cang-font-changed"));
    loadBuiltInFontMatchingCandidatesWith("zh-Hans", dependencies);

    expect(dependencies.inspectFontBuffer).toHaveBeenCalledTimes(7);
  });

  it("inspects the shipped Korean faces and rejects a preferred SFX face that lacks the actual punctuation", () => {
    const reportWarning = vi.fn();

    const candidates = loadBuiltInFontMatchingCandidates("ko", reportWarning);
    const startOver = candidates.find(
      (candidate) => candidate.fontId === "start-over",
    );
    const dohyeon = candidates.find(
      (candidate) => candidate.fontId === "dohyeon",
    );
    const ridiBatang = candidates.find(
      (candidate) => candidate.fontId === "ridi-batang",
    );

    expect(candidates).toHaveLength(21);
    expect(reportWarning).not.toHaveBeenCalled();
    expect(startOver && fontCandidateSupportsText(startOver, "슥…")).toBe(
      false,
    );
    expect(dohyeon && fontCandidateSupportsText(dohyeon, "슥…")).toBe(true);
    expect(
      ridiBatang && fontCandidateSupportsBodyLocale(ridiBatang, "ko"),
    ).toBe(true);
  });

  it.each([
    ["ko", "nanum-barun-gothic"],
    ["en", "comic-neue"],
    ["ja", "yusei-magic"],
    ["zh-Hans", "zcool-xiaowei"],
    ["zh-Hant", "lxgw-wenkai-tc"],
  ] as const)(
    "ships at least one complete %s body face",
    (locale, expectedFontId) => {
      const reportWarning = vi.fn();
      const candidates = loadBuiltInFontMatchingCandidates(
        locale,
        reportWarning,
      );

      expect(reportWarning).not.toHaveBeenCalled();
      expect(
        candidates
          .filter((candidate) =>
            fontCandidateSupportsBodyLocale(candidate, locale),
          )
          .map((candidate) => candidate.fontId),
      ).toContain(expectedFontId);
    },
  );
});

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "manga-built-in-font-"));
  tempDirs.push(path);
  return path;
}

function makeDependencies(
  root: string,
  assetRoots: readonly string[] = [root],
): BuiltInFontMatchingCatalogDependencies {
  return {
    assetRoots,
    inspectFontBuffer: vi.fn(() => TEST_INSPECTION),
    readDirectory: vi.fn((path: string) => readdirSync(path)),
    readFontFile: vi.fn((path: string) => readFileSync(path)),
    reportWarning: vi.fn(),
    statFontFile: vi.fn((path: string) => statSync(path)),
  };
}

function writeLocaleAssets(
  root: string,
  locale: UiLocale,
  hashed: boolean,
): Map<string, string> {
  const written = new Map<string, string>();
  for (const font of BUILT_IN_BLOCK_FONTS.filter(
    (candidate) => candidate.locale === locale,
  )) {
    const relativePath = resolveTestRelativePath(font.id);
    const extension = extname(relativePath);
    const fileName = hashed
      ? `${basename(relativePath, extension)}-TestHash${extension}`
      : relativePath;
    const path = join(root, fileName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(`${font.id}-font-payload`));
    written.set(font.id, path);
  }
  return written;
}

function resolveTestRelativePath(fontId: string): string {
  const regularOverrides: Readonly<Record<string, string>> = {
    "nanum-gothic": "nanum-gothic-regular.ttf",
    "nanum-myeongjo": "nanum-myeongjo-regular.ttf",
    "nanum-barun-gothic": "nanum-barun-gothic-regular.ttf",
    "seoul-namsan": "seoul-namsan-regular.ttf",
    "seoul-hangang": "seoul-hangang-regular.ttf",
    gaegu: "gaegu-regular.ttf",
    "ridi-batang": "ridi-batang.otf",
  };
  const fileName = regularOverrides[fontId] ?? `${fontId}.ttf`;
  if (
    [
      "dohyeon",
      "ridi-batang",
      "cafe24-gowoonbam",
      "start-over",
      "jua",
      "gaegu",
      "black-and-white-picture",
      "black-han-sans",
      "gasoek-one",
      "kirang-haerang",
      "nanum-brush-script",
      "single-day",
    ].includes(fontId)
  ) {
    return join("ko", fileName);
  }
  if (
    [
      "comic-neue",
      "kalam",
      "bangers",
      "luckiest-guy",
      "permanent-marker",
      "freckle-face",
    ].includes(fontId)
  ) {
    return join("en", fileName);
  }
  if (
    [
      "yusei-magic",
      "mochiy-pop-one",
      "hachi-maru-pop",
      "dela-gothic-one",
      "reggae-one",
      "dot-gothic-16",
    ].includes(fontId)
  ) {
    return join("ja", fileName);
  }
  if (
    [
      "zcool-kuaile",
      "zcool-qingke-huangyou",
      "zcool-xiaowei",
      "ma-shan-zheng",
      "long-cang",
      "liu-jian-mao-cao",
    ].includes(fontId)
  ) {
    return join("zh-hans", fileName);
  }
  if (
    [
      "huninn",
      "iansui",
      "lxgw-wenkai-tc",
      "lxgw-marker-gothic",
      "chenyu-luoyan",
      "cubic-11",
    ].includes(fontId)
  ) {
    return join("zh-hant", fileName);
  }
  return fileName;
}
