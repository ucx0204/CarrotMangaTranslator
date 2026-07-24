import React from "react";
import { settingsGateway } from "../../api/settingsGateway";
import { useMountedRef } from "../../hooks/useMountedRef";
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
  const mountedRef = useMountedRef();
  const pickLocalModelFile = React.useCallback(async () => {
    setLocalActionBusy(true);
    try {
      const picked = await settingsGateway.pickLocalModelFile();
      if (!mountedRef.current || !picked) {
        return;
      }
      clearTestState();
      setters.setLocalModelPath(picked.modelPath);
      if (picked.detectedMmprojPath) {
        setters.setLocalMmprojPath(picked.detectedMmprojPath);
      }
    } finally {
      if (mountedRef.current) {
        setLocalActionBusy(false);
      }
    }
  }, [clearTestState, mountedRef, setters]);

  const pickLocalMmprojFile = React.useCallback(async () => {
    setLocalActionBusy(true);
    try {
      const picked = await settingsGateway.pickLocalMmprojFile();
      if (!mountedRef.current || !picked) {
        return;
      }
      clearTestState();
      setters.setLocalMmprojPath(picked);
    } finally {
      if (mountedRef.current) {
        setLocalActionBusy(false);
      }
    }
  }, [clearTestState, mountedRef, setters]);

  return { localActionBusy, pickLocalModelFile, pickLocalMmprojFile };
}
