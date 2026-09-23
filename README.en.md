<p align="center"><img src="docs/images/00-carrot-logo.png" alt="Carrot Manga Translator" width="140"></p>

# Carrot Manga Translator

A desktop app for **OCR → translation → text removal → lettering and review → export**. Bring your own manuscript and translate with local Gemma, Codex, or an OpenAI-compatible API.

[한국어](README.md) · **English** · [日本語](README.ja.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md)

**[Download v2.8.0](https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/v2.8.0)** · [Release notes](docs/release-notes/v2.8.0.md) · [Bugs and requests](https://github.com/ucx0204/CarrotMangaTranslator/issues)

[Getting started](#start) · [Edit text](#edit) · [SFX ImageGen](#sfx) · [Shortcuts](#shortcuts) · [Troubleshooting](#troubleshooting)

Windows 10/11 · Apple Silicon macOS 14+ · [GPL-3.0-only](LICENSE)

![Manuscript, pages, and block editing](docs/images/readme-v2712/workspace.png)

Keep dialogue as **editable text blocks**, and use **Codex ImageGen** to turn large sound effects into lettering that fits the artwork. [Before/after and workflow](#sfx)

<a id="start"></a>

## Start by finishing one page

1. **[Install](#install)**, then choose the source/target languages and engine in **Settings → AI → Translation**.
2. Check **[OCR and image settings](#setup)** and run **Check/Update → OCR/model check**.
3. Use **[Add source](#import)** to import images or a folder.
4. Open the chapter and select one page in **[Translation settings](#translate)**. Start with **Translate only**.
5. **[Correct OCR and translation](#edit)**, then use **[Remove original text](#erase)** and **Fit to balloon**.
6. **[Export](#export)** the finished image. Once the settings work, process the remaining pages.

### Jump to a task

| What you want to do                               | Go to                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Install or change engines                         | [Installation](#install) · [AI, languages, hardware](#setup)                    |
| Import chapters, archives, PDFs, or links         | [Library and import](#import)                                                   |
| Choose pages, retranslate, recover failures       | [Translation](#translate)                                                       |
| Navigate, select, compare with the original       | [Workspace](#workspace)                                                         |
| Edit dialogue, size, wrapping, curves, or warp    | [Text and layout](#edit)                                                        |
| Reuse fonts and formatting                        | [Fonts, presets, block library](#styles)                                        |
| Clean leftovers, paint, restore the original      | [Removal and retouching](#erase)                                                |
| Translate or generate sound effects               | [Sound effects](#sfx)                                                           |
| Hide parts of images before sending               | [Image redaction](#redaction)                                                   |
| Keep names, voices, and story context consistent  | [Terms, memory, research](#context)                                             |
| Change names, sentences, or styles in bulk        | [Batch editing](#batch)                                                         |
| Read dialogue or review in another app            | [Text view and review sheets](#review)                                          |
| Export images/PSD, save automatically, share work | [Export](#export) · [Automatic saving](#autosave) · [Backup and sharing](#data) |
| Find a command or fix a problem                   | [Shortcuts](#shortcuts) · [Troubleshooting](#troubleshooting)                   |

<a id="install"></a>

## Installation

| Platform          | Download and setup                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11     | Run the release's **Setup EXE** and choose a data folder.                                                                 |
| Apple Silicon Mac | Download the **arm64 DMG or ZIP** and move the app to **Applications**. Requires macOS 14+. Intel Macs are not supported. |

If the OS displays a warning, check that release's signing information and checksums. On Mac, first-launch approval is available under **System Settings → Privacy & Security**. [Signing policy](CODE_SIGNING_POLICY.md)

Models and runtimes download separately, so allow additional disk space. Initial setup needs internet access. Local Gemma, OCR, and inpainting can run locally once their files are ready; Codex, remote APIs, and web research need a connection.

<a id="setup"></a>

## Languages and AI

Set the **interface language** in **Settings → General** and the **source/translation languages** separately in **Settings → AI → Translation**.

![Translation engine, languages, and Codex account](docs/images/readme-v2712/settings-translation.png)

| Engine          | Prepare                                 | Check after selecting                                                                                  |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Local Gemma** | Model storage and RAM/VRAM              | Preset and runtime. Try a small preset suited to your device first.                                    |
| **Codex**       | Sign in to ChatGPT inside the app       | Available models and reasoning effort. The bundled server requires no separate Codex CLI installation. |
| **API**         | Base URL, model ID, and key if required | OpenAI compatibility and image input support. Compatible local servers also work.                      |

**The AI subtabs configure different jobs.** Changing the translation engine does not also change every OCR, removal, Codex image, and research setting.

| AI subtab        | Controls                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Translation**  | Languages, Gemma/Codex/API, generation limits                                                                           |
| **OCR**          | HayaiOCR/PaddleOCR and supported devices. Compare on the same page if detection or reading is poor.                     |
| **Image**        | **AOT / LaMa / Flux** removal, supported backends, separate **Codex image model and reasoning effort**, image redaction |
| **Web research** | Accounts/keys, search-result analysis model, usage limits                                                               |
| **Hardware**     | App graphics GPU, local AI compute GPU, detected-device recommendations. Restart after saving a graphics GPU change.    |

<details>
<summary>Advanced settings and more screenshots</summary>

- **Gemma:** choose a Hugging Face model or local files. Preset memory labels are guidance; long pages, context size, and other applications also affect memory use. Match the runtime to your device. For OOM errors, try a smaller preset and context limit.
- **API:** set Temperature, top_p, top_k, reasoning_effort, extra JSON, and custom headers only if your server supports them. Adjust request intervals, retries, and keys to the service's limits. Do not share screens showing keys.
- **Generation limits:** maximum output tokens limit the response; the work-context budget limits reference information. Larger values do not automatically improve translation.
- **Readiness:** save settings, then run **Check/Update → OCR/model check**. Update checking opens the releases page.
- Screens: [General](docs/images/readme-v2712/settings-general.png) · [OCR](docs/images/readme-v2712/settings-ocr.png) · [Image](docs/images/readme-v2712/settings-image.png) · [Research](docs/images/readme-v2712/settings-research.png) · [Hardware](docs/images/readme-v2712/settings-hardware.png) · [Check/Update](docs/images/readme-v2712/settings-test.png)

</details>

<a id="import"></a>

## Importing and the library

The hierarchy is **Work → Chapter → Page → Block**. A work holds shared terms and characters; chapters hold pages; pages hold originals, translation blocks, and retouched images. A block is a piece of dialogue, narration, or a sound effect.

Use **Add source**, check the preview order and exclusions, then create a work or add a chapter to an existing work. Use **Add multiple chapters** for several episodes at once. You can also drag files or folders into the app.

![Source import choices](docs/images/readme-v2712/import.png)

| Source                             | How to import                                                       |
| ---------------------------------- | ------------------------------------------------------------------- |
| PNG, JPEG, WebP                    | Select images or an image folder                                    |
| ZIP, CBZ, RAR, CBR                 | Select an archive and review its images                             |
| PDF                                | Import pages as images                                              |
| Folder/archive containing chapters | Use multiple-chapter import and check chapter grouping/order        |
| Web page                           | Load its image list, filter by size, and select the images you need |
| `.mgtshare`                        | **Import work** restores an editing project. [Sharing](#data)       |

Search the library for works/chapters and use the page list to check order and processing status. Review any rejected corrupt or unsupported files. If a website's login or access restrictions prevent import, use files you have prepared yourself.

<a id="translate"></a>

## Translate, resume, and retranslate

Open a chapter and choose **Translation settings** or press `T`. Select chapters/pages within the work; **Untranslated only** narrows the selection to remaining work.

![Page selection and translation, lettering, and removal options](docs/images/readme-v2712/translate.png)

| Option                               | What it does                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Quick single pass**                | Translates each page once using brief recent context.                                                                    |
| **Cumulative context**               | Builds scene, terminology, and character memory for later pages. Choose detailed, balanced, or essential-term recording. |
| **Auto-create blocks**               | Detects text regions again.                                                                                              |
| **Keep existing blocks**             | Keeps regions and formatting while replacing text. Pages without blocks get new ones.                                    |
| **Natural line breaks**              | Inserts breaks into the translation to suit the block. Check before enabling if you want to keep manual breaks.          |
| **AI font sizing**                   | Estimates the original text size.                                                                                        |
| **Automatic font matching**          | Applies a suitable **Korean font** to each block. This is separate from sizing.                                          |
| **Translate only / Remove original** | Stops after translation or continues with text removal.                                                                  |
| **Fit to balloon**                   | Fits translated text inside balloons after removal.                                                                      |
| **Codex removal**                    | Uses Codex image processing where available. Check [Image settings](#setup) too.                                         |

Save a useful combination as the default for future translations. `Shift+T` resumes remaining pages. Check progress and errors in task status, then select unfinished pages instead of unnecessarily repeating completed work.

**Retranslation can replace manual edits and existing results, and is not part of workspace undo history.** Preserve edits with [Export work](#data) first. A page being processed is protected from editing; other unlocked pages remain editable. Commands affecting the entire chapter depend on that chapter's activity state.

<a id="workspace"></a>

## Finding your way around

The left side holds the **library and pages**, the center shows the **manuscript**, and the right side holds **page blocks and the selected block editor**. Collapse panels to make room. Select text on the page or an item in the block list to edit it.

| Action             | How                                                                                |
| ------------------ | ---------------------------------------------------------------------------------- |
| Change page        | Thumbnails, `PageUp` / `PageDown`                                                  |
| Pan                | Drag with the hand tool, `H` or `3`                                                |
| Zoom               | `Ctrl+wheel` or zoom controls; fit page/width/height and actual size are available |
| Compare original   | Toggle with `O`                                                                    |
| Show translation   | `V` toggles blocks; `Shift+B` toggles editing backgrounds/borders                  |
| Add a block        | Draw a region with `W` or `2`                                                      |
| Select/move/resize | Selection tool `S` or `1`; drag the block or handles                               |
| Multiple blocks    | Multi-select or `Ctrl+A` for the current page                                      |
| Reading order      | List up/down buttons, `Ctrl+Alt+↑/↓`, or coordinate sorting                        |

Selection highlights and editing borders are separate from the exported artwork. Check lettering both zoomed in and at full-page scale.

<a id="edit"></a>

## Editing dialogue and lettering

### Text: check OCR before rewriting

Select a block and compare source and translation in the **Text** tab. Correct misread names, numbers, or punctuation before translating the required region again. Role, speaker, review status, and notes also help later batch editing and review.

![Editing a selected block](docs/images/readme-v2712/editor-text.png)

Select part of a translation to apply bold, italic, font, size, color, opacity, background, outline, or glow to those characters. Without a selection, check whether formatting applies to newly typed text. **Code** view exposes the formatting representation. **Reset all formatting** removes inline formatting from the sentence.

### Layout: fit the balloon

| Adjustment                               | Purpose                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Position, size, rotation                 | Move and resize the block. Reset rotation with `Ctrl+Shift+T`.                                                                |
| Horizontal/vertical, alignment, wrapping | Match the page and balloon. Distinguish explicit line breaks from automatic wrapping.                                         |
| Balloon fit                              | Use the balloon's interior. Edit its shape with a polygon or grow/shrink brushes; removing the fit returns to the OCR region. |
| Curve, perspective, warp                 | Fit curved or angled dialogue/SFX using on-page handles and previews.                                                         |

### Format: appearance and spacing

The **Format** tab controls font, size, bold, italic, alignment, color, outlines, glow, line spacing, character spacing, width, and opacity. If a few characters look different, inspect their inline formatting too.

Use **Batch apply** to copy selected formatting groups to a selection, page, or chapter. Check the groups so that copying a color does not also replace sizes. [Layout](docs/images/readme-v2712/editor-layout.png) · [Format](docs/images/readme-v2712/editor-format.png)

<a id="styles"></a>

## Reusing fonts, styles, and blocks

| Feature            | Stores                             | Where to use it                                                                                       |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Default format** | Defaults for new blocks            | Settings → Default format. Apply separately to change existing blocks.                                |
| **Style presets**  | Chosen formatting groups           | Create from current style, name it, choose groups, pin to quick styles. Assign `Alt+1`–`Alt+0` slots. |
| **Block library**  | Reusable text and block formatting | Block menu → Save to library. Search names/source/translation and insert into the current page.       |
| **Font manager**   | Registered fonts and display order | Register TTF/OTF, favorite, hide, reorder, and choose a default font.                                 |

Rename/group presets or overwrite them from the current style. Saved library blocks can also be edited. On another computer, register missing fonts or choose replacements. Automatic font matching runs during translation; it does not create reusable style presets.

[Default format screen](docs/images/readme-v2712/settings-format.png)

Save Codex ImageGen sound effects to the **block library**, including their image, mask, and font weight, for reuse on other pages. Copy selected text/image blocks between pages, chapters, and works with `Ctrl+C` / `Ctrl+V`.

<a id="erase"></a>

## Removing text and retouching

Work through **automatic removal → leftover cleanup → original comparison**. Automatic removal uses source-text block regions to reconstruct the background. Mark text you want to keep as **Exclude from automatic removal** in the block menu.

![Retouch tools and manuscript](docs/images/readme-v2712/retouch.png)

| Tool                                  | Action                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| **Automatic removal**, `I`            | Select pages and run the configured inpainting model; optionally fit balloons afterward |
| **Mask**, `J`                         | Paint a removal region and apply it to reconstruct the background                       |
| **Brush**, `B`                        | Paint the chosen color; useful for small marks on flat backgrounds                      |
| **Rectangle**, `R`; **Ellipse**, `E`  | Cover a dragged shape with the chosen color                                             |
| **Eraser**, `X`; **Rectangle eraser** | Restore **original-image pixels** in the region; these do not erase a removal mask      |
| **Color picker**, `P`                 | Sample a paint color from the page                                                      |

With the brush, rectangle, or ellipse, **`Alt+left-click` samples color**. `Alt+right-drag` adjusts the radius in drawing tools. Hold `Shift` while dragging a brush stroke to constrain it to a straight line. `Space` applies the mask when the active tool state allows it.

Rectangle, ellipse, and rectangle-restore tools use a fixed black/white outlined crosshair visible on light and dark art. Undo a mistaken stroke; use an eraser when you need original pixels back. [Automatic removal screen](docs/images/readme-v2712/erase.png)

<a id="sfx"></a>

## Sound effects: review before processing

A font change alone can lose the brushwork and impact of a large sound effect. **Codex ImageGen** can localize the image lettering while dialogue stays editable as text blocks.

| Japanese original                                                                              | Korean dialogue + image lettering                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| <img src="docs/images/readme-v2712/comparison-before.png" alt="Japanese original" width="430"> | <img src="docs/images/readme-v2712/comparison-after.png" alt="Korean dialogue + image lettering" width="430"> |

The large `ドン` becomes a brush-lettered `쾅`. Dialogue blocks are positioned over the cleaned original text. This comparison uses artwork prepared with Codex’s built-in imagegen and the app’s production text renderer. [How the sample was made](docs/images/readme-v2712/README.md)

HayaiOCR sound-effect candidates can be reviewed separately from dialogue. Open **Translate sound effects**, include/exclude candidates by page, reject drawings mistaken for text, and add or adjust missed regions.

![Sound-effect candidates and translation mode](docs/images/readme-v2712/sfx.png)

1. Check the recognized source and region.
2. Choose editable **text** or **Codex image** output. Image output uses the separate Codex image settings.
3. For images, review the translations first and **confirm all pages before generation**. Finalize the words before they become part of an image.
4. Compare with the original. Edit text as regular blocks; use the provided image editing/restoration controls for generated lettering.

Single-region translation keeps the original. Choose removal in the full SFX translation options. **Reset** restores deleted/excluded candidates while keeping region corrections and translations.

When resuming image work, a page whose SFX overlaps a redaction **keeps its translated text and holds its image step**. Other pages continue. Adjust the redaction and resume to process unfinished images. [Redaction](#redaction)

<a id="redaction"></a>

## Redacting images before transmission

Enable it in **Settings → AI → Image → Outgoing image redaction**. In supported AI image workflows, it masks the **copy being sent**, rather than painting the original file.

Use page/chapter/work **Prepare redaction** commands to inspect and adjust regions. Review automatic detections yourself. Do not cover text you need translated or generated; adjust overlaps first. Redaction and source-text removal serve different purposes.

Enabling image redaction does not automatically remove OCR text or work context from translation requests. Check the selected engine and [privacy policy](docs/privacy-policy.md) to understand what is sent.

<a id="context"></a>

## Consistent names, voices, and story memory

Open **Terms/Memory** from the right-side tools to maintain shared information across a work's chapters.

![Glossary and work context](docs/images/readme-v2712/context-glossary.png)

| Tab                   | What to record                                                 | Example manuscript                                   |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| **Glossary**          | Source/target spelling, aliases, category, note, enabled state | `侍従長 → 시종장` (head attendant)                   |
| **Characters**        | Names, aliases, speaking style, character notes                | Seraphina gives cruel orders in calm, polite speech  |
| **Translation rules** | Honorifics, SFX handling, default tone                         | Preserve honorifics; translate SFX                   |
| **Story memory**      | Page summaries and visual context                              | Her execution orders over cold tea silence the court |

Enter information manually or review an **AI Terms/Memory** analysis. You can also refine information accumulated during translation. Consolidate duplicate names/aliases and save. [Characters](docs/images/readme-v2712/context-characters.png) · [Rules](docs/images/readme-v2712/context-rules.png) · [Story](docs/images/readme-v2712/context-memory.png)

<details>
<summary>Web research, proposal review, and context budget</summary>

**Web research** supplements context after you confirm the work title, engine, and scope. The research title is separate from the library title. Codex research and Tavily search followed by LLM analysis have different account/key requirements and limits; check **Settings → AI → Web research** first.

Compare proposed terms, characters, and rules with sources and existing entries, then apply only what you need. Search results may be wrong or refer to another work. For an original demo story without external references, enter the context yourself.

Watch the context budget as the guide grows and prioritize useful information. If saving reports a conflict, inspect the other changes and reopen the latest version before applying yours. **Reset all terms/memory** deletes the work's glossary, characters, and story memory for every chapter; it is not a routine cleanup tool.

</details>

<a id="batch"></a>

## Change text and formatting in bulk

Open **Batch text editing** with `Ctrl+H`: **scope → conditions → actions → before/after preview → apply**. Test on the current page before expanding to the chapter.

![Conditions, actions, and on-page before/after preview](docs/images/readme-v2712/batch.png)

Filter by source/translation, role, speaker, review status, and other fields. Distinguish **all conditions** from **any condition**. **All balloons** targets every block in the selected scope. Arrange replacements, formatting/field changes, and inline emphasis in execution order.

### Example: change only Seraphina's register

1. Match **speaker = Seraphina** and translation containing `처형했습니다`, requiring both.
2. Replace `처형했습니다` with the more formal `처형하였습니다`.
3. Bold only the newly inserted `처형하였습니다`.
4. Confirm that the attendant's dialogue stays unchanged, then apply.

Speaker conditions require correctly assigned speakers. IDs differ between works; do not copy the demo ID blindly.

<details>
<summary>Other uses and saved rules</summary>

- **Ellipses/spaces:** use the starter rule to replace `...` with `…` and collapse repeated spaces.
- **SFX styling:** target the sound-effect role to change weight, size, or outlines.
- **Review flags:** find empty translations or specific wording and update review status/notes.
- **Regular expressions:** use when literal matching is insufficient; check case sensitivity and replace-all settings.
- **Exclude results:** remove exceptions even when they match. Inspect on-page before/after previews and the included count.
- **Reuse:** save named rules as YAML. Sequences run multiple rules in order; each step's output feeds the next.
- **Conflicts:** blocks changed since preview are skipped instead of overwritten. Rebuild the preview from current data. The latest batch edit can be undone.

</details>

<a id="review"></a>

## Reading and reviewing dialogue

Press `G` for **Text view**. Read OCR and translation together or show only one, search the chapter, and click page headings to return to the manuscript. Select blocks to apply only the formatting fields you change.

![Collected OCR and translations](docs/images/readme-v2712/gather.png)

| Exchange format        | Matching method                               | Keep in mind                                                                       |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Copy / TXT export      | Currently displayed text                      | Choose whether to include page headings                                            |
| TXT import             | Line order from a **translation-only** export | Reordering can break correspondence; check warnings and counts                     |
| CSV / TSV review sheet | `block_id`                                    | Updates translation, review status, and notes; leaves OCR unchanged. Preserve IDs. |

For spreadsheet review, review sheets preserve correspondence more reliably. Keep the original export and inspect unknown-ID, duplicate, or missing-entry warnings before importing changes.

<a id="export"></a>

## Export images and PSD

Choose chapters/pages in **Export results** or `Ctrl+E`. If preflight lists untranslated, failed, or incomplete postprocessing pages, return to them before exporting.

![Export scope, format, and destination](docs/images/readme-v2712/export.png)

| Output                                | Options and purpose                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source format / PNG / JPEG / WebP** | Renders finished images. Choose JPEG/WebP quality and whether to preserve source filenames/subfolders.                                                                                             |
| **Without text**                      | Saves the cleaned background without translated lettering; requires a removal result.                                                                                                              |
| **Layered PSD**                       | Separates original, cleaned background, and block lettering. Supported text stays editable; complex vertical, curved, perspective, or inline-styled text may be rasterized to preserve appearance. |

Choose a new timestamped folder or direct output to a selected folder. For name collisions, check **replace / skip / cancel**. Image export differs from [project sharing](#data); PSD is not a complete backup of app editing state either. [PSD screen](docs/images/readme-v2712/export-psd.png)

<a id="autosave"></a>

## Automatically saving results

Manage work/chapter connections and output formats in **Settings → Automatic result saving**. Use it to keep an external results folder updated as you edit. Check the linked destination and status; retry failed or pending items through the status controls.

![Automatic result saving by work](docs/images/readme-v2712/settings-results.png)

In the result folder, `result` holds finished images, `originals` recoverable sources, `inpainted` cleaned images, and `mask` removed regions. This is separate from saving the app's editing data. Check destinations before disabling or changing connections, and do not treat these folders as disposable caches.

<a id="data"></a>

## Sharing, backup, and privacy

Use **Export work** to save selected works/chapters as `.mgtshare`. On another computer, **Import work** can create a work or add/replace chapters in an existing one. Check the final chapter list and order before applying.

| Included in work files                                                                        | Prepare separately                                                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Manuscript images, blocks, reading order, formatting, inpainting results, and other work data | App settings, ChatGPT login/API keys, AI/OCR models and runtimes, logs. Also check required fonts on the destination. |

To preserve the whole environment, close the app and **back up the data folder**. `library` contains originals and editing data, not disposable cache. Distinguish it from settings, fonts, logs, and model caches; retain sources and outputs. The macOS default is `~/Library/Application Support/manga-gemma-translator`.

Remote engines may receive required images, text, and context. Logs may contain paths or manuscript excerpts; review them before sharing. Error reports are not uploaded automatically. [Privacy policy](docs/privacy-policy.md) · [Security policy](SECURITY.md)

<a id="shortcuts"></a>

## Shortcuts and command search

Use **`Ctrl+K` to search commands** and **`?` for shortcut help**. Customize bindings, inspect conflicts, or restore defaults in **Settings → Shortcuts**. On macOS, `Cmd` also works for the `Ctrl` combinations below. Some tool shortcuts are suppressed while typing.

| Action                                        | Default keys                                                |
| --------------------------------------------- | ----------------------------------------------------------- |
| Settings / command palette / help             | `Ctrl+,` / `Ctrl+K` / `?`                                   |
| Translation settings / resume remaining       | `T` / `Shift+T`                                             |
| Text view / batch edit / export               | `G` / `Ctrl+H` / `Ctrl+E`                                   |
| Previous/next page                            | `PageUp` / `PageDown` (`A` / `D` and arrows also available) |
| Select / add block / pan                      | `S` or `1` / `W` or `2` / `H` or `3`                        |
| Original / translation / editing borders      | `O` / `V` / `Shift+B`                                       |
| Automatic removal / mask / brush              | `I` / `J` / `B`                                             |
| Rectangle / ellipse / restore eraser / picker | `R` / `E` / `X` / `P`                                       |
| Zoom / reset zoom                             | `Ctrl+wheel` / `Ctrl+0`                                     |
| Undo / redo                                   | `Ctrl+Z` / `Ctrl+Shift+Z`                                   |
| Select all blocks / duplicate / delete        | `Ctrl+A` / `Ctrl+D` / `Delete`                              |
| Previous/next block                           | `Ctrl+Shift+Tab` / `Ctrl+Tab`                               |
| Move reading order / coordinate sort          | `Ctrl+Alt+↑/↓` / `Ctrl+Shift+R`                             |
| Style slots 1–10                              | `Alt+1`–`Alt+0`                                             |

[Command palette](docs/images/readme-v2712/palette.png) · [Shortcut settings](docs/images/readme-v2712/settings-shortcuts.png)

<a id="troubleshooting"></a>

## When something goes wrong

| Symptom                       | First checks                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Translation will not start    | Page selection → languages/engine → login/key/model readiness → OCR/model check                          |
| First run is slow             | Download/verification progress; compare one representative page after preparation                        |
| OOM or GPU errors             | Try a smaller Gemma preset, recommended device settings, CPU OCR, and a lighter removal model separately |
| OCR merges/splits incorrectly | Source language; compare HayaiOCR/PaddleOCR. Keep existing blocks when retranslating corrected regions.  |
| Inconsistent names/voices     | Glossary, characters, cumulative context; speaker-filtered batch edits for existing translations         |
| Text overflows or is tiny     | Region, direction, wrapping, size, width; also check inline formatting and balloon fit                   |
| Removal damages artwork       | Undo/restore originals, exclude blocks or reduce masks, compare another model                            |
| SFX image work is held        | Fix redaction overlap and resume image work                                                              |
| Save or batch conflicts       | Reopen current data, compare changes, and reapply without overwriting other edits                        |
| Codex connection fails        | In-app login/model list; bundled-server errors in logs                                                   |
| API 401/403/404               | Key, URL, model, image support; remove unsupported advanced parameters                                   |
| Export font differs           | Missing/registered fonts and PSD rasterization cases                                                     |

If reproducible, review **Settings → Error report**, then [file an issue](https://github.com/ucx0204/CarrotMangaTranslator/issues) with app version, OS, engine, steps, and expected/actual results. Check keys, private paths, and manuscript content before sharing.

<a id="development"></a>

## Development, documentation, and license

Install Node.js, npm, and Git, then:

```sh
npm install
npm run dev
```

Run `npm run check` for checks, `npm run dist:win` for Windows packaging, and `npm run dist:mac` for Apple Silicon packaging. See `npm run qa:ui -- --help` for real UI captures.

- [Contributing](CONTRIBUTING.md) · [Architecture](docs/architecture.md) · [UI rules](docs/ui-design-rules.md)
- [Project adoption](docs/reputation.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Bundled fonts](third_party/fonts/README.md)
- Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).
- App source is [GPL-3.0-only](LICENSE). Check separate distribution terms for fonts, models, and runtimes.

This guide covers v2.8.0. Screenshots show real app components with demo data and Korean UI. The sample art and translations illustrate features, not model performance. [Capture and sample provenance](docs/images/readme-v2712/README.md)

[Back to start](#start)
