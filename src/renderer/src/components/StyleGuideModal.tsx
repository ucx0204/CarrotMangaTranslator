/* eslint-disable max-lines, max-lines-per-function */
import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/settingsTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  CharacterProfile,
  CharacterSpeechStyle,
  GlossaryEntry,
  GlossaryEntryCategory,
  WorkStyleGuide,
} from "../../../shared/workContextTypes";
import type {
  WorkContextAnalysisCounts,
  WorkContextAnalysisScope,
} from "../../../shared/workContextAnalysisTypes";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_TOKENS,
} from "../../../shared/modelPresets";
import {
  buildWorkContextBudgetPreview,
  WORK_CONTEXT_RECENT_PAGE_COUNT,
  type WorkContextBudgetOmittedPart,
  type WorkContextBudgetPlan,
} from "../../../shared/workContextBudget";
import { mangaGateway } from "../api/mangaGateway";
import { toast } from "../lib/toastStore";
import { Button, Modal } from "./ui";

type StyleGuideTab = "glossary" | "characters" | "rules" | "memory";

type StyleGuideModalProps = {
  chapter: ChapterSnapshot;
  settings: AppSettings | null;
  onClose: () => void;
};

const CATEGORY_IDS: GlossaryEntryCategory[] = [
  "character",
  "alias",
  "place",
  "term",
  "honorific",
  "other",
];

const SPEECH_STYLE_IDS: CharacterSpeechStyle[] = [
  "neutral",
  "polite",
  "casual",
  "rough",
  "childish",
  "elderly",
  "formal",
  "custom",
];

