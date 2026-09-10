"""Feature-only integration checkpoint 3. No automatic detection or release actions."""
import json
import os
import re
from pathlib import Path

assert os.environ.get("GITHUB_REF") == "refs/heads/feat/manual-redaction-workspace-20260910"


def replace_once(path, old, new):
    target = Path(path)
    source = target.read_text(encoding="utf-8")
    normalized = lambda text: re.sub(r"\s+", "", text)
    if normalized(new) in normalized(source):
        return
    if source.count(old) != 1:
        raise RuntimeError(f"Unexpected integration context: {path}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_once("src/renderer/src/components/imageRedaction/RedactionMaskCanvas.tsx",
             "  onFailure: (error: unknown) => void;", "  onFailure: (error: unknown) => void; onReady?: () => void;")
replace_once("src/renderer/src/components/imageRedaction/RedactionMaskCanvas.tsx",
             "strokes, draft, thumbnail, onFailure }: Props", "strokes, draft, thumbnail, onFailure, onReady }: Props")
replace_once("src/renderer/src/components/imageRedaction/RedactionMaskCanvas.tsx",
             "  const report = useEventCallback(onFailure);", "  const report = useEventCallback(onFailure);\n  const ready = useEventCallback(() => onReady?.());")
replace_once("src/renderer/src/components/imageRedaction/RedactionMaskCanvas.tsx",
             "      if (draft) paintDraft(context, scaleStroke(draft, scale));", "      if (draft) paintDraft(context, scaleStroke(draft, scale));\n      ready();")
replace_once("src/renderer/src/components/imageRedaction/RedactionMaskCanvas.tsx",
             "[width, height, strokes, draft, scale, report]", "[width, height, strokes, draft, scale, report, ready]")
replace_once("src/renderer/src/components/imageRedaction/useRedactionWorkspace.ts",
             "return () => { mounted.current = false; previews.dispose(); };", "return () => {\n      mounted.current = false;\n      queueMicrotask(() => { if (!mounted.current) previews.dispose(); });\n    };")
replace_once("src/renderer/src/components/imageRedaction/useRedactionWorkspace.ts",
             "notify: (status) => { if (mounted.current) setSaveStatus(status); },", "notify: (status) => {\n      if (!mounted.current) return;\n      setSaveStatus(status);\n      if (status.kind === \"saved\") setError(\"\");\n    },")
replace_once("src/renderer/src/components/imageRedaction/redactionWorkspaceModel.ts",
             "return editRedactionDocuments(state, changes, true);", "return editRedactionDocuments(state, changes, input.ids.length > 1);")
path = Path("src/renderer/src/components/imageRedaction/RedactionWorkspace.module.css")
css = path.read_text(encoding="utf-8")
if ".panel[hidden]" not in css:
    path.write_text(css + "\n.panel { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; gap: var(--sp-2); }\n.panel[hidden] { display: none; }\n", encoding="utf-8")

