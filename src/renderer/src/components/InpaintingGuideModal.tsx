import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import inpaintingGuideImage from "../assets/images/inpainting-guide.png";
import styles from "./InpaintingGuideModal.module.css";
import { CheckboxField } from "./ui/CheckboxField";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";

export function InpaintingGuideModal({
  onClose,
}: {
  onClose: (hideNextTime: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [hideNextTime, setHideNextTime] = useState(false);

  return (
    <Modal
      title={t("inpainting.guide.title")}
      size="xl"
      width="min(1360px, calc(100vw - 24px))"
      bodyClassName={styles.body}
      // Read-only guide: dismissing it cannot lose work, so the backdrop and
      // the header close button both honour the "don't show again" checkbox.
      closeOnBackdrop
      onClose={() => onClose(hideNextTime)}
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
            <ModalActionButtons
              confirm={{
                label: t("common.confirm"),
                onClick: () => onClose(hideNextTime),
              }}
            />
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
