export type Point = [number, number]

export type Quad = [Point, Point, Point, Point]

export type Role = 'outer' | 'inner'

export type Tool = 'pan' | 'pen-outer' | 'pen-inner'

export type BezierNode = {
  point: Point
  // Symmetric handle vector. Outgoing handle is point + handle;
  // incoming handle is point - handle.
  handle: Point
  corner: boolean
}

export type RectPath = {
  nodes: BezierNode[]
  // Ordered around the path: top-left, top-right, bottom-right, bottom-left.
  // Additional side nodes are inserted between these indices.
  cornerIndices: [number, number, number, number]
}

export type ExportResult = {
  outputPath: string
  outputWidth: number
  outputHeight: number
}

export type LoadedImage = {
  path: string
  width: number
  height: number
  dataUrl: string
}

export type SerigraphicaAPI = {
  openImage: () => Promise<LoadedImage | null>
  openImagePath: (imagePath: string) => Promise<LoadedImage>
  filePathForDrop: (file: File) => string
  exportCorrected: (
    imagePath: string,
    corners: Quad,
    quality: number
  ) => Promise<ExportResult>
}

declare global {
  interface Window {
    serigraphica: SerigraphicaAPI
  }
}
