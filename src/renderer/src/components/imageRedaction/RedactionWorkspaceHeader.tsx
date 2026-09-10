import React from "react";
import { useTranslation } from "react-i18next";
import { IconInfoCircle } from "@tabler/icons-react";
import { redactionViewSchema } from "../../../../shared/imageRedactionWorkspace";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ControlTooltip } from "../ui/ControlTooltip";
import { NumberField } from "../ui/NumberField";
import { Select } from "../ui/Select";
import { Tabs } from "../ui/Tabs";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { changeRedactionView } from "./redactionWorkspaceModel";
import styles from "./RedactionWorkspace.module.css";

type Props = {
  form: RedactionWorkspaceController;
  onOpen: (id: string) => void;
  onHelp: () => void;
  preparation?: boolean;
};

export function RedactionWorkspaceHeader(props: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  const { form, onHelp, preparation } = props;
  const { view } = form.state.workspace;
  const disabled = form.busy || form.drawing;
  return (
    <div className={styles.headerTools}>
      <Tabs
        ariaLabel={t("manualRedaction.viewMode")}
        className={styles.tabs}
        tabClassName={styles.tab}
        items={(["edit", "grid"] as const).map((mode) => ({
          value: mode,
          label: t(`manualRedaction.mode_${mode}`),
          id: `redaction-tab-${mode}`,
          panelId: `redaction-panel-${mode}`,
        }))}
        value={view.mode}
        onChange={(mode) => {
          if (!disabled)
            form.commit((current) => changeRedactionView(current, { mode }));
        }}
      />
      <RedactionPageControls form={form} onOpen={props.onOpen} />
      <ControlTooltip
        content={t("manualRedaction.canvasHint")}
        placement="bottom"
      >
        <Button size="sm" onClick={onHelp} disabled={disabled}>
          {t("manualRedaction.shortcuts")}
        </Button>
      </ControlTooltip>
      <ControlTooltip
        content={t(
          preparation
            ? "manualRedaction.preparationHint"
            : "manualRedaction.outboundHint",
        )}
        placement="left"
      >
        <IconButton label={t("manualRedaction.about")} title="">
          <IconInfoCircle size={18} aria-hidden="true" />
        </IconButton>
      </ControlTooltip>
    </div>
  );
}

function RedactionPageControls({
  form,
  onOpen,
}: Pick<Props, "form" | "onOpen">): React.JSX.Element {
  const { t } = useTranslation("components");
  const { pages, view } = form.state.workspace;
  const disabled = form.busy || form.drawing;
  const index = pages.findIndex((page) => page.id === view.currentId);
  return (
    <>
      <Select
        ariaLabel={t("manualRedaction.filter")}
        value={view.filter}
        disabled={disabled}
        options={redactionViewSchema.shape.filter.options.map((value) => ({
          value,
          label: t(`manualRedaction.filter_${value}`),
        }))}
        onValueChange={(value) => {
          const filter = redactionViewSchema.shape.filter.parse(value);
          form.commit((current) =>
            changeRedactionView(current, { filter, gridOffset: 0 }),
          );
        }}
      />
      <div className={styles.pageJump}>
        <NumberField
          className={styles.number}
          variant="framed"
          ariaLabel={t("manualRedaction.jumpPage")}
          value={index + 1}
          min={1}
          max={pages.length}
          onValueChange={(number) => {
            const page = pages[number - 1];
            if (page) onOpen(page.id);
          }}
          disabled={disabled}
        />
        <span>/ {pages.length}</span>
      </div>
      {view.mode === "grid" ? <RedactionThumbnailSize form={form} /> : null}
    </>
  );
}

function RedactionThumbnailSize({
  form,
}: Pick<Props, "form">): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <NumberField
      className={styles.number}
      variant="framed"
      ariaLabel={t("manualRedaction.thumbnailSize")}
      min={100}
      max={260}
      value={form.state.workspace.view.thumbnailSize}
      onValueChange={(thumbnailSize) =>
        form.commit((current) =>
          changeRedactionView(current, { thumbnailSize, gridOffset: 0 }),
        )
      }
      unit="px"
      disabled={form.busy}
    />
  );
}
