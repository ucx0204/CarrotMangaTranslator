import {
  controlConditionMask,
  type InterruptedDialogue,
} from "./qwenControlReferences";
import { hasOutlinedColumns } from "./qwenOutlinedColumns";
import { QwenNativePrintRegistration } from "./qwenNativePrintRegistration";
import {
  hasWhiteTitleOnDarkStock,
  describeCoverPrint,
  couldContainTitleStock,
  compactSoundCondition,
  luminousTitleMask,
} from "./qwenPrintedReference";
import {
  writeQwenControlArguments,
  registrationOption,
  type QwenSamplingCrop,
  type QwenMeasuredPrint,
  type QwenControlLaunch,
  referenceEditMode,
} from "./qwenControlSampling";
import { nativeImage, type NativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readGeneratedBitmap } from "./imageRaster";
import { QwenSubstrate } from "./qwenSubstrate";
import { QwenJacketVerifier } from "./qwenJacketVerifier";
import { pairedRuleEdit } from "./qwenRuledPaper";
import {
  registeredSoundReference,
  matchPrintedStock,
} from "./qwenSoundReference";
import type { IllustratedTitleHint } from "./fluxWorkerTypes";

type Size = { width: number; height: number };
export class QwenControlCrop {
  readonly registration: QwenNativePrintRegistration;
  readonly substrate: QwenSubstrate;
  readonly jacketVerifier: QwenJacketVerifier;
  constructor(private readonly launch: QwenControlLaunch) {
    this.substrate = new QwenSubstrate(launch.models.prior);
    this.registration = new QwenNativePrintRegistration(launch);
    this.jacketVerifier = new QwenJacketVerifier(dirname(launch.models.prior));
  }

  dispose() {
    return Promise.all([
      this.substrate.dispose(),
      this.jacketVerifier.dispose(),
      this.registration.dispose(),
    ]);
  }

  restoreReference(
    source: NativeImage,
    mask: NativeImage,
    signal: AbortSignal,
  ) {
    return this.substrate.restore(source, mask, signal);
  }

  async restorePrintedScreen(
    input: string,
    mask: string,
    output: string,
    signal: AbortSignal,
    framedOnly = false,
    speech = false,
  ) {
    await this.registration.applyNativeDetail(
      "qwen-screen-detail.py",
      input,
      mask,
      output,
      signal,
      framedOnly ? "--framed-only" : speech ? "--speech" : undefined,
    );
  }

  async reconcileCoverViews(
    input: string,
    mask: string,
    preferred: string,
    peer: string,
    size: Size,
    signal: AbortSignal,
  ) {
    const changed = await this.registration.applyNativeDetail(
      "qwen-restore-illustration.py",
      input,
      mask,
      preferred,
      signal,
      "--cover-peer=" + peer,
    );
    if (changed)
      return readGeneratedBitmap(preferred, size.width, size.height, size);
  }

  async interruptedDialogue(
    input: string,
    mask: string,
    prior: NativeImage,
    signal: AbortSignal,
  ): Promise<InterruptedDialogue | undefined> {
    const confirmed = await this.registration.registerImage(
      "qwen-reconnect-balloon.py",
      input,
      mask,
      prior,
      signal,
    );
    if (confirmed) return { kind: "dialogue", prior };
  }

  async registerDecodedContours(
    input: string,
    mask: string,
    decoded: Buffer,
    size: Size,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const image = nativeImage.createFromBitmap(decoded, size);
    const registered = await this.registration.registerImage(
      "qwen-register-contours.py",
      input,
      mask,
      image,
      signal,
    );
    return registered?.toBitmap() ?? decoded;
  }

  async restoreMeasuredPrint(
    input: string,
    mask: string,
    decoded: Buffer,
    size: Size,
    signal: AbortSignal,
    material: QwenMeasuredPrint,
  ) {
    const evidence =
      "prior" in material ? input + "." + randomUUID() + ".png" : undefined;
    try {
      if (evidence && "prior" in material)
        await writeFile(evidence, material.prior.toPNG());
      const native = await this.registration.registerImage(
        material.kind === "dialogue"
          ? "qwen-reconnect-balloon.py"
          : material.kind === "sky"
            ? "qwen-register-substrate.py"
            : material.kind === "title"
              ? "qwen-title-stock.py"
              : "qwen-restore-illustration.py",
        input,
        mask,
        nativeImage.createFromBitmap(decoded, size),
        signal,
        registrationOption(material, evidence),
      );
      if (!native)
        throw new Error(
          "Qwen 표지의 원본 윤곽과 농도를 다시 확인할 수 없습니다.",
        );
      return native;
    } finally {
      if (evidence) await rm(evidence, { force: true });
    }
  }

  private async titleGuide(
    source: NativeImage,
    stencil: Uint8Array,
    prefix: string,
    signal: AbortSignal,
    originalMask: string | undefined,
  ) {
    if (!originalMask || !couldContainTitleStock(source, stencil)) return;
    const titleSource = await this.registration.registerImage(
      "qwen-title-stock.py",
      prefix,
      originalMask,
      source,
      signal,
      "source",
    );
    if (!titleSource) return;
    const ink = nativeImage.createFromBuffer(await readFile(originalMask));
    const base = await this.substrate.restore(titleSource, ink, signal);
    const guide = await this.registration.registerImage(
      "qwen-title-stock.py",
      prefix,
      originalMask,
      base,
      signal,
      "guide",
    );
    return { prior: guide ?? base, titleSource };
  }

