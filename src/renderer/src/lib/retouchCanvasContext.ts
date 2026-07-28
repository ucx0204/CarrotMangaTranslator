export type RetouchCanvasContext = {
  arc: (
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ) => void;
  beginPath: () => void;
  clearRect: (x: number, y: number, width: number, height: number) => void;
  clip: () => void;
  closePath: () => void;
  drawImage: (
    image: CanvasImageSource,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number,
  ) => void;
  ellipse: (
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ) => void;
  fill: () => void;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineTo: (x: number, y: number) => void;
  lineWidth: number;
  moveTo: (x: number, y: number) => void;
  restore: () => void;
  save: () => void;
  setLineDash: (segments: Iterable<number>) => void;
  setTransform: (
    scaleX: number,
    skewY: number,
    skewX: number,
    scaleY: number,
    translateX: number,
    translateY: number,
  ) => void;
  stroke: () => void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
};
