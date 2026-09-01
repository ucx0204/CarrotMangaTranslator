import React from "react";
import completionSoundUrl from "../assets/audio/completion.ogg";

export type CompletionSoundPreferences = {
  muted: boolean;
  volume: number;
  translationMuted?: boolean;
  soundEffectMuted?: boolean;
  sourceErasingMuted?: boolean;
  researchMuted?: boolean;
};

export type CompletionSoundCategory =
  | "translation"
  | "sound-effect"
  | "source-erasing"
  | "research";

export type ResolvedCompletionSoundPreferences =
  Required<CompletionSoundPreferences>;

export const DEFAULT_COMPLETION_SOUND_PREFERENCES: ResolvedCompletionSoundPreferences =
  {
    muted: true,
    volume: 0.55,
    translationMuted: false,
    soundEffectMuted: false,
    sourceErasingMuted: false,
    researchMuted: false,
  };

const COMPLETION_SOUND_STORAGE_KEY =
  "carrot-manga-translator.completion-sound.v1";

export function useCompletionSoundController() {
  const [preferences, setStoredPreferences] = React.useState(
    readCompletionSoundPreferences,
  );
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  React.useEffect(() => {
    writeCompletionSoundPreferences(preferences);
    if (audioRef.current) audioRef.current.volume = preferences.volume;
  }, [preferences]);

  React.useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const setPreferences = React.useCallback(
    (next: CompletionSoundPreferences): void => {
      setStoredPreferences(normalizeCompletionSoundPreferences(next));
    },
    [],
  );

  const playCompletionSound = React.useCallback(
    (category: CompletionSoundCategory): void => {
      if (
        preferences.muted ||
        preferences.volume <= 0 ||
        isCategoryMuted(preferences, category)
      ) {
        return;
      }
      try {
        const audio = audioRef.current ?? new Audio(completionSoundUrl);
        audioRef.current = audio;
        audio.preload = "auto";
        audio.volume = preferences.volume;
        audio.currentTime = 0;
        const playback = audio.play();
        if (playback) {
          void playback.catch((error) => {
            console.warn("Could not play the completion sound.", error);
          });
        }
      } catch (error) {
        console.warn("Could not prepare the completion sound.", error);
      }
    },
    [preferences],
  );

  return {
    ...preferences,
    playCompletionSound,
    setPreferences,
  };
}

export function normalizeCompletionSoundPreferences(
  value: unknown,
): ResolvedCompletionSoundPreferences {
  if (!isRecord(value)) return { ...DEFAULT_COMPLETION_SOUND_PREFERENCES };
  const volume =
    typeof value.volume === "number" && Number.isFinite(value.volume)
      ? Math.min(1, Math.max(0, value.volume))
      : DEFAULT_COMPLETION_SOUND_PREFERENCES.volume;
  return {
    muted:
      typeof value.muted === "boolean"
        ? value.muted
        : DEFAULT_COMPLETION_SOUND_PREFERENCES.muted,
    volume,
    translationMuted:
      typeof value.translationMuted === "boolean"
        ? value.translationMuted
        : false,
    soundEffectMuted:
      typeof value.soundEffectMuted === "boolean"
        ? value.soundEffectMuted
        : false,
    sourceErasingMuted:
      typeof value.sourceErasingMuted === "boolean"
        ? value.sourceErasingMuted
        : false,
    researchMuted:
      typeof value.researchMuted === "boolean" ? value.researchMuted : false,
  };
}

function isCategoryMuted(
  preferences: ResolvedCompletionSoundPreferences,
  category: CompletionSoundCategory,
): boolean {
  if (category === "translation") return preferences.translationMuted;
  if (category === "sound-effect") return preferences.soundEffectMuted;
  if (category === "source-erasing") return preferences.sourceErasingMuted;
  return preferences.researchMuted;
}

function readCompletionSoundPreferences(): ResolvedCompletionSoundPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_COMPLETION_SOUND_PREFERENCES };
  }
  try {
    const stored = window.localStorage.getItem(COMPLETION_SOUND_STORAGE_KEY);
    return stored
      ? normalizeCompletionSoundPreferences(JSON.parse(stored))
      : { ...DEFAULT_COMPLETION_SOUND_PREFERENCES };
  } catch (error) {
    void error; // localStorage may be unavailable in hardened renderers.
    return { ...DEFAULT_COMPLETION_SOUND_PREFERENCES };
  }
}

function writeCompletionSoundPreferences(
  preferences: ResolvedCompletionSoundPreferences,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COMPLETION_SOUND_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch (error) {
    void error; // Preference persistence must not interrupt job completion.
    // A read-only renderer storage area should not break job completion.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
