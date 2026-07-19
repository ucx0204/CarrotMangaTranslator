import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireFlux: vi.fn(),
  acquireKoharu: vi.fn(),
  disposeFlux: vi.fn(),
  disposeKoharu: vi.fn(),
}));

vi.mock("node:os", () => ({ totalmem: () => 32 * 1024 * 1024 * 1024 }));
vi.mock("../src/main/inpainting/fluxEnginePool", () => ({
  acquireFluxInpaintingEngine: mocks.acquireFlux,
  disposeCachedFluxInpaintingEngine: mocks.disposeFlux,
}));
vi.mock("../src/main/inpainting/koharuEnginePool", () => ({
  acquireKoharuInpaintingEngine: mocks.acquireKoharu,
  disposeCachedKoharuInpaintingEngine: mocks.disposeKoharu,
}));

describe("selected inpainting model routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disposeFlux.mockResolvedValue(false);
    mocks.disposeKoharu.mockResolvedValue(false);
  });

  it("uses only Flux when Flux is selected", async () => {
    const fluxLease = { engine: { model: "flux-klein" }, release: vi.fn() };
    mocks.acquireFlux.mockResolvedValue(fluxLease);
    const { acquireInpaintingEngine } =
      await import("../src/main/inpainting/inpaintingEnginePool");

    await expect(
      acquireInpaintingEngine({
        appPaths: {} as never,
        model: "flux-klein",
        fluxBackend: "metal-native",
      }),
    ).resolves.toBe(fluxLease);
    expect(mocks.acquireFlux).toHaveBeenCalledOnce();
    expect(mocks.acquireKoharu).not.toHaveBeenCalled();
    expect(mocks.disposeKoharu).toHaveBeenCalledWith("switch-to-flux");
  });

  it.each(["lama-manga", "aot-inpainting"] as const)(
    "uses only %s when it is selected",
    async (model) => {
      const koharuLease = { engine: { model }, release: vi.fn() };
      mocks.acquireKoharu.mockResolvedValue(koharuLease);
      const { acquireInpaintingEngine } =
        await import("../src/main/inpainting/inpaintingEnginePool");

      await expect(
        acquireInpaintingEngine({
          appPaths: {} as never,
          model,
          koharuBackend: "metal-native",
        }),
      ).resolves.toBe(koharuLease);
      expect(mocks.acquireKoharu).toHaveBeenCalledWith(
        expect.objectContaining({ model }),
      );
      expect(mocks.acquireFlux).not.toHaveBeenCalled();
      expect(mocks.disposeFlux).toHaveBeenCalledWith("switch-to-koharu");
    },
  );
});
