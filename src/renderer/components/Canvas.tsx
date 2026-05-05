import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { BezierNode, Point, RectPath, Role, Tool } from '../../shared/types'

const NODE_RADIUS = 7 // screen px
const NODE_HIT_RADIUS = 12 // screen px
const HANDLE_RADIUS = 5 // screen px
const HANDLE_HIT_RADIUS = 10 // screen px
const SEGMENT_HIT_RADIUS = 9 // screen px
const CURVE_SAMPLE_STEPS = 36
const DEFAULT_HANDLE_LENGTH = 60 // image px
const MESH_CURVE_SAMPLE_STEPS = 18
const MESH_CONSTRAINT_STEPS = 8
const INVERSE_MESH_COLOR = 'inverse'
const INVERSE_FALLBACK_COLOR = '#4de8ff'
const COLOR_SAMPLE_MAX_DIM = 720

const COLORS: Record<Role, { stroke: string; fill: string; guide: string }> = {
  outer: { stroke: '#ff5e5e', fill: 'rgba(255, 94, 94, 0.08)', guide: 'rgba(255, 94, 94, 0.42)' },
  inner: { stroke: '#4ea1ff', fill: 'rgba(78, 161, 255, 0.08)', guide: 'rgba(78, 161, 255, 0.42)' }
}
const HALO_COLOR = 'rgba(0, 0, 0, 0.85)'
const SIDE_NODE_COLOR = '#f4d35e'

type Props = {
  src: string
  imageWidth: number
  imageHeight: number
  tool: Tool
  outerPath: RectPath | null
  innerPath: RectPath | null
  outerDraft: Point[]
  innerDraft: Point[]
  hideGuides: boolean
  showMesh: boolean
  meshDivisions: number
  meshColor: string
  onViewChange: (zoom: number) => void
  onAppendCorner: (role: Role, point: Point) => void
  onNodeChange: (role: Role, index: number, point: Point) => void
  onHandleChange: (role: Role, index: number, handle: Point) => void
  onInsertNode: (role: Role, segmentIndex: number, node: BezierNode) => void
}

export type CanvasHandle = {
  fitToView: () => void
  zoomToActualSize: () => void
}

type View = { tx: number; ty: number; scale: number }

type Drag =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'node'; role: Role; index: number }
  | { kind: 'handle'; role: Role; index: number; side: 'in' | 'out' }
  | null

type HoverSegment = { role: Role; index: number; point: Point; tangent: Point } | null

function roleFromTool(tool: Tool): Role | null {
  if (tool === 'pen-outer') return 'outer'
  if (tool === 'pen-inner') return 'inner'
  return null
}

function add(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1]]
}

function sub(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]]
}

function mul(a: Point, scalar: number): Point {
  return [a[0] * scalar, a[1] * scalar]
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function clampPoint(p: Point, width: number, height: number): Point {
  return [
    Math.max(0, Math.min(width, p[0])),
    Math.max(0, Math.min(height, p[1]))
  ]
}

function nodeOutHandle(node: BezierNode): Point {
  return node.corner ? node.point : add(node.point, node.handle)
}

function nodeInHandle(node: BezierNode): Point {
  return node.corner ? node.point : sub(node.point, node.handle)
}

function cubicPoint(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const mt = 1 - t
  const mt2 = mt * mt
  const t2 = t * t
  return [
    mt2 * mt * a[0] + 3 * mt2 * t * b[0] + 3 * mt * t2 * c[0] + t2 * t * d[0],
    mt2 * mt * a[1] + 3 * mt2 * t * b[1] + 3 * mt * t2 * c[1] + t2 * t * d[1]
  ]
}

function cubicTangent(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const mt = 1 - t
  return [
    3 * mt * mt * (b[0] - a[0]) + 6 * mt * t * (c[0] - b[0]) + 3 * t * t * (d[0] - c[0]),
    3 * mt * mt * (b[1] - a[1]) + 6 * mt * t * (c[1] - b[1]) + 3 * t * t * (d[1] - c[1])
  ]
}

function closestPointOnSegment(p: Point, a: Point, b: Point): { point: Point; t: number; distance: number } {
  const ab = sub(b, a)
  const len2 = ab[0] * ab[0] + ab[1] * ab[1]
  const t = len2 <= 1e-6 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2))
  const point = add(a, mul(ab, t))
  return { point, t, distance: distance(p, point) }
}

function defaultNodeHandle(tangent: Point): Point {
  const len = Math.hypot(tangent[0], tangent[1])
  if (len < 1e-6) return [0, 0]
  return [
    (tangent[0] / len) * DEFAULT_HANDLE_LENGTH,
    (tangent[1] / len) * DEFAULT_HANDLE_LENGTH
  ]
}

