# Windows protected-folder installation and startup

Working branch: `fix/windows-protected-folder-uac`.
Base: `2885975a0cee77bc1c0541d7436857eb06acae44`.
This is an implementation checkpoint, not a release or merge approval.

## Goal and boundaries

Allow installation into protected Windows folders after normal UAC approval.
Do not reject a setup merely because it was launched as administrator. Keep the
application manifest `asInvoker`: ordinary writable data locations must not
require elevation. Resolve the actual data root before deciding whether startup
needs one explicit UAC relaunch. An elevated application cannot accept file drops
from a normal Explorer window; explain this in the installer rather than
silently forcing every user to run elevated.

Do not change application identity, force existing per-user installs into a new
machine-wide registration, loosen installation-directory ACLs, migrate user data
implicitly, remove uninstall safeguards, or publish a release as part of this work.

## Incremental checkpoints

Every changed file is committed independently on the working branch. Follow-up
fixes receive new commits; do not amend, squash, or merge master during this task.

- [x] Create the working branch from master and record a recovery checklist.
- [x] Add startup write-access probing and regression tests.
- [x] Add the Windows UAC process boundary, cancellation and loop prevention.
- [x] Integrate the gate before Electron storage configuration and instance locks.
- [x] Pin the original data root across relaunch and main-process path resolution.
- [x] Reject a different administrator SID before accessing the original data root.
- [x] Allow elevated installer data-root validation and preserve safe-path checks.
- [x] Keep assisted install-scope selection and asInvoker defaults under tests.
- [x] Update installer regression tests and show the Explorer drag/drop warning.
- [x] Run scoped local checks and record their actual limits below.
- [ ] Complete focused Windows CI and resolve its type, lint and formatting results.
- [ ] Complete the full repository check and real packaged-app startup smoke.
- [ ] Complete interactive Windows installation, UAC, update and uninstall QA.

## Implemented behavior

`startupWriteAccess.ts` probes app-owned storage with unique scratch files,
including create, replacement and deletion. Existing settings, models and user
images are not rewritten. Scratch cleanup never recursively deletes a directory.
Required empty app directories may be created during preflight. Permission
failures remain distinct from disk, path and I/O failures; primary and cleanup
errors are preserved together.

`windowsElevation.ts` calls an absolute system PowerShell path with a fixed,
encoded script. The script uses .NET ProcessStartInfo with UseShellExecute and
`runas`; no cmd.exe, temporary script, PATH lookup or execution-policy bypass is
introduced. Argument data is separately encoded and Windows-quoted. Native
cancellation is not treated as a successful launch. Identity reads have a bounded
timeout; an interactive approval is not cut off by an arbitrary timeout.

`windowsStartup.ts` handles the state transition before Electron storage and
locks. A writable root never triggers token inspection or UAC. After permission
denial, a non-elevated process may relaunch once. The child validates its real
token and original SID before probing the handed-off data root. Different-account
approval stops rather than risking another user's encrypted settings. Already
administered failures and non-permission failures report their cause without a
retry loop. `bootstrap.ts` pins the approved root for later AppPaths resolution.

The installer first probes as the original user when the retained UAC outer
process is available, then accepts successful writes by the elevated installer.
It no longer rejects direct administrator launches as unverifiable. Actual write
failures, the path-length limit, data-root checks and uninstall protections remain.

## Remaining implementation decisions

The branch currently uses electron-builder's existing **all-users UAC flow** or a
setup launched directly as administrator. It does **not yet automatically elevate
mid-wizard** when a non-elevated **current-user** installation selects a protected
path. That case still offers actionable failure guidance. Do not describe the
current checkpoint as a complete automatic protected-path installer experience.

Implementing that transition must retain selected install/data paths, explicitly
communicate any scope change, handle UAC cancellation before removing an old
version, and preserve existing per-user registrations. Do not simply force
`perMachine: true` or invoke an all-users inner installer for an existing per-user
installation. Explicit config values can be added after this policy is settled;
the existing allowElevation/asInvoker defaults are currently unchanged.

`MgtWriteDataRootPointer` still needs explicit write-failure handling and safe
pointer replacement. Silent installs, setup-started-as-admin under another account,
finish-page launch privilege, existing restricted child files, cross-token instance
locks and mixed per-user/per-machine update/uninstall paths need Windows acceptance
coverage. These are not marked complete by the mock tests.

## Validation evidence and limits

Local checks used byte-identical copies of four repository files, confirmed by
Git blob hashes before execution:

| File | Blob SHA |
| --- | --- |
| electronStoragePaths.ts | 08f1b10cf7f669bb37c97318d9b8763520226798 |
| startupWriteAccess.ts | 62e43fe20ef0e4926c421533a4a3f099819072a5 |
| windowsElevation.ts | 2f1816320e155f50272549634aa19cd3fde57165 |
| windowsStartup.ts | 2d4489ac84f0736d8ba9c97cc5720f377faed5a0 |

Passed locally on Linux with Node 22.16.0:

- Four standalone filesystem checks: repeated writable startup, existing data
  preservation, invalid relative roots, occupied directory paths, scratch cleanup
  and permission-denied deletion with an ENOTEMPTY cleanup consequence.
- Twenty standalone startup/elevation checks, including cancellation, exact
  executable/working directory/argument transfer, handoff root pinning, different
  SID rejection before original-root access, already-elevated failure, non-permission
  errors, malformed markers/results, Windows argument quoting, NUL/size rejection,
  identity validation and missing system-directory behavior.
- Strict scoped TypeScript checking of the three new production modules and their
  storage-path dependency using the locally available TypeScript 5.8.3 and Node
  types 25.1.0, ES2022/CommonJS, noEmit and skipLibCheck.

The twenty process checks simulated native process responses. They did not display
UAC, execute PowerShell, or validate Explorer drag/drop. The local checks used
standalone Node assertions, not the repository's Vitest runner. The scoped compiler
is not the repository-pinned compiler or a full Electron/renderer typecheck.

The branch contains `Windows UAC Check` and an isolated installer smoke script.
At this checkpoint, run `34633089282` for code commit
`c795314d6ca7c11b5e8df39f4404f39d893b6902` was still installing dependencies;
no Windows CI pass is claimed. Check its actual result before resuming. This
documentation-only commit skips CI to avoid interrupting that code validation.

## Resumption

The local execution environment has no direct GitHub DNS access for git clone;
repository reads and individual commits use the authorized GitHub connector.
Interactive Windows UAC/Explorer testing is not available locally. Never mark an
interactive acceptance case passed based on source inspection or simulated results.

Read this file, the latest branch history, `AGENTS.md`, the Windows CI job logs,
`build/installer.nsh`, `scripts/build-windows-installer.cjs` and
`src/main/bootstrap.ts`. Preserve newer branch changes and inspect actual files
before trusting a checkbox. Keep subsequent changes as separate file commits.
