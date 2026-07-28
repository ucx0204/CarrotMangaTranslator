# Contributing

Thank you for helping improve Carrot Manga Translator. Focused bug reports,
tests, documentation updates, and pull requests are welcome.

## Before you start

- Search the existing [issues](https://github.com/ucx0204/CarrotMangaTranslator/issues)
  and
  [pull requests](https://github.com/ucx0204/CarrotMangaTranslator/pulls)
  before opening a duplicate.
- For a large feature or architecture change, open an issue first so the scope
  and platform impact can be discussed.
- Report security vulnerabilities privately as described in
  [SECURITY.md](SECURITY.md), not in a public issue.

## Protect private and copyrighted material

- Do not include API keys, access tokens, authorization headers, private
  images, unredacted logs, or personal file-system paths in an issue or pull
  request.
- Use images you created, images you have permission to share, or the
  repository's CC BY-SA 3.0 `Haruko` sample when a visual fixture is needed.
- Do not commit local application data, downloaded models or runtimes, build
  artifacts, caches, or raw diagnostic logs.

## Development setup

The primary development flow requires Node.js LTS, npm, Git, and Windows.
Platform-specific macOS changes also need validation through the public macOS
workflow or an appropriate Apple Silicon environment.

```powershell
npm install
npm run dev
```

Read [docs/architecture.md](docs/architecture.md) before changing process
boundaries, shared contracts, IPC, runtime adapters, error handling, or test
structure.

## Making a change

1. Keep the change focused and avoid unrelated formatting or generated-file
   churn.
2. Add or update behavior tests for fixes and user-visible changes.
3. Update the relevant README, privacy notice, release documentation, or
   third-party notice when behavior or dependencies change.
4. Run the complete repository check:

   ```powershell
   npm run check
   ```

5. Explain the user impact, implementation boundary, and validation in the pull
   request.

Changes proposed by accounts that are not listed as project authors or
committers require maintainer review before merge. Release and signing controls
are described in [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).

## License

By contributing, you agree that your contribution is distributed under the
repository's [GPL-3.0-only license](LICENSE). Do not add code, models, fonts,
images, or other assets whose license is incompatible or cannot be documented.
