import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PanelId } from "../shared/panelBridgeTypes";
import { logError } from "./logger";

export type PanelWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Persists popped-out panel window bounds to a small JSON file so a panel
 * reopens at its last size/position. Kept separate from AppSettings to avoid
 * cross-writer races (only the main process touches window bounds).
 */
export class PanelWindowBoundsStore {
  private readonly filePath: string;
  private bounds: Partial<Record<PanelId, PanelWindowBounds>>;

  constructor(dataRoot: string) {
    this.filePath = join(dataRoot, "panel-window-bounds.json");
    this.bounds = this.read();
  }

  get(panelId: PanelId): PanelWindowBounds | undefined {
    return this.bounds[panelId];
  }

  set(panelId: PanelId, bounds: PanelWindowBounds): void {
    this.bounds = { ...this.bounds, [panelId]: bounds };
    this.write();
  }

  private read(): Partial<Record<PanelId, PanelWindowBounds>> {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Partial<Record<PanelId, PanelWindowBounds>>)
        : {};
    } catch (error) {
      if (!isMissingFileError(error)) {
        logError("Failed to read panel window bounds", { error });
      }
      return {};
    }
  }

  private write(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.bounds));
    } catch (error) {
      logError("Failed to write panel window bounds", { error });
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
