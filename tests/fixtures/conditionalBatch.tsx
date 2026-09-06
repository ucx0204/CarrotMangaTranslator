import React from "react";
import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { createTestMangaGatewayStub } from "../../src/renderer/src/api/mangaGateway";
import { conditionalBatchGateway } from "../../src/renderer/src/api/conditionalBatchGateway";
import { useConditionalBatchSchemeController } from "../../src/renderer/src/components/useConditionalBatchSchemeController";
import { FontsContext } from "../../src/renderer/src/fonts/fontsContextValue";
import {
  DEFAULT_BLOCK_FONT_CATALOG,
  getBaseBlockFontOptions,
  getBlockFontOptions,
} from "../../src/renderer/src/lib/fonts";
import {
  createBlankBatchSchemeDraft,
  type ConditionalBatchSchemeDraftV2,
  type ConditionalBatchSnapshotV2,
} from "../../src/shared/conditionalBatchRules";
import type { ChapterSnapshot } from "../../src/shared/libraryTypes";
import type { TranslationBlock } from "../../src/shared/textTypes";

function batchBlock(id: string): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    sourceText: "原文",
    translatedText: "번역문",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 20,
    lineHeight: 1.3,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

export function batchChapter(): ChapterSnapshot {
  const time = "2026-09-06T00:00:00.000Z";
  const blocks = [batchBlock("b1"), batchBlock("b2")];
  return {
    id: "chapter",
    workId: "work",
    title: "synthetic",
    sourceKind: "images",
    status: "completed",
    pageOrder: ["page"],
    createdAt: time,
    updatedAt: time,
    pages: [
      {
        id: "page",
        name: "synthetic.png",
        imagePath: "C:/qa/synthetic.png",
        dataUrl:
          "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='1000' height='1600'/>",
        width: 1000,
        height: 1600,
        blocks,
        blockOrder: blocks.map((b) => b.id),
        analysisStatus: "completed",
        createdAt: time,
        updatedAt: time,
      },
    ],
  };
}

export function sizeDraft(size = 30): ConditionalBatchSchemeDraftV2 {
  return {
    ...createBlankBatchSchemeDraft(),
    name: "글자 키우기",
    actions: [
      {
        id: "size",
        enabled: true,
        type: "setFields",
        changes: [{ field: "fontSizePx", operation: "set", value: size }],
      },
    ],
  };
}

function batchSnapshot(): ConditionalBatchSnapshotV2 {
  return {
    schemaVersion: 1,
    schemes: [{ id: "saved", ...sizeDraft() }],
    sequences: ["seq-a", "seq-b"].map((id) => ({
      id,
      name: id,
      description: "",
      steps: [{ id: "step", schemeId: "saved", enabled: true }],
    })),
  };
}

export function BatchFonts({ children }: { children: React.ReactNode }) {
  return (
    <FontsContext.Provider
      value={{
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        baseOptions: getBaseBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG),
        options: getBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG),
        busy: false,
        ready: true,
        registerFont: async () => {},
        removeFont: async () => {},
        savePreferences: async () => {},
      }}
    >
      {children}
    </FontsContext.Provider>
  );
}

export function installBatchGateway(initial = batchSnapshot()) {
  let stored = structuredClone(initial);
  const save = vi.fn<typeof conditionalBatchGateway.saveConditionalBatchScheme>(
    async ({ id, scheme }) => {
      stored = {
        ...stored,
        schemes: [
          { id: id ?? "new-id", ...scheme },
          ...stored.schemes.filter((s) => s.id !== id),
        ],
      };
      return stored;
    },
  );
  const remove = vi.fn<
    typeof conditionalBatchGateway.deleteConditionalBatchScheme
  >(async (id) => {
    stored = { ...stored, schemes: stored.schemes.filter((s) => s.id !== id) };
    return stored;
  });
  const importYaml = vi.fn<
    typeof conditionalBatchGateway.importConditionalBatchYaml
  >(async () => stored);
  const saveSequence = vi.fn<
    typeof conditionalBatchGateway.saveConditionalBatchSequence
  >(async (sequence) => {
    stored = {
      ...stored,
      sequences: [
        ...stored.sequences.filter((s) => s.id !== sequence.id),
        sequence,
      ],
    };
    return stored;
  });
  const exportYaml = vi.fn<
    typeof conditionalBatchGateway.exportConditionalBatchYaml
  >(async () => "saved yaml");
  Object.defineProperty(window, "mangaApi", {
    configurable: true,
    value: createTestMangaGatewayStub({
      listConditionalBatchSchemes: async () => stored,
      saveConditionalBatchScheme: save,
      deleteConditionalBatchScheme: remove,
      importConditionalBatchYaml: importYaml,
      saveConditionalBatchSequence: saveSequence,
      exportConditionalBatchYaml: exportYaml,
      saveConditionalBatchYamlFile: async () => null,
    }),
  });
  return {
    save,
    remove,
    importYaml,
    saveSequence,
    exportYaml,
    get stored() {
      return stored;
    },
    set stored(next: ConditionalBatchSnapshotV2) {
      stored = next;
    },
  };
}

export async function settleBatch() {
  await act(async () => {
    await Promise.resolve();
  });
}

export async function savedBatchController(id = "saved") {
  const hook = renderHook(() => useConditionalBatchSchemeController());
  await settleBatch();
  await act(async () => {
    hook.result.current.selectScheme(id);
  });
  return hook;
}
