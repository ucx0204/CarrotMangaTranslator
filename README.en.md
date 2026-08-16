<p align="center">
  <img src="docs/images/00-carrot-logo.png" alt="Carrot Manga Translator logo" width="180">
</p>

# Carrot Manga Translator

<p align="center">
  Manga import, OCR, AI translation, editing, inpainting, and PNG/layered PSD export for Windows and Apple Silicon macOS
</p>

<p align="center">
  <a href="README.md">한국어</a> ·
  <strong>English</strong> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a>
</p>

Carrot Manga Translator is a manga production tool that finds dialogue and sound effects in images, creates translation blocks with AI, and lets you refine the wording and layout before exporting a finished PNG or layered PSD. The default translation direction is Japanese → Korean, but you can choose other source and target languages.

- Download the stable v1.16.0 release (Windows EXE · Apple Silicon DMG/ZIP): [GitHub Releases](https://github.com/ucx0204/CarrotMangaTranslator/releases)
- Current version information: [v1.16.0 release notes](docs/release-notes/v1.16.0.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Architecture and quality rules: [docs/architecture.md](docs/architecture.md)
- Project usage and public references: [docs/reputation.md](docs/reputation.md)

## At a Glance

- Organize a single image, an image folder, or a ZIP/CBZ file by title and chapter.
- Translate by combining Paddle OCR with a local `Gemma 4` model, `OpenAI Codex`, or an OpenAI-compatible `API`.
- Use the app interface in Korean, Japanese, English, Simplified Chinese, or Traditional Chinese.
- Choose from 48 presets for manga source and target languages, or enter a BCP 47 language code directly.
- Edit each translation block's text, position, direction, font, color, outline, and spacing.
- Apply glossaries, character speech styles, translation rules, and story memory to AI translations.
- Remove original text with AOT, LaMa, or Flux, make touch-ups with brush tools, and export the result as a finished PNG or layered PSD.
- Review text externally with TXT and CSV/TSV files, and share editable project data as `*.mgtshare` packages.

## Before You Install

- Supported operating systems: Windows 10/11 x64 and Apple Silicon (M1 or newer) on macOS 14+. Intel Macs are not supported.
- Required free space: In addition to the app itself, you may need several GB or more depending on the Gemma, OCR, and inpainting models you select.
- Internet connection: Required for installation, the first model download, and Codex/API use. Local models can work offline after setup is complete.
- Some CPU paths work without a GPU, but OCR, local translation, and Flux inpainting may be much slower.

The stable Apple Silicon build bundles arm64 FFmpeg, a Python runtime for Paddle OCR on the CPU, and Metal executables. Only Gemma, OCR, and inpainting model weights are checksum-verified and downloaded on first use. The v1.16.0 macOS build is ad-hoc signed unless the release workflow is provided with Developer ID and notarization credentials, so Gatekeeper may require manual approval under System Settings → Privacy & Security on first launch. macOS data is stored under `~/Library/Application Support/manga-gemma-translator`.

## Quick Start

1. From the [stable v1.16.0 release](https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/v1.16.0), download `CarrotMangaTranslator-Setup-v1.16.0.exe` for Windows or the arm64 DMG/ZIP for Apple Silicon. If macOS blocks the first launch, approve the app manually under System Settings → Privacy & Security.
2. Check the interface language under `Settings → General`. On first launch, the app automatically selects a supported Windows language. If the Windows language is not supported, the app uses Korean.
3. Under `Settings → Translation Engine`, choose the source language, target language, and engine.
   - To process everything on your PC, choose `Gemma 4`.
   - To use your Codex CLI login, choose `OpenAI Codex`.
   - To use an external server that accepts image input, choose `API`.
4. Under `Settings → Hardware · OCR`, choose the OCR quality and device. Then go to `Install / Check` and run `Check OCR/Models`. The app automatically prepares the required files the first time.
5. On the main screen, open `Translate`, select an image, folder, or ZIP/CBZ file, and enter a title and chapter name.
6. Select `Translate` on the chapter card, then choose the page range. `Untranslated only + Auto-create` is a good starting point. Enable `Second pass` if you want stronger contextual consistency.
7. Review the generated blocks. If needed, use inpainting to remove the original text and touch up the image, then export selected pages as finished PNG files or layered PSD documents.

> The app interface language and the manga translation languages are independent. Changing the interface to English does not change your Japanese → Korean translation settings.

## Screenshots

| Workspace and original image                                                                                                         | Translation range and second pass                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/images/example-workspace.png" alt="Main workspace with a title and page open" width="100%">                           | <img src="docs/images/example-translation-options.png" alt="Page range and translation option selection" width="100%"> |
| **Translation progress and generated blocks**                                                                                        | **Automatic inpainting step**                                                                                          |
| <img src="docs/images/example-translation-progress.png" alt="AI translation progress and generated translation blocks" width="100%"> | <img src="docs/images/example-inpainting.png" alt="Automatic inpainting step for removing original text" width="100%"> |

## Features

### Import and Library

- Supported image formats: PNG, JPG, JPEG, WEBP
- Supported archive formats: ZIP, CBZ
- `Open Image` imports one image. `Open Folder` and `Open Archive` naturally sort multiple images and import them as one chapter.
- `Batch Translate Title` displays subfolders and ZIP/CBZ files within a folder as possible chapters, then adds only the selected chapters at once.
- Search and sort titles and chapters, rename or delete them, reorder chapters and pages by dragging, and delete individual pages.
- WEBP files are normalized to PNG when they are added to the library. A single input file must not exceed 256 MB, and a decoded image must not exceed 120 MP.

### Translation Range and Pipeline

- Select chapters and pages directly from their thumbnails, or use `Select All`, `Untranslated Only`, and `Clear All`.
- `Second pass` analyzes terminology, characters, and context again after the first pass, then retranslates the selected range. It can improve quality, but takes more time and increases API usage.
- Choose an automatic analysis range from `Empty chapters only`, `Start over`, or `Current chapter only`.
- `Auto-create` creates new blocks from OCR and AI results.
- `Keep existing blocks` preserves manually adjusted regions and formatting, and only refills each region's OCR text and translation. Pages without blocks are processed with Auto-create.
- Retranslate a page, cancel a task, or drag over part of a page to run `Region Translation`.
- The app uses both Paddle OCR results and page images. OCR caches are separated by source language, and unnecessary AI calls are reduced when a Japanese page contains almost no evidence of Japanese text.

### Terminology, Characters, and Project Memory

- Use `AI Auto-analysis` to create a glossary, character profiles, translation rules, and story memory.
- Each glossary entry stores the source term, translation, category, aliases, and notes, and can be enabled or disabled individually.
- Each character entry stores the source and translated names, a speech style such as polite or casual language, and custom speech instructions.
- Translation rules can cover forms of address, sound effects, writing style, and title-specific cautions.
- Story memory keeps track of events and context from earlier pages for later translations and second-pass translation.
- The token budget at the bottom of the screen shows how much context is used by memory and how much room remains for translation responses.

### Block Editing and Formatting

- Use the Select tool to move and resize blocks, the Block tool to drag out a new region, and the Hand tool to move around a zoomed-in page.
- Use `Ctrl+click` to select multiple blocks.
- Edit the translation and OCR source text, horizontal or vertical writing, alignment, rotation, opacity, auto-fit, font size, line spacing, letter spacing, width scale, bold, italic, text color, outline, and outline thickness.
- Apply `**bold**`, `*italic*`, and `***bold+italic***` markup to selected parts of a translation.
- Set default formatting for new blocks, then batch-apply only the selected properties to multiple blocks, the current page, or the current chapter.
- Use the editor in the right panel, in a movable floating panel inside the app, or in a separate Windows window.
- Editing within the current chapter supports up to 100 undo and redo steps.
- Zoom in, zoom out, return to actual size, preview the original, and toggle block and background visibility.
- Use the `Ctrl+K` command palette and the `?` keyboard shortcut guide. Every shortcut can be changed in Settings.

### Fonts

In addition to the existing Korean fonts, the app includes six free fonts each for English, Japanese, Simplified Chinese, and Traditional Chinese. The font list always places `Default` at the top, followed by the font group for the current app language. The remaining groups retain the order Korean → English → Japanese → Simplified Chinese → Traditional Chinese, with only the current language group moved to the front. User-added fonts appear last.

| Group               | Included fonts                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| English             | Comic Neue, Kalam, Bangers, Luckiest Guy, Permanent Marker, Freckle Face                       |
| Japanese            | Yusei Magic, Mochiy Pop One, Hachi Maru Pop, Dela Gothic One, Reggae One, DotGothic16          |
| Simplified Chinese  | ZCOOL KuaiLe, ZCOOL QingKe HuangYou, ZCOOL XiaoWei, Ma Shan Zheng, Long Cang, Liu Jian Mao Cao |
| Traditional Chinese | Huninn, Iansui, LXGW WenKai TC, LXGW Marker Gothic, ChenYuluoyan, Cubic 11                     |

You can also add or remove other fonts with `+ Add TTF/OTF Font`. User fonts are copied to the `fonts/` directory in the data folder and used for on-screen previews and PNG/PSD exports. Font sources and licenses are documented in [third_party/fonts](third_party/fonts/README.md).

### Text Overview and External Review

- Collect `Translation + OCR`, `Translation only`, or `OCR only` text from the current page or the entire chapter in one view.
- Move through search results in order, copy the text, or save it as a TXT file.
- When you import a `Translation only` TXT file, block positions and OCR source text remain unchanged, and only translations are updated in line order.
- CSV/TSV review sheets export the `block_id`, OCR source text, translation, review status, and notes.
- Importing a review sheet applies only the translation, status, and notes for matching `block_id` values, and warns about missing or duplicate IDs and OCR mismatches.
- Text within a page is sorted according to the reading direction of the source language.

### Inpainting and Result Export

- `AOT Minimal`: The lightest path, prioritizing the ability to run
- `LaMa Efficient`: A lightweight original-text removal path optimized for manga
- `Flux Full`: A path that prioritizes quality on complex backgrounds
- Exclude individual translation blocks from inpainting, expand mask borders, and automatically process the current page or all remaining pages.
- Use the mask brush to mark areas for removal, and use the color brush, color picker, and restore brush to fix small artifacts manually.
- Touch-up work also supports undo and redo.
- Export selected pages as finished PNG files or layered PSD documents. A PSD separates the original background, cleaned background, and each text block; complex vertical, curved, or perspective text stays pixel-accurate as a raster layer.

### Sharing and Importing

An `*.mgtshare` file is not a finished PNG or PSD. It is an editable project package that can be reopened in the app. It can include the original images, translation blocks, coordinates, formatting, and inpainting results for selected titles and chapters, but does not include settings, login information, models, or logs.

When importing, you can create a new title or add or replace chapters in an existing title. Before applying the import, you can drag chapters into the desired order on the merge screen. Always confirm that you have distribution rights before sharing copyrighted original images.

## Languages and Settings

### App and Translation Languages

| Type                        | Purpose                                             | Supported options                                                     |
| --------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| App language                | Buttons, menus, status messages, and error messages | 한국어, 日本語, English, 简体中文, 繁體中文                           |
| Source and target languages | Language pair read and translated by OCR and AI     | 48 presets, or a directly entered BCP 47 code such as `eo` or `pt-BR` |

The Settings window is divided into six tabs.

- `General`: App interface language
- `Translation Engine`: Language pair, Gemma/Codex/API, model, maximum output tokens, context length, and advanced API request values
- `Hardware · OCR`: OCR quality and device, Gemma GPU runtime, and inpainting model and backend
- `Text Formatting`: Default direction, alignment, font, size, spacing, color, and outline for new blocks
- `Shortcuts`: Key combinations for viewing, translation, editing, inpainting, and global commands
- `Install / Check`: OCR and model readiness checks, app version, update page, and log folder

### Translation Engine Comparison

| Engine       | Advantages                                                                                                    | What you need                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Gemma 4      | Pages and the model are processed on your PC, with offline use available after setup                          | A GGUF model, a CUDA/ROCm/Vulkan runtime suitable for your PC, and enough RAM/VRAM |
| OpenAI Codex | Uses your Codex CLI login and does not store an API key in the app                                            | Codex CLI installation and login, plus an internet connection                      |
| API          | Connects to OpenAI-compatible vision models, local servers, NVIDIA NIM, Gemini-compatible endpoints, and more | A Base URL, the name of an image-capable model, and an API key if required         |

As a general guide, try the Gemma presets in this order:

- Around 8 GB VRAM: `12B Minimal`
- Around 16 GB VRAM: `26B Efficient`
- 24 GB VRAM or more: `31B Full`
- Specialized configurations: `Custom`

OCR quality options are `Minimal`, `Efficient`, and `Full`. `Full` uses the PP-OCRv6 Transformers semantic pipeline and requires a supported GPU; on CPU, start with `Efficient`.

<details>
<summary><strong>Setting Up the OpenAI Codex Engine</strong></summary>

The Codex engine uses Codex CLI login information saved in Windows through a local `openai-oauth` endpoint. You do not enter an OpenAI API key directly into the app.

Run the official Windows installation command in PowerShell:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Open a new PowerShell window and sign in:

```powershell
codex login
```

Confirm that `codex` opens normally. Then select `OpenAI Codex` in the app and run `Check OCR/Models`. For a model that is not listed, enter its model ID under `Custom`. If a port conflict occurs, change the `openai-oauth port` in Settings.

Official guide: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)

</details>

<details>
<summary><strong>OpenAI-Compatible APIs, NVIDIA NIM, and Gemini</strong></summary>

The API engine appends `/chat/completions` to the Base URL and sends the image with OCR hints. The selected model must support image input.

- General OpenAI-compatible server: `https://server.example/v1`
- NVIDIA NIM: `https://integrate.api.nvidia.com/v1`
- Gemini OpenAI-compatible endpoint: `https://generativelanguage.googleapis.com/v1beta/openai`
- For a local server such as LM Studio, you can leave the API key blank if authentication is not required.

Find the model ID and key in your provider's interface. You can also set `Temperature`, `top_p`, `top_k`, `reasoning_effort`, additional request body JSON, and custom headers JSON. If the server rejects unrecognized values, clear the advanced values first and try again.

You can also override values with environment variables:

- Official OpenAI key: `OPENAI_API_KEY`
- Compatible server: `MANGA_TRANSLATOR_API_BASE_URL`, `MANGA_TRANSLATOR_API_MODEL`, `MANGA_TRANSLATOR_API_KEY`

</details>

<details>
<summary><strong>NVIDIA and AMD Paths</strong></summary>

| Task       | NVIDIA                                       | AMD                        | User-selected alternative |
| ---------- | -------------------------------------------- | -------------------------- | ------------------------- |
| Gemma      | CUDA 12, dedicated runtime for RTX 50 series | ROCm or Vulkan             | A smaller model preset    |
| Paddle OCR | NVIDIA CUDA                                  | AMD ROCm on supported GPUs | CPU Minimal/Efficient     |
| Flux       | NVIDIA CUDA                                  | ZLUDA + AMD HIP SDK        | CPU                       |

For AMD Gemma, the app automatically finds a ROCm target that matches your GPU and driver. If automatic detection is incorrect, advanced users can specify one as follows:

```powershell
$env:MANGA_TRANSLATOR_AMD_ROCM_TARGET = "gfx110X"
```

AMD ZLUDA inpainting requires the [AMD HIP SDK for Windows](https://www.amd.com/en/developer/resources/rocm-hub/hip-sdk.html). If GPU OCR fails, the app stops the job and displays the error. To continue on the CPU, explicitly change the OCR device to CPU in Settings; Gemma can still use the AMD GPU.

</details>

## Data Storage

User work and large runtimes are stored separately under the data folder you select during installation.

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

- `library/` contains titles, chapters, pages, and block data.
- `fonts/` contains TTF/OTF fonts that you add.
- `hf-cache/`, `llama.cpp/`, `ocr-runtime/`, and `models/` contain downloaded models and runtimes.
- `logs/` contains `app.log` for the current run and `previous.log` for the preceding run. Raw logs may contain local paths or project-related content, so do not publish them as-is.
- When uninstalling the app, you can separately choose whether to delete project data and model/OCR caches.

Back up the data folder or export important projects as `*.mgtshare` packages.

## Frequently Asked Questions

### First Launch and Translation Are Very Slow

The first launch includes time to download and verify model, Python, OCR, and inpainting runtimes. If the app is still slow after setup, try a smaller Gemma preset, `Efficient` CPU OCR, and AOT or LaMa inpainting first. It also helps to prevent games, browsers, and other GPU tasks from sharing VRAM during processing.

### Codex Does Not Connect

Confirm in PowerShell that `codex` runs and that you are signed in. Select the Codex engine again in the app and run `Check OCR/Models`. If you suspect a port conflict, change the `openai-oauth port`. An OCR setup failure can look like a Codex connection problem, so check which step failed in the result log.

### The API Returns 401, 403, or 404

Check the API key, Base URL, and model ID. Usually, the Base URL should end at `/v1`, and the model must support image input. Clear advanced request values and JSON fields that your provider may not support, then try again.

### AMD GPU OCR Fails

ROCm on Windows is sensitive to the supported GPU and driver combination. You can switch only the OCR device to CPU while continuing to run Gemma translation on the AMD GPU. Also check the logs for simultaneous integrated-GPU detection, insufficient VRAM, and Windows TDR issues.

### AMD ZLUDA Inpainting Fails

Check the AMD HIP SDK for Windows and `HIP_PATH`, then restart the app. To continue working immediately, switch the Flux backend to CPU or use the AOT/LaMa path.

### OCR Fails on an RTX 50-Series GPU

Check that you have the latest NVIDIA driver and the app's OCR runtime for the RTX 50 series. If GPU OCR continues to fail, switch only OCR to CPU `Efficient` and continue translating.

### The Font in the Export Differs from the Preview

Bundled fonts are included in both the preview and PNG/PSD output. If you deleted a user font file or opened the project on another PC, add that font again. Before exporting, also check the writing direction, auto-fit, weight, and batch-applied font settings.

## Reporting an Issue

The `Error Report` dialog opens when a translation or analysis task fails, or when the app encounters an unexpected error. To report a problem later, select `Report a Problem` from the `Ctrl+K` command palette.

Use the dialog to share a report through [GitHub Issues](https://github.com/ucx0204/CarrotMangaTranslator/issues):

1. Describe what you were doing immediately before the error and review the generated Markdown preview.
2. Exclude system information or sanitized error logs if you do not want to share them.
3. Select `Create Issue on GitHub`. The app opens a prefilled issue in your system browser. If the report is too long for the URL, the diagnostic text is copied to the clipboard for you to paste into the issue body.
4. Review the public issue again, then submit it yourself on GitHub.

The app never uploads an error report or submits a GitHub issue automatically. The shared diagnostic text masks values that may be sensitive, including API keys, authorization headers, home-directory paths, and project text, but automatic detection cannot be guaranteed to catch everything. Always review the preview.

The raw `app.log` and `previous.log` files are more detailed than the shared diagnostic text and are not sanitized. If maintainers need a raw log for further investigation, use `Open Log Folder` and attach only a copy from which you have manually removed paths, tokens, and project content.

## Development

You need Windows, Node.js LTS, npm, and Git.

```powershell
npm install
npm run dev
```

Development mode uses `.tmp/electron-dev` as a separate userData/session folder. Run the complete check with:

```powershell
npm run check
```

Build the app and create the Windows installer with:

```powershell
npm run build
npm run dist:win
```

For process boundaries, the SSOT, error handling, and testing rules, see [Code Boundaries and Quality Rules](docs/architecture.md).

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

**Status (28 July 2026):** The SignPath Foundation application is currently under review. Current Windows release artifacts are unsigned and are not covered by this code-signing policy.

- [Full code signing policy](CODE_SIGNING_POLICY.md)
- [Security policy](SECURITY.md)
- [Privacy policy](docs/privacy-policy.md)

## Demo Image Sources

The manga shown in the README's four screenshots is based on the [`Haruko`](https://github.com/idpf/epub3-samples/tree/main/30/haruko-jpeg) sample from the [IDPF EPUB 3 Samples Project](https://github.com/idpf/epub3-samples). The original is licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Carrot Manga Translator's Korean translation blocks and work status were added to the screenshots. These demo images are covered by CC BY-SA 3.0 separately from the app's source code.

## License

The app's source code is distributed under [GPL-3.0-only](LICENSE). Fonts, ffmpeg, JavaScript/Python packages, OCR and AI models, and their runtimes used with or downloaded by the app may have separate terms. Before redistributing, review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [bundled font notices](third_party/fonts/README.md).
