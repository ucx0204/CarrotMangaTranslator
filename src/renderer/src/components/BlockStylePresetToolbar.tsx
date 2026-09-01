import React from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconPlus,
  IconSettings,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockStylePresetSummary } from "../../../shared/blockStylePresets";
import { PresetRowActions } from "./PresetRowActions";
import { MenuSurface } from "./ui/MenuSurface";

type PresetControlToolbarProps = {
  activePreset: BlockStylePresetSummary | undefined;
  canCreate: boolean;
  canDelete: boolean;
  canOverwrite: boolean;
  canRename: boolean;
  contentRef: React.RefObject<HTMLDivElement | null>;
  deletingPresetId: string;
  disabled: boolean;
  open: boolean;
  overwritingPresetId: string;
  pickerDisabled: boolean;
  presets: readonly BlockStylePresetSummary[];
  rootRef: React.RefObject<HTMLDivElement | null>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onApply: (presetId: string) => void;
  onClose: (restoreFocus?: boolean) => void;
  onCreate: () => void;
  onDelete: (presetId: string) => void;
  onManage?: () => void;
  onOpenChange: React.Dispatch<React.SetStateAction<boolean>>;
  onOverwrite: (presetId: string) => void;
  onRename: (preset: BlockStylePresetSummary) => void;
};

export function PresetControlToolbar({
  activePreset,
  canCreate,
  canDelete,
  canOverwrite,
  canRename,
  contentRef,
  deletingPresetId,
  disabled,
  open,
  overwritingPresetId,
  pickerDisabled,
  presets,
  rootRef,
  triggerRef,
  onApply,
  onClose,
  onCreate,
  onDelete,
  onManage,
  onOpenChange,
  onOverwrite,
  onRename,
}: PresetControlToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="block-style-preset-toolbar">
      <div className="block-style-preset-picker" ref={rootRef}>
        <PresetMenuTrigger
          disabled={pickerDisabled}
          label={activePreset?.name ?? t("stylePresets.select")}
          open={open}
          triggerRef={triggerRef}
          onOpenChange={onOpenChange}
        />
        {open ? (
          <PresetPickerMenu
            activePresetId={activePreset?.id ?? ""}
            canDelete={canDelete}
            canOverwrite={canOverwrite}
            canRename={canRename}
            deletingPresetId={deletingPresetId}
            overwritingPresetId={overwritingPresetId}
            menuRef={contentRef}
            presets={presets}
            onApply={onApply}
            onDelete={onDelete}
            onOverwrite={onOverwrite}
            onRename={onRename}
            onClose={onClose}
          />
        ) : null}
      </div>
      {canCreate ? (
        <button
          type="button"
          className="block-style-preset-toolbar-button"
          aria-label={t("stylePresets.createFromCurrent")}
          title={t("stylePresets.createFromCurrent")}
          disabled={disabled}
          onClick={onCreate}
        >
          <IconPlus size={16} aria-hidden="true" />
        </button>
      ) : null}
      {onManage ? (
        <button
          type="button"
          className="block-style-preset-toolbar-button"
          aria-label={t("stylePresets.manage")}
          title={t("stylePresets.manage")}
          onClick={onManage}
        >
          <IconSettings size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function PresetMenuTrigger({
  disabled,
  label,
  open,
  triggerRef,
  onOpenChange,
}: {
  disabled: boolean;
  label: string;
  open: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onOpenChange: React.Dispatch<React.SetStateAction<boolean>>;
}): React.JSX.Element {
  return (
    <button
      ref={triggerRef}
      type="button"
      className="block-style-preset-trigger"
      aria-expanded={open}
      aria-haspopup="menu"
      disabled={disabled}
      onClick={() => onOpenChange((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && !open) {
          event.preventDefault();
          onOpenChange(true);
        }
      }}
    >
      <span>{label}</span>
      <IconChevronDown
        className={open ? "open" : ""}
        size={16}
        aria-hidden="true"
      />
    </button>
  );
}

function PresetPickerMenu({
  activePresetId,
  canDelete,
  canOverwrite,
  canRename,
  deletingPresetId,
  overwritingPresetId,
  menuRef,
  presets,
  onApply,
  onDelete,
  onOverwrite,
  onRename,
  onClose,
}: Pick<PresetControlToolbarProps, "canDelete" | "presets"> & {
  activePresetId: string;
  canOverwrite: boolean;
  canRename: boolean;
  deletingPresetId: string;
  overwritingPresetId: string;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onApply: (presetId: string) => void;
  onDelete: (presetId: string) => void;
  onOverwrite: (presetId: string) => void;
  onRename: (preset: BlockStylePresetSummary) => void;
  onClose: (restoreFocus?: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <MenuSurface
      ref={menuRef}
      className="block-style-preset-menu"
      ariaLabel={t("stylePresets.title")}
      onClose={onClose}
    >
      {presets.map((preset) => (
        <PresetMenuRow
          active={preset.id === activePresetId}
          canDelete={canDelete}
          canOverwrite={canOverwrite}
          canRename={canRename}
          deleteBusy={Boolean(deletingPresetId)}
          overwriteBusy={Boolean(overwritingPresetId)}
          deleting={preset.id === deletingPresetId}
          key={preset.id}
          preset={preset}
          onApply={onApply}
          onDelete={onDelete}
          onOverwrite={onOverwrite}
          onRename={onRename}
        />
      ))}
    </MenuSurface>
  );
}

function PresetMenuRow({
  active,
  canDelete,
  canOverwrite,
  canRename,
  deleteBusy,
  deleting,
  overwriteBusy,
  preset,
  onApply,
  onDelete,
  onOverwrite,
  onRename,
}: {
  active: boolean;
  canDelete: boolean;
  canOverwrite: boolean;
  canRename: boolean;
  deleteBusy: boolean;
  deleting: boolean;
  overwriteBusy: boolean;
  preset: BlockStylePresetSummary;
  onApply: (presetId: string) => void;
  onDelete: (presetId: string) => void;
  onOverwrite: (presetId: string) => void;
  onRename: (preset: BlockStylePresetSummary) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className="block-style-preset-menu-row"
      data-active={active}
      data-has-actions={canDelete || canOverwrite || canRename}
    >
      <button
        type="button"
        className="block-style-preset-menu-item"
        aria-checked={active}
        role="menuitemradio"
        disabled={deleting}
        onClick={() => onApply(preset.id)}
      >
        <span className="block-style-preset-menu-check">
          {active ? <IconCheck size={15} aria-hidden="true" /> : null}
        </span>
        <span className="block-style-preset-menu-name">{preset.name}</span>
        {preset.missingFont ? (
          <IconAlertTriangle
            className="block-style-preset-menu-warning"
            size={15}
            aria-label={t("stylePresets.missingFontShort")}
          />
        ) : null}
      </button>
      <PresetRowActions
        canDelete={canDelete}
        canOverwrite={canOverwrite}
        canRename={canRename}
        deleteBusy={deleteBusy}
        overwriteBusy={overwriteBusy}
        preset={preset}
        onDelete={onDelete}
        onOverwrite={onOverwrite}
        onRename={onRename}
      />
    </div>
  );
}
