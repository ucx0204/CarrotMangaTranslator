import React from "react";
import { CODEX_TYPESETTING_MODEL } from "../../../../shared/codexTypesettingDefaults";
import { useTranslation } from "react-i18next";
import type {
  CodexAccountModel,
  CodexAccountSnapshot,
} from "../../../../shared/codexAccountTypes";
import type { CodexReasoningEffort } from "../../../../shared/codexSettings";
import { CODEX_IMAGE_MODELS } from "../../../../shared/codexSettings";
import { CODEX_REASONING_OPTIONS } from "../settingsOptions";
import { Field } from "../ui/Field";
import { InlineMessage } from "../ui/InlineMessage";
import { Select } from "../ui/Select";
import { CodexAccountField } from "./CodexAccountField";

export type CodexSettingsFieldsProps = {
  imageOnly?: boolean;
  clearTestState: () => void;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexImageReasoningEffort?: CodexReasoningEffort;
  codexImageModel?: string;
  setCodexImageModel?: React.Dispatch<React.SetStateAction<string>>;
  setCodexImageReasoningEffort?: React.Dispatch<
    React.SetStateAction<CodexReasoningEffort>
  >;
  controlsBusy: boolean;
  setCodexModel: React.Dispatch<React.SetStateAction<string>>;
  setCodexReasoningEffort: React.Dispatch<
    React.SetStateAction<CodexReasoningEffort>
  >;
  onAccountSnapshotChange?: (snapshot: CodexAccountSnapshot | null) => void;
};

export function CodexSettingsFields(
  props: CodexSettingsFieldsProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const { onAccountSnapshotChange } = props;
  const [account, setAccount] = React.useState<CodexAccountSnapshot | null>(
    null,
  );
  const publishAccount = React.useCallback(
    (snapshot: CodexAccountSnapshot | null) => {
      setAccount(snapshot);
      onAccountSnapshotChange?.(snapshot);
    },
    [onAccountSnapshotChange],
  );
  const models = account?.models ?? [];
  const authenticated = account?.authenticated === true;
  const imageModel = props.codexImageModel ?? CODEX_TYPESETTING_MODEL;
  useCatalogSelectionRepair(props, account);

  return (
    <>
      <CodexAccountField
        controlsBusy={props.controlsBusy}
        onSnapshotChange={publishAccount}
      />
      {props.imageOnly ? (
        <>
          <div className="codex-catalog-fields">
            <Field
              as="div"
              className="codex-catalog-row"
              density="comfortable"
              variant="row"
              label={t("settings.codex.model")}
            >
              <Select
                ariaLabel={t("settings.codex.model")}
                value={imageModel}
                disabled={props.controlsBusy || !authenticated}
                options={CODEX_IMAGE_MODELS.map((id) => ({
                  value: id,
                  label:
                    models.find((model) => model.id === id)?.displayName ??
                    (id === "gpt-6-astra" ? "GPT-6 Astra" : "GPT-5.6 Sol"),
                  disabled: !models.some((model) => model.id === id),
                }))}
                onValueChange={(id) => {
                  props.clearTestState();
                  props.setCodexImageModel?.(id);
                }}
              />
            </Field>
            <CodexReasoningField
              {...props}
              models={models}
              controlsBusy={
                props.controlsBusy ||
                !authenticated ||
                !models.some((model) => model.id === imageModel)
              }
              image
            />
          </div>
          {imageModel !== CODEX_TYPESETTING_MODEL && (
            <InlineMessage
              variant="warning"
              title={t("settings.codex.imageModelWarning")}
            />
          )}
        </>
      ) : authenticated && models.length > 0 ? (
        <div className="codex-catalog-fields">
          <CodexModelField {...props} models={models} />
          <CodexReasoningField {...props} models={models} />
        </div>
      ) : null}
    </>
  );
}

