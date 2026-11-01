import React from "react";
import { useTranslation } from "react-i18next";
import styles from "./ConditionalBatchEditor.module.css";
import {
  type ConditionalBatchEditorModel,
  type ConditionalBatchEditorModelProps,
} from "./conditionalBatchEditorTypes";
import { ConditionalBatchFooter } from "./ConditionalBatchFooter";
import { ConditionalBatchPreviewPane } from "./ConditionalBatchPreviewPane";
import { ConditionalBatchResultsCard } from "./ConditionalBatchResultsCard";
import { ConditionalBatchRulePanel } from "./ConditionalBatchRulePanel";
import { ConfirmModal } from "./ConfirmModal";
import { Modal } from "./ui/Modal";
import { SegmentedControl } from "./ui/SegmentedControl";
import { useConditionalBatchEditorModel } from "./useConditionalBatchEditorModel";

export type ConditionalBatchEditorProps = ConditionalBatchEditorModelProps & {
  onEntered?: () => void;
};

export function ConditionalBatchEditor(
  props: ConditionalBatchEditorProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useConditionalBatchEditorModel(props);
  const [discardConfirmOpen, setDiscardConfirmOpen] = React.useState(false);
  const handleClose = (): void => {
    if (model.hasDirtyTemporaryDrafts) {
      setDiscardConfirmOpen(true);
      return;
    }
    model.close();
  };
  return (
    <>
      <ConditionalBatchEditorModal
        model={model}
        title={t("conditionalBatch.title")}
        onEntered={props.onEntered}
        onClose={handleClose}
      />
      <DiscardTemporaryRulesConfirm
        open={discardConfirmOpen}
        onCancel={() => setDiscardConfirmOpen(false)}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          model.close();
        }}
      />
    </>
  );
}

function ConditionalBatchEditorModal({
  model,
  title,
  onEntered,
  onClose,
}: {
  model: ConditionalBatchEditorModel;
  title: React.ReactNode;
  onEntered?: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useTranslation();
  const [activeTab, setActiveTab] = React.useState<
    "rules" | "preview" | "results"
  >("rules");
  const handleKeyDown = useConditionalBatchKeyboardShortcuts(model);
  return (
    <Modal
      title={title}
      onEntered={onEntered}
      onClose={onClose}
      fillHeight
      bodyLayout="bare"
      cardClassName={styles.modalCard}
      bodyClassName={styles.modalBody}
    >
      <div
        className={styles.root}
        inert={model.rulePanelProps.storageBusy}
        aria-busy={model.rulePanelProps.storageBusy}
        data-active-tab={activeTab}
        data-conditional-batch-editor=""
        onKeyDown={handleKeyDown}
      >
        <EditorTabs activeTab={activeTab} onChange={setActiveTab} />
        <div className={styles.ruleSlot}>
          <ConditionalBatchRulePanel {...model.rulePanelProps} />
        </div>
        <div
          className={styles.previewColumn}
          data-conditional-batch-preview-column=""
        >
          <ConditionalBatchPreviewPane {...model.previewPaneProps} />
          <ConditionalBatchResultsCard {...model.resultsProps} />
        </div>
        {model.rulePanelProps.recipePickerOpen ? null : (
          <ConditionalBatchFooter {...model.footerProps} />
        )}
      </div>
    </Modal>
  );
}

function EditorTabs({
  activeTab,
  onChange,
}: {
  activeTab: "rules" | "preview" | "results";
  onChange: (tab: "rules" | "preview" | "results") => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.mobileTabs}>
      <SegmentedControl
        ariaLabel={t("batchEditorCopy.batchEditorView")}
        singleRow
        value={activeTab}
        options={[
          {
            id: "rules",
            label: t("batchEditorCopy.rules"),
          },
          {
            id: "preview",
            label: t("batchEditorCopy.preview"),
          },
          {
            id: "results",
            label: t("batchEditorCopy.results"),
          },
        ]}
        onChange={onChange}
      />
    </div>
  );
}

function DiscardTemporaryRulesConfirm({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!open) return null;
  return (
    <ConfirmModal
      title={t("batchEditorCopy.closeTemporaryRules")}
      message={t("batchEditorCopy.thereAreUnsavedTemporaryRules")}
      confirmLabel={t("batchEditorCopy.discardAndClose")}
      confirmVariant="danger"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function useConditionalBatchKeyboardShortcuts(
  model: ConditionalBatchEditorModel,
): (event: React.KeyboardEvent<HTMLDivElement>) => void {
  return React.useCallback(
    (event) => handleConditionalBatchShortcut(event, model),
    [model],
  );
}

// eslint-disable-next-line complexity -- disjoint key chords intentionally short-circuit before invoking any editor mutation
function handleConditionalBatchShortcut(
  event: React.KeyboardEvent<HTMLDivElement>,
  model: ConditionalBatchEditorModel,
): void {
  const currentResult = model.resultsProps.currentResult;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    if (
      !model.footerProps.busy &&
      !model.footerProps.inspectionOnly &&
      !model.footerProps.validationMessage &&
      model.footerProps.includedCount > 0
    ) {
      event.preventDefault();
      model.footerProps.onApply();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    if (!model.rulePanelProps.activeSequence) {
      event.preventDefault();
      model.rulePanelProps.onSaveScheme();
    }
    return;
  }
  if (isEditableEventTarget(event.target)) return;
  if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    model.resultsProps.onMoveResult(-1);
    return;
  }
  if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    model.resultsProps.onMoveResult(1);
    return;
  }
  if (event.altKey && event.key.toLowerCase() === "x" && currentResult) {
    event.preventDefault();
    model.resultsProps.onToggleResult(
      currentResult.key,
      model.resultsProps.excludedResultKeys.has(currentResult.key),
    );
  }
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}
