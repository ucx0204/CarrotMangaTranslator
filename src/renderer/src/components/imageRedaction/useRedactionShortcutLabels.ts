import { useContext, useMemo } from "react";
import type { RedactionPreferences } from "../../../../shared/imageRedactionWorkspace";
import { formatCombo } from "../../lib/shortcuts/comboFromEvent";
import { ShortcutBindingsContext } from "../../lib/shortcuts/shortcutBindingsContext";
import {
  redactionBindings,
  type RedactionKeyAction,
} from "./redactionKeyboard";

/** Tooltips and help describe the same effective bindings as the editor. */
export function useRedactionShortcutLabels(preferences: RedactionPreferences) {
  const overrides = useContext(ShortcutBindingsContext);
  const bindings = useMemo(
    () => redactionBindings(preferences, overrides),
    [preferences, overrides],
  );
  return (...actions: RedactionKeyAction[]) =>
    [...bindings]
      .filter(([, action]) => actions.includes(action))
      .map(([combo]) => formatCombo(combo))
      .join(" / ") || "—";
}
