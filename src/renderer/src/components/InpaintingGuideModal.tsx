import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import inpaintingGuideImage from "../assets/images/inpainting-guide.png";
import styles from "./InpaintingGuideModal.module.css";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";

export function InpaintingGuideModal({
  onClose,
}: {
  onClose: (hideNextTime: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [hideNextTime, setHideNextTime] = useState(false);

  return (
    <Modal
      ariaLabel={t("inpainting.guide.title")}
      size="xl"
      width="min(1360px, calc(100vw - 24px))"
      bodyClassName={styles.body}
      footer={
        <ModalActionBar
          leading={
            <label className="guide-hide-check">
              <input
                type="checkbox"
                checked={hideNextTime}
                onChange={(event) => setHideNextTime(event.target.checked)}
              />
              <span>{t("inpainting.guide.hideNextTime")}</span>
            </label>
          }
          actions={
            <Button variant="primary" onClick={() => onClose(hideNextTime)}>
              {t("common.confirm")}
            </Button>
          }
        />
      }
    >
      <div className={styles.content}>
        <img
          className={styles.image}
          src={inpaintingGuideImage}
          alt={t("inpainting.guide.imageAlt")}
        />
      </div>
    </Modal>
  );
}