export function StyleGuideModal({
  chapter,
  settings,
  onClose,
}: StyleGuideModalProps): React.JSX.Element {
  const { i18n, t } = useTranslation("components");
  const [tab, setTab] = React.useState<StyleGuideTab>("glossary");
  const [guide, setGuide] = React.useState<WorkStyleGuide | null>(null);
  const [memory, setMemory] = React.useState<ChapterStoryMemory | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [analyzingScope, setAnalyzingScope] =
    React.useState<WorkContextAnalysisScope | null>(null);

  React.useEffect(() => {
    let alive = true;
    setBusy(true);
    Promise.all([
      mangaGateway.getWorkStyleGuide(chapter.workId),
      mangaGateway.getChapterStoryMemory(chapter.id),
    ])
      .then(([nextGuide, nextMemory]) => {
        if (!alive) {
          return;
        }
        setGuide(nextGuide);
        setMemory(nextMemory);
      })
      .catch((error) => {
        console.error(error);
        toast.error(t("styleGuide.loadFailed"));
      })
      .finally(() => {
        if (alive) {
          setBusy(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [chapter.id, chapter.workId, t]);

  const saveGuide = React.useCallback(async () => {
    if (!guide) {
      return;
    }
    setSaving(true);
    try {
      const saved = await mangaGateway.saveWorkStyleGuide(
        normalizeGuideForSave(guide),
      );
      setGuide(saved);
      toast.success(t("styleGuide.saveSuccess"));
    } catch (error) {
      console.error(error);
      toast.error(t("styleGuide.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [guide, t]);

  const analyzeWithAi = React.useCallback(
    async (scope: WorkContextAnalysisScope) => {
      setAnalyzingScope(scope);
      try {
        const result = await mangaGateway.analyzeWorkContext({
          chapterId: chapter.id,
          scope,
        });
        setGuide(result.styleGuide);
        setMemory(result.storyMemory);
        setTab("glossary");
        const changed = countAnalysisChanges(result.counts);
        toast.success(
          t("styleGuide.analysis.success", {
            scope: t(
              scope === "work"
                ? "styleGuide.analysis.entireWork"
                : "styleGuide.analysis.currentChapter",
            ),
            included: result.coverage.includedChapters,
            total: result.coverage.totalChapters,
            changed,
          }),
        );
        for (const warning of result.warnings.slice(0, 2)) {
          toast.info(warning);
        }
      } catch (error) {
        console.error(error);
        toast.error(t("styleGuide.analysis.failed"));
      } finally {
        setAnalyzingScope(null);
      }
    },
    [chapter.id, t],
  );

  const working = busy || analyzingScope !== null;
  const budget = React.useMemo(
    () =>
      guide && memory
        ? buildWorkContextBudgetPreview({
            ctx: settings?.ctx ?? DEFAULT_CONTEXT_TOKENS,
            maxTokens: settings?.maxTokens ?? DEFAULT_MAX_TOKENS,
            recentPageCount: WORK_CONTEXT_RECENT_PAGE_COUNT,
            storyMemory: memory,
            styleGuide: guide,
          })
        : null,
    [guide, memory, settings?.ctx, settings?.maxTokens],
  );

  return (
    <Modal
      title={t("styleGuide.title")}
      size="xl"
      onClose={onClose}
      closeOnBackdrop
      bodyClassName="style-guide-body"
      footer={
        <div className="style-guide-footer">
          <StyleGuideBudgetSummary
            budget={budget}
            locale={i18n.resolvedLanguage ?? i18n.language}
          />
          <div className="style-guide-footer-actions">
            <Button
              variant="primary"
              onClick={() => void saveGuide()}
              disabled={!guide || saving || analyzingScope !== null}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      }
    >
      <StyleGuideAnalysisActions
        analyzingScope={analyzingScope}
        disabled={working}
        onAnalyze={(scope) => void analyzeWithAi(scope)}
      />
      <StyleGuideTabs active={tab} onChange={setTab} />
      <StyleGuideTabContent
        busy={busy}
        guide={guide}
        memory={memory}
        onGuideChange={setGuide}
        tab={tab}
      />
    </Modal>
  );
}

function StyleGuideTabContent({
  busy,
  guide,
  memory,
  onGuideChange,
  tab,
}: {
  busy: boolean;
  guide: WorkStyleGuide | null;
  memory: ChapterStoryMemory | null;
  onGuideChange: (guide: WorkStyleGuide) => void;
  tab: StyleGuideTab;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (busy || !guide) {
    return (
      <p className="muted-line style-guide-empty">{t("common.loading")}</p>
    );
  }
  return (
    <>
      {tab === "glossary" ? (
        <GlossaryTab guide={guide} onGuideChange={onGuideChange} />
      ) : null}
      {tab === "characters" ? (
        <CharactersTab guide={guide} onGuideChange={onGuideChange} />
      ) : null}
      {tab === "rules" ? (
        <RulesTab guide={guide} onGuideChange={onGuideChange} />
      ) : null}
      {tab === "memory" ? <MemoryTab memory={memory} /> : null}
    </>
  );
}

function StyleGuideBudgetSummary({
  budget,
  locale,
}: {
  budget: WorkContextBudgetPlan | null;
  locale: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (!budget) {
    return <span className="style-guide-budget-placeholder" />;
  }

  const hasWarning = budget.omittedParts.length > 0;
  return (
    <div className="style-guide-budget" aria-live="polite">
      <div className="style-guide-budget-main">
        <strong>
          {t("styleGuide.budget.total", {
            tokens: formatTokenCount(budget.original.totalTokens, locale, t),
          })}
        </strong>
        <span>
          {t("styleGuide.budget.outputHeadroom", {
            percent: budget.original.outputHeadroomPercent,
          })}
        </span>
      </div>
      <div className="style-guide-budget-detail">
        {t("styleGuide.budget.breakdown", {
          story: formatTokenCount(budget.original.storyMemoryTokens, locale, t),
          glossary: formatTokenCount(budget.original.glossaryTokens, locale, t),
          characters: formatTokenCount(
            budget.original.characterTokens,
            locale,
            t,
          ),
        })}
      </div>
      {hasWarning ? (
        <p className="style-guide-budget-warning">
          {buildBudgetWarningText(budget, locale, t)}
        </p>
      ) : null}
    </div>
  );
}

function StyleGuideAnalysisActions({
  analyzingScope,
  disabled,
  onAnalyze,
}: {
  analyzingScope: WorkContextAnalysisScope | null;
  disabled: boolean;
  onAnalyze: (scope: WorkContextAnalysisScope) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section
      className="style-guide-analysis"
      aria-label={t("styleGuide.analysis.ariaLabel")}
    >
      <div className="style-guide-analysis-info">
        <h3>{t("styleGuide.analysis.title")}</h3>
        <p>{t("styleGuide.analysis.description")}</p>
      </div>
      <div className="style-guide-analysis-actions">
        <span className="style-guide-analysis-scope">
          {t("styleGuide.analysis.scope")}
        </span>
        <Button
          disabled={disabled}
          aria-busy={analyzingScope === "chapter"}
          onClick={() => onAnalyze("chapter")}
        >
          {t(
            analyzingScope === "chapter"
              ? "styleGuide.analysis.analyzing"
              : "styleGuide.analysis.currentChapter",
          )}
        </Button>
        <Button
          variant="primary"
          disabled={disabled}
          aria-busy={analyzingScope === "work"}
          onClick={() => onAnalyze("work")}
        >
          {t(
            analyzingScope === "work"
              ? "styleGuide.analysis.analyzing"
              : "styleGuide.analysis.entireWork",
          )}
        </Button>
      </div>
    </section>
  );
}

function StyleGuideTabs({
  active,
  onChange,
}: {
  active: StyleGuideTab;
  onChange: (tab: StyleGuideTab) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const tabs: Array<{ id: StyleGuideTab; label: string }> = [
    { id: "glossary", label: t("styleGuide.tabs.glossary") },
    { id: "characters", label: t("styleGuide.tabs.characters") },
    { id: "rules", label: t("styleGuide.tabs.rules") },
    { id: "memory", label: t("styleGuide.tabs.memory") },
  ];
  return (
    <div
      className="style-guide-tabs"
      role="tablist"
      aria-label={t("styleGuide.tabs.ariaLabel")}
    >
      {tabs.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === active}
          className={item.id === active ? "active" : ""}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function GlossaryTab({
  guide,
  onGuideChange,
}: {
  guide: WorkStyleGuide;
  onGuideChange: (guide: WorkStyleGuide) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateEntry = (id: string, patch: Partial<GlossaryEntry>): void => {
    onGuideChange({
      ...guide,
      glossary: guide.glossary.map((entry) =>
        entry.id === id ? { ...entry, ...patch, updatedAt: nowIso() } : entry,
      ),
    });
  };

  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-guide-section-head">
          <h3>{t("styleGuide.tabs.glossary")}</h3>
          <Button
            size="sm"
            onClick={() =>
              onGuideChange({
                ...guide,
                glossary: [
                  ...guide.glossary,
                  makeGlossaryEntry({
                    source: "",
                    target: "",
                    category: "term",
                  }),
                ],
              })
            }
          >
            {t("styleGuide.addRow")}
          </Button>
        </div>
        {guide.glossary.length === 0 ? (
          <p className="style-guide-table-empty">
            {t("styleGuide.glossary.empty")}
          </p>
        ) : (
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
            {guide.glossary.map((entry) => (
              <div key={entry.id} className="style-guide-row glossary">
                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={(event) =>
                      updateEntry(entry.id, { enabled: event.target.checked })
                    }
                  />
                </label>
                <input
                  value={entry.source}
                  placeholder={t("styleGuide.glossary.source")}
                  onChange={(event) =>
                    updateEntry(entry.id, { source: event.target.value })
                  }
                />
                <input
                  value={entry.target}
                  placeholder={t("styleGuide.glossary.translation")}
                  onChange={(event) =>
                    updateEntry(entry.id, { target: event.target.value })
                  }
                />
                <select
                  value={entry.category}
                  onChange={(event) =>
                    updateEntry(entry.id, {
                      category: event.target.value as GlossaryEntryCategory,
                    })
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
                    updateEntry(entry.id, {
                      aliases: splitList(event.target.value),
                    })
                  }
                />
                <input
                  value={entry.note ?? ""}
                  placeholder={t("styleGuide.note")}
                  onChange={(event) =>
                    updateEntry(entry.id, { note: event.target.value })
                  }
                />
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    onGuideChange({
                      ...guide,
                      glossary: guide.glossary.filter(
                        (candidate) => candidate.id !== entry.id,
                      ),
                    })
                  }
                >
                  {t("common.delete")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function countAnalysisChanges(counts: WorkContextAnalysisCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function formatTokenCount(
  tokens: number,
  locale: string,
  t: TFunction<"components">,
): string {
  return t("styleGuide.budget.tokenCount", {
    count: new Intl.NumberFormat(locale).format(
      Math.max(0, Math.round(tokens)),
    ),
  });
}

function formatOmittedParts(
  parts: WorkContextBudgetOmittedPart[],
  t: TFunction<"components">,
): string {
  return parts
    .map((part) => t(`styleGuide.budget.omittedParts.${part}`))
    .join(", ");
}

function buildBudgetWarningText(
  budget: WorkContextBudgetPlan,
  locale: string,
  t: TFunction<"components">,
): string {
  const minimum = formatTokenCount(budget.minOutputHeadroomTokens, locale, t);
  const effective = t("styleGuide.budget.effectiveHeadroom", {
    tokens: formatTokenCount(budget.effective.outputHeadroomTokens, locale, t),
    percent: budget.effective.outputHeadroomPercent,
  });
  const omitted = formatOmittedParts(budget.omittedParts, t);
  if (budget.effective.outputHeadroomTokens < budget.minOutputHeadroomTokens) {
    return t("styleGuide.budget.warningInsufficient", {
      minimum,
      omitted,
      effective,
    });
  }
  return t("styleGuide.budget.warningAdjusted", {
    minimum,
    omitted,
    effective,
  });
}

function CharactersTab({
  guide,
  onGuideChange,
}: {
  guide: WorkStyleGuide;
  onGuideChange: (guide: WorkStyleGuide) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateCharacter = (
    id: string,
    patch: Partial<CharacterProfile>,
  ): void => {
    onGuideChange({
      ...guide,
      characters: guide.characters.map((character) =>
        character.id === id
          ? { ...character, ...patch, updatedAt: nowIso() }
          : character,
      ),
    });
  };

  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-guide-section-head">
          <h3>{t("styleGuide.characters.title")}</h3>
          <Button
            size="sm"
            onClick={() =>
              onGuideChange({
                ...guide,
                characters: [...guide.characters, makeCharacterProfile()],
              })
            }
          >
            {t("styleGuide.addRow")}
          </Button>
        </div>
        {guide.characters.length === 0 ? (
          <p className="style-guide-table-empty">
            {t("styleGuide.characters.empty")}
          </p>
        ) : (
          <div className="style-guide-table">
            <div className="style-guide-row character head" aria-hidden="true">
              <span />
              <span>{t("styleGuide.characters.displayName")}</span>
              <span>{t("styleGuide.characters.sourceNames")}</span>
              <span>{t("styleGuide.characters.translatedName")}</span>
              <span>{t("styleGuide.characters.speechStyle")}</span>
              <span>{t("styleGuide.characters.customSpeechStyle")}</span>
              <span>{t("styleGuide.note")}</span>
              <span />
            </div>
            {guide.characters.map((character) => (
              <div key={character.id} className="style-guide-row character">
                <label className="inline-toggle">
                  <input
                    type="checkbox"
                    checked={character.enabled}
                    onChange={(event) =>
                      updateCharacter(character.id, {
                        enabled: event.target.checked,
                      })
                    }
                  />
                </label>
                <input
                  value={character.displayName}
                  placeholder={t("styleGuide.characters.displayName")}
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      displayName: event.target.value,
                    })
                  }
                />
                <input
                  value={character.sourceNames.join(", ")}
                  placeholder={t("styleGuide.characters.sourceNames")}
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      sourceNames: splitList(event.target.value),
                    })
                  }
                />
                <input
                  value={character.targetName}
                  placeholder={t("styleGuide.characters.translatedName")}
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      targetName: event.target.value,
                    })
                  }
                />
                <select
                  value={character.speechStyle}
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      speechStyle: event.target.value as CharacterSpeechStyle,
                    })
                  }
                >
                  {SPEECH_STYLE_IDS.map((id) => (
                    <option key={id} value={id}>
                      {t(`styleGuide.characters.speechStyles.${id}`)}
                    </option>
                  ))}
                </select>
                <input
                  value={character.customSpeechStyle ?? ""}
                  placeholder={t("styleGuide.characters.customSpeechStyle")}
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      customSpeechStyle: event.target.value,
                    })
                  }
                />
                <input
                  value={character.note ?? ""}
                  placeholder={t("styleGuide.note")}
                  onChange={(event) =>
                    updateCharacter(character.id, { note: event.target.value })
                  }
                />
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    onGuideChange({
                      ...guide,
                      characters: guide.characters.filter(
                        (candidate) => candidate.id !== character.id,
                      ),
                    })
                  }
                >
                  {t("common.delete")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RulesTab({
  guide,
  onGuideChange,
}: {
  guide: WorkStyleGuide;
  onGuideChange: (guide: WorkStyleGuide) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="style-guide-content">
      <section className="style-guide-section rules">
        <label>
          {t("styleGuide.rules.honorifics.label")}
          <select
            value={guide.rules.honorifics}
            onChange={(event) =>
              onGuideChange({
                ...guide,
                rules: {
                  ...guide.rules,
                  honorifics: event.target
                    .value as WorkStyleGuide["rules"]["honorifics"],
                },
              })
            }
          >
            <option value="preserve">
              {t("styleGuide.rules.honorifics.preserve")}
            </option>
            <option value="adapt">
              {t("styleGuide.rules.honorifics.adapt")}
            </option>
            <option value="drop">
              {t("styleGuide.rules.honorifics.drop")}
            </option>
          </select>
        </label>
        <label>
          {t("styleGuide.rules.sfx.label")}
          <select
            value={guide.rules.sfxMode}
            onChange={(event) =>
              onGuideChange({
                ...guide,
                rules: {
                  ...guide.rules,
                  sfxMode: event.target
                    .value as WorkStyleGuide["rules"]["sfxMode"],
                },
              })
            }
          >
            <option value="preserve">
              {t("styleGuide.rules.sfx.preserve")}
            </option>
            <option value="translate">
              {t("styleGuide.rules.sfx.translate")}
            </option>
            <option value="note">{t("styleGuide.rules.sfx.note")}</option>
          </select>
        </label>
        <label>
          {t("styleGuide.rules.tone.label")}
          <select
            value={guide.rules.defaultTone}
            onChange={(event) =>
              onGuideChange({
                ...guide,
                rules: {
                  ...guide.rules,
                  defaultTone: event.target
                    .value as WorkStyleGuide["rules"]["defaultTone"],
                },
              })
            }
          >
            <option value="natural_korean">
              {t("styleGuide.rules.tone.natural")}
            </option>
            <option value="literal">
              {t("styleGuide.rules.tone.literal")}
            </option>
          </select>
        </label>
      </section>
    </div>
  );
}

function MemoryTab({
  memory,
}: {
  memory: ChapterStoryMemory | null;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (!memory || memory.pages.length === 0) {
    return (
      <div className="style-guide-content">
        <p className="muted-line style-guide-empty">
          {t("styleGuide.memory.empty")}
        </p>
      </div>
    );
  }
  return (
    <div className="style-guide-content">
      <section className="style-guide-section">
        <div className="style-memory-list">
          {memory.pages.map((page) => (
            <article key={page.pageId} className="style-memory-item">
              <h3>
                {t("styleGuide.memory.pageHeading", {
                  index: page.pageIndex + 1,
                  pageName: page.pageName,
                })}
              </h3>
              <p>
                {page.summary || page.translatedDigest || page.sourceDigest}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function makeGlossaryEntry({
  source,
  target,
  category,
}: {
  source: string;
  target: string;
  category: GlossaryEntryCategory;
}): GlossaryEntry {
  const now = nowIso();
  return {
    id: makeLocalId("glossary"),
    source,
    target,
    category,
    aliases: [],
    note: "",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeGuideForSave(guide: WorkStyleGuide): WorkStyleGuide {
  const now = nowIso();
  return {
    ...guide,
    glossary: guide.glossary
      .map((entry) => ({
        ...entry,
        source: entry.source.trim(),
        target: entry.target.trim(),
        aliases: (entry.aliases ?? [])
          .map((alias) => alias.trim())
          .filter(Boolean),
        note: entry.note?.trim() ?? "",
      }))
      .filter((entry) => entry.source),
    characters: guide.characters
      .map((character) => ({
        ...character,
        displayName: character.displayName.trim(),
        targetName: character.targetName.trim(),
        sourceNames: character.sourceNames
          .map((sourceName) => sourceName.trim())
          .filter(Boolean),
        aliases: (character.aliases ?? [])
          .map((alias) => alias.trim())
          .filter(Boolean),
        customSpeechStyle: character.customSpeechStyle?.trim() ?? "",
        note: character.note?.trim() ?? "",
      }))
      .filter(
        (character) =>
          character.displayName ||
          character.targetName ||
          character.sourceNames.length > 0,
      )
      .map((character) => ({
        ...character,
        displayName:
          character.displayName ||
          character.targetName ||
          character.sourceNames[0] ||
          "",
      })),
    updatedAt: now,
  };
}

function makeCharacterProfile(): CharacterProfile {
  const now = nowIso();
  return {
    id: makeLocalId("character"),
    displayName: "",
    sourceNames: [],
    targetName: "",
    aliases: [],
    speechStyle: "neutral",
    customSpeechStyle: "",
    note: "",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function makeLocalId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
