import { useTranslation } from "react-i18next";
import React from "react";
import settingsMenuImage from "../../assets/images/mcp-claude/claude-settings-menu.png";
import connectorsImage from "../../assets/images/mcp-claude/claude-connectors.png";
import addConnectorImage from "../../assets/images/mcp-claude/claude-add-custom-connector.png";
import addressImage from "../../assets/images/mcp-claude/claude-connector-address-redacted.png";
import authImage from "../../assets/images/mcp-claude/claude-connector-auth-redacted.png";
import connectImage from "../../assets/images/mcp-claude/claude-connect-redacted.png";
import { Button } from "../ui/Button";
import { GuideImage } from "./McpGuideImage";
import styles from "./McpSettingsPanel.module.css";

type RunAction = (action: () => Promise<unknown>) => Promise<void>;

/** A copyable terminal snippet built from the live server address. */
export function McpCommandCopy({
  commands,
  busy,
  run,
  label,
}: {
  commands: string | null;
  busy: boolean;
  run: RunAction;
  label?: string;
}) {
  const { t } = useTranslation("components");
  const [copied, setCopied] = React.useState(false);
  if (!commands)
    return (
      <p className={styles.note}>
        {t("mcpGuideCopy.enableMcpToDisplayAConnectionCommandWithThis")}
      </p>
    );
  return (
    <div className={styles.commandRow}>
      <pre className={styles.command}>
        <code>{commands}</code>
      </pre>
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await navigator.clipboard.writeText(commands);
            setCopied(true);
          })
        }
      >
        {copied
          ? t("errorReport.deviceCopied")
          : (label ?? t("mcpGuideCopy.copyCommand"))}
      </Button>
    </div>
  );
}

/** Claude's web and desktop apps add the server as a custom connector. */
export function ClaudeGuide() {
  const { t } = useTranslation("components");
  return (
    <ol className={`${styles.setupSteps} ${styles.visualSteps}`}>
      <li data-guide-step="settings">
        <strong>{t("workspace.empty.openSettings")}</strong>
        <p>{t("mcpGuideCopy.clickYourNameAtTheBottomLeftOfClaude")}</p>
        <GuideImage
          src={settingsMenuImage}
          title={t("mcpGuideCopy.settingsInTheNameMenu")}
          kind="menu"
        />
      </li>
      <li data-guide-step="connectors">
        <strong>{t("mcpGuideCopy.connectorsAddAddCustomConnector")}</strong>
        <p>{t("mcpGuideCopy.openConnectorsNearTheBottomOfSettingsLeftList")}</p>
        <GuideImage
          src={connectorsImage}
          title={t("mcpGuideCopy.connectorsInSettings")}
        />
        <GuideImage
          src={addConnectorImage}
          title={t("mcpGuideCopy.addCustomConnectorInTheAddMenu")}
          kind="menu"
        />
      </li>
      <li data-guide-step="address">
        <strong>{t("mcpGuideCopy.enterNameAndConnectionUrl")}</strong>
        <dl className={styles.guideFields}>
          <dt>{t("styleGuide.usage.sort.name")}</dt>
          <dd>{t("common:app.title")}</dd>
          <dt>{t("mcpGuideCopy.url")}</dt>
          <dd>{t("mcpGuideCopy.copyTheConnectionUrlFromAboveAndPasteIt")}</dd>
        </dl>
        <p>{t("mcpGuideCopy.clickContinue")}</p>
        <GuideImage
          src={addressImage}
          title={t("mcpGuideCopy.customConnectorNameAndUrlUrlHiddenInThis")}
          kind="form"
        />
      </li>
      <ClaudeConnectSteps />
      <li data-guide-step="request">
        <strong>{t("mcpGuideCopy.requestWorkInANewConversation")}</strong>
        <p>
          {t("mcpGuideCopy.enableCarrotMangaTranslatorInTheConversationSTools")}
        </p>
        <blockquote className={styles.example}>
          {t("mcpGuideCopy.reviewMyEditsToThePreviousChapterAndHandle")}
        </blockquote>
      </li>
    </ol>
  );
}

/** Keep the detected sign-in options, then connect and approve in the app. */
function ClaudeConnectSteps() {
  const { t } = useTranslation("components");
  return (
    <>
      <li data-guide-step="auth">
        <strong>
          {t("mcpGuideCopy.keepTheDetectedAuthenticationOptionsAndAdd")}
        </strong>
        <p>
          {t("mcpGuideCopy.leaveSignInNowAndAutomaticRegistrationAsDetected")}
        </p>
        <GuideImage
          src={authImage}
          title={t(
            "mcpGuideCopy.customConnectorAuthenticationUrlHiddenInThisExample",
          )}
          kind="form"
        />
      </li>
      <li data-guide-step="connect">
        <strong>{t("mcpGuideCopy.connectCompareCodesAndApprove")}</strong>
        <p>
          {t("mcpGuideCopy.clickConnectToOpenApprovalInYourBrowserCompare")}
        </p>
        <GuideImage
          src={connectImage}
          title={t(
            "mcpGuideCopy.connectorSConnectButtonUrlHiddenInThisExample",
          )}
          kind="form"
        />
      </li>
    </>
  );
}

/** The shared three steps for CLI clients: register, approve, then ask. */
export function McpCliSteps({
  registerTitle,
  registration,
  approveTitle,
  approveNote,
  requestNote,
}: {
  registerTitle: string;
  registration: React.ReactNode;
  approveTitle: string;
  approveNote: string;
  requestNote: string;
}) {
  const { t } = useTranslation("components");
  return (
    <ol className={styles.setupSteps}>
      <li>
        <strong>{registerTitle}</strong>
        {registration}
      </li>
      <li>
        <strong>{approveTitle}</strong>
        <p className={styles.note}>{approveNote}</p>
      </li>
      <li>
        <strong>{t("mcpGuideCopy.requestWorkInANewConversation")}</strong>
        <p className={styles.note}>{requestNote}</p>
        <blockquote className={styles.example}>
          {t("mcpGuideCopy.reviewMyEditsToThePreviousChapterAndHandle")}
        </blockquote>
      </li>
    </ol>
  );
}

/** Claude Code registers the server from its CLI, like Codex. */
export function ClaudeCodeGuide({
  url,
  busy,
  run,
}: {
  url?: string | null;
  busy: boolean;
  run: RunAction;
}) {
  const { t } = useTranslation("components");
  return (
    <McpCliSteps
      registerTitle={t("mcpGuideCopy.registerTheServerInClaudeCode")}
      registration={
        <>
          <p className={styles.note}>
            {t("mcpGuideCopy.runThisInATerminalOnThePcWith")}
          </p>
          <McpCommandCopy
            commands={
              url
                ? `claude mcp add --transport http --scope user carrot ${JSON.stringify(url)}`
                : null
            }
            busy={busy}
            run={run}
          />
        </>
      }
      approveTitle={t("mcpGuideCopy.authenticateInMcpAndApprove")}
      approveNote={t(
        "mcpGuideCopy.inClaudeCodeChooseMcpCarrotAuthenticateCompareThe",
      )}
      requestNote={t(
        "mcpGuideCopy.afterConnectingStartANewClaudeCodeConversationKeep",
      )}
    />
  );
}
