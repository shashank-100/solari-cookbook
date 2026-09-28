/**
 * Pixel diff of two screenshots.
 *
 * Full-page screenshots of base and head are often different sizes — a PR
 * that adds a section makes the page taller. pixelmatch wants equal sizes, so
 * the region both images cover is compared pixel by pixel, and everything
 * outside it counts as changed: a page that grew by 400px *is* a visual
 * change, even if the new 400px are plain white.
 *
 * (Padding the smaller image with transparent pixels and diffing the whole
 * canvas doesn't work: pixelmatch blends transparency against white, so the
 * padding matches a white page and the growth disappears.)
 */
import pixelmatch from "pixelmatch"
import { PNG } from "pngjs"

export interface DiffResult {
  width: number
  height: number
  changedPixels: number
  /** changedPixels / (width * height), 0..1 */
  ratio: number
  /** Base and head had different dimensions. */
  resized: boolean
  /** Topmost changed row, or null. On a long page this is where to look. */
  firstChangedY: number | null
  /** The diff image: unchanged pixels faded, changed pixels red. */
  png: Buffer
}

function crop(img: PNG, width: number, height: number): PNG {
  if (img.width === width && img.height === height) return img
  const out = new PNG({ width, height })
  PNG.bitblt(img, out, 0, 0, width, height, 0, 0)
  return out
}

export function diffPngs(basePng: Buffer, headPng: Buffer, threshold = 0.1): DiffResult {
  const a = PNG.sync.read(basePng)
  const b = PNG.sync.read(headPng)
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const common = { w: Math.min(a.width, b.width), h: Math.min(a.height, b.height) }

  const inner = new PNG({ width: common.w, height: common.h })
  const DIFF_RGB = [255, 0, 0] as const
  const innerChanged = pixelmatch(
    crop(a, common.w, common.h).data,
    crop(b, common.w, common.h).data,
    inner.data,
    common.w,
    common.h,
    { threshold, diffColor: [...DIFF_RGB] },
  )

  let firstChangedY: number | null = null
  if (innerChanged > 0) {
    scan: for (let y = 0; y < common.h; y++) {
      for (let x = 0; x < common.w; x++) {
        const i = (y * common.w + x) * 4
        if (inner.data[i] === DIFF_RGB[0] && inner.data[i + 1] === DIFF_RGB[1] && inner.data[i + 2] === DIFF_RGB[2]) {
          firstChangedY = y
          break scan
        }
      }
    }
  }
  // Only the size differs: the first change is where the shorter one ends.
  if (firstChangedY === null && (common.w < width || common.h < height)) {
    firstChangedY = common.w < width ? 0 : common.h
  }

  // Full-size diff: the compared region, then solid red wherever only one
  // image has pixels.
  const out = new PNG({ width, height })
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255
    out.data[i + 3] = 255
  }
  PNG.bitblt(inner, out, 0, 0, common.w, common.h, 0, 0)

  const changedPixels = innerChanged + (width * height - common.w * common.h)
  return {
    width,
    height,
    changedPixels,
    ratio: width * height === 0 ? 0 : changedPixels / (width * height),
    resized: a.width !== b.width || a.height !== b.height,
    firstChangedY,
    png: PNG.sync.write(out),
  }
}
