import React from "react";
import { useTranslation } from "react-i18next";
import {
  resolveBlockStylePresetPatch,
  summarizeBlockStylePresets,
  type BlockStylePreset,
  type BlockStylePresetSummary,
} from "../../../../shared/blockStylePresets";
import { resolveEffectiveTextOutlineWidthPx } from "../../../../shared/textOutline";
import {
  buildGatherTextDirectFormatPatch,
  isGatherTextDirectFormatPatchEmpty,
  mergeGatherTextDirectFormatPatch,
  type GatherTextDirectFormatField,
  type GatherTextDirectFormatPatch,
  type GatherTextDirectFormatValues,
} from "../../lib/gatherTextDirectFormatModel";
import { Button } from "../ui/Button";
import { BlockStylePresetControls } from "../BlockStylePresetControls";
import { Modal } from "../ui/Modal";
import { ModalActionBar } from "../ui/ModalActionBar";
import { useFonts } from "../../fonts/useFonts";
import { GatherTextDirectDetailControls } from "./GatherTextDirectDetailControls";
import { GatherTextDirectFormatPreview } from "./GatherTextDirectFormatPreview";
import { GatherTextDirectTypographyControls } from "./GatherTextDirectTypographyControls";
import {
  resolvePreviewValue,
  type DirectChangeHandler,
} from "./gatherTextDirectFormatUi";
import type { GatherTextFormatSelection } from "./useGatherTextFormatSelection";

export function GatherTextDirectFormatModal({
  selection,
}: {
  selection: GatherTextFormatSelection;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const editor = useDirectFormatEditor();
  const { options: fontOptions } = useFonts();
  const {
    activePresetId,
    applyPreset,
    presetSummaries,
    reset,
    update,
    updateFontSize,
  } = useDirectFormatModalState(selection, editor, fontOptions);
  const canApply =
    !selection.disabled && selection.selectedCount > 0 && !editor.emptyPatch;
  return (
    <Modal
      title={t("gatherText.directFormatTitle")}
      size="lg"
      width="min(780px, 100%)"
      onClose={selection.closeFormatModal}
      maxHeight="880px"
      bodyLayout="bare"
      bodyClassName="gather-direct-editor-body"
      footer={
        <DirectFormatFooter
          canApply={canApply}
          emptyPatch={editor.emptyPatch}
          onApply={() => selection.apply(editor.patch)}
          onCancel={selection.closeFormatModal}
          onReset={reset}
        />
      }
    >
      <GatherTextDirectFormatPreview
        exampleText={editor.exampleText}
        model={selection.formatModel}
        patch={editor.patch}
        onExampleTextChange={editor.setExampleText}
      />
      <div className="gather-direct-editor-controls-scroll">
        {presetSummaries.length > 0 ? (
          <DirectFormatPresetBar
            activePresetId={activePresetId}
            disabled={selection.disabled}
            presets={presetSummaries}
            onApply={applyPreset}
          />
        ) : null}
        <GatherTextDirectTypographyControls
          disabled={selection.disabled}
          model={selection.formatModel}
          patch={editor.patch}
          onChange={update}
          onFontSizeChange={updateFontSize}
        />
        <GatherTextDirectDetailControls
          disabled={selection.disabled}
          model={selection.formatModel}
          patch={editor.patch}
          onChange={update}
        />
      </div>
    </Modal>
  );
}

type DirectFormatEditor = ReturnType<typeof useDirectFormatEditor>;

function useDirectFormatModalState(
  selection: GatherTextFormatSelection,
  editor: DirectFormatEditor,
  fontOptions: ReadonlyArray<{ id: string }>,
) {
  const stylePresets = React.useMemo(
    () => selection.stylePresets ?? [],
    [selection.stylePresets],
  );
  const presetSummaries = React.useMemo(
    () =>
      summarizeBlockStylePresets(
        stylePresets,
        new Set(fontOptions.map((option) => option.id)),
      ),
    [fontOptions, stylePresets],
  );
  const [activePresetId, setActivePresetId] = React.useState("");
  const {
    mergePatch,
    patch,
    resetPatch,
    update: updateEditor,
    updateFontSize: updateEditorFontSize,
  } = editor;
  const update = React.useCallback<DirectChangeHandler>(
    (field, value) => {
      setActivePresetId("");
      updateEditor(field, value);
    },
    [updateEditor],
  );
  const updateFontSize = React.useCallback(
    (value: number) => {
      setActivePresetId("");
      updateEditorFontSize(value);
    },
    [updateEditorFontSize],
  );
  const reset = React.useCallback(() => {
    setActivePresetId("");
    resetPatch();
  }, [resetPatch]);
  const applyPreset = React.useCallback(
    (presetId: string) => {
      const preset = stylePresets.find((item) => item.id === presetId);
      if (!preset) return;
      const summary = presetSummaries.find((item) => item.id === presetId);
      mergePatch(
        buildDirectPresetPatch({
          missingFont: summary?.missingFont ?? false,
          model: selection.formatModel,
          patch,
          preset,
        }),
      );
      setActivePresetId(presetId);
    },
    [mergePatch, patch, presetSummaries, selection.formatModel, stylePresets],
  );
  return {
    activePresetId,
    applyPreset,
    presetSummaries,
    reset,
    update,
    updateFontSize,
  };
}

function DirectFormatPresetBar({
  activePresetId,
  disabled,
  presets,
  onApply,
}: {
  activePresetId: string;
  disabled: boolean;
  presets: readonly BlockStylePresetSummary[];
  onApply: (presetId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="gather-direct-preset-bar">
      <div>
        <strong>{t("stylePresets.title")}</strong>
        <small>{t("gatherText.presetHint")}</small>
      </div>
      <BlockStylePresetControls
        activePresetId={activePresetId}
        canCreate={false}
        canDelete={false}
        disabled={disabled}
        presets={presets}
        onApply={onApply}
        onCreate={() => false}
        onDelete={() => false}
      />
    </section>
  );
}

function DirectFormatFooter({
  canApply,
  emptyPatch,
  onApply,
  onCancel,
  onReset,
}: {
  canApply: boolean;
  emptyPatch: boolean;
  onApply: () => void;
  onCancel: () => void;
  onReset: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <Button
          className="gather-direct-editor-reset"
          variant="ghost"
          disabled={emptyPatch}
          onClick={onReset}
        >
          {t("gatherText.resetChanges")}
        </Button>
      }
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!canApply} onClick={onApply}>
            {t("common.apply")}
          </Button>
        </>
      }
    />
  );
}

