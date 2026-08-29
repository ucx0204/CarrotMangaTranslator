import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/settingsTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type { WorkContextResearchProposal } from "../../../shared/workContextResearchTypes";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import { ConfirmModal } from "./ConfirmModal";
import { useConfirmDialog } from "../hooks/useConfirmDialog";
import {
  toastNotificationPort,
  type NotificationPort,
} from "../lib/notificationPort";
import {
  StyleGuideAnalysisActions,
  StyleGuideBudgetSummary,
  StyleGuideTabContent,
  StyleGuideTabs,
} from "./styleGuide/StyleGuideChrome";
import { useStyleGuideModalModel } from "./styleGuide/useStyleGuideModalModel";
import { StyleGuideResearchReview } from "./styleGuide/StyleGuideResearchReview";
import {
  StyleGuideResearchElapsed,
  StyleGuideResearchEngineBadge,
  StyleGuideResearchProgressContent,
} from "./styleGuide/StyleGuideResearchProgressModal";
import { StyleGuideResearchSetupContent } from "./styleGuide/StyleGuideResearchSetupContent";
import { useStyleGuideResearchSetup } from "./styleGuide/useStyleGuideResearchSetup";

type StyleGuideModalProps = {
  chapter: ChapterSnapshot;
  workTitle: string;
  jobActive?: boolean;
  notificationPort?: NotificationPort;
  settings: AppSettings | null;
  onSaveSettings?: (settings: AppSettings) => Promise<AppSettings | null>;
  onClose: () => void;
};

export function StyleGuideModal({
  chapter,
  workTitle,
  jobActive = false,
  notificationPort = toastNotificationPort,
  settings,
  onSaveSettings,
  onClose,
}: StyleGuideModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useStyleGuideModalModel(
    chapter,
    workTitle,
    settings,
    notificationPort,
  );
  const [researchSetupOpen, setResearchSetupOpen] = React.useState(false);
  const confirm = useConfirmDialog();
  const confirmAndReset = async (): Promise<void> => {
    const approved = await confirm.askConfirm(
      t("styleGuide.reset.button"),
      t("styleGuide.reset.message"),
      t("styleGuide.reset.detail"),
    );
    if (approved) {
      await model.resetAllWorkContext();
    }
  };
  return (
    <>
      <StyleGuidePrimaryModal
        jobActive={jobActive}
        model={model}
        onAnalyze={() => setResearchSetupOpen(true)}
        onClose={onClose}
        onReset={confirmAndReset}
      />
      {researchSetupOpen ? (
        <StyleGuideResearchSetupModal
          engine={model.researchEngine}
          initialTitle={model.researchTitle}
          settings={settings}
          onDismiss={() => setResearchSetupOpen(false)}
          onSaveSettings={onSaveSettings}
          onSaveTitle={model.saveResearchTitle}
          onStart={model.researchWithInternet}
        />
      ) : null}
      {model.analyzing && model.researchProgress ? (
        <StyleGuideResearchProgressModal
          progress={model.researchProgress}
          onCancel={() => void model.cancelResearch()}
        />
      ) : null}
      {model.proposal ? (
        <StyleGuideResearchReviewModal
          proposal={model.proposal}
          selectedIds={model.selectedOperationIds}
          onSelectedIdsChange={model.setSelectedOperationIds}
          onApply={model.applySelectedProposal}
          onDismiss={model.dismissProposal}
        />
      ) : null}
      {confirm.confirmDialog ? (
        <ConfirmModal
          title={confirm.confirmDialog.title}
          message={confirm.confirmDialog.message}
          detail={confirm.confirmDialog.detail}
          onCancel={() => confirm.resolveConfirmDialog(false)}
          onConfirm={() => confirm.resolveConfirmDialog(true)}
        />
      ) : null}
    </>
  );
}

function StyleGuidePrimaryModal({
  jobActive,
  model,
  onAnalyze,
  onClose,
  onReset,
}: {
  jobActive: boolean;
  model: ReturnType<typeof useStyleGuideModalModel>;
  onAnalyze: () => void;
  onClose: () => void;
  onReset: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      title={t("styleGuide.title")}
      size="xl"
      onClose={onClose}
      closeDisabled={model.resetting}
      bodyClassName="style-guide-body"
      footer={
        <StyleGuideFooter
          jobActive={jobActive}
          model={model}
          onClose={onClose}
          onReset={onReset}
        />
      }
    >
      <StyleGuideAnalysisActions
        analyzing={model.analyzing}
        disabled={model.working}
        engine={model.researchEngine}
        onEngineChange={model.setResearchEngine}
        onAnalyze={onAnalyze}
      />
      <StyleGuideTabs active={model.tab} onChange={model.setTab} />
      <StyleGuideTabContent
        busy={model.busy}
        guide={model.guide}
        memory={model.memory}
        onGuideChange={model.setGuide}
        onMemoryChange={model.setMemory}
        tab={model.tab}
        usage={model.usage}
        usageStatus={model.usageStatus}
      />
    </Modal>
  );
}

