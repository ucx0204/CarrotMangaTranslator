import React, { useState } from "react";
import { Button, Modal } from "./ui";

export function InpaintingGuideModal({ onClose }: { onClose: (hideNextTime: boolean) => void }): React.JSX.Element {
  const [hideNextTime, setHideNextTime] = useState(false);

  return (
    <Modal
      ariaLabel="인페인팅 안내"
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
      <div className="inpainting-guide-content">
        <h2>인페인팅 흐름</h2>
        <p>원문 지우기는 ① 자동 → ② 직접 보정 → ③ 출력 순서로 진행합니다.</p>
        <ol>
          <li>① 자동: 이 페이지 또는 남은 페이지의 원문 배경을 한 번에 지웁니다.</li>
          <li>② 직접 보정: 붓·복원·그려서 지우기로 마음에 안 드는 부분을 다듬습니다.</li>
          <li>③ 출력: 블록의 폰트·색·위치를 정리한 뒤 PNG로 내보냅니다.</li>
        </ol>
      </div>
    </Modal>
  );
}
