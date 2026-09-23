import { describe, it, expect } from "vitest";
import {
  resolveDefaultAppSettings,
  normalizeAppSettings,
} from "../src/main/appSettings";
import { canUseCodexImages } from "../src/shared/codexCapabilities";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";
import type { CodexAccountSnapshot } from "../src/shared/codexAccountTypes";
const account: CodexAccountSnapshot = {
  authenticated: true,
  accountKind: "chatgpt",
  email: null,
  planType: null,
  requiresOpenaiAuth: true,
  appServerVersion: "test",
  models: [
    {
      id: "gpt-6-astra",
      displayName: "Astra",
      supportedReasoningEfforts: ["low"],
      defaultReasoningEffort: "low",
      isDefault: true,
    },
  ],
};
describe("auxiliary Codex image capability", () => {
  it.each(["auto", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const)(
    "roundtrips the %s image backend separately from its controller",
    (imageGenerationModel) => {
      const defaults = resolveDefaultAppSettings({});
      const settings = {
        ...defaults,
        codex: { ...defaults.codex, imageGenerationModel },
      };
      expect(AppSettingsSchema.safeParse(settings).success).toBe(true);
      expect(normalizeAppSettings(settings).codex).toEqual(settings.codex);
      const invalid = {
        ...settings,
        codex: { ...settings.codex, imageGenerationModel: "unknown" },
      };
      expect(AppSettingsSchema.safeParse(invalid).success).toBe(false);
      expect(normalizeAppSettings(invalid).codex.imageGenerationModel).toBe(
        "gpt-image-2.5-flare",
      );
    },
  );
  it.each([
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6.1-future",
  ])("saves and permits the available %s image controller", (imageModel) => {
    const defaults = resolveDefaultAppSettings({});
    const settings = { ...defaults, codex: { ...defaults.codex, imageModel } };
    expect(AppSettingsSchema.safeParse(settings).success).toBe(true);
    expect(normalizeAppSettings(settings).codex.imageModel).toBe(imageModel);
    expect(
      canUseCodexImages(settings, {
        ...account,
        models: [{ ...account.models[0], id: imageModel }],
      }),
    ).toBe(true);
    expect(canUseCodexImages(settings, { ...account, models: [] })).toBe(false);
  });
  it.each([
    "gpt-5.5",
    "gpt-5.1-codex",
    "gpt-4.1",
    "gpt-image-2",
    "gpt-5.6invalid",
    "unsupported-model",
  ])("rejects %s even when present in the account catalog", (imageModel) => {
    const defaults = resolveDefaultAppSettings({});
    const settings = { ...defaults, codex: { ...defaults.codex, imageModel } };
    expect(AppSettingsSchema.safeParse(settings).success).toBe(false);
    expect(normalizeAppSettings(settings).codex.imageModel).toBe("gpt-6-astra");
    expect(
      canUseCodexImages(settings, {
        ...account,
        models: [{ ...account.models[0], id: imageModel }],
      }),
    ).toBe(false);
  });
  it("requires a supported image controller and ChatGPT account, with low as the unset effort", () => {
    const settings = resolveDefaultAppSettings({});
    expect(canUseCodexImages(null, account)).toBe(false);
    expect(canUseCodexImages(settings, null)).toBe(false);
    expect(canUseCodexImages(settings, { ...account, accountKind: null })).toBe(
      false,
    );
    settings.codex.imageModel = "unsupported-model";
    expect(canUseCodexImages(settings, account)).toBe(false);
    settings.codex.imageModel = undefined;
    settings.codex.imageReasoningEffort = undefined;
    expect(canUseCodexImages(settings, account)).toBe(true);
  });
  it("restores a separate Sol image controller without requiring Astra or changing text settings", () => {
    const defaults = resolveDefaultAppSettings({});
    const restored = normalizeAppSettings({
      ...defaults,
      codex: {
        ...defaults.codex,
        imageModel: "gpt-5.6-sol",
        imageReasoningEffort: "low",
        model: "gpt-6-astra",
        reasoningEffort: "high",
      },
    });
    expect(restored.codex).toMatchObject({
      imageModel: "gpt-5.6-sol",
      imageReasoningEffort: "low",
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(
      canUseCodexImages(restored, {
        ...account,
        models: [{ ...account.models[0], id: "gpt-5.6-sol" }],
      }),
    ).toBe(true);
    expect(canUseCodexImages(restored, account)).toBe(false);
  });
  it.each(["gemma", "openai-api", "openai-codex"] as const)(
    "works with %s text translation and separate image effort",
    (provider) => {
      const settings = resolveDefaultAppSettings({});
      settings.modelProvider = provider;
      settings.codex.model = "gpt-5.6-sol";
      settings.codex.reasoningEffort = "high";
      settings.codex.imageReasoningEffort = "low";
      expect(canUseCodexImages(settings, account)).toBe(true);
      expect(
        canUseCodexImages(settings, { ...account, authenticated: false }),
      ).toBe(false);
      expect(canUseCodexImages(settings, { ...account, models: [] })).toBe(
        false,
      );
      settings.codex.imageReasoningEffort = "high";
      expect(canUseCodexImages(settings, account)).toBe(false);
    },
  );
  it("drops retired global delegation on normalization", () => {
    const old = resolveDefaultAppSettings({});
    const restored = normalizeAppSettings({
      ...old,
      codex: { ...old.codex, delegateAll: true },
    });
    expect(restored.codex).not.toHaveProperty("delegateAll");
    expect(restored.ui?.codexTypesettingPreferences).toEqual(
      old.ui?.codexTypesettingPreferences,
    );
  });
});
