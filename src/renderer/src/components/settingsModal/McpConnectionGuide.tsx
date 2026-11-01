import { useTranslation } from "react-i18next";
import { appI18n } from "../../appI18n";
import React from "react";
import { mcpGateway } from "../../api/mcpGateway";
import { Button } from "../ui/Button";
import { Tabs } from "../ui/Tabs";
import { ChatgptGuide } from "./McpChatgptGuide";
import { OpenCodeGuide, GenericMcpGuide } from "./McpOpenCodeGuide";
import { GrokGuide, GrokBuildGuide } from "./McpGrokGuide";
import {
  ClaudeCodeGuide,
  ClaudeGuide,
  McpCliSteps,
  McpCommandCopy,
} from "./McpClaudeGuide";
import styles from "./McpSettingsPanel.module.css";

const t = appI18n.getFixedT(null, "components");

const MCP_CLIENTS = [
  "codex",
  "chatgpt",
  "claude",
  "claude-code",
  "opencode",
  "grok",
  "grok-build",
  "generic",
] as const;
type McpClient = (typeof MCP_CLIENTS)[number];
const CLIENT_LABELS: Record<McpClient, string> = {
  codex: "Codex",
  chatgpt: "ChatGPT",
  claude: "Claude",
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  get grok() {
    return t("mcpGuideCopy.grokWeb");
  },
  "grok-build": "Grok Build",
  get generic() {
    return t("mcpGuideCopy.otherMcpApp");
  },
};
const HELP_LABELS: Record<McpClient, string> = {
  get codex() {
    return t("mcpGuideCopy.codexConnectionDocs");
  },
  get chatgpt() {
    return t("mcp.openChatgpt");
  },
  get claude() {
    return t("mcpGuideCopy.openClaude");
  },
  get "claude-code"() {
    return t("mcpGuideCopy.claudeCodeConnectionDocs");
  },
  get opencode() {
    return t("mcpGuideCopy.opencodeConnectionDocs");
  },
  get grok() {
    return t("mcpGuideCopy.openGrokConnectors");
  },
  get "grok-build"() {
    return t("mcpGuideCopy.grokBuildConnectionDocs");
  },
  get generic() {
    return t("mcpGuideCopy.mcpConnectionDocs");
  },
};

export function McpTailscaleGuide({
  busy,
  run,
}: {
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  useTranslation();
  return (
    <div className={styles.body}>
      <ol
        className={styles.setupSteps}
        aria-label={t("mcpGuideCopy.tailscaleSetup")}
      >
        <li>
          <strong>{t("mcpGuideCopy.installTailscale")}</strong>
          <p className={styles.note}>
            {t("mcpGuideCopy.installItOnThePcRunningCarrot")}
          </p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => mcpGateway.openMcpHelp("tailscale"))}
          >
            {t("mcpGuideCopy.downloadTailscale")}
          </Button>
        </li>
        <li>
          <strong>{t("mcpGuideCopy.signInAndConnectThePc")}</strong>
          <p className={styles.note}>
            {t("mcpGuideCopy.windowsHiddenIconsBesideTheClockUpArrowRight")}
          </p>
          <p className={styles.note}>
            {t("mcpGuideCopy.logInSignInInTheBrowserConnectOn")}
          </p>
        </li>
        <li>
          <strong>{t("mcp.enable")}</strong>
          <p className={styles.note}>
            {t("mcpGuideCopy.clickEnableMcpAboveIfTailscaleAsksForPermission")}
          </p>
        </li>
        <li>
          <strong>{t("mcpGuideCopy.connectAnAiApp")}</strong>
          <p className={styles.note}>
            {t("mcpGuideCopy.waitForReadyToConnectDiagnoseConnectionCopyUrl")}
          </p>
        </li>
      </ol>
      <p className={styles.note}>
        {t("mcpGuideCopy.keepCarrotAndTailscaleRunningWhileInUse")}
      </p>
      <p className={styles.note}>
        {t("mcpGuideCopy.signInErrorCheckLogInAndConnectIn")}
      </p>
      <p className={styles.note}>
        {t("mcpGuideCopy.port443InUseTurnOffMcpInOther")}
      </p>
    </div>
  );
}

export function McpConnectionGuide({
  url,
  busy,
  run,
}: {
  url?: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  useTranslation();
  const [client, setClient] = React.useState<McpClient>("codex");
  const id = React.useId();
  return (
    <div className={styles.body}>
      <Tabs
        ariaLabel={t("mcpGuideCopy.aiAppToConnect")}
        className={styles.clientTabs}
        tabClassName={styles.clientTab}
        value={client}
        onChange={setClient}
        items={MCP_CLIENTS.map((value) => ({
          value,
          label: CLIENT_LABELS[value],
          id: `${id}-${value}`,
          panelId: `${id}-${value}-panel`,
        }))}
      />
      <div
        role="tabpanel"
        id={`${id}-${client}-panel`}
        aria-labelledby={`${id}-${client}`}
        className={styles.body}
      >
        {client === "opencode" ? (
          <OpenCodeGuide url={url} busy={busy} run={run} />
        ) : client === "grok" ? (
          <GrokGuide url={url} />
        ) : client === "grok-build" ? (
          <GrokBuildGuide url={url} busy={busy} run={run} />
        ) : client === "generic" ? (
          <GenericMcpGuide url={url} />
        ) : client === "claude-code" ? (
          <ClaudeCodeGuide url={url} busy={busy} run={run} />
        ) : client === "claude" ? (
          <ClaudeGuide />
        ) : client === "chatgpt" ? (
          <ChatgptGuide />
        ) : (
          <McpCliSteps
            registerTitle={t("mcpGuideCopy.registerTheServerInCodex")}
            registration={<CodexRegistration url={url} busy={busy} run={run} />}
            approveTitle={t("mcpGuideCopy.compareCodesAndApprove")}
            approveNote={t(
              "mcpGuideCopy.compareTheNumericCodesInTheBrowserAndThe",
            )}
            requestNote={t(
              "mcpGuideCopy.afterConnectingOpenANewTaskInCodexKeep",
            )}
          />
        )}
        <div className={styles.actions}>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(() => mcpGateway.openMcpHelp(client))}
          >
            {HELP_LABELS[client]}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CodexRegistration({
  url,
  busy,
  run,
}: {
  url?: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  useTranslation();
  return (
    <>
      <p className={styles.note}>
        {t("mcpGuideCopy.runBothLinesInOrderInATerminalOn")}
      </p>
      <McpCommandCopy
        commands={
          url
            ? `codex mcp add carrot --url ${JSON.stringify(url)}\ncodex mcp login carrot`
            : null
        }
        busy={busy}
        run={run}
      />
    </>
  );
}
