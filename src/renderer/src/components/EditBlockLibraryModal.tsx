import React from "react";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  createBlockLibrarySaveInput,
  instantiateBlockLibraryEntry,
  type BlockLibraryEntryV1,
  type BlockLibrarySnapshotV1,
} from "../../../shared/blockLibrary";
import type { TransformEditorMode } from "../../../shared/panelBridgeTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { useFonts } from "../fonts/useFonts";
import { BlockLibraryArtworkPreview } from "./BlockLibraryCard";
import {
  resolveBlockLibraryError,
  type BlockLibrarySource,
} from "./blockLibraryModel";
import { EditorPanel } from "./EditorPanel";
import { clampFontSize } from "./editorPanelUtils";
import { AppModal } from "./ConfirmModal";
import { TextField } from "./ui/Field";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import styles from "./BlockLibraryModals.module.css";

const PREVIEW_PAGE_SIZE = { width: 1000, height: 1000 } as const;

type EditBlockLibraryModalProps = {
  entry: BlockLibraryEntryV1;
  onClose: () => void;
  onUpdated: (snapshot: BlockLibrarySnapshotV1) => void;
  source: BlockLibrarySource;
};

export function EditBlockLibraryModal(
  props: EditBlockLibraryModalProps,
): React.JSX.Element {
  const state = useBlockLibraryEditState(props);
  return (
    <AppModal
      size="xl"
      title={state.t("blockLibrary.editTitle")}
      closeDisabled={state.busy}
      onClose={props.onClose}
      cardClassName={styles.editorModalCard}
      bodyClassName={styles.editorModalBody}
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              cancel={{
                label: state.t("common.cancel"),
                onClick: props.onClose,
                disabled: state.busy,
              }}
              confirm={{
                label: state.t("common.save"),
                onClick: () => void state.save(),
                disabled: state.busy || !state.normalizedName,
              }}
            />
          }
        />
      }
    >
      <BlockLibraryEditorContent entry={props.entry} state={state} />
    </AppModal>
  );
}

function BlockLibraryEditorContent({
  entry,
  state,
}: {
  entry: BlockLibraryEntryV1;
  state: ReturnType<typeof useBlockLibraryEditState>;
}): React.JSX.Element {
  return (
    <div className={styles.editorLayout}>
      <aside className={styles.editorPreviewPane}>
        <TextField
          autoFocus
          disabled={state.busy}
          label={state.t("blockLibrary.name")}
          maxLength={120}
          value={state.name}
          onChange={(event) => state.setName(event.target.value)}
        />
        <BlockLibraryArtworkPreview
          block={state.previewBlock}
          className={styles.editorPreview}
          fontCatalog={state.catalog}
          previewName={state.normalizedName || entry.name}
        />
        {state.fontMissing ? (
          <p className={styles.editorFontWarning}>
            <IconAlertTriangle size={15} aria-hidden="true" />
            {state.t("blockLibrary.missingFont")}
          </p>
        ) : null}
        {state.error ? <p className={styles.error}>{state.error}</p> : null}
      </aside>
      <div className={styles.editorControls}>
        <EditorPanel
          block={state.block}
          disabled={state.busy}
          embedded
          pageSize={PREVIEW_PAGE_SIZE}
          selectedBlockCount={1}
          showStylePresets={false}
          templateMode
          transformMode={state.transformMode}
          onAdjustFontSize={state.adjustFontSize}
          onDelete={() => undefined}
          onDuplicate={() => undefined}
          onSelectTransformMode={state.setTransformMode}
          onUpdate={state.updateBlock}
        />
      </div>
    </div>
  );
}

function useBlockLibraryEditState({
  entry,
  onUpdated,
  source,
}: EditBlockLibraryModalProps) {
  const { t } = useTranslation("components");
  const { catalog, options } = useFonts();
  const [name, setName] = React.useState(entry.name);
  const [block, setBlock] = React.useState<TranslationBlock>(() =>
    instantiateBlockLibraryEntry(entry, `library-edit-${entry.id}`),
  );
  const [transformMode, setTransformMode] =
    React.useState<TransformEditorMode>("select");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const normalizedName = name.replace(/\s+/g, " ").trim();
  const fontMissing = Boolean(
    block.fontFamily &&
    !options.some((option) => option.id === block.fontFamily),
  );
  const updateBlock = React.useCallback(
    (patch: Partial<TranslationBlock>) =>
      setBlock((current) => ({ ...current, ...patch })),
    [],
  );
  const adjustFontSize = React.useCallback((adjustment: -1 | 1) => {
    setBlock((current) => ({
      ...current,
      autoFitText: false,
      fontSizePx: clampFontSize(current.fontSizePx + adjustment),
    }));
  }, []);
  const save = React.useCallback(
    () =>
      saveBlockLibraryEdit({
        block,
        busy,
        entryId: entry.id,
        errorFallback: t("blockLibrary.updateFailed"),
        normalizedName,
        onUpdated,
        setBusy,
        setError,
        source,
      }),
    [block, busy, entry.id, normalizedName, onUpdated, source, t],
  );
  return {
    adjustFontSize,
    block,
    busy,
    catalog,
    error,
    fontMissing,
    name,
    normalizedName,
    previewBlock: fontMissing ? { ...block, fontFamily: undefined } : block,
    save,
    setName,
    setTransformMode,
    t,
    transformMode,
    updateBlock,
  };
}

async function saveBlockLibraryEdit({
  block,
  busy,
  entryId,
  errorFallback,
  normalizedName,
  onUpdated,
  setBusy,
  setError,
  source,
}: {
  block: TranslationBlock;
  busy: boolean;
  entryId: string;
  errorFallback: string;
  normalizedName: string;
  onUpdated: (snapshot: BlockLibrarySnapshotV1) => void;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  source: BlockLibrarySource;
}): Promise<void> {
  if (!normalizedName || busy) return;
  setBusy(true);
  setError("");
  try {
    const input = createBlockLibrarySaveInput(
      block,
      PREVIEW_PAGE_SIZE,
      normalizedName,
    );
    onUpdated(await source.updateBlockLibraryEntry({ id: entryId, ...input }));
  } catch (saveError) {
    setError(resolveBlockLibraryError(saveError, errorFallback));
    setBusy(false);
  }
}
