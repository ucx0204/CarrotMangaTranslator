import type { InterruptedDialogue } from "./qwenControlReferences";
import {
  illustrationHint,
  type QwenMeasuredPrint,
  type QwenControlLaunch,
} from "./qwenControlSampling";
import {
  finishMeasuredPrint,
  writeMeasuredQwenCrop,
  writeScreenedQwenCrop,
  pasteQwenView,
  selectCoverView,
  qwenReferenceSize,
} from "./qwenCoverViews";
import { repairObliqueJacket } from "./qwenJacketView";
import { writeHatchedSound } from "./qwenHatchedSound";
import {
  QwenNativeReference,
  type QwenReferenceModels,
  prepareQwenSamplingInputs,
  prepareQwenArtworkCrop,
  originalViewSampling,
} from "./qwenNativeReference";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { nativeImage } from "electron";
import type {
  FluxWorkerRequest,
  FluxWorkerCropResult,
} from "./fluxWorkerTypes";
import { QwenControlCrop } from "./qwenControlCrop";
import {
  QwenControlSession,
  type QwenSessionLaunch,
} from "./qwenControlSession";
import { readNativeCropInputs, writeNativeCrop } from "./fluxCropIO";
import { readGeneratedBitmap } from "./imageRaster";
import { restoreQwenPaper } from "./qwenPaper";
import { refineQwenPrintedContours } from "./qwenPrintedContours";
import { compositeQwenArtwork } from "./qwenTextArtwork";

type Launch = QwenSessionLaunch & {
  platformGpu?: QwenSessionLaunch["platformGpu"] & { device: string };
  models: QwenReferenceModels;
  control?: QwenControlLaunch;
  adapter?: { directory: string; name: string; strength: number };
};