function lerp(a: Point, b: Point, t: number): Point {
  return [
    a[0] * (1 - t) + b[0] * t,
    a[1] * (1 - t) + b[1] * t
  ]
}

function pathSegmentPoint(path: RectPath, index: number, t: number): Point {
  const a = path.nodes[index]
  const b = path.nodes[(index + 1) % path.nodes.length]
  return cubicPoint(a.point, nodeOutHandle(a), nodeInHandle(b), b.point, t)
}

function sideSegmentIndices(path: RectPath, sideIndex: number): number[] {
  const start = path.cornerIndices[sideIndex]
  const end = path.cornerIndices[(sideIndex + 1) % 4]
  const out: number[] = []
  let index = start
  for (let guard = 0; guard < path.nodes.length; guard++) {
    out.push(index)
    index = (index + 1) % path.nodes.length
    if (index === end) break
  }
  return out
}

function pointOnSide(path: RectPath, sideIndex: number, t: number): Point {
  const segments = sideSegmentIndices(path, sideIndex)
  if (segments.length === 0) return path.nodes[path.cornerIndices[sideIndex]].point
  const samples: { point: Point; length: number }[] = []
  let previous = pathSegmentPoint(path, segments[0], 0)
  let total = 0
  samples.push({ point: previous, length: 0 })
  for (const segmentIndex of segments) {
    for (let step = 1; step <= MESH_CURVE_SAMPLE_STEPS; step++) {
      const point = pathSegmentPoint(path, segmentIndex, step / MESH_CURVE_SAMPLE_STEPS)
      total += distance(previous, point)
      samples.push({ point, length: total })
      previous = point
    }
  }
  if (total <= 1e-6) return samples[0].point
  const target = total * Math.max(0, Math.min(1, t))
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].length < target) continue
    const prev = samples[i - 1]
    const cur = samples[i]
    const span = cur.length - prev.length
    const localT = span <= 1e-6 ? 0 : (target - prev.length) / span
    return lerp(prev.point, cur.point, localT)
  }
  return samples[samples.length - 1].point
}

function coonsPoint(path: RectPath, u: number, v: number): Point {
  const tl = path.nodes[path.cornerIndices[0]].point
  const tr = path.nodes[path.cornerIndices[1]].point
  const br = path.nodes[path.cornerIndices[2]].point
  const bl = path.nodes[path.cornerIndices[3]].point
  const top = pointOnSide(path, 0, u)
  const right = pointOnSide(path, 1, v)
  const bottom = pointOnSide(path, 2, 1 - u)
  const left = pointOnSide(path, 3, 1 - v)

  const edgeBlend = add(lerp(top, bottom, v), lerp(left, right, u))
  const cornerBlend = add(
    add(mul(tl, (1 - u) * (1 - v)), mul(tr, u * (1 - v))),
    add(mul(br, u * v), mul(bl, (1 - u) * v))
  )
  return sub(edgeBlend, cornerBlend)
}

function pathCornerPoint(path: RectPath, index: number): Point {
  return path.nodes[path.cornerIndices[index]].point
}

type Boundary = (t: number) => Point

type MeshLayout = {
  width: number
  height: number
  innerX0: number
  innerX1: number
  innerY0: number
  innerY1: number
}

type TpsModel = {
  targets: Point[]
  xWeights: number[]
  yWeights: number[]
}

function averageBoundaryDistance(a: Boundary, b: Boundary): number {
  let total = 0
  for (let i = 0; i <= MESH_CONSTRAINT_STEPS; i++) {
    const t = i / MESH_CONSTRAINT_STEPS
    total += distance(a(t), b(t))
  }
  return total / (MESH_CONSTRAINT_STEPS + 1)
}

function boundaryLength(boundary: Boundary): number {
  let total = 0
  let previous = boundary(0)
  for (let i = 1; i <= MESH_CONSTRAINT_STEPS * 3; i++) {
    const point = boundary(i / (MESH_CONSTRAINT_STEPS * 3))
    total += distance(previous, point)
    previous = point
  }
  return total
}

