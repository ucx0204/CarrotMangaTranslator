import React from "react";
import { InpaintingProvider } from "./InpaintingProvider";
import type { InpaintingContextValue } from "./inpaintingTypes";

export function InpaintingSessionProvider({
  value,
  children,
}: {
  value: InpaintingContextValue;
  children: React.ReactNode;
}): React.JSX.Element {
  return <InpaintingProvider value={value}>{children}</InpaintingProvider>;
}