function CodexModelField({
  clearTestState,
  codexModel,
  codexReasoningEffort,
  controlsBusy,
  models,
  setCodexModel,
  setCodexReasoningEffort,
}: CodexSettingsFieldsProps & {
  models: readonly CodexAccountModel[];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const activeModel = resolveCatalogModel(models, codexModel);
  return (
    <Field
      as="div"
      className="codex-catalog-row"
      density="comfortable"
      variant="row"
      label={t("settings.codex.model")}
      labelId="codex-model-label"
    >
      <Select
        ariaLabel={t("settings.codex.model")}
        value={activeModel.id}
        disabled={controlsBusy}
        options={models.map((model) => ({
          value: model.id,
          label: model.displayName,
        }))}
        onValueChange={(nextValue) => {
          const nextModel = models.find(
            (model) => model.id === nextValue,
          ) as CodexAccountModel;
          clearTestState();
          setCodexModel(nextModel.id);
          if (
            !nextModel.supportedReasoningEfforts.includes(codexReasoningEffort)
          ) {
            setCodexReasoningEffort(nextModel.defaultReasoningEffort);
          }
        }}
      />
    </Field>
  );
}

function CodexReasoningField({
  clearTestState,
  codexModel,
  codexReasoningEffort,
  controlsBusy,
  models,
  setCodexReasoningEffort,
  codexImageReasoningEffort,
  codexImageModel,
  setCodexImageReasoningEffort,
  image = false,
}: CodexSettingsFieldsProps & {
  models: readonly CodexAccountModel[];
  image?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = image
    ? models.find(
        (item) => item.id === (codexImageModel ?? CODEX_TYPESETTING_MODEL),
      )
    : resolveCatalogModel(models, codexModel);
  const selectedEffort = image
    ? (codexImageReasoningEffort ?? "low")
    : codexReasoningEffort;
  const label = image
    ? t("settings.codex.imageReasoning")
    : t("settings.codex.reasoning.label");
  const { efforts, activeEffort } = reasoningOptions(model, selectedEffort);
  return (
    <Field
      as="div"
      className="codex-catalog-row"
      density="comfortable"
      variant="row"
      label={label}
      labelId={image ? "codex-image-reasoning-label" : "codex-reasoning-label"}
    >
      <Select
        ariaLabel={image ? label : t("settings.codex.reasoning.ariaLabel")}
        value={activeEffort}
        disabled={controlsBusy}
        options={efforts.map((effort) => ({
          value: effort,
          label: reasoningLabel(effort, t),
        }))}
        onValueChange={(nextValue) => {
          const nextEffort = efforts.find(
            (effort) => effort === nextValue,
          ) as CodexAccountModel["defaultReasoningEffort"];
          clearTestState();
          if (image) setCodexImageReasoningEffort?.(nextEffort);
          else setCodexReasoningEffort(nextEffort);
        }}
      />
    </Field>
  );
}

function useCatalogSelectionRepair(
  props: CodexSettingsFieldsProps,
  account: CodexAccountSnapshot | null,
): void {
  React.useEffect(() => {
    if (!account?.authenticated || account.models.length === 0) return;
    if (props.imageOnly) {
      repairImageEffort(props, account.models);
      return;
    }
    const model = resolveCatalogModel(account.models, props.codexModel);
    const modelChanged = model.id !== props.codexModel;
    const effortChanged = !model.supportedReasoningEfforts.includes(
      props.codexReasoningEffort,
    );
    if (!modelChanged && !effortChanged) return;
    props.clearTestState();
    if (modelChanged) props.setCodexModel(model.id);
    if (effortChanged)
      props.setCodexReasoningEffort(model.defaultReasoningEffort);
  }, [account, props]);
}

function isUnsupportedImageEffort(
  props: CodexSettingsFieldsProps,
  model: CodexAccountModel,
): boolean {
  return (
    Boolean(props.setCodexImageReasoningEffort) &&
    !model.supportedReasoningEfforts.includes(
      props.codexImageReasoningEffort ?? "low",
    )
  );
}

function resolveCatalogModel(
  models: readonly CodexAccountModel[],
  selectedId: string,
): CodexAccountModel {
  const selected = models.find((model) => model.id === selectedId);
  return selected ?? models.find((model) => model.isDefault) ?? models[0];
}

function reasoningLabel(
  effort: CodexAccountModel["defaultReasoningEffort"],
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const option = CODEX_REASONING_OPTIONS.find(
    (candidate) => candidate.id === effort,
  ) as (typeof CODEX_REASONING_OPTIONS)[number];
  return t(option.labelKey);
}

function repairImageEffort(
  props: CodexSettingsFieldsProps,
  models: readonly CodexAccountModel[],
): void {
  const model = models.find(
    (item) => item.id === (props.codexImageModel ?? CODEX_TYPESETTING_MODEL),
  );
  if (!model || !isUnsupportedImageEffort(props, model)) return;
  props.clearTestState();
  props.setCodexImageReasoningEffort?.(model.defaultReasoningEffort);
}
function reasoningOptions(
  model: CodexAccountModel | undefined,
  selectedEffort: CodexAccountModel["defaultReasoningEffort"],
) {
  const efforts =
    model?.supportedReasoningEfforts ??
    CODEX_REASONING_OPTIONS.map((option) => option.id);
  return {
    efforts,
    activeEffort: efforts.includes(selectedEffort)
      ? selectedEffort
      : (model?.defaultReasoningEffort ?? "low"),
  };
}
