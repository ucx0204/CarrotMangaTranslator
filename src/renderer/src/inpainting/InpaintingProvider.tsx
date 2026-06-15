import React from "react";
import { InpaintingContext } from "./inpaintingContextValue";
import type { InpaintingContextValue } from "./inpaintingTypes";

export function InpaintingProvider({
  value,
  children,
}: {
  value: InpaintingContextValue;
  children: React.ReactNode;
}): React.JSX.Element {
  return <InpaintingContext.Provider value={value}>{children}</InpaintingContext.Provider>;
}
