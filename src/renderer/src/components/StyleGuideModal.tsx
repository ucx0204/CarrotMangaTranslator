/* eslint-disable max-lines, max-lines-per-function */
import React from "react";
import type {
  AppSettings,
  ChapterSnapshot,
  ChapterStoryMemory,
  CharacterProfile,
  CharacterSpeechStyle,
  GlossaryEntry,
  GlossaryEntryCategory,
  WorkContextAnalysisCounts,
  WorkContextAnalysisScope,
  WorkStyleGuide,
} from "../../../shared/types";
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

const CATEGORY_OPTIONS: Array<{ id: GlossaryEntryCategory; label: string }> = [
  { id: "character", label: "인물" },
  { id: "alias", label: "별명" },
  { id: "place", label: "장소" },
  { id: "term", label: "용어" },
  { id: "honorific", label: "호칭" },
  { id: "other", label: "기타" },
];

const SPEECH_STYLE_OPTIONS: Array<{
  id: CharacterSpeechStyle;
  label: string;
}> = [
  { id: "neutral", label: "중립" },
  { id: "polite", label: "정중" },
  { id: "casual", label: "반말" },
  { id: "rough", label: "거침" },
  { id: "childish", label: "아이" },
  { id: "elderly", label: "노년" },
  { id: "formal", label: "격식" },
  { id: "custom", label: "직접" },
];

export function StyleGuideModal({
  chapter,
  settings,
  onClose,
}: StyleGuideModalProps): React.JSX.Element {
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
        toast.error("용어/기억 정보를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (alive) {
          setBusy(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [chapter.id, chapter.workId]);

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
      toast.success("용어/기억을 저장했습니다.");
    } catch (error) {
      console.error(error);
      toast.error("용어/기억 저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }, [guide]);

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
        const coverage = `${result.coverage.includedChapters}/${result.coverage.totalChapters}화`;
        const label = scope === "work" ? "작품 전체" : "현재 화";
        toast.success(
          `${label} AI 분석을 반영했습니다. ${coverage}, ${changed}개 변경`,
        );
        for (const warning of result.warnings.slice(0, 2)) {
          toast.info(warning);
        }
      } catch (error) {
        console.error(error);
        toast.error("AI 용어/기억 분석에 실패했습니다.");
      } finally {
        setAnalyzingScope(null);
      }
    },
    [chapter.id],
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
      title="용어/기억"
      size="xl"
      onClose={onClose}
      closeOnBackdrop
      bodyClassName="style-guide-body"
      footer={
        <div className="style-guide-footer">
          <StyleGuideBudgetSummary budget={budget} />
          <div className="style-guide-footer-actions">
            <Button
              variant="primary"
              onClick={() => void saveGuide()}
              disabled={!guide || saving || analyzingScope !== null}
            >
              저장
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
      {busy || !guide ? (
        <p className="muted-line style-guide-empty">불러오는 중...</p>
      ) : (
        <>
          {tab === "glossary" ? (
            <GlossaryTab guide={guide} onGuideChange={setGuide} />
          ) : null}
          {tab === "characters" ? (
            <CharactersTab guide={guide} onGuideChange={setGuide} />
          ) : null}
          {tab === "rules" ? (
            <RulesTab guide={guide} onGuideChange={setGuide} />
          ) : null}
          {tab === "memory" ? <MemoryTab memory={memory} /> : null}
        </>
      )}
    </Modal>
  );
}

