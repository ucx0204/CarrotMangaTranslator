import React from "react";

export function ConfirmModal({
  title,
  message,
  detail,
  onConfirm,
  onCancel
}: {
  title: string;
  message: string;
  detail?: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop confirm-backdrop" role="presentation">
      <div
        className="modal-card confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="confirm-title-row">
            <span className="confirm-warning-icon" aria-hidden="true">
              !
            </span>
            <h2 id="confirm-title">{title}</h2>
          </div>
        </div>
        <section className="modal-section confirm-body">
          <strong>{message}</strong>
          {detail ? <p>{detail}</p> : null}
        </section>
        <div className="modal-actions">
          <button onClick={onCancel}>취소</button>
          <button className="primary" onClick={onConfirm}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}
