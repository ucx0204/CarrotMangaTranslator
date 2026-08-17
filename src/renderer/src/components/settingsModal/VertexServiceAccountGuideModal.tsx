import React from "react";
import { Trans, useTranslation } from "react-i18next";
import type { VertexSetupPageId } from "../../../../shared/apiProviderPresets";
import { settingsGateway } from "../../api/settingsGateway";
import { Modal } from "../ui/Modal";
import { ModalActionBar, ModalActionButtons } from "../ui/ModalActionBar";
import styles from "./VertexServiceAccountGuideModal.module.css";

export function VertexServiceAccountGuideModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const pageOpener = useVertexSetupPageOpener();

  return (
    <Modal
      title={t("settings.api.vertexGuide.title")}
      onClose={onClose}
      closeOnBackdrop
      size="lg"
      width="min(820px, calc(100vw - 24px))"
      bodyClassName={styles.body}
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              confirm={{
                label: t("common.close"),
                onClick: onClose,
              }}
            />
          }
        />
      }
    >
      <VertexGuideSteps pageOpener={pageOpener} />
      <div className={styles.notices}>
        <VertexGuideIntro />
        <VertexGuideSecurity />
      </div>
      {pageOpener.openError ? (
        <p className={styles.error} role="alert">
          {t("settings.api.vertexGuide.openError")}
        </p>
      ) : null}
    </Modal>
  );
}

type VertexSetupPageOpener = {
  openingPage: VertexSetupPageId | null;
  openError: boolean;
  openPage: (page: VertexSetupPageId) => Promise<void>;
};

function useVertexSetupPageOpener(): VertexSetupPageOpener {
  const [openingPage, setOpeningPage] =
    React.useState<VertexSetupPageId | null>(null);
  const [openError, setOpenError] = React.useState(false);
  const openPage = async (page: VertexSetupPageId): Promise<void> => {
    setOpeningPage(page);
    setOpenError(false);
    try {
      await settingsGateway.openVertexSetupPage(page);
    } catch (_error) {
      setOpenError(true);
    } finally {
      setOpeningPage(null);
    }
  };
  return { openingPage, openError, openPage };
}

const LINKED_GUIDE_STEPS = [
  [1, "project", "project-create"],
  [2, "api", "vertex-ai-api"],
  [3, "account", "service-accounts"],
] as const;

function VertexGuideSteps({
  pageOpener,
}: {
  pageOpener: VertexSetupPageOpener;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ol className={styles.steps}>
      {LINKED_GUIDE_STEPS.map(([number, key, page]) => (
        <GuideStep
          key={page}
          number={number}
          title={t(`settings.api.vertexGuide.${key}.title`)}
          description={<GuideDescription name={key} />}
          action={
            <GuideLinkButton
              label={t(`settings.api.vertexGuide.${key}.action`)}
              page={page}
              openingPage={pageOpener.openingPage}
              onOpen={pageOpener.openPage}
            />
          }
        >
          {key === "account" ? <RequiredRole /> : null}
        </GuideStep>
      ))}
      <GuideStep
        number={4}
        title={t("settings.api.vertexGuide.key.title")}
        description={<GuideDescription name="key" />}
      >
        <code className={styles.exampleEmail}>
          vertex-ai@YOUR_PROJECT_ID.iam.gserviceaccount.com
        </code>
      </GuideStep>
      <GuideStep
        number={5}
        title={t("settings.api.vertexGuide.app.title")}
        description={<GuideDescription name="app" />}
      />
    </ol>
  );
}

type GuideDescriptionName =
  | (typeof LINKED_GUIDE_STEPS)[number][1]
  | "key"
  | "app";

function GuideDescription({
  name,
}: {
  name: GuideDescriptionName;
}): React.JSX.Element {
  return (
    <Trans
      i18nKey={`settings.api.vertexGuide.${name}.description`}
      ns="components"
      components={{
        highlight: <strong className={styles.highlight} />,
      }}
    />
  );
}

function RequiredRole(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.roleBox}>
      <span>{t("settings.api.vertexGuide.account.roleLabel")}</span>
      <strong>{t("settings.api.vertexGuide.account.roleName")}</strong>
      <code>roles/aiplatform.user</code>
    </div>
  );
}

function VertexGuideIntro(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <aside className={styles.intro}>
      <span className={styles.introIcon} aria-hidden="true">
        ✓
      </span>
      <p>{t("settings.api.vertexGuide.intro")}</p>
    </aside>
  );
}

function VertexGuideSecurity(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <aside className={styles.security}>
      <span className={styles.securityIcon} aria-hidden="true">
        !
      </span>
      <p>{t("settings.api.vertexGuide.security.description")}</p>
    </aside>
  );
}

function GuideStep({
  action,
  children,
  description,
  number,
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  description: React.ReactNode;
  number: number;
  title: string;
}): React.JSX.Element {
  return (
    <li className={styles.step}>
      <span className={styles.stepNumber} aria-hidden="true">
        {number}
      </span>
      <div className={styles.stepContent}>
        <div className={styles.stepHeader}>
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          {action}
        </div>
        {children}
      </div>
    </li>
  );
}

function GuideLinkButton({
  label,
  onOpen,
  openingPage,
  page,
}: {
  label: string;
  onOpen: (page: VertexSetupPageId) => Promise<void>;
  openingPage: VertexSetupPageId | null;
  page: VertexSetupPageId;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.linkButton}
      disabled={openingPage !== null}
      onClick={() => void onOpen(page)}
    >
      {openingPage === page ? `${label}…` : label}
    </button>
  );
}
