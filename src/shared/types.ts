export type Point = [number, number]

export type Quad = [Point, Point, Point, Point]

export type Role = 'outer' | 'inner'

export type Tool = 'pan' | 'paint-outer' | 'paint-inner'

export type Stroke = {
  points: Point[]
  radius: number
}

export type DetectResult = {
  corners: Quad
  imageWidth: number
  imageHeight: number
  confidence: number
}

export type Polyline = Point[]

export type SideFitDiagnostic = {
  state: 'fitted' | 'fallback'
  sampleCount: number
  maskHitSamples: number
  positiveSamples: number
  acceptedSamples: number
  edgeCoverage: number
  medianResponse: number
  responseFloor: number
  meanOffset: number
  maxOffset: number
  polynomialDegree?: number
  straightCenterPrior?: boolean
}

export type RectFitDiagnostics = {
  sides: [SideFitDiagnostic, SideFitDiagnostic, SideFitDiagnostic, SideFitDiagnostic]
  scale: number
  bandRadius: number
  cornerShifts?: [number, number, number, number]
}

export type RectShape = {
  corners: Quad
  // Four boundary polylines in order: top (TL→TR), right (TR→BR),
  // bottom (BR→BL), left (BL→TL). Each polyline starts at one corner
  // and ends at the next; the interior points capture curvature.
  sides: [Polyline, Polyline, Polyline, Polyline]
  diagnostics?: RectFitDiagnostics
}

export type DeriveResult = {
  outer: RectShape | null
  inner: RectShape | null
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
  restartFitEngine: () => Promise<{ ok: boolean }>
  detectOuterRect: (imagePath: string) => Promise<DetectResult>
  deriveFromStrokes: (
    imagePath: string,
    imageWidth: number,
    imageHeight: number,
    outerStrokes: Stroke[],
    innerStrokes: Stroke[]
  ) => Promise<DeriveResult>
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
