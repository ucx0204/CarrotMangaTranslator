import React from "react";
import { useTranslation } from "react-i18next";
import type {
  GlossaryEntry,
  GlossaryEntryCategory,
} from "../../../../shared/workContextTypes";
import { Button } from "../ui/Button";
import type { StyleGuideEditorProps } from "./styleGuideTypes";
import {
  CATEGORY_IDS,
  makeGlossaryEntry,
  nowIso,
  splitList,
} from "./styleGuideUtils";

export function GlossaryTab({
  guide,
  onGuideChange,
}: StyleGuideEditorProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateEntry = (id: string, patch: Partial<GlossaryEntry>): void => {
    onGuideChange({
      ...guide,
      glossary: guide.glossary.map((entry) =>
        entry.id === id ? { ...entry, ...patch, updatedAt: nowIso() } : entry,
      ),
    });
  };
  const addEntry = (): void => {
    onGuideChange({
      ...guide,
      glossary: [
        ...guide.glossary,
        makeGlossaryEntry({ source: "", target: "", category: "term" }),
      ],
    });
  };
  const removeEntry = (id: string): void => {
    onGuideChange({
      ...guide,
      glossary: guide.glossary.filter((entry) => entry.id !== id),
    });
  };
  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-guide-section-head">
          <h3>{t("styleGuide.tabs.glossary")}</h3>
          <Button size="sm" onClick={addEntry}>
            {t("styleGuide.addRow")}
          </Button>
        </div>
        {guide.glossary.length ? (
          <GlossaryTable
            entries={guide.glossary}
            onUpdate={updateEntry}
            onRemove={removeEntry}
          />
        ) : (
          <p className="style-guide-table-empty">
            {t("styleGuide.glossary.empty")}
          </p>
        )}
      </section>
    </div>
  );
}

function GlossaryTable({
  entries,
  onUpdate,
  onRemove,
}: {
  entries: GlossaryEntry[];
  onUpdate: (id: string, patch: Partial<GlossaryEntry>) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-table">
      <div className="style-guide-row glossary head" aria-hidden="true">
        <span />
        <span>{t("styleGuide.glossary.source")}</span>
        <span>{t("styleGuide.glossary.translation")}</span>
        <span>{t("styleGuide.glossary.category")}</span>
        <span>{t("styleGuide.glossary.aliases")}</span>
        <span>{t("styleGuide.note")}</span>
        <span />
      </div>
      {entries.map((entry) => (
        <GlossaryRow
          key={entry.id}
          entry={entry}
          onUpdate={(patch) => onUpdate(entry.id, patch)}
          onRemove={() => onRemove(entry.id)}
        />
      ))}
    </div>
  );
}

function GlossaryRow({
  entry,
  onUpdate,
  onRemove,
}: {
  entry: GlossaryEntry;
  onUpdate: (patch: Partial<GlossaryEntry>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-row glossary">
      <label className="inline-toggle">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={(event) => onUpdate({ enabled: event.target.checked })}
        />
      </label>
      <input
        value={entry.source}
        placeholder={t("styleGuide.glossary.source")}
        onChange={(event) => onUpdate({ source: event.target.value })}
      />
      <input
        value={entry.target}
        placeholder={t("styleGuide.glossary.translation")}
        onChange={(event) => onUpdate({ target: event.target.value })}
      />
      <select
        value={entry.category}
        onChange={(event) =>
          onUpdate({ category: event.target.value as GlossaryEntryCategory })
        }
      >
        {CATEGORY_IDS.map((id) => (
          <option key={id} value={id}>
            {t(`styleGuide.glossary.categories.${id}`)}
          </option>
        ))}
      </select>
      <input
        value={(entry.aliases ?? []).join(", ")}
        placeholder={t("styleGuide.glossary.aliases")}
        onChange={(event) =>
          onUpdate({ aliases: splitList(event.target.value) })
        }
      />
      <input
        value={entry.note ?? ""}
        placeholder={t("styleGuide.note")}
        onChange={(event) => onUpdate({ note: event.target.value })}
      />
      <Button size="sm" variant="danger" onClick={onRemove}>
        {t("common.delete")}
      </Button>
    </div>
  );
}
