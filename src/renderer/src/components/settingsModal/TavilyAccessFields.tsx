import React from "react";
import { useTranslation } from "react-i18next";
import {
  MIN_TAVILY_MAX_CREDITS_PER_RUN,
  type TavilyUsageSnapshot,
} from "../../../../shared/internetResearchTypes";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../../../../shared/settingsSecrets";
import { appGateway } from "../../api/appGateway";
import { settingsGateway } from "../../api/settingsGateway";
import { toast } from "../../lib/toastStore";
import { formatSettingsErrorMessage } from "../settingsModalHelpers";
import buttonStyles from "../ui/Button.module.css";
import { TextField } from "../ui/Field";
import { SettingsNumberField } from "./SettingsNumberField";

export type TavilyAccessFieldsProps = {
  apiKey: string;
  maxCreditsPerRun: string;
  controlsBusy: boolean;
  setApiKey: React.Dispatch<React.SetStateAction<string>>;
  setMaxCreditsPerRun: React.Dispatch<React.SetStateAction<string>>;
  onChange?: () => void;
};

const TAVILY_SITE_URL = "https://www.tavily.com/";

export function TavilyAccessFields(
  props: TavilyAccessFieldsProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const usage = useTavilyUsage(props.apiKey);
  return (
    <div className="settings-research-stack">
      <TextField
        density="comfortable"
        type="password"
        autoComplete="off"
        label={t("settings.research.tavily.apiKey")}
        value={props.apiKey}
        disabled={props.controlsBusy}
        placeholder={t("settings.research.tavily.apiKeyPlaceholder")}
        onChange={(event) => {
          props.onChange?.();
          props.setApiKey(event.target.value);
        }}
      />
      <button
        type="button"
        className="settings-external-link tavily-site-link"
        disabled={props.controlsBusy}
        onClick={() => void openTavilySite(t)}
      >
        {t("settings.research.tavily.openSite")}
      </button>
      <SettingsNumberField
        ariaLabel={t("settings.research.tavily.perRun")}
        value={props.maxCreditsPerRun}
        onValueChange={(value) => {
          props.onChange?.();
          props.setMaxCreditsPerRun(value);
        }}
        min={MIN_TAVILY_MAX_CREDITS_PER_RUN}
        disabled={props.controlsBusy}
      />
      <TavilyUsageCard
        apiKey={props.apiKey}
        controlsBusy={props.controlsBusy}
        usage={usage}
      />
    </div>
  );
}

function TavilyUsageCard({
  apiKey,
  controlsBusy,
  usage,
}: {
  apiKey: string;
  controlsBusy: boolean;
  usage: ReturnType<typeof useTavilyUsage>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="tavily-usage-card" aria-live="polite">
      <div>
        <strong>{t("settings.research.tavily.usageTitle")}</strong>
        <p>{formatTavilyUsage(usage.snapshot, usage.loading, t)}</p>
        {usage.snapshot?.account ? (
          <small>
            {t("settings.research.tavily.plan", {
              plan: usage.snapshot.account.plan || "-",
            })}
          </small>
        ) : null}
      </div>
      <button
        type="button"
        className={`${buttonStyles.button} ${buttonStyles.secondary}`}
        onClick={() => void usage.refresh(true)}
        disabled={controlsBusy || usage.loading || !apiKey.trim()}
      >
        <span className={buttonStyles.label}>
          {usage.loading
            ? t("settings.research.tavily.checking")
            : t("settings.research.tavily.check")}
        </span>
      </button>
      {usage.error ? (
        <p className="codex-account-error">{usage.error}</p>
      ) : null}
    </section>
  );
}

async function openTavilySite(
  t: ReturnType<typeof useTranslation>["t"],
): Promise<void> {
  try {
    await appGateway.openResearchSource(TAVILY_SITE_URL);
  } catch (error) {
    console.error(error);
    toast.error(t("settings.research.tavily.openSiteFailed"));
  }
}

function useTavilyUsage(apiKey: string) {
  const { t } = useTranslation("components");
  const [snapshot, setSnapshot] = React.useState<TavilyUsageSnapshot | null>(
    null,
  );
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const latestRequestId = React.useRef(0);
  const refresh = React.useCallback(
    async (force = false) => {
      if (!apiKey.trim()) return;
      const requestId = ++latestRequestId.current;
      setLoading(true);
      setError(null);
      try {
        const next = await settingsGateway.getTavilyUsage({ apiKey, force });
        if (requestId === latestRequestId.current) setSnapshot(next);
      } catch (caught) {
        if (requestId === latestRequestId.current) {
          setError(
            formatSettingsErrorMessage(
              caught,
              t(resolveTavilyUsageErrorKey(caught)),
            ),
          );
        }
      } finally {
        if (requestId === latestRequestId.current) setLoading(false);
      }
    },
    [apiKey, t],
  );
  React.useEffect(() => {
    latestRequestId.current += 1;
    setSnapshot(null);
    setError(null);
    setLoading(false);
    if (apiKey === SETTINGS_SECRET_PRESERVE_SENTINEL) void refresh(false);
  }, [apiKey, refresh]);
  return { snapshot, loading, error, refresh };
}

function resolveTavilyUsageErrorKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|api 키가 올바르지|unauthori[sz]ed/i.test(message)) {
    return "settings.research.tavily.invalidKey";
  }
  if (/432|433|크레딧 한도|credit.+limit|quota/i.test(message)) {
    return "settings.research.tavily.quotaReached";
  }
  if (/429|요청이 너무 많|too many|rate.?limit/i.test(message)) {
    return "settings.research.tavily.rateLimited";
  }
  if (/응답 형식|json 객체|invalid.+response/i.test(message)) {
    return "settings.research.tavily.invalidResponse";
  }
  if (/fetch|network|enotfound|timed? ?out|timeout|econn/i.test(message)) {
    return "settings.research.tavily.networkFailed";
  }
  return "settings.research.tavily.checkFailed";
}

function formatTavilyUsage(
  snapshot: TavilyUsageSnapshot | null,
  loading: boolean,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (loading && !snapshot) return t("settings.research.tavily.checking");
  const account = snapshot?.account ?? snapshot?.key;
  if (!account) return t("settings.research.tavily.usageUnavailable");
  return t("settings.research.tavily.usage", {
    used: account.used,
    limit: account.limit,
    remaining: account.remaining,
  });
}
