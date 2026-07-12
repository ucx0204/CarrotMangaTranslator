import React from "react";
import { useTranslation } from "react-i18next";
import type { ChapterStoryMemory } from "../../../../shared/workContextTypes";

export function MemoryTab({
  memory,
}: {
  memory: ChapterStoryMemory | null;
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
