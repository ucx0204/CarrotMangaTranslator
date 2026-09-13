/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  useConditionalBatchEditorModel,
  type ConditionalBatchEditorModelProps,
} from "../src/renderer/src/components/useConditionalBatchEditorModel";
import type { AppWorkspaceProps } from "../src/renderer/src/components/appWorkspaceTypes";
import type { ConditionalBatchSchemeDraftV2 } from "../src/shared/conditionalBatchRules";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";
import {
  BatchFonts,
  batchChapter,
  installBatchGateway,
  settleBatch,
  sizeDraft,
} from "./fixtures/conditionalBatch";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "mangaApi");
});

function guide(workId = "work", mismatch = false): WorkStyleGuide {
  const time = "2026-09-09T00:00:00.000Z";
  return {
    schemaVersion: 1,
    workId,
    glossary: mismatch
      ? [
          {
            id: "g",
            enabled: true,
            source: "原文",
            target: "필수 표기",
            category: "term",
            createdAt: time,
            updatedAt: time,
          },
        ]
      : [],
    characters: [
      {
        id: `speaker-${workId}`,
        displayName: workId,
        targetName: workId,
        sourceNames: [workId],
        speechStyle: "neutral",
        enabled: true,
        createdAt: time,
        updatedAt: time,
      },
    ],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: time,
    updatedAt: time,
  };
}

function glossaryDraft(): ConditionalBatchSchemeDraftV2 {
  return {
    ...sizeDraft(),
    actions: [
      {
        id: "color",
        type: "setFields",
        enabled: true,
        changes: [{ field: "textColor", operation: "set", value: "#ff0000" }],
      },
    ],
    match: {
      mode: "all",
      groups: [],
      conditions: [
        {
          id: "g",
          enabled: true,
          field: "glossaryMismatch",
          operator: "isFalse",
        },
      ],
    },
  };
}

