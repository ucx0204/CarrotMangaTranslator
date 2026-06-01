import React, { useState } from "react";

export function InpaintingGuideModal({ onClose }: { onClose: (hideNextTime: boolean) => void }): React.JSX.Element {
  const [hideNextTime, setHideNextTime] = useState(false);

  return (
    <div className="modal-backdrop guide-backdrop" role="presentation">
      <div
        className="modal-card inpainting-guide-modal"
        role="dialog"
        aria-modal="true"
        aria-label="인페인팅 안내"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="inpainting-guide-content">
          <h2>인페인팅 흐름</h2>
          <p>이제 원문 지우기는 Flux 무늬 배경 처리로 통일됩니다.</p>
          <ol>
            <li>이 페이지 또는 전체 페이지의 원문을 지웁니다.</li>
            <li>마음에 안 드는 부분은 붓, 복원 붓, 그려서 지우기로 보정합니다.</li>
            <li>블록을 눌러 폰트, 색상, 위치를 정리한 뒤 PNG로 출력합니다.</li>
          </ol>
        </div>
        <div className="modal-actions guide-actions">
          <label className="guide-hide-check">
            <input type="checkbox" checked={hideNextTime} onChange={(event) => setHideNextTime(event.target.checked)} />
            <span>다시는 보지 않기</span>
          </label>
          <button className="primary" onClick={() => onClose(hideNextTime)}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}
