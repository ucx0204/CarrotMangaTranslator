import React from "react";
import type { BlockStylePresetSummary } from "../../../shared/blockStylePresets";
import {
  StylePresetEditorModal,
  StylePresetRenameModal,
  type StylePresetDraft,
} from "./StylePresetEditorModal";
import { usePopupController } from "./ui/usePopupController";
import { PresetControlToolbar } from "./BlockStylePresetToolbar";

type BlockStylePresetControlsProps = {
  activePresetId: string;
  canDelete?: boolean;
  canCreate: boolean;
  disabled: boolean;
  presets: readonly BlockStylePresetSummary[];
  onApply: (presetId: string) => void;
  onCreate: (draft: StylePresetDraft) => boolean | Promise<boolean>;
  onDelete: (presetId: string) => boolean | Promise<boolean>;
  onManage?: () => void;
  onOverwrite?: (presetId: string) => boolean | Promise<boolean>;
  onRename?: (presetId: string, name: string) => boolean | Promise<boolean>;
};

export function BlockStylePresetControls({
  activePresetId,
  canCreate,
  canDelete = true,
  disabled,
  onApply,
  onCreate,
  onDelete,
  onManage,
  onOverwrite,
  onRename,
  presets,
}: BlockStylePresetControlsProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [deletingPresetId, setDeletingPresetId] = React.useState("");
  const [overwritingPresetId, setOverwritingPresetId] = React.useState("");
  const [renamePreset, setRenamePreset] =
    React.useState<BlockStylePresetSummary | null>(null);
  const activePreset = presets.find((preset) => preset.id === activePresetId);
  const pickerDisabled = disabled || presets.length === 0;
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
  const overwritePreset = usePresetOverwriteAction(
    onOverwrite,
    setOverwritingPresetId,
  );
  const applyPreset = createPresetApplyAction(onApply, close);
  const renameSelectedPreset = createPresetRenameAction(close, setRenamePreset);
  return (
    <section className="block-style-preset-controls">
      <PresetControlToolbar
        activePreset={activePreset}
        canCreate={canCreate}
        canDelete={canDelete}
        canOverwrite={Boolean(onOverwrite)}
        canRename={Boolean(onRename)}
        contentRef={contentRef}
        deletingPresetId={deletingPresetId}
        disabled={disabled}
        open={open}
        overwritingPresetId={overwritingPresetId}
        pickerDisabled={pickerDisabled}
        presets={presets}
        rootRef={rootRef}
        triggerRef={triggerRef}
        onApply={applyPreset}
        onClose={close}
        onCreate={() => setCreateOpen(true)}
        onDelete={deletePreset}
        onManage={onManage}
        onOpenChange={setOpen}
        onOverwrite={overwritePreset}
        onRename={renameSelectedPreset}
      />
      <PresetControlDialogs
        createOpen={createOpen}
        renamePreset={renamePreset}
        onCloseCreate={() => setCreateOpen(false)}
        onCloseRename={() => setRenamePreset(null)}
        onCreate={onCreate}
        onRename={onRename}
      />
    </section>
  );
}

function PresetControlDialogs({
  createOpen,
  renamePreset,
  onCloseCreate,
  onCloseRename,
  onCreate,
  onRename,
}: {
  createOpen: boolean;
  renamePreset: BlockStylePresetSummary | null;
  onCloseCreate: () => void;
  onCloseRename: () => void;
  onCreate: BlockStylePresetControlsProps["onCreate"];
  onRename: BlockStylePresetControlsProps["onRename"];
}): React.JSX.Element {
  return (
    <>
      {createOpen ? (
        <StylePresetEditorModal onClose={onCloseCreate} onSave={onCreate} />
      ) : null}
      {renamePreset && onRename ? (
        <StylePresetRenameModal
          initialName={renamePreset.name}
          onClose={onCloseRename}
          onSave={(name) => onRename(renamePreset.id, name)}
        />
      ) : null}
    </>
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

function usePresetOverwriteAction(
  onOverwrite: BlockStylePresetControlsProps["onOverwrite"],
  setOverwritingPresetId: React.Dispatch<React.SetStateAction<string>>,
): (presetId: string) => void {
  return (presetId) => {
    if (!onOverwrite) return;
    setOverwritingPresetId(presetId);
    void Promise.resolve(onOverwrite(presetId)).finally(() =>
      setOverwritingPresetId(""),
    );
  };
}

function createPresetApplyAction(
  onApply: BlockStylePresetControlsProps["onApply"],
  close: (restoreFocus?: boolean) => void,
): (presetId: string) => void {
  return (presetId) => {
    onApply(presetId);
    close(true);
  };
}

function createPresetRenameAction(
  close: (restoreFocus?: boolean) => void,
  setRenamePreset: React.Dispatch<
    React.SetStateAction<BlockStylePresetSummary | null>
  >,
): (preset: BlockStylePresetSummary) => void {
  return (preset) => {
    close(false);
    setRenamePreset(preset);
  };
}
