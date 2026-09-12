# Windows protected-folder installation and startup

Working branch: `fix/windows-protected-folder-uac`.
Base: `2885975a0cee77bc1c0541d7436857eb06acae44`.
Verified implementation: `f93a0069557deb5610a3a5c45a47d6f0baef69e8`.
Verification completed on 2026-09-12. This document-only checkpoint follows the
verified code without changing its behavior. No master merge or release was made.

## Delivered behavior

Windows setup requests administrator approval at startup. Program Files and
other protected installation/data directories are supported. Direct administrator
launch is accepted; actual invalid paths, disk errors and failed writes still stop
installation. Assisted per-user/all-users selection and application identity stay
unchanged.

The application remains `asInvoker`. A writable data root does not request UAC,
even when the executable is installed in Program Files. Permission-denied startup
writes may trigger one explicit `runas` relaunch before Electron storage, instance
locks or the main module are initialized. Cancellation, a failed launch, an
already-elevated write failure and non-permission errors do not loop.

The exact data root, executable, working directory and arguments survive relaunch.
The child checks its actual token and the original SID before accessing data.
Another administrator account is rejected to protect account-bound API keys and
settings. No installation-directory ACL is loosened and no user data is silently
relocated. The installer and user guide explain the Explorer drag/drop limitation
of an elevated application and the separate writable-data alternative.

Setup preflight runs before the old version is removed, including silent updates.
It validates nonexistent paths lexically with `GetFullPathNameW`, checks dedicated
root safety and probes both destinations. Pointer writes use a same-directory
staging file, checked writes/flush and atomic replacement. Failure does not
truncate the existing data-root pointer or report installation success.

New `data-root.txt` files are UTF-8. Setup and removal accept UTF-8 with or without
a BOM and decode legacy ANSI only when strict UTF-8 decoding fails. Embedded NULs,
oversized pointers and unreadable pointers are rejected instead of becoming a
different path. Actual Unicode/space-containing installation and repair were tested.

The uninstaller retains an `asInvoker` build-time executable and requests its own
runtime elevation. It preserves options/scope, verifies a relaunch SID/token and
stops before deletion on cancellation or account mismatch. Normal removal keeps
data; explicit data-cleanup choices remain separate.

## Implementation map

- `src/main/startupWriteAccess.ts`: app-owned create/replace/delete probes,
  permission classification and non-recursive scratch cleanup.
- `src/main/windowsElevation.ts`: actual token/SID inspection and system
  PowerShell/.NET `runas`, with encoded data and Windows argument quoting.
- `src/main/windowsStartup.ts` and `bootstrap.ts`: relaunch policy, account/data
  handoff and ordering before storage, locks and main initialization.
- `build/installer.nsh`, `windows-data-root-text.nsh` and
  `windows-uninstall-elevation.nsh`: protected installation, UTF-8 pointers,
  preflight, safe replacement and removal elevation.
- `scripts/build-windows-installer.cjs`: guarded preflight insertion before
  `uninstallOldVersion` in the real electron-builder templates.
- `electron-builder.config.cjs`: explicit `asInvoker`, `allowElevation: true`
  and `packElevateHelper: false`. The unused electron-updater `elevate.exe` is not
  shipped; this app uses manual release updates and its own elevation boundaries.
  The package file-count limit remains 331 rather than being relaxed.
- `scripts/smoke-windows-uac-installer.cjs`: isolated production-NSIS fixture.
- `scripts/smoke-windows-installer.cjs`: real installed Electron startup,
  ordinary/Program Files installation, upgrade and data-preserving removal.
- `docs/updating.md`: user-facing installation, update and UAC guidance.

## Final Windows verification

All three checks below completed with `success` on the same implementation SHA
`f93a0069557deb5610a3a5c45a47d6f0baef69e8`. Results were checked against completed
job logs, not inferred from an earlier commit or a running workflow.

### Focused UAC check

Run `34671590758`, job `103493828684`: passed.

