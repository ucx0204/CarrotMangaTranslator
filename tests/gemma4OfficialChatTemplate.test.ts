import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Gemma4OfficialChatTemplateModule = {
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_BYTES: number;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_FILE: string;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_REVISION: string;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SHA256: string;
  GEMMA4_OFFICIAL_CHAT_TEMPLATE_SOURCE: string;
  resolveGemma4OfficialChatTemplatePath: () => string;
  verifyGemma4OfficialChatTemplate: (templatePath?: string) => string;
};

const templateModule =
  require("../src/main/runtime/model/gemma4-official-chat-template.cjs") as Gemma4OfficialChatTemplateModule;

const temporaryDirectories: string[] = [];

afterEach(() => {
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
      "gemma-4-26b-a4b-it-4d7ae4984b7db7de8f8457170b3f1a419ee76d52.jinja",
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
});
