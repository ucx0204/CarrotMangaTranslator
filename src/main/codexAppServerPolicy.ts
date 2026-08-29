const CODEX_APP_SERVER_COMMON_CONFIG_OVERRIDES = [
  'cli_auth_credentials_store="file"',
  'forced_login_method="chatgpt"',
  'history.persistence="none"',
  "project_doc_max_bytes=0",
  "project_doc_fallback_filenames=[]",
  "mcp_servers={}",
  "apps={}",
  "plugins={}",
  "marketplaces={}",
  "check_for_update_on_startup=false",
  "feedback.enabled=false",
] as const;

const CODEX_APP_SERVER_DISABLED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "computer_use",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_chat",
  "in_app_dictation",
  "in_app_local_automation",
  "in_app_updates",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugin_sharing",
  "plugins",
  "remote_plugin",
  "request_permissions_tool",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "web_search",
  "workspace_dependencies",
] as const;

export type CodexAppServerCapability = "isolated" | "research";

export function buildCodexAppServerArguments(
  capability: CodexAppServerCapability,
): readonly string[] {
  const disabledFeatures = CODEX_APP_SERVER_DISABLED_FEATURES.filter(
    (feature) => capability !== "research" || feature !== "web_search",
  );
  return [
    "app-server",
    ...CODEX_APP_SERVER_COMMON_CONFIG_OVERRIDES.flatMap((override) => [
      "-c",
      override,
    ]),
    "-c",
    `web_search="${capability === "research" ? "live" : "disabled"}"`,
    ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
    "--strict-config",
    "--listen",
    "stdio://",
  ];
}

export const CODEX_APP_SERVER_ARGUMENTS =
  buildCodexAppServerArguments("isolated");
export const CODEX_APP_SERVER_RESEARCH_ARGUMENTS =
  buildCodexAppServerArguments("research");
