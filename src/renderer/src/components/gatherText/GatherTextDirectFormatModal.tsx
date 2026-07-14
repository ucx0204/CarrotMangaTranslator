import React from "react";
import { useTranslation } from "react-i18next";
import {
  buildGatherTextDirectFormatPatch,
  isGatherTextDirectFormatPatchEmpty,
  mergeGatherTextDirectFormatPatch,
  type GatherTextDirectFormatField,
  type GatherTextDirectFormatPatch,
  type GatherTextDirectFormatValues,
} from "../../lib/gatherTextDirectFormatModel";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { GatherTextDirectDetailControls } from "./GatherTextDirectDetailControls";
import { GatherTextDirectFormatPreview } from "./GatherTextDirectFormatPreview";
import { GatherTextDirectTypographyControls } from "./GatherTextDirectTypographyControls";
import type { DirectChangeHandler } from "./gatherTextDirectFormatUi";
import type { GatherTextFormatSelection } from "./useGatherTextFormatSelection";

export function GatherTextDirectFormatModal({
  selection,
}: {
  selection: GatherTextFormatSelection;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const editor = useDirectFormatEditor();
  const canApply =
    !selection.disabled && selection.selectedCount > 0 && !editor.emptyPatch;
  return (
    <Modal
      title={t("gatherText.directFormatTitle")}
      size="lg"
      width="min(780px, 100%)"
      onClose={selection.closeFormatModal}
      closeOnBackdrop
      bodyClassName="gather-direct-editor-body"
      cardClassName="gather-direct-editor-modal"
      footer={
        <DirectFormatFooter
          canApply={canApply}
          emptyPatch={editor.emptyPatch}
          onApply={() => selection.apply(editor.patch)}
          onCancel={selection.closeFormatModal}
          onReset={editor.resetPatch}
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
        <GatherTextDirectTypographyControls
          disabled={selection.disabled}
          model={selection.formatModel}
          patch={editor.patch}
          onChange={editor.update}
          onFontSizeChange={editor.updateFontSize}
        />
        <GatherTextDirectDetailControls
          disabled={selection.disabled}
          model={selection.formatModel}
          patch={editor.patch}
          onChange={editor.update}
        />
      </div>
    </Modal>
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
    <>
      <Button
        className="gather-direct-editor-reset"
        variant="ghost"
        disabled={emptyPatch}
        onClick={onReset}
      >
        {t("gatherText.resetChanges")}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button variant="primary" disabled={!canApply} onClick={onApply}>
        {t("common.apply")}
      </Button>
    </>
  );
}

function useDirectFormatEditor(): {
  emptyPatch: boolean;
  exampleText: string;
  patch: GatherTextDirectFormatPatch;
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
  return {
    emptyPatch: isGatherTextDirectFormatPatchEmpty(patch),
    exampleText,
    patch,
    resetPatch: () => setPatch({}),
    setExampleText,
    update,
    updateFontSize,
  };
}
