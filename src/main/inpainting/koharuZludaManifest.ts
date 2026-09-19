// Exact non-trace DLLs from the runner's pinned v6-preview.65 release.
// Do not flatten zluda/trace/ over these libraries.
export type KoharuZludaSource = {
  url: string;
  fileName: string;
  bytes: number;
  sha256: string;
  dlls: Readonly<Record<string, { bytes: number; sha256: string }>>;
};

export const KOHARU_ZLUDA_SOURCE: KoharuZludaSource = {
  url: "https://github.com/vosen/ZLUDA/releases/download/v6-preview.65/zluda-windows-5c75a54.zip",
  fileName: "zluda-windows-5c75a54.zip",
  bytes: 32_880_554,
  sha256: "4a8d04f51a642f358b561482f39cd706639c4329fb685e0156884dee46a43ec1",
  dlls: {
    "nvcuda.dll": {
      bytes: 59_158_528,
      sha256:
        "02777ca5a104dded12df9cb2819337abbd1c2da95651a5bd6ff94da6ffd4ca93",
    },
    "nvcudart_hybrid64.dll": {
      bytes: 1_066_704,
      sha256:
        "bf430d65b863c49bab525001a0712992d17f52f4b5a205536160a337cf8b22b3",
    },
    "cublas64_13.dll": {
      bytes: 264_704,
      sha256:
        "d755998a322630fada67e1030b20061413233be27fa0d3946391f9f77a102f05",
    },
    "cublasLt64_13.dll": {
      bytes: 228_352,
      sha256:
        "3a91b2f6fb7579424bf593e16d596952a0558c55f816831ac20471ec9f3e0e2d",
    },
    "cufft64_12.dll": {
      bytes: 104_960,
      sha256:
        "a9f7cfb391133a09a9522d1a1d595b03b674ea858b40288f6d6e4c7e204ea7a8",
    },
    "cudnn64_9.dll": {
      bytes: 274_432,
      sha256:
        "18747587894a4489d13a153506d6825b8b8c369158468a618951cfd5cc856243",
    },
  },
};
