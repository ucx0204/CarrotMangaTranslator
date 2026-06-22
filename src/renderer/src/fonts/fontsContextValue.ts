import React from "react";
import type { CustomFont } from "../../../shared/libraryTypes";
import type { BlockFontOption } from "../lib/fonts";

export type FontsContextValue = {
  customFonts: CustomFont[];
  options: BlockFontOption[];
  busy: boolean;
  registerFont: () => Promise<void>;
  removeFont: (id: string) => Promise<void>;
};

export const FontsContext = React.createContext<FontsContextValue | null>(null);