labels = {
"title": ["전송 이미지 가리기", "Outbound image redaction", "送信画像のマスキング"],
"operationFailed": ["처리하지 못했습니다. 변경 내용은 이 창에 남아 있습니다. 다시 시도해 주세요. 원본이 변경된 경우 저장된 초안으로 다시 준비해 주세요.", "The operation failed. Your edits remain in this window. Retry; if a source changed, reopen the saved draft.", "処理できませんでした。編集内容はこの画面に残っています。再試行してください。原本が変更された場合は保存済みの下書きを開き直してください。"],
"openFailed": ["가리기 작업을 열지 못했습니다. 저장한 초안은 유지됩니다. 다시 시도하거나 작업을 취소해 주세요.", "The redaction workspace could not be opened. Saved drafts are preserved. Retry or cancel the job.", "編集画面を開けませんでした。保存済みの下書きは維持されます。再試行するか処理をキャンセルしてください。"],
"loading": ["불러오는 중…", "Loading…", "読み込み中…"],
"canvas": ["수동 가리기 편집 영역", "Manual redaction canvas", "手動マスキング編集領域"],
"canvasHint": ["X 다음 · Z 이전 · Enter 확인하고 다음 · Shift+Enter 보류 · Space+드래그 이동 · Ctrl/⌘+휠 확대", "X next · Z previous · Enter review and next · Shift+Enter defer · Space+drag pan · Ctrl/⌘+wheel zoom", "X 次へ · Z 前へ · Enter 確認して次へ · Shift+Enter 保留 · Space+ドラッグ 移動 · Ctrl/⌘+ホイール 拡大"],
"previewFailed": ["이미지를 표시하지 못했습니다. 원본이 변경되었거나 파일을 읽을 수 없습니다. 다시 시도해 주세요.", "The image could not be displayed. It may have changed or become unreadable. Please retry.", "画像を表示できませんでした。原本が変更されたか、読み込めません。再試行してください。"],
"previewErrorShort": ["미리보기 오류", "Preview error", "プレビューエラー"],
"unreviewed": ["미확인", "Unreviewed", "未確認"],
"reviewed": ["확인 완료", "Reviewed", "確認済み"],
"deferred": ["보류", "Deferred", "保留"],
"hasMask": ["가림 편집 있음", "Mask edited", "マスク編集あり"],
"pageLabel": ["{{number}} · {{name}} · {{status}}", "{{number}} · {{name}} · {{status}}", "{{number}} · {{name}} · {{status}}"],
"pageList": ["가리기 페이지 목록", "Redaction pages", "マスキングのページ一覧"],
"emptyFilter": ["이 조건에 해당하는 페이지가 없습니다.", "No pages match this filter.", "この条件に一致するページはありません。"],
"tool": ["수동 가리기 도구", "Manual redaction tool", "手動マスキングツール"],
"tool_rectangle": ["사각형 R", "Rectangle R", "矩形 R"],
"tool_brush": ["브러시 B", "Brush B", "ブラシ B"],
"tool_erase": ["가림 지우개 E", "Restore mask E", "マスク消しゴム E"],
"tool_select": ["선택 V", "Select V", "選択 V"],
"tool_pan": ["이동 H", "Pan H", "移動 H"],
"deleteSelection": ["선택 가림 삭제", "Delete selected mask", "選択したマスクを削除"],
"previousMask": ["이전 페이지 가림 가져오기", "Use previous page masks", "前のページのマスクを使用"],
"presets": ["가림 프리셋", "Mask presets", "マスクのプリセット"],
"viewMode": ["보기 방식", "View mode", "表示モード"],
"mode_edit": ["연속 편집", "Continuous editing", "連続編集"],
"mode_grid": ["전체 보기", "Overview", "一覧表示"],
"filter": ["페이지 필터", "Page filter", "ページのフィルター"],
"filter_all": ["전체", "All", "すべて"],
"filter_unreviewed": ["미확인", "Unreviewed", "未確認"],
"filter_deferred": ["보류", "Deferred", "保留"],
"filter_masked": ["가림 편집 있음", "Mask edited", "マスク編集あり"],
"filter_error": ["불러오기 오류", "Load errors", "読み込みエラー"],
"jumpPage": ["페이지 번호로 이동", "Go to page number", "ページ番号に移動"],
"thumbnailSize": ["썸네일 크기", "Thumbnail size", "サムネイルのサイズ"],
"shortcuts": ["단축키·보기 설정", "Shortcuts and view", "ショートカット・表示設定"],
"selectedCount": ["{{count}}장 선택", "{{count}} selected", "{{count}}ページを選択"],
"selectFiltered": ["표시 범위 전체 선택", "Select filtered pages", "表示範囲をすべて選択"],
"clearSelection": ["선택 해제", "Clear selection", "選択を解除"],
"reviewSelection": ["선택한 페이지 확인", "Review selected pages", "選択したページを確認"],
"copySelection": ["선택 범위에 가림 적용", "Apply masks to selection", "選択範囲にマスクを適用"],
"undoBatch": ["일괄 작업 취소", "Undo batch", "一括操作を元に戻す"],
"redoBatch": ["일괄 작업 다시 실행", "Redo batch", "一括操作をやり直す"],
"applyCount": ["{{count}}장에 적용", "Apply to {{count}} pages", "{{count}}ページに適用"],
"batchCount": ["선택한 {{count}}장 · 가림 편집 {{masked}}장", "{{count}} selected pages · {{masked}} with edited masks", "選択した{{count}}ページ · マスク編集済み{{masked}}ページ"],
"explicitReviewHint": ["선택한 범위를 현재 가리기 상태로 확인합니다. 이미지를 불러오는 것만으로는 확인 처리되지 않습니다.", "Explicitly review the selected pages with their current masks. Loading a preview alone never marks a page reviewed.", "選択した範囲を現在のマスク状態で確認します。プレビューを読み込んだだけでは確認済みになりません。"],
"failedCount": ["{{count}}장의 불러오기 오류를 먼저 해결해 주세요.", "Resolve loading errors on {{count}} pages first.", "先に{{count}}ページの読み込みエラーを解決してください。"],
"unseenAcknowledgement": ["미리보기를 아직 불러오지 않은 {{count}}장도 포함하여, 선택한 범위를 현재 가리기 상태로 확인합니다.", "I explicitly confirm the current masks for this selection, including {{count}} pages whose previews have not loaded yet.", "プレビューがまだ読み込まれていない{{count}}ページを含め、選択範囲を現在のマスク状態で明示的に確認します。"],
"sizeMismatch": ["{{count}}장의 크기가 다릅니다. 비율 맞춤을 선택한 경우 결과를 다시 확인해야 합니다.", "{{count}} pages have different dimensions. Proportional copies must be reviewed again.", "{{count}}ページのサイズが異なります。比率に合わせてコピーした結果は再確認が必要です。"],
"copyScale": ["다른 크기 처리", "Dimension handling", "異なるサイズの処理"],
"scale_exact": ["같은 크기만", "Exact dimensions", "同じサイズのみ"],
"scale_proportional": ["페이지 비율에 맞춤", "Scale to page dimensions", "ページの比率に合わせる"],
"replaceExisting": ["기존 가림을 교체합니다. 기본 동작은 기존 가림에 추가입니다.", "Replace existing masks. The default is to add to existing masks.", "既存のマスクを置き換えます。通常は既存のマスクに追加します。"],
"copyReviewHint": ["적용한 페이지는 미확인으로 바뀝니다. 그림마다 위치가 다를 수 있으므로 직접 확인해 주세요. 여러 장 적용은 한 번에 되돌릴 수 있습니다.", "Affected pages become unreviewed. Check placement manually on each image. Multi-page applications can be undone together.", "適用したページは未確認になります。画像ごとに位置を確認してください。複数ページへの適用はまとめて元に戻せます。"],
"examplePreview": ["적용 예시 · {{name}}", "Example result · {{name}}", "適用例 · {{name}}"],
"chooseScaling": ["크기 처리 방식을 선택하면 적용 결과가 표시됩니다.", "Choose dimension handling to preview the result.", "サイズの処理方法を選ぶと適用結果が表示されます。"],
"close": ["닫기", "Close", "閉じる"],
"usePreset": ["선택 범위에 사용", "Use for selection", "選択範囲に使用"],
"presetHint": ["선택한 가림이 있으면 그 가림을, 없으면 현재 페이지의 가림을 저장합니다. 자동 감지 없이 직접 만든 가림만 사용합니다. 최대 30개까지 저장합니다.", "Save the selected mask, or all masks on the current page when none is selected. Presets contain only manually created masks, with no detection. Up to 30 presets.", "マスクを選択している場合はそのマスク、未選択の場合は現在のページのマスクを保存します。自動検出は行いません。最大30件まで保存できます。"],
"presetName": ["프리셋 이름", "Preset name", "プリセット名"],
"presetNameHint": ["예: 상단 워터마크", "For example: top watermark", "例: 上部の透かし"],
"savePreset": ["현재 가림을 프리셋으로 저장", "Save current masks as preset", "現在のマスクをプリセットに保存"],
"savedPresets": ["저장한 프리셋", "Saved presets", "保存済みプリセット"],
"strokeCount": ["가림 동작 {{count}}개", "{{count}} mask operations", "マスク操作{{count}}件"],
"confirmDeletePreset": ["이 프리셋 삭제 확인", "Confirm preset deletion", "このプリセットの削除を確定"],
"deletePreset": ["프리셋 삭제", "Delete preset", "プリセットを削除"],
"noPresets": ["저장한 프리셋이 없습니다.", "No presets saved yet.", "保存済みのプリセットはありません。"],
"keysNavigate": ["이전 / 다음 페이지로 이동만", "Navigate without marking reviewed", "確認せず前後のページへ移動"],
"keysConfirm": ["현재 상태 확인 후 다음 미확인 페이지", "Review current state and go to next unreviewed page", "現在の状態を確認して次の未確認ページへ"],
"keysDefer": ["보류 후 다음 미확인 페이지", "Defer and go to next unreviewed page", "保留して次の未確認ページへ"],
"keysContinue": ["전체 확인 후 작업 계속 (사전 편집은 저장만)", "Continue after review; preparation mode only saves", "全体確認後に続行（事前編集では保存のみ）"],
"keysTools": ["사각형 / 브러시 / 가림 지우개 / 선택 / 이동", "Rectangle / brush / mask eraser / select / pan", "矩形 / ブラシ / マスク消しゴム / 選択 / 移動"],
"keysPan": ["누르고 있는 동안 화면 이동", "Temporarily pan while held", "押している間だけ画面を移動"],
"keysSize": ["브러시 크기 줄이기 / 늘리기", "Decrease / increase brush size", "ブラシを小さく / 大きく"],
"keysUndo": ["현재 페이지 실행 취소", "Undo on the current page", "現在のページの操作を元に戻す"],
"keysRedo": ["현재 페이지 다시 실행", "Redo on the current page", "現在のページの操作をやり直す"],
"keysZoom": ["화면에 맞춤 / 실제 크기", "Fit / actual size", "画面に合わせる / 実寸"],
"shortcutScope": ["문자 단축키는 편집 영역에 포커스가 있을 때만 작동합니다. 입력·한글 조합 중에는 동작하지 않습니다. Enter를 계속 누르거나 마지막 페이지를 확인해도 자동 전송하지 않습니다.", "Character shortcuts work only in the editing area, never while typing or composing text. Holding Enter or reviewing the last page does not send automatically.", "文字キーは編集領域にフォーカスがあるときだけ有効です。文字入力・変換中は動作しません。Enterの長押しや最後のページの確認だけで自動送信されることはありません。"],
"letterShortcuts": ["문자 단축키 사용", "Enable character shortcuts", "文字ショートカットを使用"],
"previousKey": ["이전 페이지 키 (빈칸: 해제)", "Previous-page key (empty to disable)", "前ページのキー（空欄で解除）"],
"nextKey": ["다음 페이지 키 (빈칸: 해제)", "Next-page key (empty to disable)", "次ページのキー（空欄で解除）"],
"keyConflict": ["서로 다른 영문 한 글자를 사용해 주세요. R/B/E/V/H/F는 도구에 사용됩니다.", "Use distinct single English letters. R/B/E/V/H/F are reserved for tools.", "異なる英字1文字を使用してください。R/B/E/V/H/Fはツール用です。"],
"keepZoom": ["처음 여는 다음 페이지에도 확대율 유지 (위치는 상단부터)", "Keep zoom on newly opened pages (start at the top)", "初めて開く次のページも拡大率を維持（位置は上から）"],
"saveAndClose": ["설정 저장 후 닫기", "Save settings and close", "設定を保存して閉じる"],
"gotoErrors": ["불러오기 오류 {{count}}장 확인", "Resolve {{count}} loading errors", "読み込みエラー{{count}}ページを確認"],
"gotoUnreviewed": ["미확인 {{count}}장으로 이동", "Go to {{count}} unreviewed pages", "未確認{{count}}ページへ移動"],
"gotoDeferred": ["보류한 {{count}}장 확인", "Review {{count}} deferred pages", "保留した{{count}}ページを確認"],
"finishPreparation": ["확인한 {{count}}장 준비 저장", "Save preparation for {{count}} reviewed pages", "確認した{{count}}ページの準備を保存"],
"continueCount": ["확인한 {{count}}장으로 작업 계속", "Continue with {{count}} reviewed pages", "確認した{{count}}ページで処理を続行"],
"progress": ["{{count}} / {{total}}장 확인", "{{count}} / {{total}} reviewed", "{{count}} / {{total}}ページ確認済み"],
"save_saved": ["초안 저장됨", "Draft saved", "下書き保存済み"],
"save_saving": ["초안 저장 중…", "Saving draft…", "下書きを保存中…"],
"save_error": ["저장 실패 — 이 창의 변경 내용 유지", "Save failed — edits retained in this window", "保存失敗 — 編集内容はこの画面に保持"],
"previous": ["이전 Z", "Previous Z", "前へ Z"],
"next": ["다음 X", "Next X", "次へ X"],
"deferNext": ["보류하고 다음", "Defer and next", "保留して次へ"],
"confirmNext": ["확인하고 다음 Enter", "Review and next Enter", "確認して次へ Enter"],
"saveExit": ["저장 후 나가기", "Save and exit", "保存して終了"],
"exitTitle": ["가리기 편집 종료", "Exit redaction editing", "マスク編集を終了"],
"keepEditing": ["편집 계속", "Keep editing", "編集を続ける"],
"discardSession": ["이번 편집 되돌리고 나가기", "Revert this session and exit", "今回の編集を戻して終了"],
"exitHint": ["저장 후 나가면 현재 위치와 가리기를 이어서 편집할 수 있습니다. 이번 편집 되돌리기는 이 창을 열기 전 상태로 복원합니다. 어느 쪽도 이미지를 전송하지 않으며, 대기 중인 작업은 취소합니다.", "Save to resume your position and masks later. Reverting restores the state from when this window opened. Neither option sends images; a waiting job is cancelled.", "保存すると現在の位置とマスクから再開できます。編集を戻すとこの画面を開く前の状態になります。どちらも画像を送信せず、待機中の処理はキャンセルします。"],
"outboundHint": ["원본은 바꾸지 않습니다. 자동 저장은 전송 승인이 아니며, 마지막에 확인한 페이지로 작업을 계속해야 전송됩니다.", "Originals stay unchanged. Autosave is not transmission approval; explicitly continue when review is complete.", "原本は変更しません。自動保存は送信の承認ではありません。確認後に明示的に処理を続行してください。"],
"preparationHint": ["사전 편집 중입니다. 이 화면에서는 이미지를 전송하지 않습니다. 저장한 가림과 확인 상태는 원본이 같을 때 다음 작업에서 재사용합니다.", "Preparation only: this window does not send images. Saved masks and reviews are reused when the original is unchanged.", "事前編集です。この画面では画像を送信しません。原本が同じ場合、保存したマスクと確認状態を次の処理で再利用します。"],
}
for index, language in enumerate(("ko", "en", "ja")):
    path = Path(f"src/shared/i18n/locales/{language}/components.json")
    catalog = json.loads(path.read_text(encoding="utf-8"))
    section = catalog.setdefault("manualRedaction", {})
    section.update({key: values[index] for key, values in labels.items()})
    path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