export class QwenImageWorker {
  private readonly nativeReference?: QwenNativeReference;
  private readonly control?: QwenControlCrop;
  private readonly session: QwenControlSession;
  private readonly lifetime = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly launch: Launch) {
    this.session = new QwenControlSession(launch);
    if (launch.control) this.control = new QwenControlCrop(launch.control);
    else
      this.nativeReference = new QwenNativeReference(
        launch.models,
        launch.adapter,
        launch.platformGpu?.device,
      );
  }

  async inpaint(
    request: FluxWorkerRequest,
    signal?: AbortSignal,
  ): Promise<FluxWorkerCropResult> {
    const active = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    active.throwIfAborted();
    const operation = this.queue.then(() => {
      active.throwIfAborted();
      return this.editCrop(request, active);
    });
    // The caller receives this crop's error. Later crops wait for settlement.
    this.queue = Promise.allSettled([operation]);
    return operation;
  }

  async dispose() {
    this.lifetime.abort();
    await this.queue;
    await Promise.all([
      this.session.dispose(),
      this.control?.dispose(),
      this.nativeReference?.dispose(),
    ]);
  }

  private async editCrop(request: FluxWorkerRequest, signal: AbortSignal) {
    const inputs = await readNativeCropInputs(request.input, request.mask);
    const substrate = this.control?.substrate ?? this.nativeReference;
    const screen = substrate?.uniformPrint(inputs);
    if (screen) {
      await writeNativeCrop(request.output, screen, inputs.original, signal);
      return "native-paper" as const;
    }
    const boundary = await substrate?.restoreSoundBoundary(
      request.illustratedTitle,
      inputs,
      signal,
      !request.illustratedTitle && !request.speechBubble,
    );
    if (boundary) {
      await writeNativeCrop(request.output, boundary, inputs.original, signal);
      return "native-paper" as const;
    }
    const restored = substrate?.restoreSelectedStock(
      request.illustratedTitle,
      inputs.source,
      inputs.stencil,
      request.input,
      signal,
    );
    if (restored)
      return writeNativeCrop(
        request.output,
        await restored,
        inputs.original,
        signal,
      );
    return this.editTextOrEffect(request, inputs, signal);
  }

  private async editTextOrEffect(
    request: FluxWorkerRequest,
    inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
    signal: AbortSignal,
  ) {
    const { width, height, stencil, original } = inputs;
    const paper = restoreQwenPaper(
      original,
      stencil,
      width,
      height,
      Boolean(request.speechBubble),
      request.illustratedTitle,
    );
    const paperImage =
      paper && nativeImage.createFromBitmap(paper, { width, height });
    const dialogue =
      paperImage &&
      request.speechBubble &&
      (await this.control?.interruptedDialogue(
        request.input,
        request.mask,
        paperImage,
        signal,
      ));
    if (paperImage && !dialogue) {
      await writeNativeCrop(request.output, paperImage, original, signal);
      return "native-paper" as const;
    }
    if (
      await repairObliqueJacket(
        this.control,
        request,
        inputs,
        signal,
        (local) => this.editCrop(local, signal),
      )
    )
      return;
    const result = await this.editReferenceCrop(
      request,
      inputs,
      dialogue || illustrationHint(request, inputs),
      signal,
    );
    if (request.illustratedTitle === "brush")
      await this.control?.registration.applyNativeDetail(
        "qwen-motion-lines.py",
        request.input,
        request.mask,
        request.output,
        signal,
      );
    return result;
  }

  private async editReferenceCrop(
    request: FluxWorkerRequest,
    inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
    hint: ReturnType<typeof illustrationHint> | InterruptedDialogue,
    signal: AbortSignal,
  ) {
    const control = this.control;
    const { source, stencil } = inputs;
    const { crop, nativeGuide, restored, guide } = await prepareQwenArtworkCrop(
      { control, native: this.nativeReference },
      request,
      inputs,
      hint,
      signal,
    );
    if (restored) return "native-paper" as const;
    const { weights, sizes, maxUpscale } = originalViewSampling(
      crop,
      inputs,
      request.speechBubble,
      this.nativeReference,
    );
    if (guide)
      return this.finishDecodedCrop(
        request,
        inputs,
        guide,
        weights,
        signal,
        crop?.material,
        request.maxPixels,
      );
    for (const side of sizes) {
      const maxPixels = Math.min(request.maxPixels, side * side);
      const generated = await this.sampleOriginalView(
        request,
        { ...inputs, nativeGuide },
        crop,
        { maxPixels, maxUpscale },
        signal,
      );
      if (generated) {
        if (crop?.referenceEdit === "uprightJacket") {
          // The parent crop projects the measured title from this temporary
          // upright book back onto the original illustration.
          const image = nativeImage.createFromBitmap(
            generated,
            source.getSize(),
          );
          await writeNativeCrop(request.output, image, inputs.original, signal);
          return;
        }
        const selected =
          control && crop?.referenceEdit === "cover"
            ? await selectCoverView({
                request,
                source,
                stencil,
                control,
                decoded: generated,
                signal,
                sizeFor: (w, h) => qwenReferenceSize(w, h, maxPixels),
                sample: this.runAtSize.bind(this),
              })
            : generated;
        return this.finishDecodedCrop(
          request,
          inputs,
          selected,
          weights,
          signal,
          crop?.material,
          maxPixels,
        );
      }
    }
    throw new Error(
      "선택 영역의 최소 해상도에서도 Qwen에 필요한 GPU 작업 공간을 확보할 수 없습니다.",
    );
  }

  private async sampleOriginalView(
    request: FluxWorkerRequest,
    inputs: Awaited<ReturnType<typeof readNativeCropInputs>> & {
      nativeGuide?: Awaited<ReturnType<QwenNativeReference["prepareCrop"]>>;
    },
    crop: Awaited<ReturnType<QwenControlCrop["prepare"]>> | undefined,
    { maxPixels, maxUpscale }: { maxPixels: number; maxUpscale?: number },
    signal: AbortSignal,
  ) {
    const view = crop?.pairedWindow;
    const native = view ? { width: view.w, height: view.h } : inputs;
    const { width, height } = native;
    const size = qwenReferenceSize(width, height, maxPixels, maxUpscale);
    const argumentsFor = await prepareQwenSamplingInputs(
      { control: this.control, native: this.nativeReference },
      request,
      inputs,
      crop,
      size,
      signal,
    );
    const decoded = await this.runAtSize(
      argumentsFor,
      request.output,
      size,
      native,
      signal,
    );
    if (!decoded || !view) return decoded;
    const result = Buffer.from(inputs.original);
    pasteQwenView(result, inputs.width, decoded, { ...view, width, height });
    return result;
  }

  private async finishDecodedCrop(
    request: FluxWorkerRequest,
    inputs: Awaited<ReturnType<typeof readNativeCropInputs>>,
    generated: Buffer,
    weights: Float32Array | undefined,
    signal: AbortSignal,
    material: QwenMeasuredPrint | undefined,
    maxPixels: number,
  ) {
    const { original, stencil, width, height } = inputs;
    if (await writeHatchedSound(request, inputs, generated, signal)) return;
    generated = this.nativeReference?.finish(inputs, generated) ?? generated;
    if (material && this.control) {
      const options = {
        request,
        source: inputs.source,
        stencil,
        control: this.control,
        decoded: generated,
        signal,
        sizeFor: (w: number, h: number) => qwenReferenceSize(w, h, maxPixels),
        sample: this.runAtSize.bind(this),
      };
      const finished = await finishMeasuredPrint(options, material);
      return writeMeasuredQwenCrop(
        request,
        inputs,
        finished,
        material.kind,
        signal,
      );
    }
    const paper = request.speechBubble
      ? undefined
      : refineQwenPrintedContours(original, stencil, generated, width, height);
    // Register the decoded silhouette while its full context is still
    // available. The native composite retains the original write limits.
    const prediction =
      this.control && !request.speechBubble && !paper
        ? await this.control.registerDecodedContours(
            request.input,
            request.mask,
            generated,
            { width, height },
            signal,
          )
        : generated;
    const result =
      paper ??
      compositeQwenArtwork(
        original,
        prediction,
        stencil,
        width,
        height,
        weights,
      );
    return writeScreenedQwenCrop(
      request,
      inputs,
      nativeImage.createFromBitmap(result, { width, height }),
      Boolean(paper),
      signal,
      this.control,
    );
  }

  private async runAtSize(
    argumentsFor: (output: string) => Promise<string[]>,
    output: string,
    size: { width: number; height: number },
    native: { width: number; height: number },
    signal: AbortSignal,
  ) {
    for (;;) {
      signal.throwIfAborted();
      const temporary = output + `.${randomUUID()}.png`;
      try {
        const args = await argumentsFor(temporary);
        signal.throwIfAborted();
        const status = await this.session.run(args, signal);
        if (status !== "ready") this.launch.status?.(status);
        // The pressured session has already released its context. Retry the
        // same native crop with CPU encoders before reducing its resolution.
        if (
          status === "memory" &&
          !this.nativeReference?.offloadEncodersAfterPressure()
        )
          return;
        if (status === "ready") {
          signal.throwIfAborted();
          return await readGeneratedBitmap(
            temporary,
            native.width,
            native.height,
            size,
          );
        }
      } finally {
        await rm(temporary, { force: true });
      }
      await delay(1400, undefined, { signal });
    }
  }
}
