import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { NumberField } from "../ui/NumberField";
import { Select } from "../ui/Select";
import { Tabs } from "../ui/Tabs";
import type { RedactionWorkspaceController } from "./useRedactionWorkspace";
import { changeRedactionView } from "./redactionWorkspaceModel";
import styles from "./RedactionWorkspace.module.css";

export function RedactionWorkspaceHeader({ form, onOpen, onHelp }: {
  form: RedactionWorkspaceController; onOpen: (id: string) => void; onHelp: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { state, commit } = form;
  const { pages, view } = state.workspace;
  const index = pages.findIndex((page) => page.id === view.currentId);
  return <div className={styles.headerTools}>
    <Tabs ariaLabel={t("manualRedaction.viewMode")} className={styles.tabs} tabClassName={styles.tab}
      items={(["edit", "grid"] as const).map((mode) => ({ value: mode, label: t(`manualRedaction.mode_${mode}`), id: `redaction-tab-${mode}`, panelId: `redaction-panel-${mode}` }))}
      value={view.mode} onChange={(mode) => { if (!form.busy && !form.drawing) commit((current) => changeRedactionView(current, { mode })); }} />
    <Select ariaLabel={t("manualRedaction.filter")} value={view.filter} disabled={form.busy || form.drawing}
      options={(["all", "unreviewed", "deferred", "masked", "error"] as const).map((value) => ({ value, label: t(`manualRedaction.filter_${value}`) }))}
      onValueChange={(filter) => commit((current) => changeRedactionView(current, { filter, gridOffset: 0 }))} />
    <div className={styles.pageJump}>
      <NumberField className={styles.number} variant="framed" ariaLabel={t("manualRedaction.jumpPage")} value={index + 1} min={1} max={pages.length}
        onValueChange={(number) => { const page = pages[number - 1]; if (page) onOpen(page.id); }} disabled={form.busy || form.drawing} />
      <span>/ {pages.length}</span>
    </div>
    {view.mode === "grid" ? <NumberField className={styles.number} variant="framed" ariaLabel={t("manualRedaction.thumbnailSize")} min={100} max={260}
      value={view.thumbnailSize} onValueChange={(thumbnailSize) => commit((current) => changeRedactionView(current, { thumbnailSize, gridOffset: 0 }))} unit="px" disabled={form.busy} /> : null}
    <Button size="sm" onClick={onHelp} disabled={form.busy || form.drawing}>{t("manualRedaction.shortcuts")}</Button>
  </div>;
}