function meshLayoutForBoundaries(
  outerTop: Boundary,
  outerRight: Boundary,
  outerBottom: Boundary,
  outerLeft: Boundary,
  innerTop: Boundary,
  innerRight: Boundary,
  innerBottom: Boundary,
  innerLeft: Boundary
): MeshLayout {
  const innerWidth = Math.max(1, (boundaryLength(innerTop) + boundaryLength(innerBottom)) / 2)
  const innerHeight = Math.max(1, (boundaryLength(innerLeft) + boundaryLength(innerRight)) / 2)
  const minGap = Math.max(12, Math.min(innerWidth, innerHeight) * 0.04)
  const leftGap = Math.max(minGap, averageBoundaryDistance(outerLeft, innerLeft))
  const rightGap = Math.max(minGap, averageBoundaryDistance(outerRight, innerRight))
  const topGap = Math.max(minGap, averageBoundaryDistance(outerTop, innerTop))
  const bottomGap = Math.max(minGap, averageBoundaryDistance(outerBottom, innerBottom))
  return {
    width: leftGap + innerWidth + rightGap,
    height: topGap + innerHeight + bottomGap,
    innerX0: leftGap,
    innerX1: leftGap + innerWidth,
    innerY0: topGap,
    innerY1: topGap + innerHeight
  }
}

function tpsKernel(a: Point, b: Point): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const r2 = dx * dx + dy * dy
  return r2 <= 1e-9 ? 0 : r2 * Math.log(r2)
}

function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length
  const rows = matrix.map((row, i) => [...row, rhs[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row
    }
    if (Math.abs(rows[pivot][col]) < 1e-8) return null
    if (pivot !== col) {
      const tmp = rows[col]
      rows[col] = rows[pivot]
      rows[pivot] = tmp
    }
    const divisor = rows[col][col]
    for (let j = col; j <= n; j++) rows[col][j] /= divisor
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = rows[row][col]
      if (Math.abs(factor) < 1e-12) continue
      for (let j = col; j <= n; j++) rows[row][j] -= factor * rows[col][j]
    }
  }
  return rows.map((row) => row[n])
}

function buildTpsModel(targets: Point[], sources: Point[]): TpsModel | null {
  const n = targets.length
  if (n < 4 || n !== sources.length) return null
  const size = n + 3
  const matrix = Array.from({ length: size }, () => Array(size).fill(0))
  const scale = Math.max(
    1,
    ...targets.map((point) => Math.hypot(point[0], point[1]))
  )
  const regularization = scale * scale * 1e-7

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) matrix[i][j] = tpsKernel(targets[i], targets[j])
    matrix[i][i] += regularization
    matrix[i][n] = 1
    matrix[i][n + 1] = targets[i][0]
    matrix[i][n + 2] = targets[i][1]
    matrix[n][i] = 1
    matrix[n + 1][i] = targets[i][0]
    matrix[n + 2][i] = targets[i][1]
  }

  const rhsX = Array(size).fill(0)
  const rhsY = Array(size).fill(0)
  for (let i = 0; i < n; i++) {
    rhsX[i] = sources[i][0]
    rhsY[i] = sources[i][1]
  }
  const xWeights = solveLinearSystem(matrix, rhsX)
  const yWeights = solveLinearSystem(matrix, rhsY)
  if (!xWeights || !yWeights) return null
  return { targets, xWeights, yWeights }
}

function transformTps(model: TpsModel, point: Point): Point {
  const n = model.targets.length
  let x = model.xWeights[n] + model.xWeights[n + 1] * point[0] + model.xWeights[n + 2] * point[1]
  let y = model.yWeights[n] + model.yWeights[n + 1] * point[0] + model.yWeights[n + 2] * point[1]
  for (let i = 0; i < n; i++) {
    const k = tpsKernel(point, model.targets[i])
    x += model.xWeights[i] * k
    y += model.yWeights[i] * k
  }
  return [x, y]
}

function drawScaledPath(ctx: CanvasRenderingContext2D, path: RectPath, scale: number) {
  const first = path.nodes[0]
  ctx.beginPath()
  ctx.moveTo(first.point[0] * scale, first.point[1] * scale)
  for (let i = 0; i < path.nodes.length; i++) {
    const a = path.nodes[i]
    const b = path.nodes[(i + 1) % path.nodes.length]
    const cp1 = nodeOutHandle(a)
    const cp2 = nodeInHandle(b)
    ctx.bezierCurveTo(
      cp1[0] * scale,
      cp1[1] * scale,
      cp2[0] * scale,
      cp2[1] * scale,
      b.point[0] * scale,
      b.point[1] * scale
    )
  }
  ctx.closePath()
}

function pathCacheKey(path: RectPath): string {
  return path.nodes
    .map((node) => `${node.corner ? 'c' : 's'}:${node.point[0].toFixed(1)},${node.point[1].toFixed(1)},${node.handle[0].toFixed(1)},${node.handle[1].toFixed(1)}`)
    .join('|')
}

