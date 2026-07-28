# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

**Status (28 July 2026):** The SignPath Foundation application is currently
under review. Current Windows release artifacts are unsigned and are not
covered by this code-signing policy.

## Scope

For Windows, this policy applies only to release artifacts that carry a valid
Authenticode signature issued to SignPath Foundation for this project. Unsigned
Windows artifacts, including releases published before SignPath enrollment,
are not retroactively covered by this policy.

Apple Silicon artifacts, whether attached to a stable release or published on
the separate Alpha channel, use one of two clearly labelled signing modes:

- Developer ID mode: the app is Developer ID Application signed,
  Apple-notarized, and stapled on the GitHub-hosted `macos-15` arm64 runner.
- Ad-hoc mode: every Mach-O file and the app bundle are ad-hoc signed for
  integrity, but there is no Apple-verified publisher identity or notarization.
  Gatekeeper requires an explicit approval in System Settings → Privacy &
  Security.

The second mode must never be described as an Apple-signed or notarized build.

## Roles

- Authors (committers): [ucx0204](https://github.com/ucx0204)
- Reviewers: [ucx0204](https://github.com/ucx0204)
- Approvers: [ucx0204](https://github.com/ucx0204)

Changes proposed by anyone who is not an author or committer must be reviewed
by a listed reviewer before they are merged.

All members with repository or SignPath access must use multi-factor
authentication.

## Build and approval controls

- Source code and build scripts are maintained in the public
  [CarrotMangaTranslator repository](https://github.com/ucx0204/CarrotMangaTranslator).
- Release artifacts covered by this policy are built from a specific repository
  commit using GitHub Actions on GitHub-hosted runners.
- Every release signing request requires manual approval by an approver.
- SignPath origin verification ties the signing request to the repository,
  workflow run, commit, and build artifact.
- Artifact rules restrict the product identity and version of files that may be
  signed.
- Windows SignPath signing covers only binaries built from source maintained by
  this project. On macOS, Apple's hardened-runtime rules require every bundled
  Mach-O (including redistributed upstream runtimes) to be nested-signed as
  part of the app. That signature attests to the assembled release and does not
  represent upstream components as project-authored software.
- The Apple Silicon workflows verify the baked release channel, arm64 Mach-O
  architecture, nested code signatures, linked libraries, the DMG, ZIP,
  checksums, and an `/Applications` launch smoke before publishing artifacts.

## Apple Developer credentials

Developer ID signing does not require the maintainer to own a Mac; signing and
notarization run on GitHub's Apple Silicon runner. It does require an active
Apple Developer Program membership and the repository secrets
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8_B64`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. If all five are absent, the
workflow deliberately creates an ad-hoc build and the release notes must say
so. A partial secret configuration fails the build instead of silently
weakening it.

## Privacy

See the project [Privacy policy](docs/privacy-policy.md).

## Reporting concerns

Report suspected vulnerabilities, signing-key compromise, or release-pipeline
compromise privately through
[GitHub Security Advisories](https://github.com/ucx0204/CarrotMangaTranslator/security/advisories/new).
Use the project's
[GitHub issue tracker](https://github.com/ucx0204/CarrotMangaTranslator/issues)
for non-sensitive policy questions. Do not include private images,
credentials, access tokens, or unredacted logs in a public issue.
