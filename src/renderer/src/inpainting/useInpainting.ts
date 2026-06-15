import React from "react";
import { InpaintingContext } from "./inpaintingContextValue";
import type { InpaintingContextValue } from "./inpaintingTypes";

export function useInpainting(): InpaintingContextValue {
  const context = React.useContext(InpaintingContext);
  if (!context) {
    throw new Error("useInpainting must be used within an InpaintingProvider");
  }
  return context;
}
