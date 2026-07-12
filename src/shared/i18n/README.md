# Adding an application language

The application UI locale is independent from the manga source/target language pair.

1. Add the BCP-47 locale and its native display name to `../uiLocales.ts`.
2. Copy one existing folder under `locales/` and translate all four catalogs:
   `common.json`, `components.json`, `renderer.json`, and `main.json`.
3. Keep every key and `{{interpolation}}` name identical to the Korean catalog.
4. Export the four catalogs from the locale folder's `index.ts`, then register
   that bundle once in `resources.ts`.
5. Add system-locale aliases to `resolveUiLocale` when the language has regional
   or script variants.
6. Run `npx vitest run tests/i18nCatalogs.test.ts tests/i18nKeyUsage.test.ts`.

Do not put model prompts, user content, log text, legacy filesystem names, or
stable import/export protocol markers in these UI catalogs.
