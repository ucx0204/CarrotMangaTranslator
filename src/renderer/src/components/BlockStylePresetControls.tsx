import React from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { BlockStylePresetSummary } from "../../../shared/blockStylePresets";
import {
  StylePresetEditorModal,
  type StylePresetDraft,
} from "./StylePresetEditorModal";
import { MenuSurface } from "./ui/MenuSurface";
import { usePopupController } from "./ui/usePopupController";

type BlockStylePresetControlsProps = {
  activePresetId: string;
  canDelete?: boolean;
  canCreate: boolean;
  disabled: boolean;
  presets: readonly BlockStylePresetSummary[];
  onApply: (presetId: string) => void;
  onCreate: (draft: StylePresetDraft) => boolean | Promise<boolean>;
  onDelete: (presetId: string) => boolean | Promise<boolean>;
};

export function BlockStylePresetControls({
  activePresetId,
  canDelete = true,
  canCreate,
  disabled,
  presets,
  onApply,
  onCreate,
  onDelete,
}: BlockStylePresetControlsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [deletingPresetId, setDeletingPresetId] = React.useState("");
  const activePreset = presets.find((preset) => preset.id === activePresetId);
  const pickerDisabled = disabled || (presets.length === 0 && !canCreate);
  const { close, contentRef, rootRef, triggerRef } = usePopupController({
    disabled: pickerDisabled,
    initialFocus: [
      '[role="menuitemradio"][aria-checked="true"]',
      '[role^="menuitem"]:not(:disabled)',
    ],
    open,
    onOpenChange: setOpen,
  });
  const deletePreset = usePresetDeleteAction({
    onDelete,
    rootRef,
    setDeletingPresetId,
    triggerRef,
  });

  return (
    <section className="block-style-preset-controls">
      <div className="block-style-preset-picker" ref={rootRef}>
        <PresetMenuTrigger
          disabled={pickerDisabled}
          label={activePreset?.name ?? t("stylePresets.select")}
          open={open}
          triggerRef={triggerRef}
          onOpenChange={setOpen}
        />
        {open ? (
          <PresetPickerMenu
            activePresetId={activePreset?.id ?? ""}
            canDelete={canDelete}
            canCreate={canCreate}
            deletingPresetId={deletingPresetId}
            disabled={disabled}
            menuRef={contentRef}
            presets={presets}
            onApply={(presetId) => {
              onApply(presetId);
              close(true);
            }}
            onCreate={() => {
              close(false);
              setCreateOpen(true);
            }}
            onDelete={deletePreset}
            onClose={close}
          />
        ) : null}
      </div>
      {createOpen ? (
        <StylePresetEditorModal
          onClose={() => setCreateOpen(false)}
          onSave={onCreate}
        />
      ) : null}
    </section>
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
  canCreate,
  deletingPresetId,
  disabled,
  menuRef,
  presets,
  onApply,
  onCreate,
  onDelete,
  onClose,
}: Pick<
  BlockStylePresetControlsProps,
  "canCreate" | "canDelete" | "disabled" | "presets"
> & {
  activePresetId: string;
  deletingPresetId: string;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onApply: (presetId: string) => void;
  onCreate: () => void;
  onDelete: (presetId: string) => void;
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
          canDelete={canDelete ?? true}
          deleteBusy={Boolean(deletingPresetId)}
          deleting={preset.id === deletingPresetId}
          key={preset.id}
          preset={preset}
          onApply={onApply}
          onDelete={onDelete}
        />
      ))}
      {canCreate ? (
        <button
          type="button"
          className="block-style-preset-menu-create"
          role="menuitem"
          disabled={disabled}
          onClick={onCreate}
        >
          <IconPlus size={15} aria-hidden="true" />
          <span>{t("stylePresets.createFromCurrent")}</span>
        </button>
      ) : null}
    </MenuSurface>
  );
}

function PresetMenuRow({
  active,
  canDelete,
  deleteBusy,
  deleting,
  preset,
  onApply,
  onDelete,
}: {
  active: boolean;
  canDelete: boolean;
  deleteBusy: boolean;
  deleting: boolean;
  preset: BlockStylePresetSummary;
  onApply: (presetId: string) => void;
  onDelete: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className="block-style-preset-menu-row"
      data-active={active}
      data-can-delete={canDelete}
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

function usePresetDeleteAction({
  onDelete,
  rootRef,
  setDeletingPresetId,
  triggerRef,
}: {
  onDelete: BlockStylePresetControlsProps["onDelete"];
  rootRef: React.RefObject<HTMLDivElement | null>;
  setDeletingPresetId: React.Dispatch<React.SetStateAction<string>>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}): (presetId: string) => void {
  return (presetId) => {
    setDeletingPresetId(presetId);
    void Promise.resolve(onDelete(presetId)).finally(() => {
      setDeletingPresetId("");
      window.requestAnimationFrame(() => {
        const next = rootRef.current?.querySelector<HTMLElement>(
          '[role="menuitemradio"]:not([disabled])',
        );
        (next ?? triggerRef.current)?.focus();
      });
    });
  };
}
