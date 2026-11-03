import { test } from 'node:test'
import assert from 'node:assert/strict'
import { desktopGuides } from '../src/renderer/desktopGuides.ts'

test('desktop adapter restores existing v3 paths and preserves other records on save', () => {
  const values = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } })
  const image = { path: '/photos/art.jpg', width: 800, height: 600, dataUrl: 'local-image://photo' }
  const rectangles = [{ nodes: [], cornerIndices: [0, 1, 2, 3] }]
  values.set('serigraphica.manualOutlines.v3', JSON.stringify({
    [image.path]: { imageWidth: 800, imageHeight: 600, rectangles, centerLargestInnerHorizontal: false },
    '/photos/other.jpg': { keep: true },
  }))
  const saved = desktopGuides.load(image)
  assert.equal(saved.centerHorizontal, false)
  assert.equal(saved.centerVertical, true)
  assert.deepEqual(saved.rectangles, rectangles)
  assert.equal(desktopGuides.load({ ...image, path: '/elsewhere/art.jpg' }), null)
  desktopGuides.save(image, { ...saved, centerVertical: false })
  const store = JSON.parse(values.get('serigraphica.manualOutlines.v3'))
  assert.deepEqual(store['/photos/other.jpg'], { keep: true })
  assert.equal(store[image.path].version, 3)
  assert.equal(store[image.path].centerLargestInnerVertical, false)
  assert.equal(JSON.stringify(store).includes('local-image://'), false)
})
