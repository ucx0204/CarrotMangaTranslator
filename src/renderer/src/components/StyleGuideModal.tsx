import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/settingsTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
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

type StyleGuideModalProps = {
  chapter: ChapterSnapshot;
  jobActive?: boolean;
  notificationPort?: NotificationPort;
  settings: AppSettings | null;
  onClose: () => void;
};

export function StyleGuideModal({
  chapter,
  jobActive = false,
  notificationPort = toastNotificationPort,
  settings,
  onClose,
}: StyleGuideModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useStyleGuideModalModel(chapter, settings, notificationPort);
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
      <Modal
        title={t("styleGuide.title")}
        size="xl"
        onClose={onClose}
        closeDisabled={model.resetting}
        closeOnBackdrop
        bodyClassName="style-guide-body"
        footer={
          <StyleGuideFooter
            jobActive={jobActive}
            model={model}
            onReset={confirmAndReset}
          />
        }
      >
        <StyleGuideAnalysisActions
          analyzingScope={model.analyzingScope}
          disabled={model.working}
          onAnalyze={(scope) => void model.analyzeWithAi(scope)}
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

function StyleGuideFooter({
  jobActive,
  model,
  onReset,
}: {
  jobActive: boolean;
  model: ReturnType<typeof useStyleGuideModalModel>;
  onReset: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-footer">
      <StyleGuideBudgetSummary budget={model.budget} locale={model.locale} />
      <div className="style-guide-footer-actions">
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
        <Button
          variant="primary"
          onClick={() => void model.saveGuide()}
          disabled={!model.guide || model.working}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
