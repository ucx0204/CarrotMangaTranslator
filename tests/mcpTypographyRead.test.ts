import { expect, it, vi } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import {
  McpFontListOutput,
  McpTypographyPreflightOutput,
  type McpFontEntry,
} from "../src/shared/mcpTypographyRead";
import { McpTypographyReadService } from "../src/main/application/mcpTypographyReadService";
import { createMcpTypographyReadTools } from "../src/main/mcp/mcpTypographyReadTools";
import { mcpToolOutputSchema } from "../src/main/mcp/mcpOutputSchemas";
import { editingChapter } from "./mcpEditing.fixture";

const base = {
  chapterId: "chapter",
  mode: "font-and-size",
  sourceLanguage: "ja",
  targetLanguage: "ko",
};
function fixture() {
  const chapter = editingChapter();
  for (const block of chapter.pages[0].blocks) {
    delete block.generatedLettering;
    block.textRole = "ordinary";
  }
  const fonts: McpFontEntry[] = [
    {
      fontId: "test-font",
      label: "시험 글꼴",
      source: "built-in",
      availability: "available",
      matchingRole: "built-in-candidate",
      locales: ["ko"],
      baseWeight: 400,
      baseItalic: false,
      hidden: false,
      favorite: true,
      defaultFont: true,
    },
    {
      fontId: "hidden-font",
      label: "Hidden",
      source: "custom",
      availability: "unverified",
      matchingRole: "custom-font",
      locales: ["en"],
      baseWeight: null,
      baseItalic: null,
      hidden: true,
      favorite: false,
      defaultFont: false,
    },
  ];
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const readCatalog = vi.fn(async () => ({
    snapshot: hashStableValue(fonts),
    fonts: structuredClone(fonts),
  }));
  const guard = vi.fn();
  const service = new McpTypographyReadService({ openChapter, readCatalog });
  return { chapter, fonts, openChapter, readCatalog, guard, service };
}

it("filters fonts before pagination, validates snapshots and has no file payloads", async () => {
  const f = fixture();
  const result = await f.service.listFonts({}, f.guard);
  expect(result.total).toBe(1);
  expect(result.fonts[0].fontId).toBe("test-font");
  expect(result.notes).toContain(
    "base_face_metrics_only_not_all_supported_weights_or_synthetic_styles",
  );
  expect(McpFontListOutput.safeParse(result).success).toBe(true);
  expect(
    await f.service.listFonts({ includeHidden: true, limit: 1 }, f.guard),
  ).toMatchObject({ total: 2, nextOffset: 1 });
  expect(
    await f.service.listFonts(
      { includeHidden: true, locale: "en", query: "HIDDEN" },
      f.guard,
    ),
  ).toMatchObject({ total: 1, fonts: [{ fontId: "hidden-font" }] });
  expect(await f.service.listFonts({ query: "absent" }, f.guard)).toMatchObject(
    { total: 0, fonts: [] },
  );
  expect(
    await f.service.listFonts(
      { offset: 99, snapshot: result.snapshot },
      f.guard,
    ),
  ).toMatchObject({ fonts: [], nextOffset: null });
  f.fonts[0].hidden = true;
  await expect(
    f.service.listFonts({ snapshot: result.snapshot }, f.guard),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.openChapter).not.toHaveBeenCalled();
});

it("describes the C23 OCR requirement without executing or changing anything", async () => {
  const f = fixture();
  const before = structuredClone(f.chapter);
  const result = await f.service.preflight(base, f.guard);
  expect(result).toMatchObject({
    status: "blocked",
    requiresOcr: true,
    analysisToolAvailable: false,
    executionReserved: false,
  });
  expect(result.blockers).toEqual([
    "font_analysis_requires_explicit_ocr_permission",
  ]);
  expect(result.requiredStages).toEqual([
    "source_size_measurement",
    "hayai_source_verification",
    "c23_font_selection",
  ]);
  expect(result.counts).toEqual({
    pages: 1,
    blocks: 2,
    fontEligible: 2,
    sizeEligible: 2,
  });
  expect(McpTypographyPreflightOutput.safeParse(result).success).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|private|original-a|sourceText|imagePath/,
  );
  expect(f.chapter).toEqual(before);
  const permitted = await f.service.preflight(
    { ...base, allowOcr: true },
    f.guard,
  );
  expect(permitted).toMatchObject({
    status: "inputs_available",
    analysisToolAvailable: false,
  });
  expect(permitted.snapshot).not.toBe(result.snapshot);
  expect(permitted.notChecked).toContain("model_assets_and_downloads");
});

