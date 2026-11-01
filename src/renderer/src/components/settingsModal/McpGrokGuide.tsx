import { useTranslation } from "react-i18next";
import React from "react";
import connectorsImage from "../../assets/images/mcp-grok/grok-connectors.png";
import newConnectorImage from "../../assets/images/mcp-grok/grok-new-connector.png";
import formImage from "../../assets/images/mcp-grok/grok-connector-form.png";
import { McpCliSteps, McpCommandCopy } from "./McpClaudeGuide";
import { GuideImage } from "./McpGuideImage";
import styles from "./McpSettingsPanel.module.css";

export function GrokGuide({ url }: { url?: string | null }) {
  const { t } = useTranslation("components");
  return (
    <ol className={`${styles.setupSteps} ${styles.visualSteps}`}>
      <li>
        <strong>{t("mcpGuideCopy.pluginsNewConnector")}</strong>
        <p>{t("mcpGuideCopy.clickOpenGrokConnectorsBelowAndSignInClick")}</p>
        <GuideImage
          src={connectorsImage}
          title={t("mcpGuideCopy.newConnectorButtonInGrokSConnectorsTab")}
        />
      </li>
      <li>
        <strong>{t("mcpGuideCopy.selectCustomMode")}</strong>
        <p>{t("mcpGuideCopy.selectCustomAtTheTopOfTheNewConnector")}</p>
        <GuideImage
          src={newConnectorImage}
          title={t("mcpGuideCopy.customModeInTheNewConnectorWindow")}
          kind="menu"
        />
      </li>
      <li>
        <strong>{t("mcpGuideCopy.enterNameAndServerUrl")}</strong>
        <dl className={styles.guideFields}>
          <dt>{t("styleGuide.usage.sort.name")}</dt>
          <dd>{t("common:app.title")}</dd>
          <dt>{t("mcpGuideCopy.serverUrl")}</dt>
          <dd className={styles.address}>
            {url ?? t("mcpGuideCopy.shownWhenMcpIsEnabled")}
          </dd>
        </dl>
        <p>{t("mcpGuideCopy.copyTheUrlAboveIncludingMcpPasteItAnd")}</p>
        <GuideImage
          src={formImage}
          title={t(
            "mcpGuideCopy.customConnectorNameAndServerUrlBeforeEnteringUrl",
          )}
          kind="form"
        />
      </li>
      <li>
        <strong>
          {t("mcpGuideCopy.oauthAuthenticationCompareCodesAndApprove")}
        </strong>
        <p>
          {t("mcpGuideCopy.compareTheBrowserSCodeAndRequestedPermissionsWith")}
        </p>
      </li>
      <li>
        <strong>{t("mcpGuideCopy.requestWorkInANewConversation")}</strong>
        <p>{t("mcpGuideCopy.keepCarrotAndTailscaleRunningInGrokAskThe")}</p>
        <blockquote className={styles.example}>
          {t("mcpGuideCopy.listTheWorksAndChaptersInMyCarrotLibrary")}
        </blockquote>
      </li>
    </ol>
  );
}

export function GrokBuildGuide({
  url,
  busy,
  run,
}: {
  url?: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useTranslation("components");
  return (
    <McpCliSteps
      registerTitle={t("mcpGuideCopy.registerTheServerInGrokBuild")}
      registration={
        <>
          <p className={styles.note}>
            {t("mcpGuideCopy.runThisInATerminalOnThePcWith93")}
          </p>
          <McpCommandCopy
            commands={
              url
                ? `grok mcp add --transport http carrot ${JSON.stringify(url)}\ngrok mcp list`
                : null
            }
            busy={busy}
            run={run}
          />
        </>
      }
      approveTitle={t("mcpGuideCopy.authenticateInMcpsAndApprove")}
      approveNote={t("mcpGuideCopy.runGrokAndSignInInMcpsSelectCarrot")}
      requestNote={t(
        "mcpGuideCopy.startANewGrokBuildConversationAfterConnectingKeep",
      )}
    />
  );
}
