/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COMPLETION_SOUND_PREFERENCES,
  normalizeCompletionSoundPreferences,
  useCompletionSoundController,
} from "../src/renderer/src/hooks/useCompletionSound";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("completion sound", () => {
  it("defaults to muted and persists the user's volume preference", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    const audioInstances: AudioMock[] = [];

    class AudioMock {
      currentTime = 7;
      preload = "none";
      volume = 1;

      constructor(readonly src: string) {
        audioInstances.push(this);
      }

      play = play;
      pause = pause;
    }

    vi.stubGlobal("Audio", AudioMock);
    const first = renderHook(() => useCompletionSoundController());

    expect(first.result.current).toMatchObject(
      DEFAULT_COMPLETION_SOUND_PREFERENCES,
    );
    act(() => first.result.current.playCompletionSound("translation"));
    expect(audioInstances).toHaveLength(0);

    act(() =>
      first.result.current.setPreferences({ muted: false, volume: 0.42 }),
    );
    act(() => first.result.current.playCompletionSound("translation"));

    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0]?.src).toContain("completion.ogg");
    expect(audioInstances[0]?.preload).toBe("auto");
    expect(audioInstances[0]?.volume).toBe(0.42);
    expect(audioInstances[0]?.currentTime).toBe(0);
    expect(play).toHaveBeenCalledOnce();

    first.unmount();
    expect(pause).toHaveBeenCalledOnce();

    const second = renderHook(() => useCompletionSoundController());
    expect(second.result.current).toMatchObject({ muted: false, volume: 0.42 });
  });

  it("normalizes corrupt or out-of-range stored preferences", () => {
    expect(normalizeCompletionSoundPreferences(null)).toEqual(
      DEFAULT_COMPLETION_SOUND_PREFERENCES,
    );
    expect(
      normalizeCompletionSoundPreferences({ muted: false, volume: -3 }),
    ).toEqual({
      muted: false,
      volume: 0,
      translationMuted: false,
      soundEffectMuted: false,
      sourceErasingMuted: false,
      researchMuted: false,
    });
    expect(
      normalizeCompletionSoundPreferences({ muted: "no", volume: 4 }),
    ).toEqual({
      muted: true,
      volume: 1,
      translationMuted: false,
      soundEffectMuted: false,
      sourceErasingMuted: false,
      researchMuted: false,
    });
    expect(
      normalizeCompletionSoundPreferences({
        muted: false,
        volume: 0.7,
        translationMuted: true,
        soundEffectMuted: true,
        sourceErasingMuted: false,
        researchMuted: true,
      }),
    ).toEqual({
      muted: false,
      volume: 0.7,
      translationMuted: true,
      soundEffectMuted: true,
      sourceErasingMuted: false,
      researchMuted: true,
    });
  });

  it("honors the master and per-completion mute preferences", () => {
    const play = vi.fn().mockResolvedValue(undefined);
    class AudioMock {
      currentTime = 0;
      preload = "none";
      volume = 1;
      play = play;
      pause = vi.fn();
    }
    vi.stubGlobal("Audio", AudioMock);
    const sound = renderHook(() => useCompletionSoundController());

    act(() =>
      sound.result.current.setPreferences({
        muted: false,
        volume: 0.5,
        translationMuted: true,
        soundEffectMuted: true,
        sourceErasingMuted: false,
        researchMuted: true,
      }),
    );
    act(() => sound.result.current.playCompletionSound("translation"));
    act(() => sound.result.current.playCompletionSound("sound-effect"));
    act(() => sound.result.current.playCompletionSound("research"));
    expect(play).not.toHaveBeenCalled();

    act(() => sound.result.current.playCompletionSound("source-erasing"));
    expect(play).toHaveBeenCalledOnce();
  });
});
