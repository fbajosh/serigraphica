import type { GuideStore, LoadedImage, SavedGuides } from '@serigraphica/editor'

// Retain the existing desktop v3 records and exact filesystem-path keys.
const KEY = 'serigraphica.manualOutlines.v3'
function readStore(): Record<string, {
  imageWidth: number; imageHeight: number; rectangles: SavedGuides['rectangles']
  centerLargestInnerHorizontal?: boolean; centerLargestInnerVertical?: boolean
}> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') ?? {} } catch { return {} }
}

export const desktopGuides: GuideStore = {
  load(image: LoadedImage) {
    const saved = readStore()[image.path]
    if (!saved || saved.imageWidth !== image.width || saved.imageHeight !== image.height || !Array.isArray(saved.rectangles)) return null
    return {
      width: image.width, height: image.height, rectangles: saved.rectangles,
      centerHorizontal: saved.centerLargestInnerHorizontal ?? true,
      centerVertical: saved.centerLargestInnerVertical ?? true,
    }
  },
  save(image, guides) {
    const store = readStore()
    const record = {
      version: 3, filename: image.path.split(/[\\/]/).pop(), imagePath: image.path,
      savedAt: new Date().toISOString(), imageWidth: image.width, imageHeight: image.height,
      rectangles: guides.rectangles,
      centerLargestInnerHorizontal: guides.centerHorizontal,
      centerLargestInnerVertical: guides.centerVertical,
    }
    localStorage.setItem(KEY, JSON.stringify({ ...store, [image.path]: record }))
  },
}