function pendingGuide() {
  let resolve!: (guide: WorkStyleGuide) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WorkStyleGuide>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function editor(
  getGuide: (workId: string) => Promise<WorkStyleGuide>,
  initialDraft = glossaryDraft(),
) {
  const backend = installBatchGateway();
  backend.stored = {
    ...backend.stored,
    schemes: [{ id: "saved", ...initialDraft }],
  };
  Object.defineProperty(window, "mangaApi", {
    configurable: true,
    value: new Proxy(window.mangaApi, {
      get(target, key) {
        return key === "getWorkStyleGuide"
          ? getGuide
          : Reflect.get(target, key);
      },
    }),
  });
  const onApply = vi.fn<ConditionalBatchEditorModelProps["onApply"]>(() => ({
    appliedCount: 2,
    conflictCount: 0,
    dirtyPageIds: ["page"],
  }));
  const onApplySequence = vi.fn<
    NonNullable<ConditionalBatchEditorModelProps["onApplySequence"]>
  >(() => ({ appliedCount: 2, conflictCount: 0, dirtyPageIds: ["page"] }));
  const chapter = batchChapter();
  const hook = renderHook(
    ({ workId }) =>
      useConditionalBatchEditorModel({
        chapter,
        workId,
        selectedPageId: "page",
        workspaceProps: {} as AppWorkspaceProps,
        busy: false,
        canUndo: false,
        undoLabel: null,
        onApply,
        onApplySequence,
        onClose: () => {},
        onSelectPage: () => {},
        onUndo: async () => false,
      }),
    { wrapper: BatchFonts, initialProps: { workId: "work" } },
  );
  return { ...hook, onApply, onApplySequence };
}

it("waits for the glossary after selecting a real saved rule before preview or apply", async () => {
  const pending = pendingGuide();
  const hook = editor(() => pending.promise);
  await settleBatch();
  await act(async () =>
    hook.result.current.rulePanelProps.onSelectScheme("saved"),
  );
  expect(hook.result.current.rulePanelProps.recipePickerOpen).toBe(false);
  expect(hook.result.current.footerProps.busy).toBe(true);
  expect(hook.result.current.footerProps.includedCount).toBe(0);
  act(() => hook.result.current.footerProps.onApply());
  expect(hook.onApply).not.toHaveBeenCalled();
  await act(async () => pending.resolve(guide("work", true)));
  await waitFor(() => expect(hook.result.current.footerProps.busy).toBe(false));
  expect(hook.result.current.footerProps.includedCount).toBe(0);
  expect(hook.result.current.footerProps.validationMessage).toBeNull();
  expect(hook.result.current.rulePanelProps.speakers?.options[0]).toMatchObject(
    {
      value: "speaker-work",
      label: "work",
    },
  );
});

it("distinguishes a failed glossary load from a valid empty glossary without blocking unrelated rules", async () => {
  const pending = pendingGuide();
  const hook = editor(() => pending.promise);
  await settleBatch();
  await act(async () =>
    hook.result.current.rulePanelProps.onSelectScheme("saved"),
  );
  await act(async () => pending.reject(Error("read failed")));
  expect(hook.result.current.footerProps.busy).toBe(true);
  expect(hook.result.current.footerProps.validationMessage).toContain(
    "용어집을 읽지 못했습니다",
  );
  expect(hook.result.current.rulePanelProps.speakers).toMatchObject({
    ready: false,
    options: [],
  });
  act(() => hook.result.current.footerProps.onApply());
  expect(hook.onApply).not.toHaveBeenCalled();
  act(() => hook.result.current.rulePanelProps.onChooseRecipe("blank"));
  act(() =>
    hook.result.current.rulePanelProps.onChangeDraft({
      ...glossaryDraft(),
      match: { mode: "allBlocks", conditions: [], groups: [] },
    }),
  );
  await waitFor(() => expect(hook.result.current.footerProps.busy).toBe(false));
  expect(hook.result.current.footerProps.validationMessage).toBeNull();
  act(() => hook.result.current.footerProps.onApply());
  expect(hook.onApply).toHaveBeenCalledOnce();
});

it("does not reuse the prior work's glossary during a work change", async () => {
  const next = pendingGuide();
  const hook = editor((workId) =>
    workId === "work" ? Promise.resolve(guide()) : next.promise,
  );
  await settleBatch();
  await act(async () =>
    hook.result.current.rulePanelProps.onSelectScheme("saved"),
  );
  await waitFor(() =>
    expect(hook.result.current.footerProps.includedCount).toBe(2),
  );
  hook.rerender({ workId: "next-work" });
  expect(hook.result.current.rulePanelProps.speakers?.options).toEqual([]);
  expect(hook.result.current.footerProps.includedCount).toBe(0);
  expect(hook.result.current.footerProps.busy).toBe(true);
  await act(async () => next.resolve(guide("next-work", true)));
  expect(hook.result.current.footerProps.includedCount).toBe(0);
  expect(hook.result.current.footerProps.busy).toBe(false);
});

it("waits for glossary-dependent sequence steps and then applies with the loaded context", async () => {
  const pending = pendingGuide();
  const hook = editor(() => pending.promise);
  await settleBatch();
  await act(async () =>
    hook.result.current.rulePanelProps.onSelectScheme("saved"),
  );
  await act(async () =>
    hook.result.current.rulePanelProps.onPreviewSequence("seq-a"),
  );
  expect(hook.result.current.footerProps.sequenceName).toBe("seq-a");
  expect(hook.result.current.footerProps.busy).toBe(true);
  act(() => hook.result.current.footerProps.onApply());
  expect(hook.onApplySequence).not.toHaveBeenCalled();
  await act(async () => pending.resolve(guide()));
  await waitFor(() =>
    expect(hook.result.current.footerProps.includedCount).toBe(2),
  );
  act(() => hook.result.current.footerProps.onApply());
  expect(hook.onApplySequence).toHaveBeenCalledOnce();
  expect(hook.onApplySequence.mock.calls[0]?.[4]).toMatchObject({
    glossary: [],
  });
});

it("ignores a late response for a prior work", async () => {
  const previous = pendingGuide();
  const hook = editor((workId) =>
    workId === "work"
      ? previous.promise
      : Promise.resolve(guide("next-work", true)),
  );
  await settleBatch();
  await act(async () =>
    hook.result.current.rulePanelProps.onSelectScheme("saved"),
  );
  hook.rerender({ workId: "next-work" });
  await waitFor(() => expect(hook.result.current.footerProps.busy).toBe(false));
  expect(hook.result.current.footerProps.includedCount).toBe(0);
  await act(async () => previous.resolve(guide()));
  expect(hook.result.current.footerProps.includedCount).toBe(0);
  expect(hook.result.current.rulePanelProps.speakers?.options[0]?.value).toBe(
    "speaker-next-work",
  );
});
