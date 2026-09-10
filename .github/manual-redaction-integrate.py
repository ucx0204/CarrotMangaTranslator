"""Repair the reviewed feature locale files; never weaken the resource type contract."""
import json
import os
import re
from pathlib import Path

assert os.environ.get("GITHUB_REF") == "refs/heads/feat/manual-redaction-workspace-20260910"
ROOT = Path("src/shared/i18n/locales")
LOCALES = ("ko", "en", "ja", "zh-Hans", "zh-Hant")
CHINESE = {
    "title": ["发送图片遮挡", "傳送圖片遮擋"],
    "operationFailed": ["操作失败，编辑内容已保留。", "操作失敗，編輯內容已保留。"],
    "openFailed": ["无法打开编辑器，已保存的草稿不受影响。", "無法開啟編輯器，已儲存的草稿不受影響。"],
    "loading": ["正在加载…", "正在載入…"],
    "canvas": ["手动遮挡编辑区域", "手動遮擋編輯區域"],
    "canvasHint": ["X 下一页 · Z 上一页 · Enter 确认并继续 · Shift+Enter 暂缓 · 空格+拖动 平移 · Ctrl/⌘+滚轮 缩放", "X 下一頁 · Z 上一頁 · Enter 確認並繼續 · Shift+Enter 暫緩 · 空格+拖曳 平移 · Ctrl/⌘+滾輪 縮放"],
    "previewFailed": ["无法显示图片，请重试。", "無法顯示圖片，請重試。"],
    "previewErrorShort": ["预览错误", "預覽錯誤"],
    "unreviewed": ["未确认", "未確認"],
    "reviewed": ["已确认", "已確認"],
    "deferred": ["暂缓", "暫緩"],
    "hasMask": ["已编辑遮挡", "已編輯遮擋"],
    "pageLabel": ["{{number}} · {{name}} · {{status}}", "{{number}} · {{name}} · {{status}}"],
    "pageList": ["遮挡页面列表", "遮擋頁面清單"],
    "emptyFilter": ["没有符合条件的页面。", "沒有符合條件的頁面。"],
    "tool": ["手动遮挡工具", "手動遮擋工具"],
    "tool_rectangle": ["矩形 R", "矩形 R"],
    "tool_brush": ["画笔 B", "筆刷 B"],
    "tool_erase": ["遮挡橡皮 E", "遮擋橡皮擦 E"],
    "tool_select": ["选择 V", "選取 V"],
    "tool_pan": ["平移 H", "平移 H"],
    "deleteSelection": ["删除所选遮挡", "刪除所選遮擋"],
    "previousMask": ["沿用上一页", "沿用上一頁"],
    "presets": ["遮挡预设", "遮擋預設"],
    "viewMode": ["查看方式", "檢視方式"],
    "mode_edit": ["连续编辑", "連續編輯"],
    "mode_grid": ["总览", "總覽"],
    "filter": ["页面筛选", "頁面篩選"],
    "filter_all": ["全部", "全部"],
    "filter_unreviewed": ["未确认", "未確認"],
    "filter_deferred": ["暂缓", "暫緩"],
    "filter_masked": ["已编辑遮挡", "已編輯遮擋"],
    "filter_error": ["加载错误", "載入錯誤"],
    "jumpPage": ["跳转到页码", "跳至頁碼"],
    "thumbnailSize": ["缩略图大小", "縮圖大小"],
    "shortcuts": ["快捷键", "快捷鍵"],
    "selectedCount": ["已选 {{count}} 页", "已選 {{count}} 頁"],
    "selectFiltered": ["全选筛选结果", "全選篩選結果"],
    "clearSelection": ["取消选择", "取消選取"],
    "reviewSelection": ["确认所选页面", "確認所選頁面"],
    "copySelection": ["应用到所选页面", "套用至所選頁面"],
    "undoBatch": ["撤销批量操作", "復原批次操作"],
    "redoBatch": ["重做批量操作", "重做批次操作"],
    "applyCount": ["应用到 {{count}} 页", "套用至 {{count}} 頁"],
    "batchCount": ["已选 {{count}} 页 · {{masked}} 页已编辑遮挡", "已選 {{count}} 頁 · {{masked}} 頁已編輯遮擋"],
    "explicitReviewHint": ["按当前遮挡状态确认所选页面。", "依目前的遮擋狀態確認所選頁面。"],
    "failedCount": ["{{count}} 页加载失败，请重试。", "{{count}} 頁載入失敗，請重試。"],
    "unseenAcknowledgement": ["也确认尚未加载预览的 {{count}} 页", "也確認尚未載入預覽的 {{count}} 頁"],
    "sizeMismatch": ["{{count}} 页尺寸不同", "{{count}} 頁尺寸不同"],
    "copyScale": ["尺寸处理", "尺寸處理"],
    "scale_exact": ["仅相同尺寸", "僅相同尺寸"],
    "scale_proportional": ["按页面尺寸缩放", "依頁面尺寸縮放"],
    "replaceExisting": ["替换现有遮挡", "取代現有遮擋"],
    "copyReviewHint": ["应用后请检查位置。批量操作可一起撤销。", "套用後請檢查位置。批次操作可一併復原。"],
    "examplePreview": ["应用预览 · {{name}}", "套用預覽 · {{name}}"],
    "chooseScaling": ["选择尺寸处理方式以显示预览。", "選擇尺寸處理方式以顯示預覽。"],
    "close": ["关闭", "關閉"],
    "usePreset": ["使用预设", "使用預設"],
    "presetHint": ["保存所选遮挡；未选择时保存本页全部遮挡。最多 30 个预设。", "儲存所選遮擋；未選取時儲存本頁全部遮擋。最多 30 個預設。"],
    "presetName": ["预设名称", "預設名稱"],
    "presetNameHint": ["例如：顶部水印", "例如：頂部浮水印"],
    "savePreset": ["保存为预设", "儲存為預設"],
    "savedPresets": ["已保存的预设", "已儲存的預設"],
    "strokeCount": ["{{count}} 个遮挡操作", "{{count}} 個遮擋操作"],
    "confirmDeletePreset": ["确认删除预设", "確認刪除預設"],
    "deletePreset": ["删除预设", "刪除預設"],
    "noPresets": ["暂无预设。", "尚無預設。"],
    "keysNavigate": ["上一页 / 下一页", "上一頁 / 下一頁"],
    "keysConfirm": ["确认并跳到下一未确认页", "確認並跳至下一未確認頁"],
    "keysDefer": ["暂缓并继续", "暫緩並繼續"],
    "keysContinue": ["继续任务 / 保存准备", "繼續工作 / 儲存準備"],
    "keysTools": ["矩形 / 画笔 / 橡皮 / 选择 / 平移", "矩形 / 筆刷 / 橡皮擦 / 選取 / 平移"],
    "keysPan": ["按住平移", "按住平移"],
    "keysSize": ["减小 / 增大画笔", "縮小 / 放大筆刷"],
    "keysUndo": ["撤销本页操作", "復原本頁操作"],
    "keysRedo": ["重做本页操作", "重做本頁操作"],
    "keysZoom": ["适应窗口 / 原始大小", "符合視窗 / 原始大小"],
    "shortcutScope": ["输入文字时快捷键不生效。按住 Enter 或确认最后一页均不会自动发送。", "輸入文字時快捷鍵不生效。按住 Enter 或確認最後一頁均不會自動傳送。"],
    "letterShortcuts": ["启用字母快捷键", "啟用字母快捷鍵"],
    "previousKey": ["上一页快捷键", "上一頁快捷鍵"],
    "nextKey": ["下一页快捷键", "下一頁快捷鍵"],
    "keyConflict": ["请使用不同的英文字母，R/B/E/V/H/F 已被占用。", "請使用不同的英文字母，R/B/E/V/H/F 已被占用。"],
    "keepZoom": ["切换页面时保持缩放", "切換頁面時保留縮放"],
    "saveAndClose": ["保存并关闭", "儲存並關閉"],
    "gotoErrors": ["查看 {{count}} 页错误", "查看 {{count}} 頁錯誤"],
    "gotoUnreviewed": ["查看 {{count}} 页未确认内容", "查看 {{count}} 頁未確認內容"],
    "gotoDeferred": ["查看 {{count}} 页暂缓内容", "查看 {{count}} 頁暫緩內容"],
    "finishPreparation": ["保存 {{count}} 页准备", "儲存 {{count}} 頁準備"],
    "continueCount": ["继续处理 {{count}} 页", "繼續處理 {{count}} 頁"],
    "progress": ["已确认 {{count}} / {{total}} 页", "已確認 {{count}} / {{total}} 頁"],
    "save_saved": ["草稿已保存", "草稿已儲存"],
    "save_saving": ["正在保存…", "正在儲存…"],
    "save_error": ["保存失败，编辑内容已保留", "儲存失敗，編輯內容已保留"],
    "previous": ["上一页", "上一頁"],
    "next": ["下一页", "下一頁"],
    "deferNext": ["暂缓并继续", "暫緩並繼續"],
    "confirmNext": ["确认并继续", "確認並繼續"],
    "saveExit": ["保存并关闭", "儲存並關閉"],
    "exitTitle": ["结束遮挡编辑", "結束遮擋編輯"],
    "keepEditing": ["继续编辑", "繼續編輯"],
    "discardSession": ["撤销本次编辑并关闭", "復原本次編輯並關閉"],
    "exitHint": ["关闭时不会发送图片，等待中的任务将被取消。", "關閉時不會傳送圖片，等待中的工作將被取消。"],
    "outboundHint": ["原图保持不变，遮挡仅应用于发送用的副本。", "原圖保持不變，遮擋僅套用至傳送用的副本。"],
    "preparationHint": ["准备编辑仅保存草稿，不会发送图片。", "準備編輯僅儲存草稿，不會傳送圖片。"],
}

