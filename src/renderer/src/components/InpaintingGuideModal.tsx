import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import inpaintingGuideImage from "../assets/images/inpainting-guide.png";
import styles from "./InpaintingGuideModal.module.css";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
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
            <CheckboxField
              className="guide-hide-check"
              label={t("inpainting.guide.hideNextTime")}
              checked={hideNextTime}
              onCheckedChange={setHideNextTime}
            />
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
