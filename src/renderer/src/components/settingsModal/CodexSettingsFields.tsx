import React from "react";
import { useTranslation } from "react-i18next";
import type {
  CodexAccountModel,
  CodexAccountSnapshot,
} from "../../../../shared/codexAccountTypes";
import type { CodexReasoningEffort } from "../../../../shared/codexSettings";
import { CODEX_REASONING_OPTIONS } from "../settingsOptions";
import { Field } from "../ui/Field";
import { Select } from "../ui/Select";
import { CodexAccountField } from "./CodexAccountField";

export type CodexSettingsFieldsProps = {
  clearTestState: () => void;
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
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
  useCatalogSelectionRepair(props, account);

  return (
    <>
      <CodexAccountField
        controlsBusy={props.controlsBusy}
        onSnapshotChange={publishAccount}
      />
      {account?.authenticated && models.length > 0 ? (
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
}: CodexSettingsFieldsProps & {
  models: readonly CodexAccountModel[];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = resolveCatalogModel(models, codexModel);
  const activeEffort = model.supportedReasoningEfforts.includes(
    codexReasoningEffort,
  )
    ? codexReasoningEffort
    : model.defaultReasoningEffort;
  return (
    <Field
      as="div"
      className="codex-catalog-row"
      density="comfortable"
      variant="row"
      label={t("settings.codex.reasoning.label")}
      labelId="codex-reasoning-label"
    >
      <Select
        ariaLabel={t("settings.codex.reasoning.ariaLabel")}
        value={activeEffort}
        disabled={controlsBusy}
        options={model.supportedReasoningEfforts.map((effort) => ({
          value: effort,
          label: reasoningLabel(effort, t),
        }))}
        onValueChange={(nextValue) => {
          const nextEffort = model.supportedReasoningEfforts.find(
            (effort) => effort === nextValue,
          ) as CodexAccountModel["defaultReasoningEffort"];
          clearTestState();
          setCodexReasoningEffort(nextEffort);
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
    const model = resolveCatalogModel(account.models, props.codexModel);
    const modelChanged = model.id !== props.codexModel;
    const effortChanged = !model.supportedReasoningEfforts.includes(
      props.codexReasoningEffort,
    );
    if (!modelChanged && !effortChanged) return;
    props.clearTestState();
    if (modelChanged) props.setCodexModel(model.id);
    if (effortChanged) {
      props.setCodexReasoningEffort(model.defaultReasoningEffort);
    }
  }, [account, props]);
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
