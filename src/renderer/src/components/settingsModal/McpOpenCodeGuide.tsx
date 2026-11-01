import { useTranslation } from "react-i18next";
import React from "react";
import { McpCliSteps, McpCommandCopy } from "./McpClaudeGuide";
import styles from "./McpSettingsPanel.module.css";

export function OpenCodeGuide({
  url,
  busy,
  run,
}: {
  url?: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useTranslation("components");
  const config = url
    ? JSON.stringify(
        {
          mcp: { carrot: { type: "remote", url, enabled: true, oauth: {} } },
        },
        null,
        2,
      )
    : null;
  return (
    <McpCliSteps
      registerTitle={t("mcpGuideCopy.addCarrotToOpencodeSettings")}
      registration={
        <>
          <p className={styles.note}>
            {t("mcpGuideCopy.addTheMcpCarrotEntryBelowToYourExisting")}
          </p>
          <McpCommandCopy
            commands={config}
            label={t("mcpGuideCopy.copySettings")}
            busy={busy}
            run={run}
          />
          <p className={styles.note}>
            {t(
              "mcpGuideCopy.afterRegistrationAuthenticateInTheTerminalAndCheckThe",
            )}
          </p>
          <McpCommandCopy
            commands={
              url ? "opencode mcp auth carrot\nopencode mcp list" : null
            }
            label={t("mcpGuideCopy.copyAuthenticationCommand")}
            busy={busy}
            run={run}
          />
        </>
      }
      approveTitle={t("mcpGuideCopy.compareCodesAndApprove")}
      approveNote={t("mcpGuideCopy.compareTheCodesInTheBrowserAndCarrotThen")}
      requestNote={t(
        "mcpGuideCopy.keepCarrotOpenWhileMakingRequestsInOpencode",
      )}
    />
  );
}

export function GenericMcpGuide({ url }: { url?: string | null }) {
  const { t } = useTranslation("components");
  return (
    <>
      <dl className={styles.guideFields}>
        <dt>{t("mcpGuideCopy.serverAddress")}</dt>
        <dd className={styles.address}>
          {url ?? t("mcpGuideCopy.shownWhenMcpIsEnabled")}
        </dd>
        <dt>{t("mcpGuideCopy.transport")}</dt>
        <dd>HTTP (Streamable HTTP)</dd>
        <dt>{t("mcpGuideCopy.authentication")}</dt>
        <dd>OAuth</dd>
      </dl>
      <ol className={styles.setupSteps}>
        <li>
          <strong>{t("mcpGuideCopy.addRemoteMcpServer")}</strong>
          <p>{t("mcpGuideCopy.enterTheUrlAboveInYourAppSMcp")}</p>
        </li>
        <li>
          <strong>{t("mcpGuideCopy.compareCodesAndApprove")}</strong>
          <p>{t("mcpGuideCopy.compareTheCodesInTheBrowserAndCarrotThen")}</p>
        </li>
        <li>
          <strong>{t("mcpGuideCopy.requestWork")}</strong>
          <p>{t("mcpGuideCopy.keepCarrotOpenAndAskYourAiAppTo")}</p>
        </li>
      </ol>
    </>
  );
}
