import React from "react";
import { useTranslation } from "react-i18next";
import type { PanelId } from "../../../shared/panelBridgeTypes";
import { FontsProvider } from "../fonts/FontsProvider";
import "../styles.css";
import { EditorPanelContainer } from "./EditorPanelContainer";
import { PanelSessionContext } from "./panelSession";
import { useRemotePanelSession } from "./useRemotePanelSession";
import { useLinkedWorkspaceActivityReporter } from "../hooks/useLinkedWorkspaceActivityReporter";

const PANEL_CONTENT: Record<PanelId, React.ComponentType> = {
  editor: EditorPanelContainer,
};

/**
 * Root component for a popped-out panel OS window. It provides a remote panel
 * session (state from the main window, actions relayed back as commands) and
 * renders the panel's content component.
 */
export function PanelWindowApp({
  panelId,
}: {
  panelId: PanelId;
}): React.JSX.Element {
  const { t } = useTranslation("renderer");
  useLinkedWorkspaceActivityReporter(null);
  const session = useRemotePanelSession();
  const Content = PANEL_CONTENT[panelId];
  return (
    <FontsProvider>
      <div className="panel-window">
        {session ? (
          <PanelSessionContext.Provider value={session}>
            <Content />
          </PanelSessionContext.Provider>
        ) : (
          <p className="panel-window-loading muted-line">
            {t("panels.connecting")}
          </p>
        )}
      </div>
    </FontsProvider>
  );
}
