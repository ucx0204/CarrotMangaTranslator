import { useTranslation } from "react-i18next";
import sidebarImage from "../../assets/images/mcp-chatgpt/plugins-sidebar.png";
import addImage from "../../assets/images/mcp-chatgpt/add-mcp-app.png";
import createImage from "../../assets/images/mcp-chatgpt/create-app-redacted.png";
import installedImage from "../../assets/images/mcp-chatgpt/installed-plugin.png";
import manageImage from "../../assets/images/mcp-chatgpt/manage-plugin.png";
import permissionSettingsImage from "../../assets/images/mcp-chatgpt/permission-settings.png";
import permissionsImage from "../../assets/images/mcp-chatgpt/tool-permissions.png";
import { GuideImage } from "./McpGuideImage";
import styles from "./McpSettingsPanel.module.css";

/** ChatGPT registers the server as an MCP app through its plugin screens. */
export function ChatgptGuide() {
  const { t } = useTranslation("components");
  return (
    <ol className={`${styles.setupSteps} ${styles.visualSteps}`}>
      <li data-guide-step="plugins">
        <strong>{t("mcpGuideCopy.openPluginsInTheLeftPanel")}</strong>
        <p>{t("mcpGuideCopy.clickTheSelectedPluginIconShownBelow")}</p>
        <GuideImage
          src={sidebarImage}
          title={t("mcpGuideCopy.pluginIconInTheLeftPanel")}
          kind="sidebar"
        />
      </li>
      <li data-guide-step="add">
        <strong>{t("mcpGuideCopy.addCreateMcpApp")}</strong>
        <p>{t("mcpGuideCopy.clickAddAtTheTopRightOfPlugins")}</p>
        <GuideImage
          src={addImage}
          title={t("mcpGuideCopy.createMcpAppInTheAddMenu")}
        />
      </li>
      <li data-guide-step="create">
        <strong>{t("mcpGuideCopy.enterNameUrlAndAuthentication")}</strong>
        <dl className={styles.guideFields}>
          <dt>{t("styleGuide.usage.sort.name")}</dt>
          <dd>{t("common:app.title")}</dd>
          <dt>{t("settings.api.sections.connection")}</dt>
          <dd>{t("mcpGuideCopy.copyTheConnectionUrlFromAboveAndPasteIt")}</dd>
          <dt>{t("mcpGuideCopy.authentication")}</dt>
          <dd>
            {t("mcpGuideCopy.keepOauthAndTheAdvancedOauthSettingsUnchanged")}
          </dd>
        </dl>
        <p>{t("mcpGuideCopy.checkIUnderstandAndWantToContinueThenClick")}</p>
        <GuideImage
          src={createImage}
          title={t("mcpGuideCopy.createMcpAppConnectionUrlHiddenInThisExample")}
          kind="form"
        />
        <p className={styles.note}>
          {t("mcpGuideCopy.whenAuthenticationOpensCompareTheNumericCodesInThe")}
        </p>
      </li>
      <ChatgptPermissionsStep />
      <li data-guide-step="request">
        <strong>{t("mcpGuideCopy.requestWorkInANewConversation")}</strong>
        <p>{t("mcpGuideCopy.addCarrotMangaTranslatorToANewConversationAnd")}</p>
        <blockquote className={styles.example}>
          {t("mcpGuideCopy.reviewMyEditsToThePreviousChapterAndHandle")}
        </blockquote>
      </li>
    </ol>
  );
}

function ChatgptPermissionsStep() {
  const { t } = useTranslation("components");
  return (
    <li data-guide-step="permissions">
      <strong>
        {t("mcpGuideCopy.reduceConfirmationPrompts")}
        <span className={styles.note}>{t("batchEditorCopy.optional")}</span>
      </strong>
      <p>{t("mcpGuideCopy.openCarrotMangaTranslatorInInstalledPlugins")}</p>
      <GuideImage
        src={installedImage}
        title={t("mcpGuideCopy.carrotMangaTranslatorInInstalledPlugins")}
        kind="highlight"
      />
      <p data-guide-step="manage">
        {t("mcpGuideCopy.clickManageAtTheTopRight")}
      </p>
      <GuideImage
        src={manageImage}
        title={t("mcpGuideCopy.manageInThePluginMenu")}
        kind="menu"
      />
      <p>{t("mcpGuideCopy.clickPermissionsInTheManagementScreen")}</p>
      <GuideImage
        src={permissionSettingsImage}
        title={t("mcpGuideCopy.permissionsInTheManagementScreen")}
      />
      <p>
        {t("mcpGuideCopy.selectAllowAllToolsToContinueWithoutConfirmingEach")}
      </p>
      <GuideImage
        src={permissionsImage}
        title={t("mcpGuideCopy.allowAllToolsInThePermissionsMenu")}
      />
      <p className={styles.note}>
        {t(
          "mcpGuideCopy.thisAlsoAllowsEditsAndDeletionsWithoutConfirmationKeep",
        )}
      </p>
    </li>
  );
}
