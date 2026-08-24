import React from "react";
import type { FontPreferences } from "../../../shared/libraryTypes";
import type { BlockFontCatalog, BlockFontOption } from "../lib/fonts";

export type FontsContextValue = {
  catalog: BlockFontCatalog;
  baseOptions: readonly BlockFontOption[];
  options: readonly BlockFontOption[];
  /** False only while the persisted font catalog is being hydrated. */
  ready?: boolean;
  busy: boolean;
  registerFont: () => Promise<void>;
  removeFont: (id: string) => Promise<void>;
  savePreferences: (preferences: FontPreferences) => Promise<void>;
};

export const FontsContext = React.createContext<FontsContextValue | null>(null);
