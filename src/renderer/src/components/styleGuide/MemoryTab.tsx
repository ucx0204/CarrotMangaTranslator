import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterStoryMemory } from "../../../../shared/workContextTypes";

export function MemoryTab({
  memory,
  onMemoryChange,
}: {
  memory: ChapterStoryMemory | null;
  onMemoryChange: (memory: ChapterStoryMemory) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (!memory?.pages.length) {
    return (
      <div className="style-guide-content">
        <p className="muted-line style-guide-empty">
          {t("styleGuide.memory.empty")}
        </p>
      </div>
    );
  }
  const updateVisualSummary = (pageId: string, value: string): void => {
    const updatedAt = new Date().toISOString();
    onMemoryChange({
      ...memory,
      pages: memory.pages.map((page) =>
        page.pageId === pageId
          ? {
              ...page,
              visualSummary: value.trim() ? value : undefined,
              visualSummarySource: "manual",
              updatedAt,
            }
          : page,
      ),
      updatedAt,
    });
  };
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
              <label>
                <span>{t("styleGuide.memory.visualSummary")}</span>
                <textarea
                  rows={3}
                  maxLength={1200}
                  value={page.visualSummary ?? ""}
                  placeholder={t("styleGuide.memory.visualSummaryPlaceholder")}
                  onChange={(event) =>
                    updateVisualSummary(page.pageId, event.target.value)
                  }
                />
              </label>
              {page.summary || page.translatedDigest || page.sourceDigest ? (
                <p>
                  <strong>{t("styleGuide.memory.textSummary")}</strong>{" "}
                  {page.summary || page.translatedDigest || page.sourceDigest}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
