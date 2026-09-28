import assert from "node:assert/strict"
import { test } from "node:test"
import { PNG } from "pngjs"
import { diffPngs } from "../src/diff.js"

/** A solid-colour PNG, optionally with a filled rectangle. */
function png(
  width: number,
  height: number,
  rgb: [number, number, number],
  box?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] },
): Buffer {
  const img = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
      const [r, g, b] = inBox ? box.rgb : rgb
      const i = (y * width + x) * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = 255
    }
  }
  return PNG.sync.write(img)
}

const WHITE: [number, number, number] = [255, 255, 255]
const BLACK: [number, number, number] = [0, 0, 0]

test("identical images have no changed pixels", () => {
  const a = png(50, 40, WHITE)
  const d = diffPngs(a, a)
  assert.equal(d.changedPixels, 0)
  assert.equal(d.ratio, 0)
  assert.equal(d.resized, false)
})

test("a changed block is counted exactly", () => {
  const a = png(100, 100, WHITE)
  const b = png(100, 100, WHITE, { x: 10, y: 10, w: 20, h: 5, rgb: BLACK })
  const d = diffPngs(a, b)
  assert.equal(d.changedPixels, 100)
  assert.equal(d.ratio, 0.01)
})

test("a taller head page counts the new area as changed", () => {
  const a = png(100, 100, WHITE)
  const b = png(100, 150, WHITE)
  const d = diffPngs(a, b)
  assert.equal(d.resized, true)
  assert.equal(d.height, 150)
  assert.equal(d.changedPixels, 100 * 50)
})

test("the diff image is a valid PNG of the padded size", () => {
  const d = diffPngs(png(30, 20, WHITE), png(40, 10, WHITE))
  const out = PNG.sync.read(d.png)
  assert.equal(out.width, 40)
  assert.equal(out.height, 20)
})

test("firstChangedY points at the topmost change", () => {
  const a = png(100, 100, WHITE)
  const b = png(100, 100, WHITE, { x: 0, y: 60, w: 10, h: 10, rgb: BLACK })
  assert.equal(diffPngs(a, b).firstChangedY, 60)
  assert.equal(diffPngs(a, a).firstChangedY, null)
  // Pure growth: the change starts where the shorter page ended.
  assert.equal(diffPngs(a, png(100, 130, WHITE)).firstChangedY, 100)
})
