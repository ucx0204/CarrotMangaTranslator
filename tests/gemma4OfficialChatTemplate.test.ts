import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Gemma4OfficialChatTemplateModule = {
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES: number;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV: string;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE: string;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION: string;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256: string;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE: string;
  prepareGemma4OfficialChatTemplate: (options?: {
    platform?: string;
    sourcePath?: string;
    stagingRoot?: string;
  }) => string;
  resolveGemma4OfficialChatTemplatePath: () => string;
  verifyGemma4OfficialChatTemplate: (templatePath?: string) => string;
};

const templateModule =
  require("../src/main/runtime/model/gemma4-official-chat-template.cjs") as Gemma4OfficialChatTemplateModule;

const temporaryDirectories: string[] = [];
const tempEnvironmentNames = ["TEMP", "TMP", "TMPDIR"] as const;
const originalEnvironment = new Map<string, string | undefined>([
  ...tempEnvironmentNames.map(
    (name) => [name, process.env[name]] as [string, string | undefined],
  ),
  [
    templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV,
    process.env[templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV],
  ],
]);

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("official Gemma 4 26B chat template", () => {
  it("pins the exact upstream revision, size, and SHA-256", () => {
    const templatePath = templateModule.resolveGemma4OfficialChatTemplatePath();
    const contents = readFileSync(templatePath);
    const sha256 = createHash("sha256").update(contents).digest("hex");

    expect(templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION).toBe(
      "4d7ae4984b7db7de8f8457170b3f1a419ee76d52",
    );
    expect(templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE).toBe(
      "gemma4-26b-4d7ae498.jinja",
    );
    expect(templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE).toBe(
      "https://huggingface.co/google/gemma-4-26B-A4B-it/raw/4d7ae4984b7db7de8f8457170b3f1a419ee76d52/chat_template.jinja",
    );
    expect(contents.byteLength).toBe(
      templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES,
    );
    expect(sha256).toBe(templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256);
    expect(templateModule.verifyGemma4OfficialChatTemplate()).toBe(
      templatePath,
    );
  });

  it("fails before launch when the vendored bytes do not match", () => {
    const directory = mkdtempSync(join(tmpdir(), "gemma4-template-"));
    temporaryDirectories.push(directory);
    const templatePath = join(directory, "chat-template.jinja");
    writeFileSync(templatePath, "tampered");

    expect(() =>
      templateModule.verifyGemma4OfficialChatTemplate(templatePath),
    ).toThrow(/failed its integrity check/i);
  });

  it("stages the verified template to an ASCII path for Windows llama.cpp", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "gemma4-source-"));
    const stagingRoot = mkdtempSync(join(tmpdir(), "gemma4-stage-"));
    temporaryDirectories.push(sourceRoot, stagingRoot);
    const unicodeDir = join(sourceRoot, "번역기");
    mkdirSync(unicodeDir);
    const sourcePath = join(unicodeDir, "chat-template.jinja");
    copyFileSync(
      templateModule.resolveGemma4OfficialChatTemplatePath(),
      sourcePath,
    );

    const stagedPath = templateModule.prepareGemma4OfficialChatTemplate({
      platform: "win32",
      sourcePath,
      stagingRoot,
    });

    expect(stagedPath).not.toBe(sourcePath);
    expect(stagedPath).toMatch(
      /chat-templates[\\/]gemma4-26b-4d7ae498\.jinja$/,
    );
    expect(
      Buffer.compare(readFileSync(stagedPath), readFileSync(sourcePath)),
    ).toBe(0);
    expect(
      templateModule.prepareGemma4OfficialChatTemplate({
        platform: "win32",
        sourcePath,
        stagingRoot,
      }),
    ).toBe(stagedPath);
  });

  it("uses the configured cache environment when no staging root is passed", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "gemma4-env-source-"));
    const stagingRoot = mkdtempSync(join(tmpdir(), "gemma4-env-stage-"));
    temporaryDirectories.push(sourceRoot, stagingRoot);
    const unicodeDir = join(sourceRoot, "번역기");
    mkdirSync(unicodeDir);
    const sourcePath = join(unicodeDir, "chat-template.jinja");
    copyFileSync(
      templateModule.resolveGemma4OfficialChatTemplatePath(),
      sourcePath,
    );
    process.env[templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV] =
      stagingRoot;

    expect(
      templateModule.prepareGemma4OfficialChatTemplate({
        platform: "win32",
        sourcePath,
      }),
    ).toBe(
      join(
        stagingRoot,
        "chat-templates",
        templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE,
      ),
    );
  });

  it("uses an isolated default temp cache when no cache root is configured", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "gemma4-default-source-"));
    const isolatedTempRoot = mkdtempSync(
      join(tmpdir(), "gemma4-default-cache-"),
    );
    temporaryDirectories.push(sourceRoot, isolatedTempRoot);
    const unicodeDir = join(sourceRoot, "번역기");
    mkdirSync(unicodeDir);
    const sourcePath = join(unicodeDir, "chat-template.jinja");
    copyFileSync(
      templateModule.resolveGemma4OfficialChatTemplatePath(),
      sourcePath,
    );
    delete process.env[templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_CACHE_ENV];
    for (const name of tempEnvironmentNames) {
      process.env[name] = isolatedTempRoot;
    }

    expect(
      templateModule.prepareGemma4OfficialChatTemplate({
        platform: "win32",
        sourcePath,
      }),
    ).toBe(
      join(
        isolatedTempRoot,
        "carrot-manga-translator-runtime",
        "chat-templates",
        templateModule.GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE,
      ),
    );
  });

  it("keeps directly readable paths unchanged", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "gemma4-ascii-source-"));
    temporaryDirectories.push(sourceRoot);
    const sourcePath = join(sourceRoot, "chat-template.jinja");
    copyFileSync(
      templateModule.resolveGemma4OfficialChatTemplatePath(),
      sourcePath,
    );

    expect(
      templateModule.prepareGemma4OfficialChatTemplate({
        platform: "win32",
        sourcePath,
      }),
    ).toBe(sourcePath);
    expect(
      templateModule.prepareGemma4OfficialChatTemplate({
        platform: "linux",
        sourcePath,
      }),
    ).toBe(sourcePath);
  });

  it("rejects a non-ASCII Windows staging root with an actionable error", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "gemma4-unicode-source-"));
    temporaryDirectories.push(sourceRoot);
    const unicodeDir = join(sourceRoot, "번역기");
    mkdirSync(unicodeDir);
    const sourcePath = join(unicodeDir, "chat-template.jinja");
    copyFileSync(
      templateModule.resolveGemma4OfficialChatTemplatePath(),
      sourcePath,
    );

    expect(() =>
      templateModule.prepareGemma4OfficialChatTemplate({
        platform: "win32",
        sourcePath,
        stagingRoot: join(sourceRoot, "캐시"),
      }),
    ).toThrow(/ASCII-only Gemma 4 template cache path/i);
  });
});
