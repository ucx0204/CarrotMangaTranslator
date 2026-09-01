import React from "react";
import { IconDeviceFloppy, IconPencil, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockStylePresetSummary } from "../../../shared/blockStylePresets";

export function PresetRowActions({
  canDelete,
  canOverwrite,
  canRename,
  deleteBusy,
  overwriteBusy,
  preset,
  onDelete,
  onOverwrite,
  onRename,
}: {
  canDelete: boolean;
  canOverwrite: boolean;
  canRename: boolean;
  deleteBusy: boolean;
  overwriteBusy: boolean;
  preset: BlockStylePresetSummary;
  onDelete: (presetId: string) => void;
  onOverwrite: (presetId: string) => void;
  onRename: (preset: BlockStylePresetSummary) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!canDelete && !canOverwrite && !canRename) return null;
  return (
    <div className="block-style-preset-menu-actions">
      {canOverwrite ? (
        <button
          type="button"
          role="menuitem"
          aria-label={`${preset.name} ${t("stylePresets.overwrite")}`}
          title={t("stylePresets.overwrite")}
          disabled={deleteBusy || overwriteBusy}
          onClick={() => onOverwrite(preset.id)}
        >
          <IconDeviceFloppy size={15} aria-hidden="true" />
        </button>
      ) : null}
      {canRename ? (
        <button
          type="button"
          role="menuitem"
          aria-label={`${preset.name} ${t("stylePresets.rename")}`}
          title={t("stylePresets.rename")}
          disabled={deleteBusy || overwriteBusy}
          onClick={() => onRename(preset)}
        >
          <IconPencil size={15} aria-hidden="true" />
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          className="block-style-preset-menu-delete"
          role="menuitem"
          aria-label={`${preset.name} ${t("common.delete")}`}
          title={t("common.delete")}
          disabled={deleteBusy}
          onClick={() => onDelete(preset.id)}
        >
          <IconTrash size={15} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
