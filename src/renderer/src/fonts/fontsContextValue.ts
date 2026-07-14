import React from "react";
import type { CustomFont, FontPreferences } from "../../../shared/libraryTypes";
import type { BlockFontOption } from "../lib/fonts";

export type FontsContextValue = {
  customFonts: CustomFont[];
  preferences: FontPreferences;
  baseOptions: BlockFontOption[];
  options: BlockFontOption[];
  busy: boolean;
  registerFont: () => Promise<void>;
  removeFont: (id: string) => Promise<void>;
  savePreferences: (preferences: FontPreferences) => Promise<void>;
};

export const FontsContext = React.createContext<FontsContextValue | null>(null);
