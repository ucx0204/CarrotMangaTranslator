/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useConditionalBatchEditorModel,
  type ConditionalBatchEditorModelProps,
} from "../src/renderer/src/components/useConditionalBatchEditorModel";
import { useConditionalBatchSchemeController } from "../src/renderer/src/components/useConditionalBatchSchemeController";
import { useConditionalBatchSequenceEditor } from "../src/renderer/src/components/useConditionalBatchSequenceEditor";
import { ConditionalBatchRulePanel } from "../src/renderer/src/components/ConditionalBatchRulePanel";
import { applyConditionalBatchSequencePreview } from "../src/shared/conditionalBatchEngine";
import {
  batchChapter,
  BatchFonts,
  installBatchGateway,
  settleBatch,
  sizeDraft,
} from "./fixtures/conditionalBatch";

let gateway: ReturnType<typeof installBatchGateway>;
beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  gateway = installBatchGateway();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        measureText: (text: string) => ({ width: [...text].length * 10 }),
      }) as never,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "mangaApi");
});

async function renderModel() {
  const chapter = batchChapter();
  const onApplySequence = vi.fn<
    NonNullable<ConditionalBatchEditorModelProps["onApplySequence"]>
  >((sequence, snapshot, preview, excluded, options) =>
    applyConditionalBatchSequencePreview(
      chapter,
      sequence,
      snapshot,
      preview,
      excluded,
      undefined,
      options,
    ),
  );
  const props = {
    chapter,
    selectedPageId: "page",
    workspaceProps: {} as ConditionalBatchEditorModelProps["workspaceProps"],
    busy: false,
    canUndo: false,
    undoLabel: null,
    onApply: vi.fn(),
    onApplySequence,
    onClose: vi.fn(),
    onSelectPage: vi.fn(),
    onUndo: async () => false,
  } satisfies ConditionalBatchEditorModelProps;
  const hook = renderHook(() => useConditionalBatchEditorModel(props), {
    wrapper: BatchFonts,
  });
  await settleBatch();
  await act(async () => {
    hook.result.current.rulePanelProps.onSelectScheme("saved");
  });
  return { ...hook, onApplySequence };
}

it("keeps exclusions separate for each sequence and restores them on return", async () => {
  const h = await renderModel();
  await act(async () => {
    h.result.current.rulePanelProps.onPreviewSequence("seq-a");
  });
  const key = h.result.current.resultsProps.preview.results[0].key;
  act(() => h.result.current.resultsProps.onToggleResult(key, false));
  expect(h.result.current.footerProps.includedCount).toBe(1);
  act(() => h.result.current.rulePanelProps.onExitSequence());
  expect(h.result.current.footerProps.includedCount).toBe(2);
  await act(async () => {
    h.result.current.rulePanelProps.onPreviewSequence("seq-b");
  });
  expect(h.result.current.footerProps.includedCount).toBe(2);
  act(() => h.result.current.footerProps.onApply());
  expect(h.onApplySequence.mock.results[0].value.appliedCount).toBe(2);
  act(() => h.result.current.rulePanelProps.onExitSequence());
  await act(async () => {
    h.result.current.rulePanelProps.onPreviewSequence("seq-a");
  });
  expect(h.result.current.resultsProps.excludedResultKeys.has(key)).toBe(true);
  expect(h.result.current.footerProps.includedCount).toBe(1);
});

it("applies the newly edited rule when entering a sequence before the debounce", async () => {
  const h = await renderModel();
  act(() => h.result.current.rulePanelProps.onChangeDraft(sizeDraft(44)));
  await act(async () => {
    h.result.current.rulePanelProps.onPreviewSequence("seq-a");
  });
  expect(
    h.result.current.resultsProps.preview.results.every(
      (r) => r.afterBlock.fontSizePx === 44,
    ),
  ).toBe(true);
  act(() => h.result.current.footerProps.onApply());
  expect(h.onApplySequence.mock.calls[0][1].schemes[0].actions).toEqual(
    sizeDraft(44).actions,
  );
  expect(h.onApplySequence.mock.results[0].value.appliedCount).toBe(2);
});

it("does not enter or apply an old sequence while saving the edit fails", async () => {
  const h = await renderModel();
  act(() => h.result.current.rulePanelProps.onChangeDraft(sizeDraft(44)));
  gateway.save.mockRejectedValue(new Error("cannot save"));
  await act(async () => {
    h.result.current.rulePanelProps.onPreviewSequence("seq-a");
  });
  expect(h.result.current.rulePanelProps.activeSequence).toBeNull();
  expect(h.result.current.rulePanelProps.storageError).toBe("cannot save");
  expect(h.onApplySequence).not.toHaveBeenCalled();
});

it("displays an application conflict notice in the actual sequence rule panel", async () => {
  const h = await renderModel();
  await act(async () => {
    h.result.current.rulePanelProps.onPreviewSequence("seq-a");
  });
  h.onApplySequence.mockReturnValue({
    appliedCount: 0,
    conflictCount: 2,
    dirtyPageIds: [],
  });
  act(() => h.result.current.footerProps.onApply());
  const notice = h.result.current.rulePanelProps.applyNotice;
  if (!notice) throw new Error("Expected application conflict notice");
  expect(notice.kind).toBe("warning");
  render(
    <BatchFonts>
      <ConditionalBatchRulePanel {...h.result.current.rulePanelProps} />
    </BatchFonts>,
  );
  expect(screen.getByText(notice.message)).toBeTruthy();
});

it("retains an authored sequence after a failed save and closes it after a successful retry", async () => {
  const h = renderHook(() => {
    const controller = useConditionalBatchSchemeController();
    return {
      controller,
      editor: useConditionalBatchSequenceEditor(
        controller.savedSchemes,
        controller.saveSequence,
      ),
    };
  });
  await settleBatch();
  act(() => h.result.current.editor.startNew());
  const steps = [{ id: "s", schemeId: "saved", enabled: true }];
  act(() => {
    h.result.current.editor.setName("작성한 연속 실행");
    h.result.current.editor.setSteps(steps);
  });
  gateway.saveSequence.mockRejectedValueOnce(new Error("disk write failed"));
  await act(async () => {
    await h.result.current.editor.save();
  });
  expect(h.result.current.controller.storageError).toBe("disk write failed");
  expect(h.result.current.editor.formOpen).toBe(true);
  expect(h.result.current.editor.name).toBe("작성한 연속 실행");
  expect(h.result.current.editor.steps).toEqual(steps);
  await act(async () => {
    await Promise.all([
      h.result.current.editor.save(),
      h.result.current.editor.save(),
    ]);
  });
  expect(gateway.saveSequence).toHaveBeenCalledTimes(2);
  expect(h.result.current.editor.formOpen).toBe(false);
  expect(gateway.stored.sequences.at(-1)?.name).toBe("작성한 연속 실행");
});