All 71 focused tests across six files passed, together with Electron typecheck,
changed-file lint, formatting and actual NSIS compilation/installation. Native
PowerShell identity inspection and an actual `runas` child argument roundtrip ran
on Windows; those two tests were not replaced by mocks.

The isolated installer exercised both `/currentuser` and `/allusers` in a
Program Files path containing Korean, Japanese and spaces. It checked UTF-8/BOM
repair, invalid destination and corrupt-pointer preservation, wrong-SID removal
rejection, data-preserving removal and setup/uninstaller manifest levels.

### Full repository check

Run `34671590767`, job `103493840779`: passed.

The complete `npm run check` passed all 26 gates, including all configured type
checks, repository formatting/lint, error handling, mock boundaries, architecture,
maintainability, duplicates, reexports, generated files, CSS structure, script
entrypoints, dead-code checks, native-runner preparation, the full test/coverage
suite, production-cleanup coverage, build, page-artwork parity, image-protocol
smoke and renderer/preload bundle boundaries. No gate was disabled to obtain this
result. Diagnostics artifact: `10290753840`.

### Real packaged application

Run `34671590767`, job `103493840859`: passed.

`npm run dist:win` built the real thin Windows application and passed its package
verification without publishing. The installed executable then started successfully
from both an ordinary temporary location and Program Files, with a Korean/spaced
installation path. Startup read the installer's real data-root pointer rather than
an environment override and produced the packaged main-module smoke marker.

Both locations passed fresh install, actual installed startup, locked-file upgrade,
startup after upgrade and uninstall preserving a sentinel in the data root.
This was the real Electron payload, separate from the smaller NSIS-only fixture.

The test-package artifact `10291575339` contains the installer, `UAC-SHA256SUMS.txt`
and `uac-acceptance.json` identifying this commit/run. The workflow reports its
archive SHA-256 as
`7ae421ceb1c6ebe8d026067a2c6af4abf23a6a8a772f59deece790cd82ac8d25`.
This is a CI test artifact with seven-day retention, not a published release.

## Coverage provenance

The three new source files were measured on Windows using V8 coverage in run
`34671435748`, source `036d6531c957feb984f02a36df2c808adc9e56d7`.
Their implementation did not change between that measurement and final acceptance.
Combined coverage was 96.55% lines, 96.61% statements, 100% functions and 93% branches.
Per-file measured floors were added to `introducedFloors` without changing existing
floors, the historical provenance or deleted-file records. The inventory test was
updated from 618 to 621 introduced files. Final full-suite coverage enforcement
also passed on the verified implementation.

Measurement artifact `10291130483` contains the report and registration evidence.
The downloaded report was checked against SHA-256
`786247a5ed6029235801d52ef49aedc9bd76896e3b555383fe76bbbc75256abb`
and the committed floor entries. The temporary branch-only registration workflow
made separate file commits and was removed after completing its work; persistent
verification workflows require only read permission for repository contents.

## Explicit verification limits

Automated Windows acceptance is complete. The hosted runner was already elevated;
this does not constitute a person approving/cancelling a secure-desktop UAC dialog,
Explorer drag/drop interaction, or a real different-account credential handoff.
Cancellation/loop/account policy has behavioral tests; the native test validates
actual `runas` and quoting under an already-elevated token. It does not prove the
interactive UI or every individual pre-existing child-file ACL configuration.

Per-user setup registration belongs to the account executing setup. Supplying a
different administrator's credentials can therefore select that administrator's
profile; the application SID guard is not an installer account-migration feature.
For ordinary startup and Explorer drops, use a data folder writable by the intended
user. A release decision should include the relevant desktop/account checks.

## Branch and recovery discipline

Each changed file was committed independently. Follow-up fixes were new commits;
no amend, squash, force-push, master merge, version bump or release was performed.
Keep that history until the user elects to squash. For later changes, start from
the actual remote branch, preserve existing data, and rerun the relevant checks.
The verified implementation SHA above remains the authority for these results;
this final documentation commit does not claim a separate code-validation run.
