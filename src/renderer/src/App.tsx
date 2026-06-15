import React from "react";
import { FontsProvider } from "./fonts/FontsProvider";
import { AppSession } from "./AppSession";
import "./styles.css";

export default function App(): React.JSX.Element {
  return (
    <FontsProvider>
      <AppSession />
    </FontsProvider>
  );
}
