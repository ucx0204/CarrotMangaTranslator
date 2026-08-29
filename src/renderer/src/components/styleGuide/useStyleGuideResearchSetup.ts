import React from "react";
import { useTranslation } from "react-i18next";
import type { CodexAccountSnapshot } from "../../../../shared/codexAccountTypes";
import {
  MIN_TAVILY_MAX_CREDITS_PER_RUN,
  type ResearchEngine,
} from "../../../../shared/internetResearchTypes";
import type { AppSettings } from "../../../../shared/settingsTypes";
import { settingsGateway } from "../../api/settingsGateway";

type ResearchSetupInput = {
  engine: ResearchEngine;
  initialTitle: string;
  settings: AppSettings | null;
  onDismiss: () => void;
  onSaveSettings?: (settings: AppSettings) => Promise<AppSettings | null>;
  onSaveTitle: (title: string) => Promise<string>;
  onStart: (title: string) => Promise<void>;
};

export type StyleGuideResearchSetupController = ReturnType<
  typeof useStyleGuideResearchSetup
>;

export function useStyleGuideResearchSetup(input: ResearchSetupInput) {
  const { t } = useTranslation("components");
  const [title, setTitle] = React.useState(input.initialTitle);
  const [tavilyApiKey, setTavilyApiKey] = React.useState(
    input.settings?.internetResearch.tavilyApiKey ?? "",
  );
  const [tavilyMaxCredits, setTavilyMaxCredits] = React.useState(
    String(input.settings?.internetResearch.tavilyMaxCreditsPerRun ?? 10),
  );
  const [codexAccount, setCodexAccount] =
    React.useState<CodexAccountSnapshot | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const parsedCredits = Number(tavilyMaxCredits);
  const canStart =
    Boolean(title.trim()) &&
    isEngineReady(input.engine, {
      apiKey: tavilyApiKey,
      codexAccount,
      credits: parsedCredits,
    }) &&
    !busy;
  const startResearch = React.useCallback(async () => {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      await prepareSelectedEngine(
        input,
        tavilyApiKey,
        parsedCredits,
        t("styleGuide.research.setupFailed"),
      );
      const savedTitle = await input.onSaveTitle(title.trim());
      setBusy(false);
      input.onDismiss();
      void input.onStart(savedTitle);
    } catch (caught) {
      console.error(caught);
      setError(
        caught instanceof Error
          ? caught.message
          : t("styleGuide.research.setupFailed"),
      );
      setBusy(false);
    }
  }, [canStart, input, parsedCredits, t, tavilyApiKey, title]);
  return {
    busy,
    canStart,
    codexAccount,
    error,
    setCodexAccount,
    setTavilyApiKey,
    setTavilyMaxCredits,
    setTitle,
    startResearch,
    tavilyApiKey,
    tavilyMaxCredits,
    title,
  };
}

function isEngineReady(
  engine: ResearchEngine,
  values: {
    apiKey: string;
    codexAccount: CodexAccountSnapshot | null;
    credits: number;
  },
): boolean {
  if (engine === "codex-web")
    return values.codexAccount?.authenticated === true;
  return (
    Boolean(values.apiKey.trim()) &&
    Number.isSafeInteger(values.credits) &&
    values.credits >= MIN_TAVILY_MAX_CREDITS_PER_RUN
  );
}

async function prepareSelectedEngine(
  input: ResearchSetupInput,
  apiKey: string,
  maxCreditsPerRun: number,
  saveFailedMessage: string,
): Promise<void> {
  if (input.engine !== "tavily") return;
  await settingsGateway.getTavilyUsage({ apiKey, force: true });
  const current = await settingsGateway.getSettings();
  const next: AppSettings = {
    ...current,
    internetResearch: {
      ...current.internetResearch,
      tavilyApiKey: apiKey,
      tavilyMaxCreditsPerRun: maxCreditsPerRun,
    },
  };
  const saved = input.onSaveSettings
    ? await input.onSaveSettings(next)
    : await settingsGateway.saveSettings(next);
  if (!saved) throw new Error(saveFailedMessage);
}
