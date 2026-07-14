import React from "react";
import { useTranslation } from "react-i18next";
import { settingsGateway } from "./settingsGateway";
import type { TestState } from "../settingsModalTypes";
import { SettingsSection } from "./SettingsSection";

type TestSettingsPanelProps = {
  canSubmit: boolean;
  controlsBusy: boolean;
  jobActive: boolean;
  runModelTest: () => Promise<void>;
  testLogLines: string[];
  testLogRef: React.RefObject<HTMLDivElement | null>;
  testState: TestState;
};

export function TestSettingsPanel({
  canSubmit,
  controlsBusy,
  jobActive,
  runModelTest,
  testLogLines,
  testLogRef,
  testState,
}: TestSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-panel-stack">
      <UpdateSection />
      <SettingsSection
        title={t("settings.test.title")}
        description={t("settings.test.description")}
      >
        <div className="settings-inline-actions">
          <button
            type="button"
            onClick={() => void runModelTest()}
            disabled={controlsBusy || !canSubmit || jobActive}
          >
            {testState.status === "running"
              ? t("settings.test.running")
              : t("settings.test.run")}
          </button>
        </div>
        {jobActive ? (
          <p className="muted-line">{t("settings.test.jobActive")}</p>
        ) : null}
        {testState.status !== "idle" ? (
          <div className={`settings-test-result ${testState.status}`}>
            <strong>{testState.message}</strong>
            {testState.detail ? <p>{testState.detail}</p> : null}
          </div>
        ) : null}
        {testLogLines.length > 0 ? (
          <div
            className="settings-test-log"
            ref={testLogRef}
            aria-label={t("settings.test.logAria")}
          >
            {testLogLines.map((line, index) => (
              <code key={`${index}-${line}`}>{line}</code>
            ))}
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}

function UpdateSection(): React.JSX.Element {
  const { t } = useTranslation("components");
  const [info, setInfo] = React.useState<{
    currentVersion: string;
    releasesUrl: string;
  } | null>(null);

  React.useEffect(() => {
    let active = true;
    void settingsGateway
      .getAppUpdateInfo()
      .then((result) => {
        if (active) {
          setInfo(result);
        }
      })
      .catch((error) => {
        console.error("Failed to read app update info", error);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <SettingsSection
      title={t("settings.update.title")}
      description={t("settings.update.description")}
    >
      <p className="muted-line">
        {info
          ? t("settings.update.currentVersion", {
              version: info.currentVersion,
            })
          : t("settings.update.checkingVersion")}
      </p>
      <div className="settings-inline-actions">
        <button
          type="button"
          onClick={() => {
            void settingsGateway.openReleasesPage().catch((error) => {
              console.error("Failed to open releases page", error);
            });
          }}
        >
          {t("settings.update.check")}
        </button>
      </div>
    </SettingsSection>
  );
}
