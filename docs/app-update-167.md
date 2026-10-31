# In-app updates (#167)

## Contract

- Stable packaged Windows x64 and macOS arm64 only. Development and preview builds cannot install updates.
- Startup checks default to enabled. Checking never downloads; downloading never installs. Nothing installs when the app is normally closed.
- The existing status center owns the download/cancel/install interaction. Settings expose the current version, check command, and startup preference. Both read the same main-process state.
- Busy work permits downloads but prevents installation. Finishing work never initiates installation.
- Windows uses exactly `electron-updater` 6.8.11, full NSIS installers, and its dedicated updater cache. macOS uses `downloadToFile` in `userData/app-updates`, validates size and SHA-256, and opens the DMG. It does not replace the app bundle.
- v3.8.0 is the first version with this feature and must be installed manually. Publication goes through the repository release workflows.

## Ownership and saving

`application/appUpdateService.ts` serializes commands and owns phases. `application/appUpdateRelease.ts` selects newer stable application releases and validates platform assets/checksums. `appUpdateDownload.ts` owns verified files; the renderer cannot supply download URLs or executable paths.

`ipc/appUpdateInstallation.ts` adapts the existing job gate, environment access barrier, library mutation coordinator, and runtime cleanup to `application/appUpdateInstallation.ts`. Installation blocks new jobs, locks all registered editor windows, flushes detached editors before the main editor, drains existing operations, and checks the window/job state again before launch. Missing acknowledgements, save failures, cleanup failures, and timeouts release the locks and leave the app running. A late completion after a timeout cannot launch the installer.

The existing setup manifest requires administrator approval even for per-user installation. `appUpdateWindows.ts` waits for the bundled `elevate.exe` launch result before calling `app.quit()`. Cancellation permits a later explicit retry. It does not wait for installer completion, which would deadlock while the app is still running. The ordinary forced-quit timeout is not an installation approval path.

Library, originals, output, settings, model locations, ZIP extraction, and data-root preservation algorithms are unchanged. Their existing characterization tests remain applicable. The standard NSIS installer-cache copy and elevation helper are restored for updater compatibility.

## Publication

The Windows installer is built with its final public name: `CarrotMangaTranslator-Setup-vX.Y.Z.exe`. `verify-windows-update-metadata.cjs` binds `latest.yml` to the exact version, filename, byte size, and SHA-512. Because the existing ZIP/non-differential builder omits the size, the build wrapper fills that missing field only after verifying both hashes. Mismatching values fail instead of being repaired.

The Release workflow seals the metadata SHA-256 in provenance. It uploads and re-downloads/verifies the EXE, `SHA256SUMS-windows.txt`, and provenance before publishing `latest.yml` last. Existing assets are never replaced; identical assets can be verified and reused after an interrupted upload. macOS continues to use `CarrotMangaTranslator-X.Y.Z-macOS-arm64.dmg` and `SHA256SUMS-macOS-arm64.txt`.

An incomplete platform release produces a short unavailable message. Network, download, storage, integrity, and editor-save failures remain separate. There is no automatic retry loop.

## Architecture budget changes

The budget baseline changes enumerate the added updater consumers of the existing logger, IPC contracts, trusted IPC handlers, settings store, library coordinator, toast store, and renderer entry point. They also enumerate the new typed contract imports and registration imports. These are explicit composition-root/domain gateway edges; no feature-to-feature dependency or new global selector is introduced. The Windows package file budget increases by exactly one for `resources/elevate.exe` (330 → 331).

The coverage inventory adds sixteen updater sources using observed full-suite metrics from `.tmp/issue167/coverage-initial.json` (SHA-256 `d38a4c0be42ee8453601e1637418ff04c930a11936fdc97dbdb89be7912ea409`). Existing floors are not lowered. The previously omitted #168 response-text source retains its original Node 22 baseline. Additional tests exercise preload subscriptions, renderer lock/save acknowledgements, and successful/failed/aborted IPC draining. Native child-process coverage and visual QA are recorded separately from V8 unit-test coverage.

## Verification and remaining release gates

- Final local run (Windows, 2026-10-31): `npm run check` passed all 27 gates; 11,518 tests passed, 9 skipped, 0 failed. Type checks, lint, architecture checks, existing coverage floors, build, page-artwork parity, and image-protocol smoke passed. Log: `.tmp/issue167/check-verified.log`.
- `npm run dist:win` passed, including packaged runtime loading and the 331-file inventory. `node scripts/verify-windows-update-metadata.cjs dist` passed. Local development installer: `CarrotMangaTranslator-Setup-v3.7.8.exe`, 398,330,369 bytes, SHA-256 `ace52373216200ddb624037800b5ba3761a894afaa65b0135af5ab200dc80f8f`. `latest.yml` SHA-256: `7c3f5dd99ba30c38c84add87c81d58186b2cad9e13048d3821f7e0cbbb9e558a`. These are local build results, not published release assets. Log: `.tmp/issue167/package-final.log`.
- Unit coverage: stable release selection, incomplete release assets, version ordering, network failures, duplicate actions, explicit download/install, cancellation, busy work, integrity failures, editor acknowledgement ordering, forged acknowledgements, save failures/timeouts, and new-work races. Startup preference migration and stale settings-form preservation are covered.
- `tests/appUpdateNative.test.ts` runs the real Electron HTTP executor and updater against a local HTTP server in an isolated Korean-path cache. It checks full download, cancellation during metadata/file transfer, cache reuse by a new updater instance, and corrupt-cache replacement. UAC cancellation is simulated at the child-process boundary; it is not a real secure-desktop UAC acceptance test.
- Windows packaging validates the final EXE, metadata binding, restored elevation helper, and packaged runtime inventory. It does not install on the user's host.
- Actual production UI was captured at 1600×980 and 1240×760: status entry, download/progress/cancel, busy installation block, save failure, macOS final action, and settings preference toggle. The pre-change status components came from the base commit. Captures were inspected for overflow, clipping, overlap, and alignment. Temporary renderer QA entry files were removed.
- Local visual report: `C:/tmp/issue167-before-after.html`. Original PNGs use the `issue167-` prefix in `C:/tmp`.

