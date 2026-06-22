import React from "react";
import { useAppSessionModel } from "./app/useAppSessionModel";
import "./styles.css";
import { AppSessionView } from "./app/session";

export function AppSession(): React.JSX.Element {
  const viewProps = useAppSessionModel();
  return <AppSessionView {...viewProps} />;
}