function StyleGuideBudgetSummary({
  budget,
}: {
  budget: WorkContextBudgetPlan | null;
}): React.JSX.Element {
  if (!budget) {
    return <span className="style-guide-budget-placeholder" />;
  }

  const hasWarning = budget.omittedParts.length > 0;
  return (
    <div className="style-guide-budget" aria-live="polite">
      <div className="style-guide-budget-main">
        <strong>
          용어/기억 {formatTokenCount(budget.original.totalTokens)}
        </strong>
        <span>출력 여유 {budget.original.outputHeadroomPercent}%</span>
      </div>
      <div className="style-guide-budget-detail">
        스토리 {formatTokenCount(budget.original.storyMemoryTokens)} · 용어집{" "}
        {formatTokenCount(budget.original.glossaryTokens)} · 캐릭터{" "}
        {formatTokenCount(budget.original.characterTokens)}
      </div>
      {hasWarning ? (
        <p className="style-guide-budget-warning">
          {buildBudgetWarningText(budget)}
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
  return (
    <section className="style-guide-analysis" aria-label="AI 용어 기억 분석">
      <div className="style-guide-analysis-info">
        <h3>AI 자동 분석</h3>
        <p>원문을 분석해 용어·캐릭터·스토리 메모리를 채웁니다.</p>
      </div>
      <div className="style-guide-analysis-actions">
        <span className="style-guide-analysis-scope">분석 범위</span>
        <Button
          disabled={disabled}
          aria-busy={analyzingScope === "chapter"}
          onClick={() => onAnalyze("chapter")}
        >
          {analyzingScope === "chapter" ? "분석 중..." : "현재 화"}
        </Button>
        <Button
          variant="primary"
          disabled={disabled}
          aria-busy={analyzingScope === "work"}
          onClick={() => onAnalyze("work")}
        >
          {analyzingScope === "work" ? "분석 중..." : "작품 전체"}
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
  const tabs: Array<{ id: StyleGuideTab; label: string }> = [
    { id: "glossary", label: "용어집" },
    { id: "characters", label: "캐릭터" },
    { id: "rules", label: "번역 규칙" },
    { id: "memory", label: "스토리 메모리" },
  ];
  return (
    <div className="style-guide-tabs" role="tablist" aria-label="용어 기억 탭">
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
          <h3>용어집</h3>
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
            행 추가
          </Button>
        </div>
        {guide.glossary.length === 0 ? (
          <p className="style-guide-table-empty">
            등록된 용어가 없습니다. 위의 “현재 화 분석”, “작품 전체” 또는 “행
            추가”로 시작하세요.
          </p>
        ) : (
          <div className="style-guide-table">
            <div className="style-guide-row glossary head" aria-hidden="true">
              <span />
              <span>원문</span>
              <span>번역</span>
              <span>분류</span>
              <span>별칭</span>
              <span>메모</span>
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
                  placeholder="원문"
                  onChange={(event) =>
                    updateEntry(entry.id, { source: event.target.value })
                  }
                />
                <input
                  value={entry.target}
                  placeholder="번역"
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
                  {CATEGORY_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  value={(entry.aliases ?? []).join(", ")}
                  placeholder="별칭"
                  onChange={(event) =>
                    updateEntry(entry.id, {
                      aliases: splitList(event.target.value),
                    })
                  }
                />
                <input
                  value={entry.note ?? ""}
                  placeholder="메모"
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
                  삭제
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

function formatTokenCount(tokens: number): string {
  return `${Math.max(0, Math.round(tokens)).toLocaleString("ko-KR")}토큰`;
}

function formatOmittedParts(parts: WorkContextBudgetOmittedPart[]): string {
  const labels: Record<WorkContextBudgetOmittedPart, string> = {
    storyMemory: "스토리 메모리",
    glossary: "용어집",
    characters: "캐릭터 기억",
  };
  return parts.map((part) => labels[part]).join(", ");
}

function buildBudgetWarningText(budget: WorkContextBudgetPlan): string {
  const base =
    `출력 여유가 ${formatTokenCount(budget.minOutputHeadroomTokens)} 미만이면 ` +
    "번역 때 스토리 메모리부터 제외합니다. 그래도 부족하면 용어집, 마지막으로 캐릭터 기억까지 제외합니다.";
  const effective =
    `${formatTokenCount(budget.effective.outputHeadroomTokens)} · ` +
    `${budget.effective.outputHeadroomPercent}%`;
  if (budget.effective.outputHeadroomTokens < budget.minOutputHeadroomTokens) {
    return `${base} 현재 설정에서는 ${formatOmittedParts(budget.omittedParts)}을 빼도 예상 여유가 ${effective}뿐이라 응답이 중간에 끊길 수 있습니다.`;
  }
  return `${base} 현재 설정에서는 ${formatOmittedParts(budget.omittedParts)}을 빼서 예상 여유를 ${effective}까지 확보합니다.`;
}

function CharactersTab({
  guide,
  onGuideChange,
}: {
  guide: WorkStyleGuide;
  onGuideChange: (guide: WorkStyleGuide) => void;
}): React.JSX.Element {
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
          <h3>캐릭터 이름/말투</h3>
          <Button
            size="sm"
            onClick={() =>
              onGuideChange({
                ...guide,
                characters: [...guide.characters, makeCharacterProfile()],
              })
            }
          >
            행 추가
          </Button>
        </div>
        {guide.characters.length === 0 ? (
          <p className="style-guide-table-empty">
            등록된 캐릭터가 없습니다. 위의 “행 추가”로 시작하세요.
          </p>
        ) : (
          <div className="style-guide-table">
            <div className="style-guide-row character head" aria-hidden="true">
              <span />
              <span>표시 이름</span>
              <span>원문 이름</span>
              <span>한국어 이름</span>
              <span>말투</span>
              <span>커스텀 말투</span>
              <span>메모</span>
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
                  placeholder="표시 이름"
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      displayName: event.target.value,
                    })
                  }
                />
                <input
                  value={character.sourceNames.join(", ")}
                  placeholder="원문 이름"
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      sourceNames: splitList(event.target.value),
                    })
                  }
                />
                <input
                  value={character.targetName}
                  placeholder="한국어 이름"
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
                  {SPEECH_STYLE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  value={character.customSpeechStyle ?? ""}
                  placeholder="커스텀 말투"
                  onChange={(event) =>
                    updateCharacter(character.id, {
                      customSpeechStyle: event.target.value,
                    })
                  }
                />
                <input
                  value={character.note ?? ""}
                  placeholder="메모"
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
                  삭제
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
  return (
    <div className="style-guide-content">
      <section className="style-guide-section rules">
        <label>
          호칭 처리
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
            <option value="preserve">원문 호칭 느낌 유지</option>
            <option value="adapt">한국어 호칭으로 자연스럽게 바꿈</option>
            <option value="drop">님/씨 같은 호칭은 빼고 이름 위주</option>
          </select>
        </label>
        <label>
          효과음 처리
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
            <option value="preserve">원문 효과음 그대로 둠</option>
            <option value="translate">한국어 효과음으로 바꿈</option>
            <option value="note">원문 효과음에 뜻 설명을 붙임</option>
          </select>
        </label>
        <label>
          기본 톤
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
            <option value="natural_korean">자연스러운 한국어 대사</option>
            <option value="literal">원문에 가까운 직역</option>
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
  if (!memory || memory.pages.length === 0) {
    return (
      <div className="style-guide-content">
        <p className="muted-line style-guide-empty">
          아직 저장된 스토리 메모리가 없습니다.
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
                {page.pageIndex + 1}쪽 · {page.pageName}
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
