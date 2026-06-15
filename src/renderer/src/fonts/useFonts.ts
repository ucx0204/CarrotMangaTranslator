import React from "react";
import { FontsContext, type FontsContextValue } from "./fontsContextValue";

export function useFonts(): FontsContextValue {
  const context = React.useContext(FontsContext);
  if (!context) {
    throw new Error("useFonts must be used within a FontsProvider");
  }
  return context;
}
