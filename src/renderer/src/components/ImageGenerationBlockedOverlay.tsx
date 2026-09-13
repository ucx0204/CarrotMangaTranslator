import type React from "react";
import { useTranslation } from "react-i18next";
import type { OverlayBlockRenderModel } from "./overlayBlockModel";
import styles from "./ImageGenerationBlockedOverlay.module.css";

export function ImageGenerationBlockedOverlay({
  model,
}: {
  model: OverlayBlockRenderModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.bounds} data-image-generation-blocked="sexual">
      <span
        className={styles.label}
        style={{
          left: Math.min(
            0,
            model.stageSize.width - model.layout.rect.left - 150,
          ),
          ...(model.layout.rect.top < 24 ? { top: 0, bottom: "auto" } : {}),
        }}
      >
        {t("overlay.sexualImageBlocked")}
      </span>
    </div>
  );
}
