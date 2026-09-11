import { createContext } from "react";
import type { KeybindingOverrides } from "../../../../shared/shortcutSettings";

/** The app composition root owns settings; modal tools inherit the same values. */
export const ShortcutBindingsContext = createContext<KeybindingOverrides>({});
