# Windows protected-folder installation and startup

Working branch: `fix/windows-protected-folder-uac`.

## Goal and boundaries

Allow installation into protected Windows folders after normal UAC approval.
Do not reject a setup merely because it was launched as administrator. Keep the
application manifest `asInvoker`: ordinary writable data locations must not
require elevation. Resolve the actual data root before deciding whether startup
needs one explicit UAC relaunch. An elevated application cannot accept file drops
from a normal Explorer window; show this tradeoff in the installer rather than
silently forcing every user to run elevated.

Do not change application identity, force existing per-user installs into a new
machine-wide registration, loosen installation-directory ACLs, migrate user data
implicitly, remove uninstall safeguards, or publish a release as part of this work.

## Incremental checkpoints

Every changed file is committed independently on the working branch. Follow-up
fixes receive new commits; do not amend, squash, or merge master during this task.

- [x] Create the working branch from master.
- [x] Record the implementation and recovery checklist.
- [ ] Add a side-effect-limited startup write-access probe and its tests.
- [ ] Add a Windows UAC relaunch boundary with cancellation and loop protection.
- [ ] Integrate the gate before Electron storage creation and instance locks.
- [ ] Permit elevated installer data-root validation and retain safe-path checks.
- [ ] Make installer elevation and application execution policy explicit.
- [ ] Update installer regression tests and user-facing guidance.
- [ ] Run available automated checks and record their exact scope/results.
- [ ] Complete interactive Windows installation, UAC, update, and uninstall QA.

## Required behavior

| Situation | Expected behavior |
| --- | --- |
| Writable data folder | Normal application startup, no UAC |
| Protected binaries, writable separate data | Installer UAC only |
| Protected data folder | One UAC relaunch when current-token writes fail |
| Installer started elevated | No instruction to restart as a normal user |
| User declines UAC | Stop cleanly, do not retry or change data |
| Already elevated and writes fail | Report the underlying failure, do not loop |
| Disk full, invalid path, missing drive | Do not treat as an elevation request |
| Other administrator account supplied | Preserve resolved paths; do not overwrite undecryptable secrets |
| Existing install updated | Keep data-root pointer, data, install scope and identity |

## Validation and resumption

The execution environment currently has no direct DNS access to github.com for
`git clone`; repository reads and individual commits use the authorized GitHub
connector. Local Windows UAC/Explorer testing is not available here. Do not mark
interactive acceptance cases as passed based on source inspection or mocks.

Resume by reading this file, the branch commit history, `AGENTS.md`,
`build/installer.nsh`, `scripts/build-windows-installer.cjs`, and
`src/main/bootstrap.ts`. Check the actual tree before relying on a checkbox.
