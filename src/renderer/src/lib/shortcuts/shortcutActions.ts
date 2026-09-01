import type { ShortcutActionId } from "../../../../shared/shortcutSettings";
import type { ShortcutActionDef, ShortcutContext } from "./shortcutActionTypes";

/**
 * Single source of truth for the app's customizable keyboard shortcuts.
 *
 * Each action has a built-in `defaultCombo`; users may override it via settings
 * (`AppSettings.keybindings`, an action-id → combo map). An override of `""`
 * means the action is intentionally unbound. The combo string format is the one
 * produced by `comboFromEvent` (e.g. "ctrl+shift+b", "delete", "1", "?").
 *
 * Wheel page navigation remains a gesture handler. Keyboard page navigation
 * and block navigation are regular actions so users can customize them.
 */

const canTranslate = (context: ShortcutContext): boolean =>
  context.chapterOpen && !context.jobActive;

export const SHORTCUT_ACTIONS: ShortcutActionDef[] = [
  {
    id: "toggle-block-chrome",
    label: "배경/테두리 표시 전환",
    category: "view",
    defaultCombo: "shift+b",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "toggle-text-blocks",
    label: "블록 표시 전환",
    category: "view",
    defaultCombo: "v",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "toggle-peek-original",
    label: "원본 미리보기 전환",
    category: "view",
    defaultCombo: "o",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "zoom-in",
    label: "이미지 확대",
    category: "view",
    defaultCombo: "ctrl+=",
    defaultAlternateCombos: [
      "numpadadd",
      "ctrl+numpadadd",
      "ctrl+add",
      "ctrl++",
      "ctrl+wheelup",
    ],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-out",
    label: "이미지 축소",
    category: "view",
    defaultCombo: "ctrl+-",
    defaultAlternateCombos: [
      "numpadsubtract",
      "ctrl+numpadsubtract",
      "ctrl+wheeldown",
    ],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-reset",
    label: "확대 초기화",
    category: "view",
    defaultCombo: "ctrl+0",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-fit-contain",
    label: "화면에 맞춤",
    category: "view",
    defaultCombo: "",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-fit-width",
    label: "너비에 맞춤",
    category: "view",
    defaultCombo: "",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-fit-height",
    label: "높이에 맞춤",
    category: "view",
    defaultCombo: "",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "zoom-actual-size",
    label: "실제 크기",
    category: "view",
    defaultCombo: "",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "page-previous",
    label: "이전 페이지",
    category: "view",
    defaultCombo: "pageup",
    defaultAlternateCombos: ["a", "arrowleft"],
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "page-next",
    label: "다음 페이지",
    category: "view",
    defaultCombo: "pagedown",
    defaultAlternateCombos: ["d", "arrowright"],
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "stage-tool-select",
    label: "선택 도구",
    category: "tool",
    defaultCombo: "s",
    defaultAlternateCombos: ["1"],
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "stage-tool-block",
    label: "블록 도구 (드래그로 블록 추가)",
    category: "tool",
    defaultCombo: "w",
    defaultAlternateCombos: ["2"],
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "stage-tool-hand",
    label: "손바닥 도구 (드래그로 이동)",
    category: "tool",
    defaultCombo: "h",
    defaultAlternateCombos: ["3"],
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "toggle-stage-toolbar",
    label: "도구 모음 표시 전환",
    category: "tool",
    defaultCombo: "4",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "open-translate-options",
    label: "번역 옵션 열기",
    category: "translate",
    defaultCombo: "t",
    enabled: canTranslate,
  },
  {
    id: "translate-pending",
    label: "이어서 번역 (남은 페이지)",
    category: "translate",
    defaultCombo: "shift+t",
    enabled: canTranslate,
  },
  {
    id: "translate-all",
    label: "전체 다시 번역",
    category: "translate",
    defaultCombo: "",
    enabled: canTranslate,
  },
  {
    id: "gather-text",
    label: "텍스트 모아보기",
    category: "translate",
    defaultCombo: "g",
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "cancel-job",
    label: "작업 취소",
    category: "translate",
    defaultCombo: "",
    enabled: (c) => c.jobActive,
  },
  {
    id: "toggle-inpainting",
    label: "원문 지우기",
    category: "inpaint",
    defaultCombo: "i",
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "retouch-tool-mask",
    label: "마스크 브러시",
    category: "inpaint",
    defaultCombo: "j",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "retouch-tool-brush",
    label: "페인트 브러시",
    category: "inpaint",
    defaultCombo: "b",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "retouch-tool-rectangle",
    label: "사각형 보정",
    category: "inpaint",
    defaultCombo: "r",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "retouch-tool-ellipse",
    label: "타원 보정",
    category: "inpaint",
    defaultCombo: "e",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "retouch-tool-eraser",
    label: "보정 지우개",
    category: "inpaint",
    defaultCombo: "x",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "retouch-tool-eraser-rectangle",
    label: "사각 지우개",
    category: "inpaint",
    defaultCombo: "",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "retouch-tool-picker",
    label: "색상 추출",
    category: "inpaint",
    defaultCombo: "p",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "retouch-apply-mask",
    label: "마스크 적용",
    category: "inpaint",
    defaultCombo: " ",
    enabled: (c) => c.chapterOpen && c.retouchToolActive && !c.editLocked,
  },
  {
    id: "retouch-cancel-mask",
    label: "마스크 취소",
    category: "inpaint",
    defaultCombo: "",
    enabled: (c) => c.chapterOpen && c.retouchToolActive && !c.editLocked,
  },
  {
    id: "block-previous",
    label: "이전 블록",
    category: "edit",
    defaultCombo: "ctrl+shift+tab",
    defaultAlternateCombos: ["alt+arrowup"],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "block-next",
    label: "다음 블록",
    category: "edit",
    defaultCombo: "ctrl+tab",
    defaultAlternateCombos: ["alt+arrowdown"],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "select-all-blocks",
    label: "페이지 블록 전체 선택",
    category: "edit",
    defaultCombo: "ctrl+a",
    enabled: (c) => c.chapterOpen && !c.editLocked,
  },
  {
    id: "move-block-earlier",
    label: "읽기 순서 앞으로",
    category: "edit",
    defaultCombo: "ctrl+alt+arrowup",
    enabled: (c) => c.blockSelected && !c.editLocked,
  },
  {
    id: "move-block-later",
    label: "읽기 순서 뒤로",
    category: "edit",
    defaultCombo: "ctrl+alt+arrowdown",
    enabled: (c) => c.blockSelected && !c.editLocked,
  },
  {
    id: "sort-reading-order",
    label: "좌표 기준 읽기 순서 정렬",
    category: "edit",
    defaultCombo: "ctrl+shift+r",
    enabled: (c) => c.blockSelected && !c.editLocked,
  },
  {
    id: "reset-block-rotation",
    label: "블록 회전 초기화",
    category: "edit",
    defaultCombo: "ctrl+shift+t",
    enabled: (c) => c.blockSelected && !c.editLocked,
  },
  {
    id: "open-search-replace",
    label: "일괄 편집",
    category: "edit",
    defaultCombo: "ctrl+h",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen,
  },
  {
    id: "open-export-options",
    label: "내보내기 열기",
    category: "edit",
    defaultCombo: "ctrl+e",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "history-undo",
    label: "실행 취소",
    category: "edit",
    defaultCombo: "ctrl+z",
    allowInEditable: true,
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "history-redo",
    label: "다시 실행",
    category: "edit",
    defaultCombo: "ctrl+shift+z",
    defaultAlternateCombos: ["ctrl+y"],
    allowInEditable: true,
    enabled: (c) => c.chapterOpen && !c.jobActive,
  },
  {
    id: "delete-block",
    label: "선택한 블록 삭제",
    category: "edit",
    defaultCombo: "delete",
    enabled: (c) => c.blockSelected && !c.editLocked,
  },
  {
    id: "duplicate-block",
    label: "선택한 블록 복제",
    category: "edit",
    defaultCombo: "ctrl+d",
    enabled: (c) => c.blockSelected && !c.editLocked,
  },
  {
    id: "toggle-block-excluded",
    label: "블록 인페인팅 제외 전환",
    category: "edit",
    defaultCombo: "shift+x",
    enabled: (c) => c.blockSelected && !c.editLocked,
  },
  ...createStyleSlotActions(),
  {
    id: "toggle-command-palette",
    label: "명령 팔레트",
    category: "global",
    defaultCombo: "ctrl+k",
    allowInEditable: true,
  },
  {
    id: "toggle-shortcut-help",
    label: "단축키 도움말",
    category: "global",
    defaultCombo: "?",
  },
  {
    id: "open-settings",
    label: "설정 열기",
    category: "global",
    defaultCombo: "ctrl+,",
    allowInEditable: true,
  },
];

function createStyleSlotActions(): ShortcutActionDef[] {
  return Array.from({ length: 10 }, (_, index) => {
    const slot = index + 1;
    const digit = slot === 10 ? 0 : slot;
    return {
      id: `apply-style-slot-${slot}` as ShortcutActionId,
      label: `스타일 슬롯 ${slot} 적용`,
      category: "edit" as const,
      defaultCombo: `alt+${digit}`,
      enabled: (context: ShortcutContext) =>
        context.blockSelected && !context.editLocked,
    };
  });
}
