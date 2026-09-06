/** @vitest-environment jsdom */
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import {
  installBatchGateway,
  savedBatchController,
  settleBatch,
  sizeDraft,
} from "./fixtures/conditionalBatch";

let gateway: ReturnType<typeof installBatchGateway>;
beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  gateway = installBatchGateway();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "mangaApi");
});

it("flushes the latest saved rule before closing inside the debounce window", async () => {
  const h = await savedBatchController();
  act(() => h.result.current.changeDraft(sizeDraft(44)));
  expect(h.result.current.autosaveState).toBe("waiting");
  await act(async () => {
    expect(await h.result.current.runWithSavedDraft(() => {})).toBe(true);
  });
  h.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(gateway.save).toHaveBeenCalledTimes(1);
  expect(gateway.stored.schemes[0].actions).toEqual(sizeDraft(44).actions);
});

it.each(["close", "recipe", "duplicate", "selection"])(
  "keeps the current edit when saving before %s fails",
  async (transition) => {
    const h = await savedBatchController();
    act(() => h.result.current.changeDraft(sizeDraft(44)));
    gateway.save.mockRejectedValue(new Error("disk unavailable"));
    await act(async () => {
      if (transition === "close")
        expect(await h.result.current.runWithSavedDraft(() => {})).toBe(false);
      if (transition === "recipe") h.result.current.chooseRecipe("ellipsis");
      if (transition === "duplicate") h.result.current.duplicateScheme();
      if (transition === "selection")
        h.result.current.selectScheme(h.result.current.temporarySchemes[0].id);
    });
    expect(h.result.current.selectedSchemeId).toBe("saved");
    expect(h.result.current.draft.actions).toEqual(sizeDraft(44).actions);
    expect(h.result.current.storageError).toBe("disk unavailable");
    expect(h.result.current.storageBusy).toBe(false);
  },
);

it.each(["recipe", "duplicate"])(
  "flushes before %s replaces the saved draft",
  async (transition) => {
    const h = await savedBatchController();
    act(() => h.result.current.changeDraft(sizeDraft(44)));
    await act(async () => {
      if (transition === "recipe") h.result.current.chooseRecipe("ellipsis");
      else h.result.current.duplicateScheme();
    });
    expect(h.result.current.selectedSchemeId).not.toBe("saved");
    expect(gateway.stored.schemes[0].actions).toEqual(sizeDraft(44).actions);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(gateway.save).toHaveBeenCalledTimes(1);
  },
);

it("autosaves and deletes imported permanent rules even when their ID starts with draft:", async () => {
  gateway.stored = {
    schemaVersion: 1,
    schemes: [{ id: "draft:export", ...sizeDraft() }],
    sequences: [],
  };
  const h = await savedBatchController("draft:export");
  act(() => h.result.current.changeDraft(sizeDraft(44)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(gateway.save).toHaveBeenCalledWith({
    id: "draft:export",
    scheme: sizeDraft(44),
  });
  await act(async () => {
    h.result.current.deleteScheme();
  });
  expect(gateway.remove).toHaveBeenCalledWith("draft:export");
  expect(gateway.stored.schemes).toEqual([]);
});

it("refreshes the selected draft on YAML overwrite and cannot autosave the old contents afterward", async () => {
  const h = await savedBatchController();
  act(() => h.result.current.changeDraft(sizeDraft(35)));
  gateway.importYaml.mockImplementation(async () => {
    gateway.stored = {
      ...gateway.stored,
      schemes: [{ id: "saved", ...sizeDraft(44) }],
    };
    return gateway.stored;
  });
  act(() =>
    h.result.current.setYamlText(
      stringify({
        schemaVersion: 1,
        schemes: [{ id: "saved", ...sizeDraft(44) }],
        sequences: [],
      }),
    ),
  );
  await act(async () => {
    h.result.current.importYaml("overwrite");
  });
  expect(h.result.current.draft.actions).toEqual(sizeDraft(44).actions);
  act(() =>
    h.result.current.changeDraft({
      ...h.result.current.draft,
      name: "renamed",
    }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(gateway.stored.schemes[0].actions).toEqual(sizeDraft(44).actions);
  expect(gateway.stored.schemes[0].name).toBe("renamed");
});

it("exports the edited saved rule after its pending autosave is flushed", async () => {
  const h = await savedBatchController();
  act(() => h.result.current.changeDraft(sizeDraft(44)));
  gateway.exportYaml.mockImplementation(async () => {
    expect(gateway.stored.schemes[0].actions).toEqual(sizeDraft(44).actions);
    return "exported";
  });
  act(() => h.result.current.exportYaml(false));
  await settleBatch();
  expect(gateway.exportYaml).toHaveBeenCalledTimes(1);
});

it("ignores an older autosave response after the latest edit has been flushed for closing", async () => {
  const h = await savedBatchController();
  let finishOldResponse: () => void = () => {};
  const responseDelay = new Promise<void>((resolve) => {
    finishOldResponse = resolve;
  });
  const save = gateway.save.getMockImplementation();
  if (!save) throw new Error("Expected a storage boundary");
  gateway.save.mockImplementationOnce(async (input) => {
    const oldSnapshot = await save(input);
    await responseDelay;
    return oldSnapshot;
  });
  act(() => h.result.current.changeDraft(sizeDraft(35)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(h.result.current.autosaveState).toBe("saving");
  act(() => h.result.current.changeDraft(sizeDraft(44)));
  const onClose = vi.fn();
  await act(async () => {
    expect(await h.result.current.runWithSavedDraft(onClose)).toBe(true);
  });
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => {
    finishOldResponse();
  });
  expect(h.result.current.savedSchemes[0].actions).toEqual(
    sizeDraft(44).actions,
  );
  expect(gateway.stored.schemes[0].actions).toEqual(sizeDraft(44).actions);
});

it("does not leave an invalid saved edit or silently use its older stored version", async () => {
  const h = await savedBatchController();
  act(() => h.result.current.changeDraft({ ...sizeDraft(44), name: "" }));
  const onLeave = vi.fn();
  await act(async () => {
    expect(await h.result.current.runWithSavedDraft(onLeave)).toBe(false);
  });
  expect(onLeave).not.toHaveBeenCalled();
  expect(h.result.current.draft.name).toBe("");
  expect(h.result.current.storageError).toBeTruthy();
  expect(gateway.save).not.toHaveBeenCalled();
});
