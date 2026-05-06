export type Point = [number, number]

export type Quad = [Point, Point, Point, Point]

export type Tool = 'pan' | 'pen-rectangle' | 'fill'

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

export type FillShape = {
  points: Quad
}

export type FillSampleRegion = {
  x0: number
  y0: number
  x1: number
  y1: number
}

export type ExportResult = {
  outputPath: string
  outputWidth: number
  outputHeight: number
}

export type DewarpOperation = 'preview' | 'export' | 'export-as'

export type DewarpProgress = {
  percent: number
  stage: string
  operation: DewarpOperation
}

export type LoadedImage = {
  path: string
  width: number
  height: number
  dataUrl: string
  method?: string
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
  exportCorrectedAs: (
    imagePath: string,
    corners: Quad,
    quality: number
  ) => Promise<ExportResult | null>
  previewCorrected: (
    imagePath: string,
    corners: Quad,
    quality: number
  ) => Promise<LoadedImage>
  exportDewarped: (
    imagePath: string,
    rectangles: RectPath[],
    quality: number,
    outputBasePath?: string,
    fillShapes?: FillShape[],
    fillSampleRegions?: FillSampleRegion[]
  ) => Promise<ExportResult>
  exportDewarpedAs: (
    imagePath: string,
    rectangles: RectPath[],
    quality: number,
    outputBasePath?: string,
    fillShapes?: FillShape[],
    fillSampleRegions?: FillSampleRegion[]
  ) => Promise<ExportResult | null>
  previewDewarped: (
    imagePath: string,
    rectangles: RectPath[],
    quality: number,
    outputBasePath?: string
  ) => Promise<LoadedImage>
  previewFilled: (
    imagePath: string,
    fillShapes: FillShape[],
    quality: number,
    fillSampleRegions?: FillSampleRegion[]
  ) => Promise<LoadedImage>
  cancelDewarp: () => Promise<boolean>
  onDewarpProgress: (callback: (progress: DewarpProgress) => void) => () => void
}

declare global {
  interface Window {
    serigraphica: SerigraphicaAPI
  }
}
