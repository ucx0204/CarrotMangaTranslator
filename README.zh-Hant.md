<p align="center">
  <img src="docs/images/00-carrot-logo.png" alt="胡蘿蔔漫畫翻譯器標誌" width="180">
</p>

# 胡蘿蔔漫畫翻譯器

<p align="center">
  一款 Windows 桌面應用程式，從匯入漫畫、OCR、AI 翻譯、編輯、清除原文到匯出 PNG，一次完成
</p>

<p align="center">
  <a href="README.md">한국어</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <strong>繁體中文</strong>
</p>

胡蘿蔔漫畫翻譯器是一款漫畫製作工具：它可以從圖片中找出對白與狀聲詞，透過 AI 產生翻譯區塊，再由使用者調整文字和排版，最後匯出為完整的 PNG。預設翻譯方向為日文 → 韓文，也可以選擇其他原文與譯文語言。

- 最新 Windows 安裝檔：[GitHub Releases](https://github.com/ucx0204/CarrotMangaTranslator/releases)
- 目前版本說明：[v1.5.0 更新說明](docs/release-notes/v1.5.0.md)
- 程式碼架構與貢獻規範：[docs/architecture.md](docs/architecture.md)

## 功能一覽

- 可依作品和章節管理單張圖片、圖片資料夾以及 ZIP/CBZ 檔案。
- 可搭配使用 Paddle OCR、`Gemma 4` 本機模型、`OpenAI Codex` 和相容 OpenAI 的 `API` 進行翻譯。
- 應用程式介面支援韓文、日文、英文、簡體中文和繁體中文。
- 漫畫的原文與譯文語言支援 48 種預設，也可直接輸入 BCP 47 語言代碼。
- 可直接編輯翻譯區塊的文字、位置、方向、字型、顏色、外框和間距。
- 可讓 AI 翻譯參考術語表、角色語氣、翻譯規則和劇情記憶。
- 可使用 AOT、LaMa、Flux 清除原文，再用筆刷修正並匯出 PNG。
- 可透過 TXT 和 CSV/TSV 進行外部校對，也可用 `*.mgtshare` 分享能繼續編輯的作品資料。

## 安裝前須知

- 支援的作業系統：Windows 10/11 x64
- 所需可用空間：除了應用程式本身，依所選的 Gemma、OCR 和圖片修補模型，可能還需要數 GB 或更多空間。
- 網路連線：安裝、第一次下載模型以及使用 Codex/API 時需要連上網路。本機模型準備完成後即可離線使用。
- 即使沒有 GPU，也能使用部分 CPU 處理方式，但 OCR、本機翻譯和 Flux 圖片修補可能會非常慢。

安裝檔本身會盡量維持精簡。大型模型和執行環境會在第一次使用相關功能時下載到指定的資料夾，之後會直接重複使用快取。

## 快速開始

1. 前往 [Releases](https://github.com/ucx0204/CarrotMangaTranslator/releases)，下載並安裝類似 `CarrotMangaTranslator-Setup-v1.5.0.exe` 的最新安裝檔。
2. 在 `設定 → 一般` 中確認應用程式介面語言。第一次啟動時會自動選擇支援的 Windows 語言，其他語言環境則預設使用韓文。
3. 在 `設定 → 翻譯引擎` 中選擇原文語言、譯文語言和翻譯引擎。
   - 想在自己的電腦上處理時，選擇 `Gemma 4`
   - 想使用 Codex CLI 登入資訊時，選擇 `OpenAI Codex`
   - 想連接支援圖片輸入的外部伺服器時，選擇 `API`
4. 在 `設定 → 硬體 · OCR` 中選擇 OCR 品質和裝置，再前往 `安裝 / 檢查` 執行 `檢查 OCR/模型`。第一次使用時，應用程式會自動準備所需檔案。
5. 在主畫面的 `翻譯` 中選擇圖片、資料夾或 ZIP/CBZ，並設定作品名稱和章節名稱。
6. 按下章節卡片上的 `翻譯`，選擇頁面範圍。第一次使用時，建議選擇 `僅未翻譯 + 自動產生`；如果更重視上下文一致性，可以開啟 `二次翻譯`。
7. 檢查產生的區塊。如有需要，可透過圖片修補清除原文並進行修正，再將目前頁面或整個章節匯出為 PNG。

> 應用程式介面語言與漫畫翻譯語言彼此獨立。即使把介面切換成英文，日文 → 韓文的翻譯設定也會維持不變。

## 畫面預覽

| 工作畫面與原圖                                                                                          | 翻譯範圍與二次翻譯                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| <img src="docs/images/example-workspace.png" alt="已開啟作品和頁面的主要工作畫面" width="100%">         | <img src="docs/images/example-translation-options.png" alt="選擇頁面範圍和翻譯選項的畫面" width="100%"> |
| **翻譯進度與產生的區塊**                                                                                | **自動圖片修補步驟**                                                                                    |
| <img src="docs/images/example-translation-progress.png" alt="AI 翻譯進度和產生的翻譯區塊" width="100%"> | <img src="docs/images/example-inpainting.png" alt="清除原文時的自動圖片修補步驟" width="100%">          |

## 功能說明

### 匯入與作品庫

- 支援的圖片格式：PNG、JPG、JPEG、WEBP
- 支援的壓縮檔：ZIP、CBZ
- `開啟圖片` 可匯入一張圖片；`開啟資料夾` 和 `開啟壓縮檔` 會將多張圖片依自然順序排列，並作為一個章節匯入。
- `批次翻譯作品` 會將資料夾內的子資料夾和 ZIP/CBZ 顯示為多個候選章節，並一次加入選取的章節。
- 支援搜尋和排序作品與章節、重新命名和刪除、拖放調整章節與頁面順序，以及刪除單一頁面。
- WEBP 加入作品庫時會轉換為 PNG。單一輸入檔案不得超過 256 MB，解碼後的圖片不得超過 120 MP。

### 翻譯範圍與處理流程

- 可透過縮圖直接選擇作品中的章節和頁面，也可使用 `全選`、`僅未翻譯` 和 `全部取消`。
- `二次翻譯` 會在第一輪結果產生後重新分析術語、角色和上下文，並再次翻譯選取範圍。翻譯品質可能會提升，但花費的時間和 API 用量也會增加。
- 自動分析範圍可選擇 `僅空白章節`、`從頭開始` 或 `僅目前章節`。
- `自動產生` 會根據 OCR 和 AI 結果建立新區塊。
- `保留現有區塊` 會保留人工調整過的區域和格式，只重新填入各區域的 OCR 與譯文。沒有區塊的頁面會以自動產生方式處理。
- 支援重新翻譯頁面、取消工作，以及在頁面上拖曳選取局部後重新分析的 `區域翻譯`。
- 翻譯會同時使用 Paddle OCR 結果和頁面圖片。OCR 快取會依原文語言分開儲存；如果日文頁面中幾乎找不到日文依據，便會減少不必要的 AI 呼叫。

### 術語、角色與作品記憶

- 可使用 `AI 自動分析` 建立術語表、角色、翻譯規則和劇情記憶。
- 術語表可儲存原文、譯文、分類、別名和備註，並可逐項設定是否啟用。
- 角色資訊可儲存原文名稱、譯名、敬語/非敬語等語氣，以及自行撰寫的說話方式說明。
- 翻譯規則可記錄稱謂、狀聲詞、文體以及各作品的注意事項。
- 劇情記憶會記錄前面頁面發生的事件和上下文，供後續翻譯和二次翻譯參考。
- 畫面底部的 Token 預算會顯示記憶占用的上下文，以及為翻譯回應保留的空間。

### 區塊編輯與格式

- 使用選取工具可移動區塊和調整大小；使用區塊工具可拖曳建立新區域；使用手掌工具可移動放大後的畫布。
- 按住 `Ctrl` 並點擊可選取多個區塊。
- 可編輯譯文與 OCR 原文、橫排/直排、對齊、傾斜角度、透明度、自動縮放、字級、行距、字距、字寬、粗體、斜體、文字顏色、外框和外框寬度。
- 可在譯文中使用 `**粗體**`、`*斜體*`、`***粗體+斜體***` 標記，為部分文字個別套用格式。
- 可設定新區塊的預設格式，也可只選擇所需屬性，批次套用到多個區塊、目前頁面或目前章節。
- 編輯器可以顯示在右側面板、應用程式內可移動的浮動面板，或獨立的 Windows 視窗中。
- 目前章節的編輯操作最多支援 100 步復原與重做。
- 支援放大、縮小、原始大小、預覽原圖，以及切換區塊和背景的顯示狀態。
- 提供 `Ctrl+K` 命令選擇區和 `?` 快速鍵說明，並可在設定中修改各項快速鍵。

### 字型

除了現有的韓文字型，應用程式還分別內建 6 款適合英文、日文、簡體中文和繁體中文的免費字型。字型清單一律將 `預設` 放在最上方，並優先顯示目前應用程式語言對應的字型群組。其他群組維持韓文 → 英文 → 日文 → 簡體中文 → 繁體中文的順序，只將目前語言的群組移到前面。使用者自行加入的字型會顯示在最後。

| 字型群組 | 內建字型                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------- |
| 英文     | Comic Neue, Kalam, Bangers, Luckiest Guy, Permanent Marker, Freckle Face                       |
| 日文     | Yusei Magic, Mochiy Pop One, Hachi Maru Pop, Dela Gothic One, Reggae One, DotGothic16          |
| 簡體中文 | ZCOOL KuaiLe, ZCOOL QingKe HuangYou, ZCOOL XiaoWei, Ma Shan Zheng, Long Cang, Liu Jian Mao Cao |
| 繁體中文 | Huninn, Iansui, LXGW WenKai TC, LXGW Marker Gothic, ChenYuluoyan, Cubic 11                     |

也可以透過 `+ 加入 TTF/OTF 字型` 加入或刪除其他字型。使用者字型會複製到資料夾中的 `fonts/`，並同時用於畫面預覽和 PNG 匯出。內建字型的來源和授權條款請參閱 [third_party/fonts](third_party/fonts/README.md)。

### 彙整文字與外部校對

- 可彙整查看目前頁面或整個章節的 `譯文+OCR`、`僅譯文` 或 `僅 OCR`。
- 可依序前往搜尋結果、複製文字或儲存為 TXT。
- 重新匯入 `僅譯文` TXT 時，會保留區塊位置和 OCR 原文，只依照行次序更新對應的譯文。
- CSV/TSV 校對表可匯出 `block_id`、OCR 原文、譯文、校對狀態和備註。
- 匯入校對表時，只會套用相同 `block_id` 對應的譯文、狀態和備註，並針對遺漏、重複及 OCR 不一致顯示警告。
- 頁面內的文字會依照原文語言的閱讀方向排序。

### 圖片修補與 PNG 匯出

- `AOT 最小`：最輕量，以能夠執行為優先的處理方式
- `LaMa 省資源`：輕量、針對漫畫最佳化的原文清除方式
- `Flux 完整載入`：優先提升複雜背景品質的處理方式
- 支援針對個別翻譯區塊排除圖片修補、擴大邊界，以及自動處理目前頁面或剩餘頁面。
- 可用遮罩筆刷指定需要再次清除的區域，並用顏色筆刷、取色器和還原筆刷手動修正細小痕跡。
- 修正操作同樣支援復原與重做。
- 可將目前頁面或整個章節匯出為 PNG，並保留區塊的位置、方向、字型、顏色、外框和傾斜角度。

### 分享與匯入

`*.mgtshare` 不是完成的 PNG，而是可在應用程式中繼續編輯的作品套件。它可以包含所選作品和章節的原始圖片、翻譯區塊、座標、格式和圖片修補結果，但不會包含設定、登入資訊、模型或記錄檔。

匯入時，可以建立新作品，也可以在現有作品中加入或取代章節；套用前還能在合併畫面中拖曳調整章節順序。分享受著作權保護的原始圖片前，請務必確認自己擁有相應的散布權限。

## 語言與設定

### 應用程式語言與翻譯語言

| 類型           | 用途                           | 支援範圍                                             |
| -------------- | ------------------------------ | ---------------------------------------------------- |
| 應用程式語言   | 按鈕、選單、狀態和錯誤訊息     | 한국어、日本語、English、简体中文、繁體中文          |
| 原文與譯文語言 | OCR 和 AI 讀取及翻譯的語言組合 | 48 種預設，也可直接輸入 `eo`、`pt-BR` 等 BCP 47 代碼 |

設定視窗分為六個分頁。

- `一般`：應用程式介面語言
- `翻譯引擎`：語言組合、Gemma/Codex/API、模型、最大輸出 Token、上下文長度和 API 進階請求參數
- `硬體 · OCR`：OCR 品質與裝置、Gemma GPU 執行環境、圖片修補模型與後端
- `文字格式`：新區塊的預設方向、對齊、字型、大小、間距、顏色和外框
- `快速鍵`：檢視、翻譯、編輯、圖片修補和全域命令的按鍵組合
- `安裝 / 檢查`：檢查 OCR 與模型是否就緒、應用程式版本、更新頁面和記錄檔資料夾

### 翻譯引擎比較

| 引擎         | 優點                                                                       | 需要準備的項目                                                   |
| ------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Gemma 4      | 頁面和模型都在本機處理，準備完成後可離線使用                               | GGUF 模型、適合電腦的 CUDA/ROCm/Vulkan 執行環境、足夠的 RAM/VRAM |
| OpenAI Codex | 使用 Codex CLI 登入資訊，不必在應用程式中儲存 API 金鑰                     | 安裝並登入 Codex CLI、網路連線                                   |
| API          | 可連接相容 OpenAI 的視覺模型、本機伺服器、NVIDIA NIM、相容 Gemini 的端點等 | Base URL、支援圖片輸入的模型名稱，以及視需要提供 API 金鑰        |

可大致依照以下順序選擇 Gemma 預設。

- 約 8 GB VRAM：`12B 最小`
- 約 16 GB VRAM：`26B 省資源`
- 24 GB 或更多 VRAM：`31B 完整載入`
- 特殊設定：`自訂`

OCR 品質分為 `最小`、`省資源` 和 `完整載入`。使用 CPU 時，從 `省資源` 開始通常較穩定；建議搭配支援的 GPU 使用 `完整載入` PaddleOCR-VL。

<details>
<summary><strong>準備 OpenAI Codex 引擎</strong></summary>

Codex 引擎會透過 `openai-oauth` 本機端點使用 Windows 中儲存的 Codex CLI 登入資訊，並不是在應用程式中直接輸入 OpenAI API 金鑰。

在 PowerShell 中執行官方 Windows 安裝命令。

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

開啟新的 PowerShell 視窗並登入。

```powershell
codex login
```

執行 `codex` 並確認可以正常開啟，接著在應用程式中選擇 `OpenAI Codex`，再執行 `檢查 OCR/模型`。如果模型不在清單中，可在 `Custom` 輸入模型 ID。若發生連接埠衝突，請更改設定中的 `openai-oauth 連接埠`。

官方說明：[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)

</details>

<details>
<summary><strong>相容 OpenAI 的 API、NVIDIA NIM 與 Gemini</strong></summary>

API 引擎會在 Base URL 後加上 `/chat/completions`，並傳送圖片和 OCR 提示。所選模型必須支援圖片輸入。

- 一般 OpenAI 相容伺服器：`https://server.example/v1`
- NVIDIA NIM：`https://integrate.api.nvidia.com/v1`
- Gemini OpenAI 相容端點：`https://generativelanguage.googleapis.com/v1beta/openai`
- LM Studio 等本機伺服器如果不需要驗證，可以將 API 金鑰留白。

請在各服務供應商的畫面中確認模型 ID 和金鑰。也可以設定 `Temperature`、`top_p`、`top_k`、`reasoning_effort`、額外的 request body JSON 和 custom headers JSON。如果伺服器拒絕無法辨識的參數，請先清除進階參數再檢查。

也可以透過環境變數覆寫這些值。

- OpenAI 官方金鑰：`OPENAI_API_KEY`
- 相容伺服器：`MANGA_TRANSLATOR_API_BASE_URL`、`MANGA_TRANSLATOR_API_MODEL`、`MANGA_TRANSLATOR_API_KEY`

</details>

<details>
<summary><strong>NVIDIA 與 AMD 處理方式</strong></summary>

| 工作       | NVIDIA                       | AMD                          | 備用方式           |
| ---------- | ---------------------------- | ---------------------------- | ------------------ |
| Gemma      | CUDA 12、RTX 50 專用執行環境 | ROCm 或 Vulkan               | 使用較小的模型預設 |
| Paddle OCR | NVIDIA CUDA                  | 在支援的 GPU 上使用 AMD ROCm | CPU 最小/省資源    |
| Flux       | NVIDIA CUDA                  | ZLUDA + AMD HIP SDK          | CPU                |

AMD Gemma 會自動尋找適合 GPU 和驅動程式的 ROCm target。如果自動偵測不正確，進階使用者可參考以下範例手動指定。

```powershell
$env:MANGA_TRANSLATOR_AMD_ROCM_TARGET = "gfx110X"
```

AMD ZLUDA 圖片修補需要安裝 [Windows 版 AMD HIP SDK](https://www.amd.com/en/developer/resources/rocm-hub/hip-sdk.html)。OCR GPU 失敗時，應用程式會改用 CPU 繼續處理剩餘頁面，而 Gemma 仍可繼續使用 AMD GPU。

</details>

## 資料儲存位置

使用者作品和大型執行環境會分別儲存在安裝時指定的資料夾下。

```text
data/
  settings.json
  library/
  logs/
  fonts/
  hf-cache/
  llama.cpp/
  ocr-runtime/
  models/
  tmp/
  panel-window-bounds.json
```

- `library/` 儲存作品、章節、頁面和區塊資料。
- `fonts/` 儲存使用者自行加入的 TTF/OTF 字型。
- `hf-cache/`、`llama.cpp/`、`ocr-runtime/` 和 `models/` 儲存下載的模型與執行環境。
- 回報錯誤時會用到 `logs/` 中的 `app.log`。
- 解除安裝應用程式時，可另外選擇是否刪除作品資料以及模型/OCR 快取。

請備份重要作品的資料夾，或將作品匯出為 `*.mgtshare`。

## 常見問題

### 第一次啟動和翻譯速度太慢

第一次啟動包含下載和驗證模型、Python、OCR 及圖片修補執行環境所需的時間。準備完成後如果仍然很慢，請先嘗試較小的 Gemma 預設、CPU `省資源` OCR，以及 AOT/LaMa 圖片修補。避免多個 GPU 工作、遊戲和瀏覽器同時占用 VRAM 也會有所幫助。

### 無法連接 Codex

請確認 PowerShell 中可以執行 `codex` 且已完成登入。在應用程式中重新選擇 Codex 引擎並執行 `檢查 OCR/模型`；如果懷疑連接埠衝突，請更改 `openai-oauth 連接埠`。OCR 準備失敗有時看起來也像 Codex 連線問題，因此請查看結果記錄中實際失敗的步驟。

### API 傳回 401、403 或 404

請檢查 API 金鑰、Base URL 和模型 ID。Base URL 通常只需填寫到 `/v1`，而且必須使用支援圖片輸入的模型。清除服務供應商不支援的進階請求參數和 JSON 後，再重新測試。

### AMD OCR GPU 執行失敗

Windows ROCm 對支援的 GPU 與驅動程式組合較為敏感。即使只把 OCR 裝置改成 CPU，Gemma 翻譯仍可繼續在 AMD GPU 上執行。也請在記錄檔中檢查是否同時辨識到內建顯示晶片、VRAM 是否不足，以及是否發生 Windows TDR。

### AMD ZLUDA 圖片修補失敗

請確認已安裝 Windows 版 AMD HIP SDK，並正確設定 `HIP_PATH`，接著重新啟動應用程式。如果需要立即繼續工作，可將 Flux 後端改成 CPU，或使用 AOT/LaMa 處理方式。

### RTX 50 系列顯示卡上 OCR 失敗

請確認已安裝最新 NVIDIA 驅動程式，並檢查應用程式中的 RTX 50 專用 OCR 執行環境。如果 GPU OCR 仍然失敗，可以只把 OCR 改成 CPU `省資源`，繼續進行翻譯。

### PNG 中的字型與畫面顯示不同

內建字型會同時用於畫面和 PNG。如果刪除了使用者字型檔，或在另一台電腦上開啟作品，請重新加入該字型。匯出前也請檢查文字方向、自動縮放、粗細以及字型批次套用狀態。

## 回報問題時

請在 [GitHub Issues](https://github.com/ucx0204/CarrotMangaTranslator/issues) 中一併提供以下資訊。

- 應用程式版本和 Windows 版本
- GPU 型號和 VRAM
- 翻譯引擎、模型/預設，以及原文 → 譯文語言
- OCR 品質與裝置、圖片修補模型與後端
- 翻譯範圍，以及是否使用 `自動產生`/`保留現有區塊`
- 可重現問題的頁面，以及透過 `開啟記錄檔資料夾` 找到的 `app.log`

記錄檔中可能包含使用者名稱等本機路徑資訊，公開前請遮蔽敏感內容。

## 開發

開發環境需要 Windows、Node.js LTS、npm 和 Git。

```powershell
npm install
npm run dev
```

開發模式會使用 `.tmp/electron-dev` 作為獨立的 userData/session 資料夾。執行以下命令進行完整檢查。

```powershell
npm run check
```

建置應用程式並產生 Windows 安裝檔：

```powershell
npm run build
npm run dist:win
```

關於程序邊界、SSOT、錯誤處理和測試規範，請參閱 [程式碼邊界與品質規範](docs/architecture.md)。

## 示範圖片來源

README 中四個畫面截圖裡的漫畫是以 [IDPF EPUB 3 Samples Project](https://github.com/idpf/epub3-samples) 的 [`Haruko`](https://github.com/idpf/epub3-samples/tree/main/30/haruko-jpeg) 範例為基礎。原作採用 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) 授權，截圖中還加入了胡蘿蔔漫畫翻譯器的韓文翻譯區塊和工作狀態。這些示範圖片獨立於應用程式原始碼，適用 CC BY-SA 3.0 條款。

## 授權條款

應用程式原始碼以 [GPL-3.0-only](LICENSE) 授權條款發布。與應用程式一同使用或下載的字型、ffmpeg、JavaScript/Python 套件、OCR/AI 模型及其執行環境可能適用不同條款。重新散布前，請查看 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [內建字型聲明](third_party/fonts/README.md)。
