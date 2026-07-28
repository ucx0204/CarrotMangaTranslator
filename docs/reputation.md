# Project usage and public references

Last verified: **28 July 2026, 05:20 UTC**

This page is maintained by the Carrot Manga Translator project. It is a
transparent index of public records and dated measurements, not an independent
review. Each linked source should be evaluated directly.

## Project identity and release history

| Item                        | Public record                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current repository          | [ucx0204/CarrotMangaTranslator](https://github.com/ucx0204/CarrotMangaTranslator)                                                                            |
| Former repository URL       | [ucx0204/Gemma4MangaTranslatorForKorean](https://github.com/ucx0204/Gemma4MangaTranslatorForKorean) resolves to the current repository                       |
| License                     | [GPL-3.0-only](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/LICENSE)                                                                         |
| Git history                 | Begins with the [first repository commit on 16 April 2026](https://github.com/ucx0204/CarrotMangaTranslator/commit/6718c84f0f80be44f6ff1900e01ad47eff9573f6) |
| Public GitHub repository    | Created on 20 April 2026                                                                                                                                     |
| Initial public release      | [v0.1.0 on 20 April 2026](https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/v0.1.0)                                                              |
| First 1.x release           | [v1.0.0 on 12 July 2026](https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/v1.0.0)                                                               |
| Current stable release      | [v1.8.1 on 28 July 2026](https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/v1.8.1)                                                               |
| Supported release platforms | Windows 10/11 x64 and Apple Silicon macOS 14+                                                                                                                |

The April community material describes the early prototype. The current
release is a packaged desktop application with Windows and Apple Silicon
release workflows, five interface languages, automated checks, public issue
tracking, a privacy policy, and an explicit code-signing policy.

## Dated public snapshot

| Public signal                                     |                    Snapshot | Definition                                                                                                                              |
| ------------------------------------------------- | --------------------------: | --------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub stars                                      |                          37 | Repository stargazer count                                                                                                              |
| GitHub forks                                      |                           9 | Repository fork count                                                                                                                   |
| Public issue threads from non-maintainer accounts | 18 threads from 11 accounts | Excludes pull requests, bots, and the `ucx0204` maintainer account                                                                      |
| Pull requests from non-maintainer accounts        |      13 PRs from 3 accounts | 2 were merged; closed, unmerged PRs are not counted as accepted contributions                                                           |
| Merged pull requests from non-maintainer accounts |       2 PRs from 2 accounts | [PR #4](https://github.com/ucx0204/CarrotMangaTranslator/pull/4) and [PR #42](https://github.com/ucx0204/CarrotMangaTranslator/pull/42) |
| Application-package asset downloads               |                       2,069 | Sum of the public counters for Windows installer EXE files and Carrot Manga Translator macOS DMG/ZIP files                              |
| All release-asset downloads                       |                       2,409 | Includes application packages, supporting runtime archives, blockmaps, update metadata, checklists, and checksum files                  |

GitHub release download counters measure asset download requests, not unique
people, installations, or active users. Re-downloads are included.

## Public usage, testing, and confirmed fixes

The records below were authored by GitHub accounts other than the maintainer.
They are public user reports and contribution records, not editorial reviews.

| Public record                                                                                                               | What it demonstrates                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Issue #10 and user follow-up](https://github.com/ucx0204/CarrotMangaTranslator/issues/10#issuecomment-4970160963)          | A user confirmed the 31B model worked and later reported processing 173 chapters averaging about 10 images each, while providing detailed feedback and test data. |
| [Issue #16 and resolution confirmation](https://github.com/ucx0204/CarrotMangaTranslator/issues/16#issuecomment-4994272415) | A separate user reported an inpainting-preview defect and confirmed that the released fix resolved it.                                                            |
| [Issue #18](https://github.com/ucx0204/CarrotMangaTranslator/issues/18)                                                     | A macOS requester tested successive Apple Silicon builds, supplied crash information, and confirmed a working build.                                              |
| [Issue #44 and v1.7.0 confirmation](https://github.com/ucx0204/CarrotMangaTranslator/issues/44#issuecomment-5082909155)     | An AMD RX 9070 user supplied a detailed real-workload report, tested fixes, and confirmed that v1.7.0 corrected the OCR ordering problem.                         |

## External contributions

- [PR #4](https://github.com/ucx0204/CarrotMangaTranslator/pull/4)
  added AMD ROCm/DFlash runtime support and was reviewed and merged.
- [PR #42](https://github.com/ucx0204/CarrotMangaTranslator/pull/42)
  corrected final macOS DMG/ZIP artifact verification and was reviewed,
  validated by CI, and merged.

## Third-party and community references

- In the independent Korean forum post
  [“Vibe coding retrospective”](https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1294647),
  a separate developer comparing manga-translation tools identified Carrot
  Manga Translator as one of the alternatives they found substantially more
  complete in structure and functionality than their own project.

The following community threads were written by the project maintainer. They
are provided for chronology and discussion context and are **not** counted as
independent references:

- [Initial community announcement](https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1122899)
- [Feature and release discussion](https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1214792)
- [Later convenience-update discussion](https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1279507)

## Maintenance and release verification

- [`npm run check`](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/package.json)
  combines TypeScript and JavaScript checking, formatting, linting, explicit
  error-handling checks, dependency and architecture checks, complexity
  budgets, dead-code checks, test coverage, a production build, renderer
  artwork parity, image-protocol smoke testing, and bundle-boundary checks.
- The public
  [Check workflow](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/.github/workflows/check.yml)
  runs repository checks in GitHub Actions. The
  [v1.8.0 release commit passed that workflow](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/30329096999).
  Its Windows job passed 1,625 tests and skipped 2; its Apple Silicon macOS
  job passed 1,478 tests and skipped 149. Both jobs covered the same 252 test
  files and 1,627-test suite.
- Windows and Apple Silicon artifacts are created by public
  [Windows](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/.github/workflows/release.yml)
  and
  [macOS](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/.github/workflows/mac-release.yml)
  release workflows from a specific repository commit. The v1.8.0
  [Windows release run](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/30329581041)
  and
  [macOS release run](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/30329772991)
  both completed successfully.
- Process boundaries, error handling, test expectations, and enforced
  architecture rules are documented in
  [docs/architecture.md](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/docs/architecture.md).

These controls verify the repository's own build and test contracts. This page
does not claim bit-for-bit reproducible builds across arbitrary environments.

## Content source and intended use

Carrot Manga Translator is a desktop production tool. Its supported import flow
starts with files selected by the user from local storage: PNG/JPEG/WebP
images, image folders, ZIP/CBZ archives, or editable `.mgtshare` project
packages. It does not provide a manga-site downloader, web crawler, DRM
decryption, or access-control bypass feature.

Users are responsible for ensuring that they have the rights or permission
required to process, translate, export, or share imported material. The
repository screenshots use the IDPF
[`Haruko`](https://github.com/idpf/epub3-samples/tree/main/30/haruko-jpeg)
sample under CC BY-SA 3.0.

## Privacy and network behavior

The project does not operate an application backend, user-account service,
advertising service, or maintainer-controlled analytics service. Network
access occurs only after the user initiates a feature that requires it, such as
using a chosen external AI provider, downloading selected models or runtimes,
opening an update or documentation page, or submitting a GitHub issue.

Local AI, OCR, and inpainting process page content on the device after required
components are installed. An external AI request may send page images or
crops, OCR text, prompts, context, model parameters, and authentication data to
the provider selected by the user. The app does not automatically upload usage
telemetry, project files, logs, or crash reports to the maintainer. See the
[privacy policy](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/docs/privacy-policy.md)
for the complete disclosure.

## Current signing status

As of 28 July 2026, the project's SignPath Foundation application is under
review. No current Windows release carries a SignPath Foundation Authenticode
signature. The v1.8.1 Windows installer is unsigned and is not covered by the
SignPath Foundation policy.

The v1.8.1 Apple Silicon artifacts are ad-hoc signed for integrity, without an
Apple-verified publisher identity or notarization. The
[code-signing policy](https://github.com/ucx0204/CarrotMangaTranslator/blob/master/CODE_SIGNING_POLICY.md)
applies only to artifacts that carry the applicable valid signature.

## Measurement method and limitations

- Repository metadata was read from the public
  [GitHub repository API](https://api.github.com/repos/ucx0204/CarrotMangaTranslator).
- Release counts were calculated from the public
  [GitHub Releases API](https://api.github.com/repos/ucx0204/CarrotMangaTranslator/releases?per_page=100).
- Issue counts exclude pull requests, bots, and the maintainer account.
- Pull-request counts exclude the maintainer account. Only merged pull requests
  are described as accepted contributions.
- Application-package downloads include installer EXE files and app DMG/ZIP
  files. They exclude blockmaps, update metadata, checksum files, test
  checklists, and separately distributed runtime archives.
- Stars, forks, issue counts, and download counters change over time. The date
  and time at the top identify the snapshot represented by this document.
