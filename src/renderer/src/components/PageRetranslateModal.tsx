import React from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import { BLOCK_MODE_OPTIONS } from "../lib/blockModeOptions";
import { OptionRow } from "./TranslationOptionsModal";
import { Button, Modal } from "./ui";

export function PageRetranslateModal({
  pageName,
  blockCount,
  uiSettings,
  onStart,
  onPersistDefaults,
  onClose,
}: {
  pageName: string;
  blockCount: number;
  uiSettings: UiSettings | undefined;
  onStart: (blockMode: AnalysisBlockMode) => void;
  onPersistDefaults: (patch: Pick<UiSettings, "blockModeDefault">) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [blockMode, setBlockMode] = React.useState<AnalysisBlockMode>(
    uiSettings?.blockModeDefault ?? "auto",
  );

  const handleStart = (): void => {
    onPersistDefaults({ blockModeDefault: blockMode });
    onStart(blockMode);
    onClose();
  };

  return (
    <Modal
      title="페이지 재번역"
      size="md"
      onClose={onClose}
      closeOnBackdrop
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={handleStart}>
            재번역 시작
          </Button>
        </>
      }
    >
      <div className="translate-options">
        <p className="translate-options-context">
          페이지: <strong>{pageName}</strong> (블록 {blockCount}개)
        </p>
        <OptionRow
          label="블록"
          options={BLOCK_MODE_OPTIONS}
          value={blockMode}
          onChange={setBlockMode}
        />
        <p className="translate-options-hint">
          {blockMode === "keep"
            ? "현재 블록들의 영역·서식을 그대로 두고 각 영역의 텍스트만 다시 채웁니다."
            : "기존 블록을 모두 지우고 자동 감지로 새 블록을 만듭니다."}
        </p>
        <p className="translate-options-hint">
          기존 번역 결과와 수정 내용이 이 페이지에서 덮어써집니다.
        </p>
      </div>
    </Modal>
  );
}
