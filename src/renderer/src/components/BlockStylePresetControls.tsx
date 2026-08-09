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
import { handleMenuKeyboardNavigation } from "./ui/menuKeyboard";

type BlockStylePresetControlsProps = {
  activePresetId: string;
  canCreate: boolean;
  disabled: boolean;
  presets: readonly BlockStylePresetSummary[];
  onApply: (presetId: string) => void;
  onCreate: (draft: StylePresetDraft) => boolean | Promise<boolean>;
  onDelete: (presetId: string) => boolean | Promise<boolean>;
};

export function BlockStylePresetControls({
  activePresetId,
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
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const activePreset = presets.find((preset) => preset.id === activePresetId);
  const pickerDisabled = disabled || (presets.length === 0 && !canCreate);
  const deletePreset = usePresetDeleteAction({
    onDelete,
    rootRef,
    setDeletingPresetId,
    triggerRef,
  });

  usePresetMenuDismiss(open, rootRef, triggerRef, () => setOpen(false));

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
            canCreate={canCreate}
            deletingPresetId={deletingPresetId}
            disabled={disabled}
            presets={presets}
            onApply={(presetId) => {
              onApply(presetId);
              setOpen(false);
              triggerRef.current?.focus();
            }}
            onCreate={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
            onDelete={deletePreset}
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
  canCreate,
  deletingPresetId,
  disabled,
  presets,
  onApply,
  onCreate,
  onDelete,
}: Pick<BlockStylePresetControlsProps, "canCreate" | "disabled" | "presets"> & {
  activePresetId: string;
  deletingPresetId: string;
  onApply: (presetId: string) => void;
  onCreate: () => void;
  onDelete: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className="block-style-preset-menu"
      role="menu"
      aria-label={t("stylePresets.title")}
      onKeyDown={handlePresetMenuKeyDown}
    >
      {presets.map((preset) => (
        <PresetMenuRow
          active={preset.id === activePresetId}
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
    </div>
  );
}

function PresetMenuRow({
  active,
  deleteBusy,
  deleting,
  preset,
  onApply,
  onDelete,
}: {
  active: boolean;
  deleteBusy: boolean;
  deleting: boolean;
  preset: BlockStylePresetSummary;
  onApply: (presetId: string) => void;
  onDelete: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="block-style-preset-menu-row" data-active={active}>
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

function usePresetMenuDismiss(
  open: boolean,
  rootRef: React.RefObject<HTMLDivElement | null>,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  close: () => void,
): void {
  React.useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const selected = root?.querySelector<HTMLElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    const first = root?.querySelector<HTMLElement>(
      '[role^="menuitem"]:not([disabled])',
    );
    window.requestAnimationFrame(() => (selected ?? first)?.focus());
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [close, open, rootRef, triggerRef]);
}

function handlePresetMenuKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
): void {
  handleMenuKeyboardNavigation(event);
}
