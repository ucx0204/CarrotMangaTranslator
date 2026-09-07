/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCodexPreferences } from "../src/renderer/src/hooks/useCodexPreferences";
import { createCodexTypesettingPreferences } from "../src/shared/codexTypesettingDefaults";
import type { CodexTypesettingPreferences } from "../src/shared/codexTypesettingTypes";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("flushes the latest text before closing and restores it after remount", async () => {
  let disk = createCodexTypesettingPreferences("ko");
  const save = vi.fn(async (next: CodexTypesettingPreferences) => {
    disk = structuredClone(next);
    return disk;
  });
  const hook = renderHook(() => useCodexPreferences(disk, "ko", true, save));
  const next = structuredClone(hook.result.current.value);
  next.presets[0].fonts[0].purpose = "작은 손글씨와 감정 대사에 사용";
  act(() => hook.result.current.setValue(next));
  await act(async () => {
    expect(await hook.result.current.flush()).toBe(true);
  });
  hook.unmount();
  const reopened = renderHook(() =>
    useCodexPreferences(disk, "ko", true, save),
  );
  expect(reopened.result.current.value.presets[0].fonts[0].purpose).toBe(
    next.presets[0].fonts[0].purpose,
  );
  expect(save).toHaveBeenCalledTimes(1);
});

it("retains failed edits and retries without resetting the draft", async () => {
  const save = vi
    .fn(async (next: CodexTypesettingPreferences) => next)
    .mockRejectedValueOnce(new Error("disk unavailable"));
  const { result } = renderHook(() =>
    useCodexPreferences(undefined, "ko", true, save),
  );
  act(() =>
    result.current.setValue({ ...result.current.value, sfxRendering: "font" }),
  );
  await act(async () => {
    expect(await result.current.flush()).toBe(false);
  });
  expect(result.current.error).toBe(true);
  expect(result.current.value.sfxRendering).toBe("font");
  await act(async () => {
    expect(await result.current.flush()).toBe(true);
  });
  expect(result.current.error).toBe(false);
  expect(save).toHaveBeenCalledTimes(2);
});

it("serializes an edit made during an in-flight save and waits for the newer save", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = vi.fn(async (next: CodexTypesettingPreferences) => {
    if (next.eraseOriginal === false) await gate;
    return next;
  });
  const { result } = renderHook(() =>
    useCodexPreferences(undefined, "ko", true, save),
  );
  act(() =>
    result.current.setValue({ ...result.current.value, eraseOriginal: false }),
  );
  let first: Promise<boolean> = Promise.resolve(false);
  act(() => {
    first = result.current.flush();
  });
  act(() =>
    result.current.setValue({
      ...result.current.value,
      eraseOriginal: true,
      sfxRendering: "font",
    }),
  );
  await act(async () => {
    release();
    expect(await first).toBe(true);
  });
  expect(save.mock.calls.map(([value]) => value.eraseOriginal)).toEqual([
    false,
    true,
  ]);
});

it("debounces typing, rejects an empty name and does not save an untouched normal mode", async () => {
  vi.useFakeTimers();
  const save = vi.fn(async (next: CodexTypesettingPreferences) => next);
  const { result, rerender } = renderHook(
    ({ enabled }) => useCodexPreferences(undefined, "ko", enabled, save),
    { initialProps: { enabled: false } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(save).not.toHaveBeenCalled();
  rerender({ enabled: true });
  act(() =>
    result.current.setValue({ ...result.current.value, sfxRendering: "font" }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
  expect(save).toHaveBeenCalledTimes(1);
  const invalid = structuredClone(result.current.value);
  invalid.presets[0].name = "";
  act(() => result.current.setValue(invalid));
  await act(async () => {
    expect(await result.current.flush()).toBe(false);
  });
  expect(result.current.valid).toBe(false);
});

it("keeps the newest preset choice and its draft during rapid switches while saving", async () => {
  const defaults = createCodexTypesettingPreferences("ko");
  defaults.presets.push({
    ...structuredClone(defaults.presets[0]),
    id: "second",
    name: "Second",
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saved: CodexTypesettingPreferences[] = [];
  const save = vi.fn(async (next: CodexTypesettingPreferences) => {
    if (saved.length === 0) await gate;
    saved.push(structuredClone(next));
    return next;
  });
  const { result } = renderHook(() =>
    useCodexPreferences(defaults, "ko", true, save),
  );
  const edited = structuredClone(result.current.value);
  edited.presets[0].fonts[0].purpose = "Retain this exact purpose";
  act(() => result.current.setValue(edited));
  await act(async () => {
    const older = result.current.selectPreset("second");
    const newest = result.current.selectPreset("default");
    release();
    await Promise.all([older, newest]);
  });
  expect(result.current.value.selectedPresetId).toBe("default");
  expect(saved.at(-1)?.selectedPresetId).toBe("default");
  expect(saved.at(-1)?.presets[0].fonts[0].purpose).toBe(
    "Retain this exact purpose",
  );
  expect(saved.some((item) => item.selectedPresetId === "second")).toBe(false);
});