function useDirectFormatEditor(): {
  emptyPatch: boolean;
  exampleText: string;
  patch: GatherTextDirectFormatPatch;
  mergePatch: (patch: GatherTextDirectFormatPatch) => void;
  resetPatch: () => void;
  setExampleText: React.Dispatch<React.SetStateAction<string>>;
  update: DirectChangeHandler;
  updateFontSize: (value: number) => void;
} {
  const { t } = useTranslation("components");
  const [patch, setPatch] = React.useState<GatherTextDirectFormatPatch>({});
  const [exampleText, setExampleText] = React.useState(() =>
    t("gatherText.previewTextDefault"),
  );
  const update = React.useCallback<DirectChangeHandler>(
    <Field extends GatherTextDirectFormatField>(
      field: Field,
      value: GatherTextDirectFormatValues[Field],
    ) => {
      setPatch((current) =>
        mergeGatherTextDirectFormatPatch(
          current,
          buildGatherTextDirectFormatPatch(field, value),
        ),
      );
    },
    [],
  );
  const updateFontSize = React.useCallback((value: number) => {
    setPatch((current) =>
      mergeGatherTextDirectFormatPatch(
        current,
        buildGatherTextDirectFormatPatch("fontSizePx", value),
        buildGatherTextDirectFormatPatch("autoFitText", false),
      ),
    );
  }, []);
  const mergePatch = React.useCallback((next: GatherTextDirectFormatPatch) => {
    setPatch((current) => mergeGatherTextDirectFormatPatch(current, next));
  }, []);
  const resetPatch = React.useCallback(() => setPatch({}), []);
  return {
    emptyPatch: isGatherTextDirectFormatPatchEmpty(patch),
    exampleText,
    patch,
    mergePatch,
    resetPatch,
    setExampleText,
    update,
    updateFontSize,
  };
}

function buildDirectPresetPatch({
  missingFont,
  model,
  patch,
  preset,
}: {
  missingFont: boolean;
  model: GatherTextFormatSelection["formatModel"];
  patch: GatherTextDirectFormatPatch;
  preset: BlockStylePreset;
}): GatherTextDirectFormatPatch {
  const presetPatch = resolveBlockStylePresetPatch(preset, {
    omitFont: missingFont,
  });
  if (
    Object.hasOwn(presetPatch, "outlineWidthScale") &&
    !Number.isFinite(presetPatch.outlineWidthPx)
  ) {
    const fontSizePx =
      typeof presetPatch.fontSizePx === "number"
        ? presetPatch.fontSizePx
        : resolvePreviewValue(model, patch, "fontSizePx");
    presetPatch.outlineWidthPx = resolveEffectiveTextOutlineWidthPx(
      presetPatch,
      fontSizePx,
    );
  }
  return mergeGatherTextDirectFormatPatch({}, presetPatch);
}
