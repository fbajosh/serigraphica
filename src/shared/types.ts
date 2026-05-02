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

export type RectShape = {
  corners: Quad
  // Four boundary polylines in order: top (TL→TR), right (TR→BR),
  // bottom (BR→BL), left (BL→TL). Each polyline starts at one corner
  // and ends at the next; the interior points capture curvature.
  sides: [Polyline, Polyline, Polyline, Polyline]
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

export type SerigraphicaAPI = {
  openImage: () => Promise<{ path: string; width: number; height: number; dataUrl: string } | null>
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