SHORT_COPY = {
    "about": ["가리기 안내", "About redaction", "マスキングについて", "遮挡说明", "遮擋說明"],
    "operationFailed": ["처리 실패. 편집 내용은 유지됩니다.", "Operation failed. Your edits are preserved.", "処理に失敗しました。編集内容は保持されています。", "操作失败，编辑内容已保留。", "操作失敗，編輯內容已保留。"],
    "openFailed": ["편집기를 열지 못했습니다. 저장된 초안은 유지됩니다.", "Cannot open the editor. Saved drafts are preserved.", "編集画面を開けません。保存済みの下書きは保持されています。", "无法打开编辑器，已保存的草稿不受影响。", "無法開啟編輯器，已儲存的草稿不受影響。"],
    "previewFailed": ["이미지를 표시하지 못했습니다. 다시 시도해 주세요.", "Cannot display the image. Please retry.", "画像を表示できません。再試行してください。", "无法显示图片，请重试。", "無法顯示圖片，請重試。"],
    "previousMask": ["이전 가림 가져오기", "Use previous masks", "前のマスクを使用", "沿用上一页", "沿用上一頁"],
    "shortcuts": ["단축키", "Shortcuts", "ショートカット", "快捷键", "快捷鍵"],
    "explicitReviewHint": ["선택한 페이지를 현재 가리기 상태로 확인합니다.", "Confirm the selected pages with their current masks.", "選択したページを現在のマスク状態で確認します。", "按当前遮挡状态确认所选页面。", "依目前的遮擋狀態確認所選頁面。"],
    "failedCount": ["{{count}}장 불러오기 실패. 다시 시도해 주세요.", "{{count}} pages failed to load. Please retry.", "{{count}}ページの読み込みに失敗。再試行してください。", "{{count}}页加载失败，请重试。", "{{count}}頁載入失敗，請重試。"],
    "unseenAcknowledgement": ["미리보기가 안 뜬 {{count}}장도 확인 처리", "Also confirm {{count}} pages without loaded previews", "未表示の{{count}}ページも確認済みにする", "也确认尚未加载预览的 {{count}} 页", "也確認尚未載入預覽的 {{count}} 頁"],
    "sizeMismatch": ["{{count}}장의 크기가 다릅니다.", "{{count}} pages have different dimensions.", "{{count}}ページのサイズが異なります。", "{{count}}页尺寸不同", "{{count}}頁尺寸不同"],
    "replaceExisting": ["기존 가림 교체", "Replace existing masks", "既存のマスクを置き換える", "替换现有遮挡", "取代現有遮擋"],
    "copyReviewHint": ["적용 후 위치를 확인하세요. 일괄 취소할 수 있습니다.", "Check placement after applying. Batch undo is available.", "適用後に位置を確認してください。一括で元に戻せます。", "应用后请检查位置。批量操作可一起撤销。", "套用後請檢查位置。批次操作可一併復原。"],
    "presetHint": ["선택한 가림을 저장합니다. 선택이 없으면 이 페이지 전체를 저장합니다. 최대 30개.", "Save selected masks, or all masks on this page when none are selected. Limit: 30 presets.", "選択したマスクを保存します。未選択ならこのページ全体を保存します。最大30件。", "保存所选遮挡；未选择时保存本页全部遮挡。最多30个预设。", "儲存所選遮擋；未選取時儲存本頁全部遮擋。最多30個預設。"],
    "savePreset": ["프리셋 저장", "Save preset", "プリセットを保存", "保存为预设", "儲存為預設"],
    "usePreset": ["프리셋 적용", "Use preset", "プリセットを適用", "使用预设", "使用預設"],
    "shortcutScope": ["입력 중에는 작동하지 않습니다. Enter 연타나 마지막 페이지 확인으로는 전송하지 않습니다.", "Shortcuts are inactive while typing. Repeated Enter or reviewing the last page never sends images.", "入力中は作動しません。Enterの連打や最後のページの確認では送信しません。", "输入文字时快捷键不生效。按住Enter或确认最后一页均不会自动发送。", "輸入文字時快捷鍵不生效。按住Enter或確認最後一頁均不會自動傳送。"],
    "previousKey": ["이전 페이지 키", "Previous page key", "前のページのキー", "上一页快捷键", "上一頁快捷鍵"],
    "nextKey": ["다음 페이지 키", "Next page key", "次のページのキー", "下一页快捷键", "下一頁快捷鍵"],
    "keepZoom": ["페이지 전환 시 확대율 유지", "Keep zoom between pages", "ページ切替時に倍率を維持", "切换页面时保持缩放", "切換頁面時保留縮放"],
    "saveAndClose": ["저장 후 닫기", "Save and close", "保存して閉じる", "保存并关闭", "儲存並關閉"],
    "save_error": ["저장 실패 · 편집 내용 유지", "Save failed · Edits preserved", "保存失敗 · 編集内容を保持", "保存失败，编辑内容已保留", "儲存失敗，編輯內容已保留"],
    "previous": ["이전", "Previous", "前へ", "上一页", "上一頁"],
    "next": ["다음", "Next", "次へ", "下一页", "下一頁"],
    "confirmNext": ["확인하고 다음", "Review and next", "確認して次へ", "确认并继续", "確認並繼續"],
    "saveExit": ["저장 후 닫기", "Save and close", "保存して閉じる", "保存并关闭", "儲存並關閉"],
    "discardSession": ["변경 취소 후 닫기", "Discard edits and close", "変更を戻して閉じる", "撤销本次编辑并关闭", "復原本次編輯並關閉"],
    "exitHint": ["전송 없이 종료합니다. 대기 중인 작업은 취소됩니다.", "Close without sending. The waiting job will be cancelled.", "送信せずに閉じます。待機中の処理はキャンセルされます。", "关闭时不会发送图片，等待中的任务将被取消。", "關閉時不會傳送圖片，等待中的工作將被取消。"],
    "outboundHint": ["원본은 유지됩니다. 가림은 전송용 복사본에만 적용됩니다.", "Originals stay unchanged. Masks apply only to outbound copies.", "原本は変更しません。マスクは送信用のコピーにのみ適用します。", "原图保持不变，遮挡仅应用于发送用的副本。", "原圖保持不變，遮擋僅套用至傳送用的副本。"],
    "preparationHint": ["사전 편집은 저장만 합니다. 전송은 시작하지 않습니다.", "Preparation saves your edits without sending images.", "事前編集は保存のみです。画像は送信しません。", "准备编辑仅保存草稿，不会发送图片。", "準備編輯僅儲存草稿，不會傳送圖片。"],
}

english = json.loads((ROOT / "en/components.json").read_text(encoding="utf-8"))["manualRedaction"]
assert set(CHINESE) == set(english) - {"about"}, "Locale keys changed: review the new translations before applying."
for index, locale in enumerate(LOCALES):
    path = ROOT / locale / "components.json"
    resource = json.loads(path.read_text(encoding="utf-8"))
    if locale.startswith("zh-"):
        resource["manualRedaction"] = {key: value[index - 3] for key, value in CHINESE.items()}
    for key, values in SHORT_COPY.items():
        resource["manualRedaction"][key] = values[index]
    path.write_text(json.dumps(resource, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

# The former three-language generator is replaced by this all-locale checkpoint.
# Stop on missing translations or differing interpolation variables; no fallback copies.
resources = [json.loads((ROOT / locale / "components.json").read_text(encoding="utf-8"))["manualRedaction"] for locale in LOCALES]
for resource in resources:
    assert set(resource) == set(resources[0])
    for key, value in resource.items():
        assert value.strip()
        placeholders = lambda text: sorted(re.findall(r"\{\{\s*([^{}]+?)\s*\}\}", text))
        assert placeholders(value) == placeholders(resources[0][key]), key
print("Reviewed manual-redaction keys and placeholders match in all five locales.")
