import React from "react";
import { ShortcutBindingsContext } from "./lib/shortcuts/shortcutBindingsContext";
import { useAppSessionModel } from "./app/useAppSessionModel";
import { AppSessionView } from "./app/session/AppSessionView";
import "./styles.css";

export function AppSession(): React.JSX.Element {
  const viewProps = useAppSessionModel();
  return (
    <ShortcutBindingsContext.Provider
      value={viewProps.shortcutHelpProps.overrides}
    >
      <AppSessionView {...viewProps} />
    </ShortcutBindingsContext.Provider>
  );
}
