import React from "react";
import { settingsGateway } from "./settingsGateway";
import type { SettingsFormSetters } from "./useSettingsFormState";

export type SettingsLocalModelActions = {
  localActionBusy: boolean;
  pickLocalModelFile: () => Promise<void>;
  pickLocalMmprojFile: () => Promise<void>;
};

export function useSettingsLocalModelActions({
  clearTestState,
  setters,
}: {
  clearTestState: () => void;
  setters: Pick<
    SettingsFormSetters,
    "setLocalMmprojPath" | "setLocalModelPath"
  >;
}): SettingsLocalModelActions {
  const [localActionBusy, setLocalActionBusy] = React.useState(false);
  const pickLocalModelFile = React.useCallback(async () => {
    setLocalActionBusy(true);
    try {
      const picked = await settingsGateway.pickLocalModelFile();
      if (!picked) {
        return;
      }
      clearTestState();
      setters.setLocalModelPath(picked.modelPath);
      if (picked.detectedMmprojPath) {
        setters.setLocalMmprojPath(picked.detectedMmprojPath);
      }
    } finally {
      setLocalActionBusy(false);
    }
  }, [clearTestState, setters]);

  const pickLocalMmprojFile = React.useCallback(async () => {
    setLocalActionBusy(true);
    try {
      const picked = await settingsGateway.pickLocalMmprojFile();
      if (!picked) {
        return;
      }
      clearTestState();
      setters.setLocalMmprojPath(picked);
    } finally {
      setLocalActionBusy(false);
    }
  }, [clearTestState, setters]);

  return { localActionBusy, pickLocalModelFile, pickLocalMmprojFile };
}
