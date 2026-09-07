import React from "react";
import { useTranslation } from "react-i18next";
import { analysisGateway } from "../api/analysisGateway";
import { ToggleOptionRow } from "./TranslationOptionControls";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";

export function ImageRedactionSettings(): React.JSX.Element {
  const { t } = useTranslation("components");
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState("");
  const load = React.useCallback(() => {
    setBusy(true);
    void analysisGateway
      .getImageRedactionEnabled()
      .then(setEnabled)
      .catch((failure: unknown) => setError(String(failure)))
      .finally(() => setBusy(false));
  }, []);
  React.useEffect(load, [load]);
  const save = (next: boolean) => {
    setBusy(true);
    setError("");
    void analysisGateway
      .setImageRedactionEnabled(next)
      .then(setEnabled)
      .catch((failure: unknown) => setError(String(failure)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Field as="div" hint={t("imageRedaction.description")}>
        <ToggleOptionRow
          label={t("imageRedaction.enabled")}
          pressed={enabled}
          disabled={busy}
          onChange={save}
        />
      </Field>
      {error ? (
        <div role="alert">
          {error}
          <Button onClick={load}>{t("imageRedaction.retry")}</Button>
        </div>
      ) : null}
    </>
  );
}
