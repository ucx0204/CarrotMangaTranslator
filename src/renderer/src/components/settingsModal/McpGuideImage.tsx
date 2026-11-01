import { useTranslation } from "react-i18next";
import React from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import styles from "./McpSettingsPanel.module.css";

/** A guide screenshot with an enlarge button that opens it in a modal. */
export function GuideImage({
  src,
  title,
  kind,
}: {
  src: string;
  title: string;
  kind?: "sidebar" | "form" | "highlight" | "menu";
}) {
  const { t } = useTranslation("components");
  const [expanded, setExpanded] = React.useState(false);
  const picture = (
    <div className={styles.guidePicture} data-kind={kind}>
      <img src={src} alt={title} />
      {kind === "highlight" && (
        <span className={styles.pluginHighlight} aria-hidden="true" />
      )}
    </div>
  );
  return (
    <figure className={styles.guideFigure}>
      {picture}
      <figcaption>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${title} · ${t("mcpGuideCopy.enlarge")}`}
          onClick={() => setExpanded(true)}
        >
          {t("mcpGuideCopy.enlarge")}
        </Button>
      </figcaption>
      {expanded && (
        <Modal
          title={title}
          size="xl"
          closeOnBackdrop
          onClose={() => setExpanded(false)}
          bodyClassName={styles.guidePreview}
        >
          {picture}
        </Modal>
      )}
    </figure>
  );
}