function StyleGuideResearchSetupModal({
  engine,
  initialTitle,
  settings,
  onDismiss,
  onSaveSettings,
  onSaveTitle,
  onStart,
}: {
  engine: ReturnType<typeof useStyleGuideModalModel>["researchEngine"];
  initialTitle: string;
  settings: AppSettings | null;
  onDismiss: () => void;
  onSaveSettings?: (settings: AppSettings) => Promise<AppSettings | null>;
  onSaveTitle: (title: string) => Promise<string>;
  onStart: (title: string) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const controller = useStyleGuideResearchSetup({
    engine,
    initialTitle,
    settings,
    onDismiss,
    onSaveSettings,
    onSaveTitle,
    onStart,
  });

  return (
    <Modal
      title={t("styleGuide.research.setupTitle")}
      size="md"
      onClose={onDismiss}
      closeDisabled={controller.busy}
      bodyClassName="style-guide-research-setup-body"
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              cancel={{
                label: t("common.cancel"),
                onClick: onDismiss,
                disabled: controller.busy,
              }}
              confirm={{
                label: t(
                  controller.busy
                    ? "styleGuide.research.preparing"
                    : "styleGuide.research.start",
                ),
                onClick: () => void controller.startResearch(),
                disabled: !controller.canStart,
              }}
            />
          }
        />
      }
    >
      <StyleGuideResearchSetupContent controller={controller} engine={engine} />
    </Modal>
  );
}

export function StyleGuideResearchProgressModal({
  progress,
  onCancel,
}: {
  progress: NonNullable<
    ReturnType<typeof useStyleGuideModalModel>["researchProgress"]
  >;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      title={t("styleGuide.research.progress.title")}
      width="min(760px, calc(100vw - 48px))"
      maxHeight="780px"
      bodyClassName="style-guide-research-progress-body"
      elevation="blocking"
      closeOnEsc={false}
      headerExtra={<StyleGuideResearchEngineBadge engine={progress.engine} />}
      footer={
        <ModalActionBar
          leading={<StyleGuideResearchElapsed startedAt={progress.startedAt} />}
          actions={
            <Button
              variant="secondary"
              disabled={progress.cancelling}
              aria-busy={progress.cancelling}
              onClick={onCancel}
            >
              {t(
                progress.cancelling
                  ? "styleGuide.research.progress.cancelling"
                  : "styleGuide.analysis.cancel",
              )}
            </Button>
          }
        />
      }
    >
      <StyleGuideResearchProgressContent progress={progress} />
    </Modal>
  );
}

function StyleGuideResearchReviewModal({
  proposal,
  selectedIds,
  onSelectedIdsChange,
  onApply,
  onDismiss,
}: {
  proposal: WorkContextResearchProposal;
  selectedIds: ReadonlySet<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onApply: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      title={t("styleGuide.research.reviewTitle")}
      size="xl"
      maxHeight="900px"
      fillHeight
      bodyLayout="flex"
      bodyClassName="style-guide-research-review-body"
      onClose={onDismiss}
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              cancel={{ label: t("common.cancel"), onClick: onDismiss }}
              confirm={{
                label: t("styleGuide.research.apply", {
                  count: selectedIds.size,
                }),
                onClick: onApply,
                disabled: selectedIds.size === 0,
              }}
            />
          }
        />
      }
    >
      <StyleGuideResearchReview
        proposal={proposal}
        selectedIds={selectedIds}
        onSelectedIdsChange={onSelectedIdsChange}
      />
    </Modal>
  );
}

function StyleGuideFooter({
  jobActive,
  model,
  onClose,
  onReset,
}: {
  jobActive: boolean;
  model: ReturnType<typeof useStyleGuideModalModel>;
  onClose: () => void;
  onReset: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      className="style-guide-footer"
      leading={
        <StyleGuideBudgetSummary budget={model.budget} locale={model.locale} />
      }
      actions={
        <>
          <Button
            variant="danger"
            onClick={() => void onReset()}
            disabled={!model.guide || model.working || jobActive}
            aria-busy={model.resetting}
          >
            {t(
              model.resetting
                ? "styleGuide.reset.running"
                : "styleGuide.reset.button",
            )}
          </Button>
          <ModalActionButtons
            cancel={{
              label: t("common.cancel"),
              onClick: onClose,
              disabled: model.resetting,
            }}
            confirm={{
              label: t("common.save"),
              onClick: () => void model.saveGuide(),
              disabled: !model.guide || model.working,
            }}
          />
        </>
      }
    />
  );
}
