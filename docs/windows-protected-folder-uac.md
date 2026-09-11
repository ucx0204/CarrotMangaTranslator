# Windows protected-folder installation and startup

Working branch: `fix/windows-protected-folder-uac`.
Base: `2885975a0cee77bc1c0541d7436857eb06acae44`.
This is an implementation checkpoint, not a release or merge approval.

## Goal and boundaries

The Windows setup requests administrator approval when it starts. A protected
installation or data folder is not rejected merely because ordinary-user writes
are unavailable. Actual disk/path/write failures still stop installation.

The installed application remains `asInvoker`. Writable data roots launch without
UAC; permission-denied startup writes may cause one explicit administrator
relaunch. An elevated app cannot accept file drops from a normal Explorer window;
the installer explains this and allows a separate writable data location.

Application identity, the user's installation-scope choice, data-root selection,
existing-data preservation and uninstall safeguards must remain intact. Do not
loosen installation-directory ACLs, force every app launch to be elevated, publish
a release, merge master or squash the working history in this task.

## Incremental checkpoints

Every changed file receives its own commit. Follow-up fixes use new commits rather
than amending earlier checkpoints. Inspect the current branch before resuming;
source, tests and validation wiring may have separate adjacent commits.

- [x] Create the branch and record recovery instructions.
- [x] Add startup write-access probing and regression tests.
- [x] Add explicit UAC launch, cancellation and retry-loop prevention.
- [x] Run the gate before Electron storage configuration and instance locks.
- [x] Pin the original data root across relaunch and later AppPaths resolution.
- [x] Reject another administrator SID before accessing the original data root.
- [x] Accept elevated installer writes and direct administrator setup launches.
- [x] Request installer elevation at startup without forcing perMachine installs.
- [x] Add destination preflight before removing an existing version.
- [x] Add safe data-root pointer replacement and explicit write-failure handling.
- [x] Add the uninstaller elevation boundary and cancellation/account checks.
- [x] Add the Explorer drag/drop warning and focused Windows CI.
- [x] Pass the initial 62 focused Windows tests and Electron typecheck.
- [x] Fix the reported startup complexity and source/test formatting differences.
- [x] Fix the isolated installer smoke's unsafe setup.exe filename.
- [ ] Confirm a complete green Windows CI run after the latest changes.
- [ ] Complete the full repository check and real packaged-app startup smoke.
- [ ] Complete interactive UAC, Explorer, cross-account and uninstall acceptance.

## Implementation map

`startupWriteAccess.ts` probes app-owned storage using unique scratch files,
including create, replace and delete operations. Existing settings, models and
images are not rewritten. Cleanup never recursively deletes a directory. Required
empty app directories may be created during preflight. Permission failures remain
distinct from disk/path failures, and primary plus cleanup errors are preserved.

`windowsElevation.ts` uses the absolute system PowerShell executable with a fixed,
encoded script and .NET ProcessStartInfo `UseShellExecute`/`runas`. Arguments are
encoded as data and Windows-quoted. There is no cmd.exe, temporary script, PATH
lookup or execution-policy bypass. Native cancellation is distinct from success.
Identity reads have a timeout; interactive approval is not arbitrarily timed out.

`windowsStartup.ts` validates relaunch context before accessing the data root.
Writable roots never trigger token inspection or UAC. On permission denial, a
non-elevated process may relaunch once. The child verifies its real token and the
original SID; another account is rejected before root resolution or probing.
Already-elevated failures and non-permission errors do not loop. `bootstrap.ts`
pins the approved root before loading the main module and taking instance locks.

`build/installer.nsh` requests admin in the installer-only custom header. The
uninstaller-generation executable is deliberately not given that manifest, so
packaging does not require developer elevation. Existing assisted scope selection
is preserved rather than setting perMachine to true. Starting setup elevated
also avoids a fragile mid-wizard scope-changing relaunch.

`MgtPrepareDataRoot`, wired before uninstallOldVersion in the build wrapper,
validates destinations and writes before removing a working version, including
silent installations. Data-root pointer writes use a temporary file and
MoveFileExW replacement rather than truncating the existing pointer first.
Failures set an error and abort instead of reporting installation success.

`build/windows-uninstall-elevation.nsh` provides the separate removal gate. A
non-elevated removal requests runas, preserves scope and original arguments, checks
the returning account and real token, and stops on cancellation or launch failure.
Updates already launched by elevated setup do not require another prompt.

## Validation evidence

### Local, scoped checks

Node 22.16.0 on Linux passed four independent filesystem checks and twenty
startup/elevation checks. These covered existing-data preservation, scratch
cleanup, EACCES/ENOTEMPTY classification, cancellation, exact exe/cwd/argument
transfer, data-root pinning, SID mismatch before data access, failed elevation,
non-permission errors, malformed markers/results, Windows quoting, NUL/size
rejection, identity validation and missing system-directory handling.

The checks used byte-verified copies of production files and standalone Node
assertions, not the repository's Vitest runner. Native process responses were
simulated; they did not execute PowerShell or display UAC. Strict scoped checking
also passed with the available TypeScript 5.8.3, Node types 25.1.0 and ES2022/CommonJS.
That compiler check was not a full repository check. After extracting relaunch
context in commit a03c3f78, the twenty checks and scoped typecheck passed again.

### Windows CI

Run 34633089282 on commit c795314d:

- Passed all 62 focused Vitest tests across four test files.
- Passed npm run typecheck:electron.
- Reported one complexity error in prepareWindowsStartup and formatting diffs.
- Did NOT complete the installer smoke: makensis rejected the fixture name
  setup.exe with warning 9000 treated as an error. The job was subsequently
  cancelled. Do not infer a native smoke pass from the API step summary alone;
  the raw log contains the failed build.

Subsequent file commits extracted relaunch-context validation, applied the exact
formatter changes, shortened oversized-input test titles, renamed the fixture to
carrot-uac-fixture.exe, and made smoke failure terminate explicitly with code 1.

Run 34633869592 for commit eaf5c7df was in progress at the last status check. Verify
its actual logs and the latest branch run before recording an overall pass. This
documentation-only commit skips CI to avoid interrupting code validation.

## Acceptance still required

Interactive UAC consent/cancellation and Explorer drag/drop require a real desktop.
Test normal and restricted data roots, setup's finish-page launch privilege,
existing restricted child files, cross-token single-instance locking, update and
optional data cleanup under both installation scopes, Unicode/space-containing
paths, and credentials for a different administrator account. In particular,
verify per-user registration and profile paths when setup uses another account;
application relaunch SID protection alone is not proof of installer correctness.

Do not mark a full application install, packaged startup or manual UAC case as
passed because a mock or minimal NSIS fixture passed. Do not merge until the latest
Windows checks and relevant acceptance cases are reviewed.

## Resumption

Read this file, the latest branch history, AGENTS.md and Windows CI logs first.
The local environment has no direct GitHub DNS access for git clone; repository
reads and single-file commits use the authorized GitHub connector. Preserve newer
branch changes, verify the actual tree before relying on a checkbox, and keep each
subsequent changed file in its own commit.
