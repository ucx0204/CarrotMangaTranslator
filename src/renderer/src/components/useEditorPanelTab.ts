import React from "react";
import type { TransformEditorMode } from "../../../shared/panelBridgeTypes";
import type { EditorTabId } from "./EditorPanelChrome";
import { readStoredEditorTab, storeEditorTab } from "./editorPanelUtils";

export function useEditorPanelTab(
  transformMode: TransformEditorMode,
  textTabRequestToken: number,
  preferTextOnMount: boolean,
): [EditorTabId, (tab: EditorTabId) => void] {
  const [activeTab, setActiveTab] = React.useState<EditorTabId>(() => {
    if (preferTextOnMount) return "text";
    return transformMode === "select" ? readStoredEditorTab() : "layout";
  });
  const previousMode = React.useRef(transformMode);
  const previousTextTabRequestToken = React.useRef(textTabRequestToken);
  React.useEffect(() => {
    const shouldRevealText =
      previousTextTabRequestToken.current !== textTabRequestToken;
    const shouldRevealLayout =
      previousMode.current === "select" && transformMode !== "select";
    previousMode.current = transformMode;
    previousTextTabRequestToken.current = textTabRequestToken;
    if (shouldRevealText) setActiveTab("text");
    else if (shouldRevealLayout) setActiveTab("layout");
  }, [textTabRequestToken, transformMode]);
  React.useEffect(() => {
    storeEditorTab(activeTab);
  }, [activeTab]);
  return [activeTab, setActiveTab];
}
