// Dominant-color extraction for the Canvas color Match mode (issue #19,
// ADR-0008). Given an HTMLImageElement, returns a softened hex like '#7a8fb3'
// or null if no usable pixels survive filtering.
//
// Algorithm (~50 LOC of real work, per ADR-0008's "roll-in-house" decision):
//
// 1. Downsample to 64x64 onto an offscreen canvas. Faster than reading the
//    natural-resolution buffer and good enough for "what color is this image";
//    we want the dominant hue, not pixel-accurate sampling.
// 2. Convert each RGB triplet to HSL.
// 3. Filter out near-white (L > 0.9), near-black (L < 0.1), and near-gray
//    (S < 0.15) pixels. These three filters together drop the "70% white UI
//    chrome wins" failure mode the ADR calls out: most screenshots have a
//    huge mass of near-white pixels that would otherwise dominate.
// 4. Bin surviving pixels by hue into 24 bins (15° each). Weight each pixel's
//    contribution by its saturation — a fully-saturated red counts more than
//    a barely-tinted gray.
// 5. Pick the heaviest bin. Compute the saturation-weighted average H/S/L
//    within that bin only (averaging across the whole image would smear the
//    answer toward gray).
// 6. Soften: cap saturation at 0.5 and clamp lightness to [0.4, 0.7]. The
//    result is a muted, readable color — palette annotations stay visible on
//    top, and an extracted near-pure red doesn't blast the user with #FF0000.

// Bin count and short-name aliases. 24 bins (15° each) is the smallest number
// that still separates adjacent hues like red/orange — finer binning splits
// the same dominant color across neighboring bins and the largest-bin pick
// becomes noisy. Saturation and lightness clamps come from ADR-0008.
const HUE_BINS = 24;
const SAMPLE_SIZE = 64;
const MAX_SATURATION = 0.5;
const MIN_LIGHTNESS = 0.4;
const MAX_LIGHTNESS = 0.7;

// Filter thresholds. Tuned to drop the obvious junk without being so
// aggressive that a mostly-pastel image returns null. If we end up with too
// many silent fallbacks in practice, loosen S_MIN first — most screenshots
// have plenty of bright UI elements but the surrounding fields can be very
// desaturated.
const L_NEAR_WHITE = 0.9;
const L_NEAR_BLACK = 0.1;
const S_NEAR_GRAY = 0.15;

interface HSL {
  h: number;
  s: number;
  l: number;
}

// RGB (0-255) to HSL (h in [0,360), s/l in [0,1]). Standard formula — we
// only need the result, not derivatives, so the cheapest direct form is fine.
function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, l };
}

// HSL (h in [0,360), s/l in [0,1]) back to hex. Mirrors any standard
// reference implementation; kept inline to avoid a util-of-a-util.
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

export function extractDominantColor(image: HTMLImageElement): string | null {
  // Skip work on a not-yet-decoded image. Callers should pass a loaded
  // element (FabricImage's getElement() returns one that's already been
  // decoded for rendering), but defend against the empty-buffer edge case.
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) return null;

  // Plain <canvas> — OffscreenCanvas would work too, but using the DOM
  // element keeps us inside the same context as the rest of the codebase
  // (createPixelatedCrop in CanvasEditor.tsx uses the same approach) and
  // sidesteps the Safari OffscreenCanvas-with-2d-context support history.
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  } catch {
    // CORS-tainted images throw on drawImage in some browsers, others throw
    // on getImageData below. Either way, the answer is null.
    return null;
  }

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  } catch {
    return null;
  }

  // Parallel arrays per bin: total saturation weight and sums for the
  // weighted average. Hue averaging would need circular math in general
  // (red wraps at 360), but within a single 15° bin all the H values are
  // close enough that a plain weighted mean produces the right answer.
  const binWeight = new Float32Array(HUE_BINS);
  const binH = new Float32Array(HUE_BINS);
  const binS = new Float32Array(HUE_BINS);
  const binL = new Float32Array(HUE_BINS);

  for (let i = 0; i < pixels.length; i += 4) {
    // Drop transparent pixels — they contribute no color to "what does this
    // image look like". A fully-transparent screenshot region (e.g., a PNG
    // with alpha) shouldn't count.
    if (pixels[i + 3] < 128) continue;
    const { h, s, l } = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (l > L_NEAR_WHITE || l < L_NEAR_BLACK) continue;
    if (s < S_NEAR_GRAY) continue;
    const bin = Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS));
    binWeight[bin] += s;
    binH[bin] += h * s;
    binS[bin] += s * s;
    binL[bin] += l * s;
  }

  // Find the bin with the most saturation-weighted pixels. If no pixels
  // survived filtering at all (all-white / all-black / all-gray image),
  // every weight is 0 and we return null per the ADR's silent-fallback rule.
  let bestBin = -1;
  let bestWeight = 0;
  for (let i = 0; i < HUE_BINS; i += 1) {
    if (binWeight[i] > bestWeight) {
      bestWeight = binWeight[i];
      bestBin = i;
    }
  }
  if (bestBin === -1) return null;

  const totalWeight = binWeight[bestBin];
  const avgH = binH[bestBin] / totalWeight;
  const avgS = Math.min(binS[bestBin] / totalWeight, MAX_SATURATION);
  const avgL = Math.max(MIN_LIGHTNESS, Math.min(MAX_LIGHTNESS, binL[bestBin] / totalWeight));
  return hslToHex(avgH, avgS, avgL);
}