it("keeps size-only analysis independent of OCR and protects manual size", async () => {
  const f = fixture();
  f.chapter.pages[0].blocks[0].fontSizeIntent = "manual";
  f.chapter.pages[0].blocks[0].sourceFontFacePx = 32;
  const result = await f.service.preflight({ ...base, mode: "size" }, f.guard);
  expect(result).toMatchObject({
    status: "inputs_available",
    requiresOcr: false,
    requiredStages: ["source_size_measurement"],
  });
  expect(result.pages[0].blocks[0]).toMatchObject({
    fontExclusion: "not_requested",
    sizeExclusion: "manual_font_size_preserved",
    hasStoredSourceMeasurement: true,
  });
  expect(result.counts).toMatchObject({ fontEligible: 0, sizeEligible: 1 });
  expect(
    (
      await f.service.preflight(
        { ...base, mode: "size", preserveManualFontSize: false },
        f.guard,
      )
    ).counts.sizeEligible,
  ).toBe(2);
  expect(
    (
      await f.service.preflight(
        { ...base, mode: "font", allowOcr: true },
        f.guard,
      )
    ).counts.sizeEligible,
  ).toBe(0);
});

it.each(["empty", "sound", "sfx", "generated"])(
  "excludes %s without rewriting the saved block",
  async (kind) => {
    const f = fixture();
    f.chapter.pages[0].blocks = [f.chapter.pages[0].blocks[0]];
    const b = f.chapter.pages[0].blocks[0];
    if (kind === "empty") b.sourceText = "  ";
    if (kind === "sound") b.textRole = "sound";
    if (kind === "sfx") b.fontRole = "sfx_impact";
    if (kind === "generated")
      b.generatedLettering = {
        version: 1,
        dataUrl: "PRIVATE",
        sourceText: "x",
        translatedText: "y",
      };
    const before = structuredClone(f.chapter);
    const result = await f.service.preflight(
      { ...base, allowOcr: true },
      f.guard,
    );
    expect(result.blockers).toContain("no_eligible_blocks");
    expect(result.requiredStages).toEqual([]);
    expect(f.chapter).toEqual(before);
  },
);

it("reports unsupported font language pairs but accepts independent size inputs", async () => {
  const f = fixture();
  expect(
    (
      await f.service.preflight(
        { ...base, sourceLanguage: "en", allowOcr: true },
        f.guard,
      )
    ).blockers,
  ).toContain("c23_font_analysis_supports_ja_to_ko_only");
  expect(
    (
      await f.service.preflight(
        { ...base, sourceLanguage: "en", targetLanguage: "en", mode: "size" },
        f.guard,
      )
    ).status,
  ).toBe("inputs_available");
});

it("preserves chapter order for reverse selection and binds membership and source revisions", async () => {
  const f = fixture();
  f.chapter.pages.push({
    ...structuredClone(f.chapter.pages[0]),
    id: "second",
  });
  f.chapter.pageOrder.push("second");
  const result = await f.service.preflight(
    { ...base, pageIds: ["second", "page"] },
    f.guard,
  );
  expect(result.pages.map((page) => page.pageId)).toEqual(["page", "second"]);
  const stable = await f.service.preflight(
    { ...base, pageIds: ["second", "page"] },
    f.guard,
  );
  expect(stable.snapshot).toBe(result.snapshot);
  f.chapter.pages[0].blocks[0].sourceText = "changed";
  expect(
    (
      await f.service.preflight(
        { ...base, pageIds: ["second", "page"] },
        f.guard,
      )
    ).snapshot,
  ).not.toBe(result.snapshot);
});

