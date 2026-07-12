import React from "react";
import { useAppSessionModel } from "./app/useAppSessionModel";
import { AppSessionView } from "./app/session/AppSessionView";
import "./styles.css";

export function AppSession(): React.JSX.Element {
  const viewProps = useAppSessionModel();
  return <AppSessionView {...viewProps} />;
}