  private async directReference(
    source: NativeImage,
    stencil: Uint8Array,
    prefix: string,
    originalMask: string | undefined,
    illustratedTitle:
      Exclude<IllustratedTitleHint, false> | InterruptedDialogue,
    signal: AbortSignal,
  ): Promise<QwenSamplingCrop> {
    const size = source.getSize();
    const direct = {
      size,
      condition: controlConditionMask(stencil, size, illustratedTitle),
      prior: source,
      prefix,
      titleSource: undefined,
      registered: false,
      sourceReference: true,
      ...referenceEditMode(illustratedTitle),
    };
    const restore = (mask: Uint8Array) =>
      this.substrate.restoreStencil(source, mask, prefix, signal);
    if (direct.referenceEdit === "washedTitle")
      return {
        ...direct,
        material: {
          kind: "washed-title",
          prior: await restore(stencil),
        },
      };
    const printedView = await this.registration.printedTitleReference(
      illustratedTitle,
      prefix,
      originalMask,
      size,
      signal,
    );
    if (printedView) return { ...direct, ...printedView };
    if (direct.referenceEdit === "layeredTitle") {
      return {
        ...direct,
        titleSource: await restore(stencil),
      };
    }
    if (direct.referenceEdit === "effect" && originalMask) {
      const paired = pairedRuleEdit(
        source.toBitmap(),
        stencil,
        size,
        originalMask,
      );
      if (paired) return { ...direct, ...paired };
      const fan = registeredSoundReference(
        source,
        stencil,
        prefix,
        originalMask,
        "actionFan",
      );
      if (fan) return fan;
      const condition = compactSoundCondition(source, stencil);
      if (condition) {
        return {
          size,
          condition,
          prefix,
          compactSound: true,
          sourceReference: false,
          registered: false,
          material: { kind: "sound" },
          prior: await restore(condition),
        };
      }
    }
    return { ...direct, ...describeCoverPrint(source, stencil, direct) };
  }

  async prepare(
    source: NativeImage,
    stencil: Uint8Array,
    prefix: string,
    signal: AbortSignal,
    originalMask?: string,
    illustratedTitle: IllustratedTitleHint | InterruptedDialogue = false,
  ): Promise<QwenSamplingCrop> {
    const size = source.getSize();
    const stock = matchPrintedStock(
      source,
      stencil,
      prefix,
      originalMask,
      illustratedTitle,
    );
    if (stock) return stock;
    const generalTitle =
      illustratedTitle === true || illustratedTitle === "lettering";
    const direct = illustratedTitle
      ? await this.directReference(
          source,
          stencil,
          prefix,
          originalMask,
          illustratedTitle,
          signal,
        )
      : registeredSoundReference(
          source,
          stencil,
          prefix,
          originalMask,
          "screenedMolding",
        );
    if (direct && !generalTitle) return direct;
    // A general cover selection may contain an optically measured title plate
    // or a circular print on dark sky. Both can be established on the original.
    const title = await this.titleGuide(
      source,
      stencil,
      prefix,
      signal,
      originalMask,
    );
    if (title) {
      return {
        size,
        condition: controlConditionMask(stencil, size, false),
        ...title,
        prefix,
        registered: false,
        sourceReference: false,
        material: { kind: "title" },
      };
    }
    const possibleSky = luminousTitleMask(source, stencil, originalMask);
    const guideDarkTitle =
      generalTitle && hasWhiteTitleOnDarkStock(source, stencil);
    if (direct && !possibleSky && !guideDarkTitle) return direct;
    return this.prepareStock(
      source,
      stencil,
      prefix,
      signal,
      direct,
      guideDarkTitle,
      possibleSky,
    );
  }

  private async prepareStock(
    source: NativeImage,
    stencil: Uint8Array,
    prefix: string,
    signal: AbortSignal,
    direct: QwenSamplingCrop | undefined,
    guideDarkTitle: boolean,
    skyMask: string | undefined,
  ): Promise<QwenSamplingCrop> {
    const size = source.getSize();
    const condition =
      guideDarkTitle && direct
        ? direct.condition
        : controlConditionMask(stencil, size, false);
    const prior = await this.substrate.restoreStencil(
      source,
      condition,
      prefix,
      signal,
    );
    const registered = skyMask
      ? await this.registration.registerImage(
          "qwen-register-substrate.py",
          prefix,
          skyMask,
          prior,
          signal,
        )
      : undefined;
    if (!registered && direct && !guideDarkTitle) return direct;
    return {
      size,
      condition,
      prior: registered ?? prior,
      titleSource: undefined,
      prefix,
      registered: !!registered,
      sourceReference:
        !registered && !guideDarkTitle && hasOutlinedColumns(source, stencil),
      material: registered
        ? ({ kind: "sky", prior } satisfies QwenMeasuredPrint)
        : guideDarkTitle
          ? { kind: "lettering" }
          : undefined,
    };
  }

  async argumentsFor(
    crop: Awaited<ReturnType<QwenControlCrop["prepare"]>>,
    target: Size,
    image: string,
    output: string,
    signal?: AbortSignal,
  ) {
    return writeQwenControlArguments(
      this.launch,
      crop,
      target,
      image,
      output,
      signal,
    );
  }
}
