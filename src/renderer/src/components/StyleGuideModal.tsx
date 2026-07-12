import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/settingsTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { Button, Modal } from "./ui";
import {
  StyleGuideAnalysisActions,
  StyleGuideBudgetSummary,
  StyleGuideTabContent,
  StyleGuideTabs,
} from "./styleGuide/StyleGuideChrome";
import { useStyleGuideModalModel } from "./styleGuide/useStyleGuideModalModel";

type StyleGuideModalProps = {
  chapter: ChapterSnapshot;
  settings: AppSettings | null;
  onClose: () => void;
};

export function StyleGuideModal({
  chapter,
  settings,
  onClose,
}: StyleGuideModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useStyleGuideModalModel(chapter, settings);
  return (
    <Modal
      title={t("styleGuide.title")}
      size="xl"
      onClose={onClose}
      closeOnBackdrop
      bodyClassName="style-guide-body"
      footer={
        <div className="style-guide-footer">
          <StyleGuideBudgetSummary
            budget={model.budget}
            locale={model.locale}
          />
          <div className="style-guide-footer-actions">
            <Button
              variant="primary"
              onClick={() => void model.saveGuide()}
              disabled={
                !model.guide || model.saving || model.analyzingScope !== null
              }
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
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
        tab={model.tab}
      />
    </Modal>
  );
}
