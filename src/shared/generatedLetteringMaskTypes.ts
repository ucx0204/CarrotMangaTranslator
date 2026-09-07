export type LetteringMaskStroke = {
  space: "asset" | "page";
  mode: "hide" | "restore";
  shape: "circle" | "square";
  points: { x: number; y: number }[];
  radiusX: number;
  radiusY: number;
  softness: number;
};
export type LetteringTool = {
  blockId: string | null;
  space: LetteringMaskStroke["space"];
  mode: LetteringMaskStroke["mode"];
  shape: LetteringMaskStroke["shape"];
  size: number;
  softness: number;
  showMask: boolean;
};