**Not release-approved yet:** Windows Sandbox is installed on this machine but both launch attempts exited without creating a VM/window or acceptance output. No host installation was attempted. Actual old-version → new-version installation/relaunch, before/after user-data hashes, custom/Korean installation paths, and real UAC cancellation still require an isolated Windows environment. The prepared local recipe is `C:/tmp/issue167-sandbox/update.wsb`. macOS DMG download/verification/opening still requires an actual Apple Silicon Mac. UI simulation is not evidence of native platform acceptance.

Before release, complete those platform gates in addition to `npm run check`, `npm run dist:win`, metadata validation, and the normal release acceptance process. Keep the manual installer route available. If updater deployment fails, stop publication of new metadata and ship a new fixed version; do not overwrite published installers or metadata. Turning off startup checks remains available in settings.

## UI revision with Claude Code

Claude Code revised the production updater components after the initial review. The status center now uses a compact version/action row, an aligned progress/cancel row, and short inline failure or busy messages. Settings use a separate compact layout. Shared command functions and existing UI primitives remain in use. The idle placeholder is hidden only when update news is visible and no task exists; running work, failed results, and history remain visible. Startup-preference save failures persist inline until a successful save.

Production QA covers wide (1600×980) and narrow (1240×760) windows, download/cancel, installation blocked during an active job, save failure, settings changes, keyboard focus, the English macOS action, and Japanese text with the popup enlarged to 200%. Captures were inspected for clipping and overlap. The enlarged-popup check is not a whole-browser zoom test. Temporary QA renderer entries were removed.

Comparison report: `C:/tmp/issue167-claude-before-after.html`. Original screenshots: `C:/tmp/issue167-claude-final-*.png`; the active-work capture is `C:/tmp/issue167-claude-final-working-v2.png`. Claude's handoff is `.tmp/issue167-ui-claude/result.md`. The focused UI/lifecycle/status regression run passed 48 tests. Final `npm run check` passed all 27 gates with 11,535 tests passed and 9 skipped, including coverage, type checks, lint, build, parity, and smoke checks. Log: `.tmp/issue167-ui-claude/check-final.log`. No existing coverage floor was lowered for the revision.

This UI revision does not alter update installation or user-data handling. The installer hashes above belong to the initial implementation build; they do not identify a newly packaged UI revision. The isolated Windows and native macOS acceptance gates above remain outstanding.

## v3.8.0 release preparation

The last published stable tag is v3.7.7. The v3.7.8 source changes were committed but no v3.7.8 tag or release exists, so the v3.8.0 notes cover the final diff from v3.7.7, including #166 and #168.

The Windows Release workflow supports `verify_only` to build and retain a verified installer without publishing. It now downloads the checksum-verified v3.7.7 installer and runs `.github/scripts/verify-update-upgrade.ps1` on a disposable runner. This checks actual version replacement, automatic restart, a custom Korean data path, and unchanged hashes of original/output/model fixture files. It records the evidence separately from release assets. It does not claim interactive UAC cancellation coverage.

The macOS workflow runs `tests/fixtures/appUpdateMac.mjs` against the real built DMG. The production download/install service transfers it from a local HTTP server, validates its size/hash, opens it with Electron, and checks that the downloaded image was mounted. Published macOS assets are reused only after a matching re-download hash; they are never overwritten.

Local Windows Sandbox was diagnosed from Application event 1023: `WindowsSandboxRemoteSession.exe` cannot load its bundled `hostfxr.dll` (`0x80070005`, `0x80008082`). The host application installation and operating-system permissions were not modified to bypass this. Real interactive UAC cancellation still requires a working isolated Windows desktop.

### Native acceptance follow-up (2026-10-31)

Windows verification run [41136579244](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/41136579244) passed real v3.7.7 → v3.8.0 installation/restart and unchanged original/output/model fixture hashes under a custom Korean data path. Its `windows-update-verification-v3.8.0` artifact contains the evidence; this was verification-only, not a published release.

The user also declined a real UAC prompt from an isolated, harmless NSIS fixture whose only instruction is `Quit`. The production download/install service and bundled `elevate.exe` returned an install error with exit code 1 and did not request application quit. No actual installer or user data was modified. The local evidence is `.tmp/release-v3.8.0/uac-real-result.json`; fixture SHA-256: `315f50baf293fe457c54ed4dbef0f1c7b5649f37a12fd0515d6588518826f321`. The regression fixture now uses the observed helper exit code instead of Windows error 1223.

macOS run [41144499971](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/41144499971) built and verified the package, downloaded and verified the real DMG, and mounted it at `/Volumes/CarrotMangaTranslator 3.8.0-arm64`. Its final assertion nevertheless failed: `hdiutil` reported the Korean cache path in decomposed Unicode while Node retained composed characters, even after `realpath`. The fixture now compares device/inode identity and requires a mounted volume. A successful rerun and the normal publication workflows remain required; the failed run is not treated as a green release gate.

## References

- [electron-builder auto-update contract](https://www.electron.build/v26/docs/features/auto-update/)
- [Electron platform/signing requirements](https://www.electronjs.org/docs/latest/api/auto-updater)
- [Bundled elevate command-line behavior](https://code.kliu.org/misc/elevate/)