it.each(["work", "order", "page"])(
  "refuses a chapter %s change during preparation",
  async (kind) => {
    const f = fixture();
    f.readCatalog.mockImplementationOnce(async () => {
      if (kind === "work") f.chapter.workId = "moved";
      if (kind === "order")
        f.chapter.pages.push({
          ...structuredClone(f.chapter.pages[0]),
          id: "second",
        });
      if (kind === "page") f.chapter.pages[0].blocks[0].fontSizePx++;
      return { snapshot: hashStableValue(f.fonts), fonts: f.fonts };
    });
    await expect(
      f.service.preflight({ ...base, pageIds: ["page"] }, f.guard),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  },
);

it("refuses missing, repeated, empty and oversized inventories without reading fonts", async () => {
  const f = fixture();
  await expect(
    f.service.preflight({ ...base, chapterId: "wrong" }, f.guard),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    f.service.preflight({ ...base, pageIds: ["missing"] }, f.guard),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    f.service.preflight({ ...base, pageIds: ["page", "page"] }, f.guard),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  f.chapter.pages[0].blocks = Array.from({ length: 1001 }, (_, i) => ({
    ...f.chapter.pages[0].blocks[0],
    id: `b${i}`,
  }));
  await expect(f.service.preflight(base, f.guard)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  f.chapter.pages = [];
  await expect(f.service.preflight(base, f.guard)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  f.chapter.pages = Array.from({ length: 51 }, (_, i) => ({
    ...editingChapter().pages[0],
    id: `p${i}`,
  }));
  await expect(f.service.preflight(base, f.guard)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  expect(f.readCatalog).not.toHaveBeenCalled();
});

it("propagates storage failures and authorization revocation", async () => {
  const f = fixture();
  f.readCatalog.mockRejectedValueOnce(new Error("font storage failed"));
  await expect(f.service.listFonts({}, f.guard)).rejects.toThrow(
    "font storage failed",
  );
  f.openChapter.mockRejectedValueOnce(new Error("chapter storage failed"));
  await expect(f.service.preflight(base, f.guard)).rejects.toThrow(
    "chapter storage failed",
  );
  const denied = () => {
    throw new Error("revoked");
  };
  await expect(f.service.listFonts({}, denied)).rejects.toThrow("revoked");
  await expect(f.service.preflight(base, denied)).rejects.toThrow("revoked");
  f.readCatalog.mockImplementationOnce(async () => {
    f.guard.mockImplementation(() => {
      throw new Error("revoked");
    });
    return { snapshot: hashStableValue(f.fonts), fonts: f.fonts };
  });
  await expect(f.service.preflight(base, f.guard)).rejects.toThrow("revoked");
});

it("registers actual read-only tools with schemas, scope enforcement and strict arguments", async () => {
  const f = fixture();
  const tools = createMcpTypographyReadTools(f.service);
  const context = {
    principalId: "owner",
    assertAuthorized: vi.fn(),
    assertScopes: vi.fn(),
  };
  for (const tool of tools) {
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    expect(tool.requiredScopes).toEqual(["carrot.read"]);
    expect(mcpToolOutputSchema(tool.name)).toBeDefined();
    await expect(tool.invoke({}, undefined)).rejects.toMatchObject({
      code: "access_denied",
    });
    await expect(tool.invoke({ badField: true }, context)).rejects.toThrow();
  }
  const fonts = await tools[0].invoke({}, context);
  const plan = await tools[1].invoke(base, context);
  expect(fonts.every((item) => item.type === "text")).toBe(true);
  expect(plan.every((item) => item.type === "text")).toBe(true);
  expect(context.assertScopes).toHaveBeenCalledWith(["carrot.read"]);
});

it("binds raw pageOrder changes and normalizes equivalent page selections", async () => {
  const f = fixture();
  const implicit = await f.service.preflight(base, f.guard);
  const explicit = await f.service.preflight(
    { ...base, pageIds: ["page"] },
    f.guard,
  );
  expect(explicit.snapshot).toBe(implicit.snapshot);
  f.chapter.pageOrder = ["other", "page"];
  expect((await f.service.preflight(base, f.guard)).snapshot).not.toBe(
    implicit.snapshot,
  );
});

it("refuses ambiguous stored page and block identifiers", async () => {
  const f = fixture();
  f.chapter.pages.push(structuredClone(f.chapter.pages[0]));
  await expect(f.service.preflight(base, f.guard)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  f.chapter.pages.pop();
  f.chapter.pages[0].blocks.push(structuredClone(f.chapter.pages[0].blocks[0]));
  await expect(f.service.preflight(base, f.guard)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  expect(f.readCatalog).not.toHaveBeenCalled();
});

it("advertises only the actually connected one-page size execution", async () => {
  const f = fixture();
  const service = new McpTypographyReadService({
    openChapter: f.openChapter,
    readCatalog: f.readCatalog,
    sourceSizeToolAvailable: true,
  });
  expect(
    await service.preflight({ ...base, mode: "size" }, f.guard),
  ).toMatchObject({
    analysisToolAvailable: true,
    analysisTool: "carrot_run_page_source_size",
  });
  expect(
    await service.preflight({ ...base, mode: "font", allowOcr: true }, f.guard),
  ).toMatchObject({
    analysisToolAvailable: false,
    analysisTool: null,
  });
  f.chapter.pages.push({
    ...structuredClone(f.chapter.pages[0]),
    id: "second",
  });
  f.chapter.pageOrder.push("second");
  expect(
    await service.preflight({ ...base, mode: "size" }, f.guard),
  ).toMatchObject({
    analysisToolAvailable: false,
    analysisTool: null,
  });
});

it("does not advertise unsupported manual-size overrides as executable", async () => {
  const f = fixture();
  const service = new McpTypographyReadService({
    openChapter: f.openChapter,
    readCatalog: f.readCatalog,
    sourceSizeToolAvailable: true,
  });
  expect(
    await service.preflight(
      { ...base, mode: "size", preserveManualFontSize: false },
      f.guard,
    ),
  ).toMatchObject({
    analysisToolAvailable: false,
    analysisTool: null,
  });
});
