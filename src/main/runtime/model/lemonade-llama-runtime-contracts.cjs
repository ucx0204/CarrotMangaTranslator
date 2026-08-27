// @ts-check

const LEMONADE_CONTRACTS = Object.freeze({
  legacy: {
    release: "b1291",
    requireBundledBlas: false,
    sha256ByTarget: Object.freeze({
      gfx103X:
        "3692a765ca0d5616284cbfe71c0a8a925824a538e9fe0efeb8710620612ecf77",
      gfx110X:
        "bcdec2f3e256162b8a52abb10a39969329deaa2fc57e33ded938a1e761d57b20",
      gfx1150:
        "09a6fe572e2be24e3e87654355db84f6fc79a057eb60427a2aad1f388f9dc5a8",
      gfx1151:
        "f185c81c0eeab19f83e24a5a98576d6c2994d746d34f465d6582efe4547edb02",
      gfx120X:
        "51072424c83349ac375b574f432bf80d14a2c7920946128de2c526cfdc3012f1",
      gfx908:
        "3634008a78f75bafc27c211b374ad62b6eaec5dd2f79a354add5b8aec7eb71ae",
      gfx90a:
        "23746b7593158e9796d18f2d13448b318b8937710c3ed1447740db6193ab36e7",
    }),
    bytesByTarget: Object.freeze({
      gfx103X: 160_723_690,
      gfx110X: 201_186_573,
      gfx1150: 120_027_841,
      gfx1151: 125_399_764,
      gfx120X: 528_745_915,
      gfx908: 123_928_182,
      gfx90a: 242_111_030,
    }),
  },
  speed: {
    release: "b1317",
    requireBundledBlas: true,
    sha256ByTarget: Object.freeze({
      gfx103X:
        "51bd001843b3d38ed93c88483bc8308b8a6c9384fa777a54d12e75ae1c657e17",
      gfx110X:
        "dbbca4f3b631ed29ad26395c965c899ef256d2031daf24c193145113c00b6390",
      gfx1150:
        "081cbcc117d3fb1a54b0e48ab50713f196729d461ea4ba25409f06bdf04094f5",
      gfx1151:
        "a532bcd7e64dd43cdef9c3fb0d63fbad6ee429696de08fa696b7bbae45cf2357",
      gfx120X:
        "eec9fa362b35be948b9b791be95ffb12d41bb3360938b1719fd2050381697684",
      gfx908:
        "0470a28a36918971a1ccb8ce409dcb6b9301265d8650e27c816c4e9187ffdd79",
      gfx90a:
        "3c2c8e324779dd09141b5ab89f7946e2768c83cdb7f7227b61c66a70bfcc3c9f",
    }),
    bytesByTarget: Object.freeze({
      gfx103X: 151_016_735,
      gfx110X: 163_321_007,
      gfx1150: 94_296_835,
      gfx1151: 99_120_177,
      gfx120X: 491_692_872,
      gfx908: 99_960_674,
      gfx90a: 215_157_539,
    }),
  },
});

/** @param {unknown} target */
function resolveLemonadeLlamaRuntimeRocm(target) {
  return resolvePinnedLemonadeRuntime(target, LEMONADE_CONTRACTS.legacy);
}

/** @param {unknown} target */
function resolveSpeedLemonadeLlamaRuntimeRocm(target) {
  return resolvePinnedLemonadeRuntime(target, LEMONADE_CONTRACTS.speed);
}

/**
 * @param {unknown} target
 * @param {{ release: string; requireBundledBlas: boolean; sha256ByTarget: Readonly<Record<string, string>>; bytesByTarget: Readonly<Record<string, number>> }} contract
 */
function resolvePinnedLemonadeRuntime(target, contract) {
  const normalized = String(target || "").trim();
  if (!normalized) throw new Error("AMD ROCm GPU target is required.");
  const sha256 = contract.sha256ByTarget[normalized];
  const expectedBytes = contract.bytesByTarget[normalized];
  if (!sha256 || !expectedBytes) {
    throw new Error(
      `No pinned llama ROCm runtime exists for target: ${normalized}`,
    );
  }
  const archive = `llama-${contract.release}-windows-rocm-${normalized}-x64.zip`;
  const baseUrl = `https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/${contract.release}`;
  return {
    id: `lemonade-llama-${contract.release}-rocm-${normalized}`,
    kind: "lemonade-rocm",
    backend: "rocm",
    dir: `lemonade-llama-${contract.release}-rocm-${normalized}`,
    archive,
    url: `${baseUrl}/${archive}`,
    archives: [
      { archive, url: `${baseUrl}/${archive}`, sha256, expectedBytes },
    ],
    requiredFiles: [
      "llama-server.exe",
      ["llama-server-impl.dll", "llama.dll"],
      ["amdhip64.dll", "amdhip64_7.dll"],
      ["ggml-hip.dll", "ggml-rocm.dll", "libggml-hip.so", "libggml-rocm.so"],
      ...(contract.requireBundledBlas ? ["hipblas.dll", "rocblas.dll"] : []),
    ],
  };
}

module.exports = {
  resolveLemonadeLlamaRuntimeRocm,
  resolveSpeedLemonadeLlamaRuntimeRocm,
};
