import React from "react";
import type { InpaintingContextValue } from "./inpaintingTypes";

export const InpaintingContext =
  React.createContext<InpaintingContextValue | null>(null);
