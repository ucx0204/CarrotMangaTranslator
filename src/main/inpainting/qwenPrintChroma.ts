function tone(b: number, g: number, r: number) {
  return (29 * b + 150 * g + 77 * r + 128) >> 8;
}

function inkBand() {
  return {
    n: 0,
    b: 0,
    r: 0,
    squares: 0,
    low: [255, 255, 255],
    high: [-255, -255, -255],
  };
}
type InkBand = ReturnType<typeof inkBand>;
type Palette = "grey" | InkBand[];

/** Slightly warm scanned ink still has a narrow chroma distribution at each
 * brightness. Coloured artwork and mixed inks do not have this property. */
export function measurePrintChroma(source: Buffer): Palette | undefined {
  let grey = true;
  for (let i = 0; i < source.length; i += 4) {
    const b = source[i],
      g = source[i + 1],
      r = source[i + 2];
    if (b === g && r === g) continue;
    if (Math.max(b, g, r) - Math.min(b, g, r) > 24) return;
    grey = false;
  }
  if (grey) return "grey";
  const bands = Array.from({ length: 16 }, inkBand);
  for (let i = 0; i < source.length; i += 4) {
    if (source[i + 3] !== 255) return;
    const b = source[i],
      g = source[i + 1],
      r = source[i + 2];
    const band = bands[tone(b, g, r) >> 4];
    const blue = b - g,
      red = r - g;
    band.n++;
    band.b += blue;
    band.r += red;
    band.squares += blue * blue + red * red;
    bound(band, 0, blue);
    bound(band, 1, red);
    bound(band, 2, red - blue);
  }
  const supported = bands.filter((v) => v.n >= 32);
  if (supported.length < 2 || !supported.every(consistentInk)) return;
  // Use the nearest measured ink for a brightness absent from a bilevel print.
  return bands.map((band, i) =>
    band.n >= 32
      ? band
      : supported.reduce((a, b) =>
          Math.abs(bands.indexOf(a) - i) <= Math.abs(bands.indexOf(b) - i)
            ? a
            : b,
        ),
  );
}

function bound(band: InkBand, index: number, value: number) {
  band.low[index] = Math.min(band.low[index], value);
  band.high[index] = Math.max(band.high[index], value);
}

function consistentInk(band: InkBand) {
  const b = band.b / band.n,
    r = band.r / band.n;
  return band.squares / band.n - b * b - r * r <= 14;
}

function inBand(band: InkBand, index: number, value: number) {
  return value >= band.low[index] - 1 && value <= band.high[index] + 1;
}

/** Change only unsupported hues. The original scan and the repair's luminance
 * give the replacement ink colour; alpha and native paper grain stay intact. */
export function constrainPrintChroma(
  original: Buffer,
  pixels: Buffer,
  palette: Palette,
) {
  let adjusted = false;
  for (let i = 0; i < pixels.length; i += 4) {
    const b = pixels[i],
      g = pixels[i + 1],
      r = pixels[i + 2];
    if (b === original[i] && g === original[i + 1] && r === original[i + 2])
      continue;
    const y = tone(b, g, r);
    if (palette === "grey") {
      if (b === g && r === g) continue;
      pixels.fill(y, i, i + 3);
    } else {
      const band = palette[y >> 4];
      if (
        inBand(band, 0, b - g) &&
        inBand(band, 1, r - g) &&
        inBand(band, 2, r - b)
      )
        continue;
      setMeasuredInk(pixels, i, y, band);
    }
    adjusted = true;
  }
  return adjusted;
}

function setMeasuredInk(pixels: Buffer, i: number, y: number, band: InkBand) {
  const blue = band.b / band.n,
    red = band.r / band.n;
  const g = -(29 * blue + 77 * red) / 256,
    b = g + blue,
    r = g + red;
  const up = Math.max(0, b, g, r),
    down = -Math.min(0, b, g, r);
  const scale = Math.min(1, up ? (255 - y) / up : 1, down ? y / down : 1);
  pixels[i] = Math.round(y + scale * b);
  pixels[i + 1] = Math.round(y + scale * g);
  pixels[i + 2] = Math.round(y + scale * r);
}
