import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { AppSettings } from "../../../../shared/settingsTypes";

const INPAINTING_GUIDE_HIDDEN_KEY = "mgt.inpaintingGuide.hidden";

type UseInpaintingGuidePreferenceArgs = {
  saveSettingsQuietly: (settings: AppSettings) => Promise<AppSettings | null>;
  setInpaintingGuideOpen: Dispatch<SetStateAction<boolean>>;
  settings: AppSettings | null;
};

export function useInpaintingGuidePreference({
  saveSettingsQuietly,
  setInpaintingGuideOpen,
  settings,
}: UseInpaintingGuidePreferenceArgs) {
  const [hideInpaintingGuide, setHideInpaintingGuide] = useState(() =>
    readStoredGuideHidden(),
  );

  useEffect(() => {
    if (!settings) {
      return;
    }
    const localStorageHidden = readStoredGuideHidden();
    const settingsHidden = settings.ui?.inpaintingGuideHidden === true;
    const nextHidden = resolveInpaintingGuideHidden(
      localStorageHidden,
      settingsHidden,
    );
    setHideInpaintingGuide(nextHidden);
    if (localStorageHidden && !settingsHidden) {
      void saveSettingsQuietly(withHiddenInpaintingGuide(settings));
    }
  }, [saveSettingsQuietly, settings]);

  const closeInpaintingGuide = useCallback(
    (hideNextTime: boolean) => {
      if (hideNextTime) {
        writeStoredGuideHidden();
        setHideInpaintingGuide(true);
        if (settings) {
          void saveSettingsQuietly(withHiddenInpaintingGuide(settings));
        }
      }
      setInpaintingGuideOpen(false);
    },
    [saveSettingsQuietly, setInpaintingGuideOpen, settings],
  );

  return {
    closeInpaintingGuide,
    hideInpaintingGuide,
  };
}

export function resolveInpaintingGuideHidden(
  localStorageHidden: boolean,
  settingsHidden: boolean,
): boolean {
  return localStorageHidden || settingsHidden;
}

export function withHiddenInpaintingGuide(settings: AppSettings): AppSettings {
  return {
    ...settings,
    ui: {
      ...settings.ui,
      inpaintingGuideHidden: true,
    },
  };
}

function readStoredGuideHidden(): boolean {
  return (
    typeof window !== "undefined" &&
    window.localStorage.getItem(INPAINTING_GUIDE_HIDDEN_KEY) === "1"
  );
}

function writeStoredGuideHidden(): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(INPAINTING_GUIDE_HIDDEN_KEY, "1");
  }
}
