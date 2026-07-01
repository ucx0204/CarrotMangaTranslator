import { PanelIdSchema } from "../../../shared/panelBridgeSchemas";
import type { PanelId } from "../../../shared/panelBridgeTypes";

/**
 * Parses a popped-out panel route from the window location hash
 * (e.g. "#panel=editor"). Returns null for the main app window.
 */
export function parsePanelRoute(hash: string): PanelId | null {
  const match = /^#panel=(.+)$/.exec(hash);
  if (!match) {
    return null;
  }
  const result = PanelIdSchema.safeParse(match[1]);
  return result.success ? result.data : null;
}
