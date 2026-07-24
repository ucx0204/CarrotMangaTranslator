import React from "react";
import { useTranslation } from "react-i18next";
import {
  MODEL_PROVIDER_OPTIONS,
  findCodexModelOption,
} from "../settingsOptions";
import {
  MAX_MAX_TOKENS,
  MIN_CONTEXT_TOKENS,
  MIN_MAX_TOKENS,
  resolveRecommendedGenerationLimits,
} from "../../../../shared/modelPresets";
import type { ModelProvider } from "../../../../shared/settingsTypes";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { SelectionSurface } from "../ui/SelectionCard";

type TranslationEngineSelectorProps = Pick<
  EngineSettingsPanelProps,
  "clearTestState" | "controlsBusy" | "modelProvider" | "setModelProvider"
>;

export function TranslationEngineSelector({
  clearTestState,
  controlsBusy,
  modelProvider,
  setModelProvider,
}: TranslationEngineSelectorProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const selectProvider = (provider: ModelProvider): void => {
    clearTestState();
    setModelProvider(provider);
  };
  const moveProviderFocus = (
    event: React.KeyboardEvent<HTMLElement>,
    provider: ModelProvider,
  ): void => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const currentIndex = MODEL_PROVIDER_OPTIONS.findIndex(
      (option) => option.id === provider,
    );
    const direction =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const nextIndex =
      (currentIndex + direction + MODEL_PROVIDER_OPTIONS.length) %
      MODEL_PROVIDER_OPTIONS.length;
    const nextProvider = MODEL_PROVIDER_OPTIONS[nextIndex].id;
    selectProvider(nextProvider);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-provider-id="${nextProvider}"]`)
      ?.focus();
  };
  return (
    <div
      className="settings-provider-grid"
      role="radiogroup"
      aria-label={t("settings.engine.provider.label")}
    >
      {MODEL_PROVIDER_OPTIONS.map((option) => (
        <SelectionSurface
          key={option.id}
          as="button"
          type="button"
          role="radio"
          className="settings-provider-card"
          data-provider-id={option.id}
          selected={modelProvider === option.id}
          tabIndex={modelProvider === option.id ? 0 : -1}
          onClick={() => selectProvider(option.id)}
          onKeyDown={(event) => moveProviderFocus(event, option.id)}
          disabled={controlsBusy}
          aria-checked={modelProvider === option.id}
        >
          <span className="settings-provider-card-head">
            <strong>{t(option.labelKey)}</strong>
            <span className="settings-provider-marker" aria-hidden="true" />
          </span>
          <span className="settings-provider-card-description">
            {t(option.descriptionKey)}
          </span>
        </SelectionSurface>
      ))}
    </div>
  );
}

type GenerationLimitsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "apiModel"
  | "clearTestState"
  | "codexModel"
  | "contextTokens"
  | "controlsBusy"
  | "maxTokens"
  | "modelProvider"
  | "setContextTokens"
  | "setMaxTokens"
  | "submit"
>;

export function GenerationLimitsFields(
  props: GenerationLimitsFieldsProps,
): React.JSX.Element {
  const { i18n, t } = useTranslation("components");
  const recommendation = resolveLimitRecommendation(props);
  const numberFormatter = React.useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage],
  );
  const alreadyRecommended =
    Number(props.maxTokens) === recommendation.maxTokens &&
    Number(props.contextTokens) === recommendation.contextTokens;
  const modelLimits = resolveModelLimitsCopy({
    contextWindowTokens: recommendation.contextWindowTokens,
    maxOutputTokens: recommendation.maxOutputTokens,
    numberFormatter,
    t,
  });

  return (
    <div className="settings-limit-stack">
      <div className="settings-limit-toolbar">
        <div className="settings-limit-recommendation">
          <strong>
            {t("settings.engine.limits.recommendedFor", {
              model: recommendation.modelLabel,
            })}
          </strong>
          <span>
            {t("settings.engine.limits.recommendedValues", {
              contextTokens: numberFormatter.format(
                recommendation.contextTokens,
              ),
              maxTokens: numberFormatter.format(recommendation.maxTokens),
            })}
          </span>
          <small>{modelLimits}</small>
        </div>
        <button
          type="button"
          className="settings-limit-apply"
          disabled={props.controlsBusy || alreadyRecommended}
          onClick={() => {
            props.clearTestState();
            props.setMaxTokens(String(recommendation.maxTokens));
            props.setContextTokens(String(recommendation.contextTokens));
          }}
        >
          {alreadyRecommended
            ? t("settings.engine.limits.recommendedApplied")
            : t("settings.engine.limits.applyRecommended")}
        </button>
      </div>
      <div className="settings-limit-grid">
        <MaxTokensField {...props} />
        <ContextTokensField {...props} />
      </div>
    </div>
  );
}

type MaxTokensFieldProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "maxTokens"
  | "modelProvider"
  | "setMaxTokens"
  | "submit"
>;

function MaxTokensField({
  clearTestState,
  controlsBusy,
  maxTokens,
  modelProvider,
  setMaxTokens,
  submit,
}: MaxTokensFieldProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack settings-limit-field">
      <label>
        {t("settings.engine.maxTokens.label")}
        <input
          type="number"
          min={MIN_MAX_TOKENS}
          max={MAX_MAX_TOKENS}
          step={100}
          value={maxTokens}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setMaxTokens(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      </label>
      <p className="muted-line modal-note">
        {t(
          modelProvider === "gemma"
            ? "settings.engine.maxTokens.gemmaDescription"
            : "settings.engine.maxTokens.remoteDescription",
        )}
      </p>
    </div>
  );
}

type ContextTokensFieldProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "contextTokens"
  | "controlsBusy"
  | "modelProvider"
  | "setContextTokens"
  | "submit"
>;

function ContextTokensField({
  clearTestState,
  contextTokens,
  controlsBusy,
  modelProvider,
  setContextTokens,
  submit,
}: ContextTokensFieldProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack settings-limit-field">
      <label>
        {t(
          modelProvider === "gemma"
            ? "settings.engine.contextTokens.gemmaLabel"
            : "settings.engine.contextTokens.remoteLabel",
        )}
        <input
          type="number"
          min={MIN_CONTEXT_TOKENS}
          step={1024}
          value={contextTokens}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setContextTokens(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
      </label>
      <p className="muted-line modal-note">
        {t(
          modelProvider === "gemma"
            ? "settings.engine.contextTokens.gemmaDescription"
            : "settings.engine.contextTokens.remoteDescription",
        )}
      </p>
    </div>
  );
}

function resolveLimitRecommendation({
  apiModel,
  codexModel,
  modelProvider,
}: Pick<
  EngineSettingsPanelProps,
  "apiModel" | "codexModel" | "modelProvider"
>) {
  const model = resolveModelForProvider(modelProvider, codexModel, apiModel);
  const limits = resolveRecommendedGenerationLimits(modelProvider, model);
  const preset = findCodexModelOption(model ?? "");
  return {
    ...limits,
    modelLabel:
      modelProvider === "gemma"
        ? "Gemma"
        : (preset?.label ?? (model?.trim() || "Custom")),
  };
}

function resolveModelForProvider(
  provider: ModelProvider,
  codexModel: string,
  apiModel: string,
): string | null {
  if (provider === "openai-codex") {
    return codexModel;
  }
  if (provider === "openai-api") {
    return apiModel;
  }
  return null;
}

function resolveModelLimitsCopy({
  contextWindowTokens,
  maxOutputTokens,
  numberFormatter,
  t,
}: {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  numberFormatter: Intl.NumberFormat;
  t: ReturnType<typeof useTranslation>["t"];
}): string {
  if (contextWindowTokens && maxOutputTokens) {
    return t("settings.engine.limits.publicLimits", {
      contextWindow: numberFormatter.format(contextWindowTokens),
      maxOutput: numberFormatter.format(maxOutputTokens),
    });
  }
  if (contextWindowTokens) {
    return t("settings.engine.limits.publicContextOnly", {
      contextWindow: numberFormatter.format(contextWindowTokens),
    });
  }
  return t("settings.engine.limits.unknownLimits");
}
