# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

## Scope

This policy applies only to Windows release artifacts that carry a valid
Authenticode signature issued to SignPath Foundation for this project. Unsigned
artifacts, including releases published before SignPath enrollment, are not
retroactively covered by this policy.

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
- The project signs only binaries built from source maintained by this project.
  Bundled upstream open-source components are not represented as project-owned
  binaries and are not separately signed with the project certificate.

## Privacy

See the project [Privacy policy](docs/privacy-policy.md).

## Reporting concerns

Report suspected policy violations through the project's
[GitHub issue tracker](https://github.com/ucx0204/CarrotMangaTranslator/issues).
Do not include private images, credentials, access tokens, or unredacted logs in
a public issue.
