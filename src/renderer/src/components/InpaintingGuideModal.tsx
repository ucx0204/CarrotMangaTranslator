import React, { useState } from "react";
import inpaintingGuideImage from "../assets/images/inpainting-guide.png";
import styles from "./InpaintingGuideModal.module.css";
import { Button, Modal } from "./ui";

export function InpaintingGuideModal({ onClose }: { onClose: (hideNextTime: boolean) => void }): React.JSX.Element {
  const [hideNextTime, setHideNextTime] = useState(false);

  return (
    <Modal
      ariaLabel="인페인팅 안내"
      size="xl"
      width="min(1360px, calc(100vw - 24px))"
      bodyClassName={styles.body}
      footer={
        <>
          <label className="guide-hide-check" style={{ marginRight: "auto" }}>
            <input type="checkbox" checked={hideNextTime} onChange={(event) => setHideNextTime(event.target.checked)} />
            <span>다시는 보지 않기</span>
          </label>
          <Button variant="primary" onClick={() => onClose(hideNextTime)}>
            확인
          </Button>
        </>
      }
    >
      <div className={styles.content}>
        <img
          className={styles.image}
          src={inpaintingGuideImage}
          alt="인페인팅 안내. 1단계 자동 배경 지우기, 2단계 남은 자국 보정, 완료 후 출력 단계로 이동."
        />
      </div>
    </Modal>
  );
}
