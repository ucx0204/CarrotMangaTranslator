import type { AppPaths } from "./appPaths";

export type DiagnosticRedactionOptions = {
  appPaths?: AppPaths;
  homeDir?: string;
};

export function redactDiagnosticText(
  value: string,
  options: DiagnosticRedactionOptions = {},
): { text: string; redactionCount: number } {
  let text = value;
  let redactionCount = 0;

  const replace = (
    pattern: RegExp,
    replacement: string | ((...args: string[]) => string),
  ): void => {
    text = text.replace(pattern, (...args: string[]) => {
      const matched = args[0];
      const next =
        typeof replacement === "string"
          ? replacement
          : replacement(...args.slice(0, -2));
      if (next !== matched) {
        redactionCount += 1;
      }
      return next;
    });
  };

  for (const pathReplacement of diagnosticPathReplacements(options)) {
    replace(pathReplacement.pattern, pathReplacement.placeholder);
  }

  replace(/(?:file:\/\/\/)?[a-z]:[\\/]+users[\\/]+[^\\/\s"'<>]+/gi, "<home>");
  replace(/[a-z]%3a(?:%5c|%2f)+(?:users)(?:%5c|%2f)+[^%/?&#\s]+/gi, "<home>");
  replace(/\/(?:users|home)\/[^/\s"'<>]+/gi, "<home>");
  replace(
    /(?:file%3a(?:%2f){2,3})?%2f(?:users|home)%2f[^%/?&#\s]+/gi,
    "<home>",
  );
  replace(/"(?:file:\/\/\/)?[a-z]:[\\/]+(?:\\.|[^"\\])*"/gi, '"<local-path>"');
  replace(/(?:file:\/\/\/)?[a-z]:[\\/]+[^\s"'<>]+/gi, "<local-path>");
  replace(/[a-z]%3a(?:%5c|%2f)+[^&#\s"']+/gi, "<local-path>");

  replace(
    /("(?:apiKey|authorization|proxyAuthorization|accessToken|refreshToken|token|secret|password|cookie|setCookie|customHeadersJson|extraBodyJson|promptOverrideText|promptOverrideTextPreview|sourceText|translatedText|ocrText|outputPreview|repairedOutputPreview|story|glossary|characters|imagePath|sourcePath|outputPath|outputDir|workName|chapterName|pageName|fileName|page)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,\s}\]]+)/gi,
    (_match, prefix, rawValue) =>
      isRedactionPlaceholder(rawValue)
        ? `${prefix}${rawValue}`
        : `${prefix}"<redacted>"`,
  );
  replace(
    /\b(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)\b(\s*[:=]\s*)(?!<redacted>)([^\s,;]+)/gi,
    (_match, key, separator) => `${key}${separator}<redacted>`,
  );
  replace(
    /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password)=)(?!%3credacted%3e|<redacted>)[^&#\s]+/gi,
    (_match, prefix) => `${prefix}<redacted>`,
  );
  replace(
    /\b(Bearer\s+)(?!<redacted>)[A-Za-z0-9._~+/=-]{8,}/gi,
    (_match, prefix) => `${prefix}<redacted>`,
  );
  replace(
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|hf_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    "<redacted-token>",
  );

  return { text, redactionCount };
}

function diagnosticPathReplacements(
  options: DiagnosticRedactionOptions,
): Array<{ pattern: RegExp; placeholder: string }> {
  const paths: Array<[string | undefined, string]> = [
    [options.appPaths?.settingsPath, "<settings-file>"],
    [options.appPaths?.logFile, "<app-log>"],
    [options.appPaths?.libraryDir, "<library-dir>"],
    [options.appPaths?.logsDir, "<logs-dir>"],
    [options.appPaths?.runtimeDir, "<runtime-dir>"],
    [options.appPaths?.toolsDir, "<tools-dir>"],
    [options.appPaths?.resourcesDir, "<resources-dir>"],
    [options.appPaths?.executableDir, "<executable-dir>"],
    [options.appPaths?.repoRoot, "<repo-root>"],
    [options.appPaths?.dataRoot, "<data-root>"],
    [options.homeDir, "<home>"],
  ];
  const seen = new Set<string>();

  return paths
    .flatMap(([pathValue, placeholder]) =>
      pathReplacementVariants(pathValue, placeholder),
    )
    .filter(({ variant }) => rememberUniqueVariant(seen, variant))
    .map(({ variant, placeholder }) => ({
      pattern: new RegExp(escapeRegExp(variant), "gi"),
      placeholder,
    }))
    .sort(
      (left, right) => right.pattern.source.length - left.pattern.source.length,
    );
}

function pathReplacementVariants(
  pathValue: string | undefined,
  placeholder: string,
): Array<{ variant: string; placeholder: string }> {
  const trimmed = pathValue?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    trimmed,
    trimmed.replace(/\\/g, "\\\\"),
    trimmed.replace(/\\/g, "/"),
    encodeURIComponent(trimmed),
  ]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((variant) => ({ variant, placeholder }));
}

function rememberUniqueVariant(seen: Set<string>, variant: string): boolean {
  const key = variant.toLowerCase();
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
}

function isRedactionPlaceholder(value: string): boolean {
  return /<redacted(?:-token)?>|<user-content>/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