function inverseInnerAverageColor(
  img: HTMLImageElement,
  innerPath: RectPath | null,
  imageWidth: number,
  imageHeight: number
): string {
  if (!innerPath || innerPath.nodes.length < 4) return INVERSE_FALLBACK_COLOR
  const scale = Math.min(1, COLOR_SAMPLE_MAX_DIM / Math.max(imageWidth, imageHeight))
  const width = Math.max(1, Math.round(imageWidth * scale))
  const height = Math.max(1, Math.round(imageHeight * scale))
  const imageCanvas = document.createElement('canvas')
  imageCanvas.width = width
  imageCanvas.height = height
  const imageCtx = imageCanvas.getContext('2d', { willReadFrequently: true })
  if (!imageCtx) return INVERSE_FALLBACK_COLOR
  imageCtx.drawImage(img, 0, 0, width, height)

  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = width
  maskCanvas.height = height
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (!maskCtx) return INVERSE_FALLBACK_COLOR
  maskCtx.fillStyle = '#fff'
  drawScaledPath(maskCtx, innerPath, scale)
  maskCtx.fill()

  try {
    const imageData = imageCtx.getImageData(0, 0, width, height).data
    const maskData = maskCtx.getImageData(0, 0, width, height).data
    let r = 0
    let g = 0
    let b = 0
    let weight = 0
    for (let i = 0; i < imageData.length; i += 4) {
      const alpha = maskData[i + 3] / 255
      if (alpha <= 0) continue
      r += imageData[i] * alpha
      g += imageData[i + 1] * alpha
      b += imageData[i + 2] * alpha
      weight += alpha
    }
    if (weight <= 0) return INVERSE_FALLBACK_COLOR
    return `rgb(${Math.round(255 - r / weight)}, ${Math.round(255 - g / weight)}, ${Math.round(255 - b / weight)})`
  } catch {
    return INVERSE_FALLBACK_COLOR
  }
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  {
    src,
    imageWidth,
    imageHeight,
    tool,
    outerPath,
    innerPath,
    outerDraft,
    innerDraft,
    hideGuides,
    showMesh,
    meshDivisions,
    meshColor,
    onViewChange,
    onAppendCorner,
    onNodeChange,
    onHandleChange,
    onInsertNode
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const viewRef = useRef<View>({ tx: 0, ty: 0, scale: 1 })
  const dragRef = useRef<Drag>(null)
  const hoverSegmentRef = useRef<HoverSegment>(null)
  const drawScheduledRef = useRef(false)
  const drawRef = useRef<() => void>(() => {})
  const inverseColorRef = useRef<{ key: string; color: string } | null>(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [imageReady, setImageReady] = useState(false)

  const propsRef = useRef({ tool, outerPath, innerPath, outerDraft, innerDraft, hideGuides, showMesh, meshDivisions, meshColor })
  propsRef.current = { tool, outerPath, innerPath, outerDraft, innerDraft, hideGuides, showMesh, meshDivisions, meshColor }

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect
      setContainerSize({ w: cr.width, h: cr.height })
    })
    ro.observe(el)
    setContainerSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    setImageReady(false)
    const img = new Image()
    img.src = src
    img.onload = () => {
      imageRef.current = img
      setImageReady(true)
    }
    img.onerror = (err) => console.error('image load error', err)
    return () => {
      imageRef.current = null
    }
  }, [src])

  const requestDraw = useCallback(() => {
    if (drawScheduledRef.current) return
    drawScheduledRef.current = true
    requestAnimationFrame(() => drawRef.current())
  }, [])

  const fitToView = useCallback(() => {
    const { w, h } = containerSize
    if (w === 0 || h === 0) return
    const padding = 24
    const sx = (w - padding * 2) / imageWidth
    const sy = (h - padding * 2) / imageHeight
    const scale = Math.min(sx, sy)
    viewRef.current = {
      scale,
      tx: (w - imageWidth * scale) / 2,
      ty: (h - imageHeight * scale) / 2
    }
    onViewChange(scale)
    requestDraw()
  }, [containerSize, imageWidth, imageHeight, onViewChange, requestDraw])

  const zoomToActualSize = useCallback(() => {
    const { w, h } = containerSize
    viewRef.current = {
      scale: 1,
      tx: (w - imageWidth) / 2,
      ty: (h - imageHeight) / 2
    }
    onViewChange(1)
    requestDraw()
  }, [containerSize, imageWidth, imageHeight, onViewChange, requestDraw])

  useEffect(() => {
    if (imageReady && containerSize.w > 0) fitToView()
  }, [imageReady, containerSize.w, containerSize.h, fitToView])

  useImperativeHandle(ref, () => ({ fitToView, zoomToActualSize }), [fitToView, zoomToActualSize])

  const imageToScreen = useCallback((ix: number, iy: number): Point => {
    const { tx, ty, scale } = viewRef.current
    return [ix * scale + tx, iy * scale + ty]
  }, [])

  const screenToImage = useCallback((sx: number, sy: number): Point => {
    const { tx, ty, scale } = viewRef.current
    return [(sx - tx) / scale, (sy - ty) / scale]
  }, [])

  const pathForRole = useCallback((role: Role): RectPath | null => {
    return role === 'outer' ? propsRef.current.outerPath : propsRef.current.innerPath
  }, [])

  const drawPath = useCallback(
    (ctx: CanvasRenderingContext2D, path: RectPath, role: Role, activeRole: Role | null, alpha = 1) => {
      const { tx, ty, scale } = viewRef.current
      const color = COLORS[role]
      const active = activeRole === role
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.beginPath()
      const first = path.nodes[0]
      ctx.moveTo(first.point[0] * scale + tx, first.point[1] * scale + ty)
      for (let i = 0; i < path.nodes.length; i++) {
        const a = path.nodes[i]
        const b = path.nodes[(i + 1) % path.nodes.length]
        const cp1 = nodeOutHandle(a)
        const cp2 = nodeInHandle(b)
        ctx.bezierCurveTo(
          cp1[0] * scale + tx,
          cp1[1] * scale + ty,
          cp2[0] * scale + tx,
          cp2[1] * scale + ty,
          b.point[0] * scale + tx,
          b.point[1] * scale + ty
        )
      }
      ctx.closePath()
      ctx.fillStyle = color.fill
      ctx.fill()
      ctx.lineJoin = 'round'
      ctx.strokeStyle = HALO_COLOR
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.strokeStyle = color.stroke
      ctx.lineWidth = 2
      ctx.stroke()

      if (active && !hideGuides) {
        for (const node of path.nodes) {
          if (node.corner) continue
          const p = imageToScreen(node.point[0], node.point[1])
          const out = imageToScreen(node.point[0] + node.handle[0], node.point[1] + node.handle[1])
          const inn = imageToScreen(node.point[0] - node.handle[0], node.point[1] - node.handle[1])
          ctx.strokeStyle = color.guide
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(inn[0], inn[1])
          ctx.lineTo(out[0], out[1])
          ctx.stroke()
          for (const h of [inn, out]) {
            ctx.beginPath()
            ctx.arc(h[0], h[1], HANDLE_RADIUS + 2, 0, Math.PI * 2)
            ctx.fillStyle = HALO_COLOR
            ctx.fill()
            ctx.beginPath()
            ctx.arc(h[0], h[1], HANDLE_RADIUS, 0, Math.PI * 2)
            ctx.fillStyle = '#fff3a0'
            ctx.fill()
            ctx.strokeStyle = '#1a1a1a'
            ctx.lineWidth = 1
            ctx.stroke()
          }
          ctx.beginPath()
          ctx.arc(p[0], p[1], 2, 0, Math.PI * 2)
          ctx.fillStyle = color.stroke
          ctx.fill()
        }
      }

      for (const node of path.nodes) {
        const [sx, sy] = imageToScreen(node.point[0], node.point[1])
        const radius = node.corner ? NODE_RADIUS : NODE_RADIUS - 1
        ctx.beginPath()
        ctx.arc(sx, sy, radius + 2, 0, Math.PI * 2)
        ctx.fillStyle = HALO_COLOR
        ctx.fill()
        ctx.beginPath()
        ctx.arc(sx, sy, radius, 0, Math.PI * 2)
        ctx.fillStyle = node.corner ? color.stroke : SIDE_NODE_COLOR
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.4
        ctx.stroke()
      }
      ctx.restore()
    },
    [hideGuides, imageToScreen]
  )

  const drawProjectedMesh = useCallback((ctx: CanvasRenderingContext2D, outer: RectPath, inner: RectPath, divisions: number, color: string) => {
    const safeDivisions = Math.max(2, Math.min(40, Math.round(divisions)))
    ctx.save()
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.72
    ctx.strokeStyle = color
    ctx.setLineDash([5, 5])

    const drawMeshLine = (points: Point[]) => {
      ctx.beginPath()
      points.forEach((point, index) => {
        const [sx, sy] = imageToScreen(point[0], point[1])
        if (index === 0) ctx.moveTo(sx, sy)
        else ctx.lineTo(sx, sy)
      })
      ctx.stroke()
    }

    const outerTop: Boundary = (u) => pointOnSide(outer, 0, u)
    const outerRight: Boundary = (v) => pointOnSide(outer, 1, v)
    const outerBottom: Boundary = (u) => pointOnSide(outer, 2, 1 - u)
    const outerLeft: Boundary = (v) => pointOnSide(outer, 3, 1 - v)
    const innerTop: Boundary = (u) => pointOnSide(inner, 0, u)
    const innerRight: Boundary = (v) => pointOnSide(inner, 1, v)
    const innerBottom: Boundary = (u) => pointOnSide(inner, 2, 1 - u)
    const innerLeft: Boundary = (v) => pointOnSide(inner, 3, 1 - v)
    const layout = meshLayoutForBoundaries(
      outerTop,
      outerRight,
      outerBottom,
      outerLeft,
      innerTop,
      innerRight,
      innerBottom,
      innerLeft
    )

    const targets: Point[] = []
    const sources: Point[] = []
    const seen = new Set<string>()
    const addConstraint = (target: Point, source: Point) => {
      const key = `${target[0].toFixed(3)},${target[1].toFixed(3)}`
      if (seen.has(key)) return
      seen.add(key)
      targets.push(target)
      sources.push(source)
    }
    for (let i = 0; i <= MESH_CONSTRAINT_STEPS; i++) {
      const t = i / MESH_CONSTRAINT_STEPS
      addConstraint([layout.width * t, 0], outerTop(t))
      addConstraint([layout.width, layout.height * t], outerRight(t))
      addConstraint([layout.width * t, layout.height], outerBottom(t))
      addConstraint([0, layout.height * t], outerLeft(t))
      addConstraint([lerp([layout.innerX0, 0], [layout.innerX1, 0], t)[0], layout.innerY0], innerTop(t))
      addConstraint([layout.innerX1, lerp([0, layout.innerY0], [0, layout.innerY1], t)[1]], innerRight(t))
      addConstraint([lerp([layout.innerX0, 0], [layout.innerX1, 0], t)[0], layout.innerY1], innerBottom(t))
      addConstraint([layout.innerX0, lerp([0, layout.innerY0], [0, layout.innerY1], t)[1]], innerLeft(t))
    }
    const model = buildTpsModel(targets, sources)
    if (!model) {
      ctx.restore()
      return
    }

    const addUnique = (values: number[], value: number) => {
      if (!values.some((existing) => Math.abs(existing - value) < 1e-6)) values.push(value)
    }
    const gridXs: number[] = []
    const gridYs: number[] = []
    for (let i = 0; i <= safeDivisions; i++) {
      gridXs.push((layout.width * i) / safeDivisions)
      gridYs.push((layout.height * i) / safeDivisions)
    }
    addUnique(gridXs, layout.innerX0)
    addUnique(gridXs, layout.innerX1)
    addUnique(gridYs, layout.innerY0)
    addUnique(gridYs, layout.innerY1)
    gridXs.sort((a, b) => a - b)
    gridYs.sort((a, b) => a - b)

    const lineSamples = Math.max(32, safeDivisions * 3)
    for (const x of gridXs) {
      const points: Point[] = []
      for (let i = 0; i <= lineSamples; i++) {
        points.push(transformTps(model, [x, (layout.height * i) / lineSamples]))
      }
      drawMeshLine(points)
    }
    for (const y of gridYs) {
      const points: Point[] = []
      for (let i = 0; i <= lineSamples; i++) {
        points.push(transformTps(model, [(layout.width * i) / lineSamples, y]))
      }
      drawMeshLine(points)
    }

    ctx.setLineDash([])
    ctx.globalAlpha = 0.95
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    const center = transformTps(model, [
      (layout.innerX0 + layout.innerX1) / 2,
      (layout.innerY0 + layout.innerY1) / 2
    ])
    const [cx, cy] = imageToScreen(center[0], center[1])
    ctx.beginPath()
    ctx.arc(cx, cy, 3, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
  }, [imageToScreen])

  const drawDraft = useCallback((ctx: CanvasRenderingContext2D, points: Point[], role: Role) => {
    if (points.length === 0) return
    const color = COLORS[role]
    ctx.save()
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = color.stroke
    ctx.lineWidth = 2
    ctx.beginPath()
    points.forEach((point, index) => {
      const [sx, sy] = imageToScreen(point[0], point[1])
      if (index === 0) ctx.moveTo(sx, sy)
      else ctx.lineTo(sx, sy)
    })
    ctx.stroke()
    ctx.setLineDash([])
    points.forEach((point, index) => {
      const [sx, sy] = imageToScreen(point[0], point[1])
      ctx.beginPath()
      ctx.arc(sx, sy, NODE_RADIUS + 2, 0, Math.PI * 2)
      ctx.fillStyle = HALO_COLOR
      ctx.fill()
      ctx.beginPath()
      ctx.arc(sx, sy, NODE_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = color.stroke
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = '10px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(index + 1), sx, sy)
    })
    ctx.restore()
  }, [imageToScreen])

  const draw = useCallback(() => {
    drawScheduledRef.current = false
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const { w, h } = containerSize
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0e0e0e'
    ctx.fillRect(0, 0, w, h)

    const { tx, ty, scale } = viewRef.current
    if (img) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, tx, ty, imageWidth * scale, imageHeight * scale)
    }

    const {
      tool: curTool,
      outerPath: op,
      innerPath: ip,
      outerDraft: od,
      innerDraft: id,
      showMesh: meshVisible,
      meshDivisions: curMeshDivisions,
      meshColor: curMeshColor
    } = propsRef.current
    const activeRole = roleFromTool(curTool)
    if (op && ip && meshVisible) {
      let effectiveMeshColor = curMeshColor
      if (curMeshColor === INVERSE_MESH_COLOR && img) {
        const key = `${src}|${imageWidth}x${imageHeight}|${ip ? pathCacheKey(ip) : 'no-inner'}`
        if (inverseColorRef.current?.key !== key) {
          inverseColorRef.current = {
            key,
            color: inverseInnerAverageColor(img, ip, imageWidth, imageHeight)
          }
        }
        effectiveMeshColor = inverseColorRef.current.color
      }
      drawProjectedMesh(ctx, op, ip, curMeshDivisions, effectiveMeshColor)
    }
    if (op) drawPath(ctx, op, 'outer', activeRole, 1)
    if (ip) drawPath(ctx, ip, 'inner', activeRole, 1)
    drawDraft(ctx, od, 'outer')
    drawDraft(ctx, id, 'inner')

    const hover = hoverSegmentRef.current
    if (hover && activeRole === hover.role) {
      const [sx, sy] = imageToScreen(hover.point[0], hover.point[1])
      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, NODE_RADIUS + 3, 0, Math.PI * 2)
      ctx.fillStyle = HALO_COLOR
      ctx.fill()
      ctx.beginPath()
      ctx.arc(sx, sy, NODE_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = SIDE_NODE_COLOR
      ctx.fill()
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.strokeStyle = '#111'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(sx - 4, sy)
      ctx.lineTo(sx + 4, sy)
      ctx.moveTo(sx, sy - 4)
      ctx.lineTo(sx, sy + 4)
      ctx.stroke()
      ctx.restore()
    }
  }, [containerSize, drawDraft, drawPath, drawProjectedMesh, imageHeight, imageToScreen, imageWidth])
  drawRef.current = draw

  useEffect(() => {
    requestDraw()
  }, [containerSize, imageReady, outerPath, innerPath, outerDraft, innerDraft, tool, hideGuides, showMesh, meshDivisions, meshColor, requestDraw])

  const findSegmentHit = useCallback((role: Role, screenPoint: Point): HoverSegment => {
    const path = pathForRole(role)
    if (!path) return null
    let best: HoverSegment = null
    let bestDistance = SEGMENT_HIT_RADIUS
    for (let i = 0; i < path.nodes.length; i++) {
      const a = path.nodes[i]
      const b = path.nodes[(i + 1) % path.nodes.length]
      const cp1 = nodeOutHandle(a)
      const cp2 = nodeInHandle(b)
      let prev = imageToScreen(a.point[0], a.point[1])
      for (let step = 1; step <= CURVE_SAMPLE_STEPS; step++) {
        const t = step / CURVE_SAMPLE_STEPS
        const imagePoint = cubicPoint(a.point, cp1, cp2, b.point, t)
        const cur = imageToScreen(imagePoint[0], imagePoint[1])
        const hit = closestPointOnSegment(screenPoint, prev, cur)
        if (hit.distance < bestDistance) {
          const sampleT = (step - 1 + hit.t) / CURVE_SAMPLE_STEPS
          const point = cubicPoint(a.point, cp1, cp2, b.point, sampleT)
          const tangent = cubicTangent(a.point, cp1, cp2, b.point, sampleT)
          bestDistance = hit.distance
          best = { role, index: i, point, tangent }
        }
        prev = cur
      }
    }
    return best
  }, [imageToScreen, pathForRole])

  const findEditHit = useCallback((role: Role, screenPoint: Point): Drag => {
    const path = pathForRole(role)
    if (!path) return null
    for (let i = 0; i < path.nodes.length; i++) {
      const node = path.nodes[i]
      if (node.corner) continue
      const out = imageToScreen(node.point[0] + node.handle[0], node.point[1] + node.handle[1])
      const inn = imageToScreen(node.point[0] - node.handle[0], node.point[1] - node.handle[1])
      if (distance(screenPoint, out) <= HANDLE_HIT_RADIUS) return { kind: 'handle', role, index: i, side: 'out' }
      if (distance(screenPoint, inn) <= HANDLE_HIT_RADIUS) return { kind: 'handle', role, index: i, side: 'in' }
    }
    for (let i = 0; i < path.nodes.length; i++) {
      const node = path.nodes[i]
      const p = imageToScreen(node.point[0], node.point[1])
      if (distance(screenPoint, p) <= NODE_HIT_RADIUS) return { kind: 'node', role, index: i }
    }
    return null
  }, [imageToScreen, pathForRole])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const screenPoint: Point = [e.clientX - rect.left, e.clientY - rect.top]
      const activeRole = roleFromTool(tool)

      if (activeRole) {
        const editHit = findEditHit(activeRole, screenPoint)
        if (editHit) {
          dragRef.current = editHit
          canvas.setPointerCapture(e.pointerId)
          return
        }

        const path = pathForRole(activeRole)
        if (path) {
          const segmentHit = findSegmentHit(activeRole, screenPoint)
          if (segmentHit) {
            const node: BezierNode = {
              point: clampPoint(segmentHit.point, imageWidth, imageHeight),
              handle: defaultNodeHandle(segmentHit.tangent),
              corner: false
            }
            const insertAt = segmentHit.index === path.nodes.length - 1 ? path.nodes.length : segmentHit.index + 1
            onInsertNode(activeRole, segmentHit.index, node)
            dragRef.current = { kind: 'node', role: activeRole, index: insertAt }
            canvas.setPointerCapture(e.pointerId)
            requestDraw()
            return
          }
        } else {
          onAppendCorner(activeRole, clampPoint(screenToImage(screenPoint[0], screenPoint[1]), imageWidth, imageHeight))
          requestDraw()
          return
        }
      }

      dragRef.current = { kind: 'pan', lastX: screenPoint[0], lastY: screenPoint[1] }
      canvas.setPointerCapture(e.pointerId)
    },
    [
      findEditHit,
      findSegmentHit,
      imageHeight,
      imageWidth,
      onAppendCorner,
      onInsertNode,
      pathForRole,
      requestDraw,
      screenToImage,
      tool
    ]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const screenPoint: Point = [e.clientX - rect.left, e.clientY - rect.top]
      const drag = dragRef.current

      if (!drag) {
        const activeRole = roleFromTool(tool)
        const editHit = activeRole ? findEditHit(activeRole, screenPoint) : null
        const segmentHit = activeRole && !editHit ? findSegmentHit(activeRole, screenPoint) : null
        hoverSegmentRef.current = segmentHit
        if (editHit?.kind === 'node' || editHit?.kind === 'handle') canvas.style.cursor = 'grab'
        else if (segmentHit) canvas.style.cursor = 'copy'
        else if (activeRole && !pathForRole(activeRole)) canvas.style.cursor = 'crosshair'
        else canvas.style.cursor = tool === 'pan' ? 'grab' : 'default'
        requestDraw()
        return
      }

      hoverSegmentRef.current = null
      if (drag.kind === 'pan') {
        viewRef.current.tx += screenPoint[0] - drag.lastX
        viewRef.current.ty += screenPoint[1] - drag.lastY
        drag.lastX = screenPoint[0]
        drag.lastY = screenPoint[1]
        requestDraw()
        return
      }

      const imagePoint = clampPoint(screenToImage(screenPoint[0], screenPoint[1]), imageWidth, imageHeight)
      if (drag.kind === 'node') {
        onNodeChange(drag.role, drag.index, imagePoint)
        return
      }
      if (drag.kind === 'handle') {
        const path = pathForRole(drag.role)
        const node = path?.nodes[drag.index]
        if (!node) return
        const nextHandle = drag.side === 'out'
          ? sub(imagePoint, node.point)
          : sub(node.point, imagePoint)
        onHandleChange(drag.role, drag.index, nextHandle)
      }
    },
    [
      findEditHit,
      findSegmentHit,
      imageHeight,
      imageWidth,
      onHandleChange,
      onNodeChange,
      pathForRole,
      requestDraw,
      screenToImage,
      tool
    ]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      dragRef.current = null
      requestDraw()
    },
    [requestDraw]
  )

  const onPointerLeave = useCallback(() => {
    hoverSegmentRef.current = null
    requestDraw()
  }, [requestDraw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01)
        const v = viewRef.current
        const nextScale = Math.max(0.05, Math.min(20, v.scale * factor))
        const ix = (x - v.tx) / v.scale
        const iy = (y - v.ty) / v.scale
        v.scale = nextScale
        v.tx = x - ix * nextScale
        v.ty = y - iy * nextScale
        onViewChange(nextScale)
      } else {
        viewRef.current.tx -= e.deltaX
        viewRef.current.ty -= e.deltaY
      }
      requestDraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [onViewChange, requestDraw])

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        style={{ display: 'block', touchAction: 'none' }}
      />
    </div>
  )
})
