import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { BezierNode, Point, RectPath, Tool } from '../../shared/types'

const NODE_RADIUS = 7 // screen px
const NODE_HIT_RADIUS = 12 // screen px
const HANDLE_RADIUS = 5 // screen px
const HANDLE_HIT_RADIUS = 10 // screen px
const SEGMENT_HIT_RADIUS = 9 // screen px
const CURVE_SAMPLE_STEPS = 36
const DEFAULT_HANDLE_LENGTH = 60 // image px
const MESH_CURVE_SAMPLE_STEPS = 18
const INVERSE_MESH_COLOR = 'inverse'
const INVERSE_FALLBACK_COLOR = '#4de8ff'
const COLOR_SAMPLE_MAX_DIM = 720

const RECTANGLE_COLORS = ['#ff5e5e', '#4ea1ff', '#4de8ff', '#5ee05e', '#ffd84d', '#ff5cff'] as const
const HALO_COLOR = 'rgba(0, 0, 0, 0.85)'
const SIDE_NODE_COLOR = '#f4d35e'
const ACTIVE_EDGE_OFFSET = 4
const ACTIVE_EDGE_WIDTH = 1.4

type Props = {
  src: string
  imageWidth: number
  imageHeight: number
  tool: Tool
  rectangles: RectPath[]
  draft: Point[]
  activeRectangleIndex: number | null
  hideGuides: boolean
  showMesh: boolean
  meshDivisions: number
  meshColor: string
  onViewChange: (zoom: number) => void
  onAppendCorner: (point: Point) => void
  onNodeChange: (rectangleIndex: number, nodeIndex: number, point: Point) => void
  onHandleChange: (rectangleIndex: number, nodeIndex: number, handle: Point) => void
  onInsertNode: (rectangleIndex: number, segmentIndex: number, node: BezierNode) => void
  onDeleteNode: (rectangleIndex: number, nodeIndex: number) => void
  onActivateRectangle: (rectangleIndex: number) => void
}

export type CanvasHandle = {
  fitToView: () => void
  zoomToActualSize: () => void
}

type View = { tx: number; ty: number; scale: number }

type Drag =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'node'; rectangleIndex: number; nodeIndex: number }
  | { kind: 'handle'; rectangleIndex: number; nodeIndex: number; side: 'in' | 'out' }
  | null

type HoverSegment = { rectangleIndex: number; segmentIndex: number; point: Point; tangent: Point } | null

function isRectangleTool(tool: Tool): boolean {
  return tool === 'pen-rectangle'
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

function colorForRectangle(index: number, outerIndex: number | null): { stroke: string; guide: string } {
  const stroke = index < 0
    ? RECTANGLE_COLORS[1]
    : index === outerIndex
    ? RECTANGLE_COLORS[0]
    : RECTANGLE_COLORS[(index % (RECTANGLE_COLORS.length - 1)) + 1]
  const isOuter = index === outerIndex
  return {
    stroke,
    guide: isOuter ? 'rgba(255, 94, 94, 0.42)' : 'rgba(78, 161, 255, 0.42)'
  }
}

function pathArea(path: RectPath): number {
  const corners = path.cornerIndices.map((index) => path.nodes[index]?.point).filter(Boolean) as Point[]
  if (corners.length < 4) return 0
  let area = 0
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % corners.length]
    area += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(area) / 2
}

function deriveRectangleRoles(rectangles: RectPath[]): { outerIndex: number | null; outerPath: RectPath | null; innerPaths: RectPath[] } {
  if (rectangles.length === 0) return { outerIndex: null, outerPath: null, innerPaths: [] }
  const sorted = rectangles
    .map((path, index) => ({ path, index, area: pathArea(path) }))
    .sort((a, b) => b.area - a.area)
  return {
    outerIndex: sorted[0].index,
    outerPath: sorted[0].path,
    innerPaths: sorted.slice(1).map((entry) => entry.path)
  }
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

type BoundarySet = {
  top: Boundary
  right: Boundary
  bottom: Boundary
  left: Boundary
}

type CanonicalPath = {
  path: RectPath
  cornerNodeIndices: [number, number, number, number]
  corners: [Point, Point, Point, Point]
  boundaries: BoundarySet
}

type TargetRect = {
  path: CanonicalPath
  x0: number
  x1: number
  y0: number
  y1: number
}

type MeshLayout = {
  width: number
  height: number
  rects: TargetRect[]
  patches: MeshPatch[]
}

type MeshPatch = {
  target: [Point, Point, Point, Point]
  boundaries: BoundarySet
}

function boundaryLength(boundary: Boundary): number {
  let total = 0
  let previous = boundary(0)
  const steps = MESH_CURVE_SAMPLE_STEPS * 2
  for (let i = 1; i <= steps; i++) {
    const point = boundary(i / steps)
    total += distance(previous, point)
    previous = point
  }
  return total
}

function solveBasisParam(tl: Point, tr: Point, bl: Point, point: Point): Point {
  const ux = tr[0] - tl[0]
  const uy = tr[1] - tl[1]
  const vx = bl[0] - tl[0]
  const vy = bl[1] - tl[1]
  const px = point[0] - tl[0]
  const py = point[1] - tl[1]
  const det = ux * vy - uy * vx
  if (Math.abs(det) < 1e-6) return [0.5, 0.5]
  return [
    (px * vy - py * vx) / det,
    (ux * py - uy * px) / det
  ]
}

function pickCanonicalCornerIndices(path: RectPath, outer?: CanonicalPath): [number, number, number, number] {
  const entries = path.cornerIndices.map((nodeIndex) => {
    const point = path.nodes[nodeIndex].point
    const coord = outer
      ? solveBasisParam(outer.corners[0], outer.corners[1], outer.corners[3], point)
      : point
    return { nodeIndex, point, coord }
  })
  const pick = (score: (entry: typeof entries[number]) => number, reverse = false) => {
    return entries.reduce((best, entry) => {
      const current = score(entry)
      const previous = score(best)
      return reverse ? (current > previous ? entry : best) : (current < previous ? entry : best)
    }).nodeIndex
  }
  const ordered = [
    pick((entry) => entry.coord[0] + entry.coord[1]),
    pick((entry) => entry.coord[0] - entry.coord[1], true),
    pick((entry) => entry.coord[0] + entry.coord[1], true),
    pick((entry) => entry.coord[0] - entry.coord[1])
  ] as [number, number, number, number]
  if (new Set(ordered).size === 4) return ordered

  const center = entries.reduce<Point>((acc, entry) => add(acc, entry.coord), [0, 0])
  center[0] /= entries.length
  center[1] /= entries.length
  const byAngle = [...entries].sort((a, b) => (
    Math.atan2(a.coord[1] - center[1], a.coord[0] - center[0]) -
    Math.atan2(b.coord[1] - center[1], b.coord[0] - center[0])
  ))
  const startIndex = byAngle.reduce((bestIndex, entry, index) => {
    const best = byAngle[bestIndex]
    return entry.coord[0] + entry.coord[1] < best.coord[0] + best.coord[1] ? index : bestIndex
  }, 0)
  const rotated = [...byAngle.slice(startIndex), ...byAngle.slice(0, startIndex)].map((entry) => entry.nodeIndex)
  return rotated as [number, number, number, number]
}

function pathSegmentPointDirected(path: RectPath, index: number, direction: 1 | -1, t: number): Point {
  if (direction === 1) return pathSegmentPoint(path, index, t)
  const prevIndex = (index - 1 + path.nodes.length) % path.nodes.length
  return pathSegmentPoint(path, prevIndex, 1 - t)
}

function directedRouteLength(path: RectPath, startIndex: number, endIndex: number, direction: 1 | -1): number {
  let total = 0
  let index = startIndex
  let previous = pathSegmentPointDirected(path, index, direction, 0)
  for (let guard = 0; guard < path.nodes.length; guard++) {
    for (let step = 1; step <= MESH_CURVE_SAMPLE_STEPS; step++) {
      const point = pathSegmentPointDirected(path, index, direction, step / MESH_CURVE_SAMPLE_STEPS)
      total += distance(previous, point)
      previous = point
    }
    index = (index + direction + path.nodes.length) % path.nodes.length
    if (index === endIndex) break
  }
  return total
}

function routeBoundary(path: RectPath, startIndex: number, endIndex: number): Boundary {
  const forwardLength = directedRouteLength(path, startIndex, endIndex, 1)
  const reverseLength = directedRouteLength(path, startIndex, endIndex, -1)
  const direction: 1 | -1 = forwardLength <= reverseLength ? 1 : -1
  return (t: number) => {
    const samples: { point: Point; length: number }[] = []
    let total = 0
    let index = startIndex
    let previous = pathSegmentPointDirected(path, index, direction, 0)
    samples.push({ point: previous, length: 0 })
    for (let guard = 0; guard < path.nodes.length; guard++) {
      for (let step = 1; step <= MESH_CURVE_SAMPLE_STEPS; step++) {
        const point = pathSegmentPointDirected(path, index, direction, step / MESH_CURVE_SAMPLE_STEPS)
        total += distance(previous, point)
        samples.push({ point, length: total })
        previous = point
      }
      index = (index + direction + path.nodes.length) % path.nodes.length
      if (index === endIndex) break
    }
    if (total <= 1e-6) return samples[0].point
    const target = total * Math.max(0, Math.min(1, t))
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].length < target) continue
      const prev = samples[i - 1]
      const cur = samples[i]
      const span = cur.length - prev.length
      return lerp(prev.point, cur.point, span <= 1e-6 ? 0 : (target - prev.length) / span)
    }
    return samples[samples.length - 1].point
  }
}

function canonicalizePath(path: RectPath, outer?: CanonicalPath): CanonicalPath {
  const cornerNodeIndices = pickCanonicalCornerIndices(path, outer)
  const corners = cornerNodeIndices.map((index) => path.nodes[index].point) as [Point, Point, Point, Point]
  const boundaries = {
    top: routeBoundary(path, cornerNodeIndices[0], cornerNodeIndices[1]),
    right: routeBoundary(path, cornerNodeIndices[1], cornerNodeIndices[2]),
    bottom: routeBoundary(path, cornerNodeIndices[3], cornerNodeIndices[2]),
    left: routeBoundary(path, cornerNodeIndices[0], cornerNodeIndices[3])
  }
  return { path, cornerNodeIndices, corners, boundaries }
}

function rectCorners(rect: TargetRect): [Point, Point, Point, Point] {
  return [
    [rect.x0, rect.y0],
    [rect.x1, rect.y0],
    [rect.x1, rect.y1],
    [rect.x0, rect.y1]
  ]
}

function connectionBoundary(a: Point, b: Point): Boundary {
  return (t) => lerp(a, b, t)
}

function makePatch(target: [Point, Point, Point, Point], boundaries: BoundarySet): MeshPatch {
  return { target, boundaries }
}

function buildBandPatches(parent: TargetRect, child: TargetRect): MeshPatch[] {
  const [ptl, ptr, pbr, pbl] = rectCorners(parent)
  const [ctl, ctr, cbr, cbl] = rectCorners(child)
  const p = parent.path
  const c = child.path
  return [
    makePatch([ptl, ptr, ctr, ctl], {
      top: p.boundaries.top,
      right: connectionBoundary(p.corners[1], c.corners[1]),
      bottom: c.boundaries.top,
      left: connectionBoundary(p.corners[0], c.corners[0])
    }),
    makePatch([ptr, pbr, cbr, ctr], {
      top: p.boundaries.right,
      right: connectionBoundary(p.corners[2], c.corners[2]),
      bottom: c.boundaries.right,
      left: connectionBoundary(p.corners[1], c.corners[1])
    }),
    makePatch([pbl, pbr, cbr, cbl], {
      top: p.boundaries.bottom,
      right: connectionBoundary(p.corners[2], c.corners[2]),
      bottom: c.boundaries.bottom,
      left: connectionBoundary(p.corners[3], c.corners[3])
    }),
    makePatch([ptl, pbl, cbl, ctl], {
      top: p.boundaries.left,
      right: connectionBoundary(p.corners[3], c.corners[3]),
      bottom: c.boundaries.left,
      left: connectionBoundary(p.corners[0], c.corners[0])
    })
  ]
}

function buildNestedMeshLayout(outerPath: RectPath, innerPaths: RectPath[]): MeshLayout {
  const outer = canonicalizePath(outerPath)
  const width = Math.max(1, (boundaryLength(outer.boundaries.top) + boundaryLength(outer.boundaries.bottom)) / 2)
  const height = Math.max(1, (boundaryLength(outer.boundaries.left) + boundaryLength(outer.boundaries.right)) / 2)
  const minGap = Math.max(8, Math.min(width, height) * 0.025)
  const sortedInnerPaths = [...innerPaths].sort((a, b) => pathArea(b) - pathArea(a))
  const outerRect: TargetRect = { path: outer, x0: 0, y0: 0, x1: width, y1: height }
  const rects: TargetRect[] = [outerRect]

  for (const path of sortedInnerPaths) {
    const canonical = canonicalizePath(path, outer)
    const measuredWidth = Math.max(1, (boundaryLength(canonical.boundaries.top) + boundaryLength(canonical.boundaries.bottom)) / 2)
    const measuredHeight = Math.max(1, (boundaryLength(canonical.boundaries.left) + boundaryLength(canonical.boundaries.right)) / 2)
    const params = canonical.corners.map((corner) => solveBasisParam(outer.corners[0], outer.corners[1], outer.corners[3], corner))
    const cx = width * (params.reduce((sum, param) => sum + param[0], 0) / params.length)
    const cy = height * (params.reduce((sum, param) => sum + param[1], 0) / params.length)
    const parent = rects[rects.length - 1]
    const maxWidth = Math.max(1, parent.x1 - parent.x0 - minGap * 2)
    const maxHeight = Math.max(1, parent.y1 - parent.y0 - minGap * 2)
    const scale = Math.min(1, maxWidth / measuredWidth, maxHeight / measuredHeight)
    const targetWidth = measuredWidth * scale
    const targetHeight = measuredHeight * scale
    const x0 = Math.max(parent.x0 + minGap, Math.min(parent.x1 - minGap - targetWidth, cx - targetWidth / 2))
    const y0 = Math.max(parent.y0 + minGap, Math.min(parent.y1 - minGap - targetHeight, cy - targetHeight / 2))
    rects.push({
      path: canonical,
      x0,
      y0,
      x1: x0 + targetWidth,
      y1: y0 + targetHeight
    })
  }

  const patches: MeshPatch[] = []
  for (let i = 0; i < rects.length - 1; i++) {
    patches.push(...buildBandPatches(rects[i], rects[i + 1]))
  }
  const smallest = rects[rects.length - 1]
  patches.push(makePatch(rectCorners(smallest), smallest.path.boundaries))
  return { width, height, rects, patches }
}

function bilinearPoint(corners: [Point, Point, Point, Point], u: number, v: number): Point {
  const [p0, p1, p2, p3] = corners
  return add(
    add(mul(p0, (1 - u) * (1 - v)), mul(p1, u * (1 - v))),
    add(mul(p2, u * v), mul(p3, (1 - u) * v))
  )
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function pointInConvexQuad(point: Point, corners: [Point, Point, Point, Point]): boolean {
  const values = corners.map((corner, index) => cross(corner, corners[(index + 1) % corners.length], point))
  const eps = 1e-6
  return values.every((value) => value >= -eps) || values.every((value) => value <= eps)
}

function invertBilinear(corners: [Point, Point, Point, Point], point: Point): Point | null {
  const [p0, p1, p2, p3] = corners
  const ux = p1[0] - p0[0]
  const uy = p1[1] - p0[1]
  const vx = p3[0] - p0[0]
  const vy = p3[1] - p0[1]
  const det = ux * vy - uy * vx
  let u = 0.5
  let v = 0.5
  if (Math.abs(det) > 1e-8) {
    const px = point[0] - p0[0]
    const py = point[1] - p0[1]
    u = (px * vy - py * vx) / det
    v = (ux * py - uy * px) / det
  }
  for (let i = 0; i < 6; i++) {
    const current = bilinearPoint(corners, u, v)
    const fx = current[0] - point[0]
    const fy = current[1] - point[1]
    if (Math.hypot(fx, fy) < 1e-4) break
    const du = [
      (1 - v) * (p1[0] - p0[0]) + v * (p2[0] - p3[0]),
      (1 - v) * (p1[1] - p0[1]) + v * (p2[1] - p3[1])
    ]
    const dv = [
      (1 - u) * (p3[0] - p0[0]) + u * (p2[0] - p1[0]),
      (1 - u) * (p3[1] - p0[1]) + u * (p2[1] - p1[1])
    ]
    const jdet = du[0] * dv[1] - du[1] * dv[0]
    if (Math.abs(jdet) < 1e-8) return null
    u -= (fx * dv[1] - fy * dv[0]) / jdet
    v -= (du[0] * fy - du[1] * fx) / jdet
  }
  return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v))]
}

function coonsFromBoundaries(boundaries: BoundarySet, u: number, v: number): Point {
  const top = boundaries.top(u)
  const right = boundaries.right(v)
  const bottom = boundaries.bottom(u)
  const left = boundaries.left(v)
  const tl = boundaries.top(0)
  const tr = boundaries.top(1)
  const br = boundaries.bottom(1)
  const bl = boundaries.bottom(0)
  const edgeBlend = add(lerp(top, bottom, v), lerp(left, right, u))
  const cornerBlend = add(
    add(mul(tl, (1 - u) * (1 - v)), mul(tr, u * (1 - v))),
    add(mul(br, u * v), mul(bl, (1 - u) * v))
  )
  return sub(edgeBlend, cornerBlend)
}

function transformNestedMesh(layout: MeshLayout, point: Point): Point {
  for (const patch of layout.patches) {
    if (!pointInConvexQuad(point, patch.target)) continue
    const uv = invertBilinear(patch.target, point)
    if (!uv) continue
    return coonsFromBoundaries(patch.boundaries, uv[0], uv[1])
  }
  return coonsFromBoundaries(layout.rects[0].path.boundaries, point[0] / layout.width, point[1] / layout.height)
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

function sampleScreenPath(path: RectPath, tx: number, ty: number, scale: number): Point[] {
  const points: Point[] = []
  for (let i = 0; i < path.nodes.length; i++) {
    const a = path.nodes[i]
    const b = path.nodes[(i + 1) % path.nodes.length]
    const cp1 = nodeOutHandle(a)
    const cp2 = nodeInHandle(b)
    for (let step = i === 0 ? 0 : 1; step <= CURVE_SAMPLE_STEPS; step++) {
      const point = cubicPoint(a.point, cp1, cp2, b.point, step / CURVE_SAMPLE_STEPS)
      points.push([point[0] * scale + tx, point[1] * scale + ty])
    }
  }
  return points
}

function drawOffsetClosedPolyline(ctx: CanvasRenderingContext2D, points: Point[], offset: number) {
  if (points.length < 2) return
  ctx.beginPath()
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length]
    const next = points[(i + 1) % points.length]
    const dx = next[0] - prev[0]
    const dy = next[1] - prev[1]
    const len = Math.hypot(dx, dy) || 1
    const point: Point = [
      points[i][0] + (-dy / len) * offset,
      points[i][1] + (dx / len) * offset
    ]
    if (i === 0) ctx.moveTo(point[0], point[1])
    else ctx.lineTo(point[0], point[1])
  }
  ctx.closePath()
  ctx.stroke()
}

function pathCacheKey(path: RectPath): string {
  return path.nodes
    .map((node) => `${node.corner ? 'c' : 's'}:${node.point[0].toFixed(1)},${node.point[1].toFixed(1)},${node.handle[0].toFixed(1)},${node.handle[1].toFixed(1)}`)
    .join('|')
}

function inverseInnerAverageColor(
  img: HTMLImageElement,
  innerPaths: RectPath[],
  imageWidth: number,
  imageHeight: number
): string {
  if (innerPaths.length === 0) return INVERSE_FALLBACK_COLOR
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
  for (const innerPath of innerPaths) {
    drawScaledPath(maskCtx, innerPath, scale)
    maskCtx.fill()
  }

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
    rectangles,
    draft,
    activeRectangleIndex,
    hideGuides,
    showMesh,
    meshDivisions,
    meshColor,
    onViewChange,
    onAppendCorner,
    onNodeChange,
    onHandleChange,
    onInsertNode,
    onDeleteNode,
    onActivateRectangle
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const viewRef = useRef<View>({ tx: 0, ty: 0, scale: 1 })
  const dragRef = useRef<Drag>(null)
  const [editDragKey, setEditDragKey] = useState('')
  const hoverSegmentRef = useRef<HoverSegment>(null)
  const drawScheduledRef = useRef(false)
  const drawRef = useRef<() => void>(() => {})
  const inverseColorRef = useRef<{ key: string; color: string } | null>(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [imageReady, setImageReady] = useState(false)

  const propsRef = useRef({ tool, rectangles, draft, activeRectangleIndex, hideGuides, showMesh, meshDivisions, meshColor })
  propsRef.current = { tool, rectangles, draft, activeRectangleIndex, hideGuides, showMesh, meshDivisions, meshColor }

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

  const pathForIndex = useCallback((rectangleIndex: number): RectPath | null => {
    return propsRef.current.rectangles[rectangleIndex] ?? null
  }, [])

  const drawPath = useCallback(
    (ctx: CanvasRenderingContext2D, path: RectPath, rectangleIndex: number, outerIndex: number | null, activeRectangle: number | null, editingRectangle: number | null, alpha = 1) => {
      const { tx, ty, scale } = viewRef.current
      const color = colorForRectangle(rectangleIndex, outerIndex)
      const active = activeRectangle === rectangleIndex
      const editing = editingRectangle === rectangleIndex
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
      ctx.lineJoin = 'round'
      if (editing) {
        const samples = sampleScreenPath(path, tx, ty, scale)
        ctx.strokeStyle = HALO_COLOR
        ctx.lineWidth = ACTIVE_EDGE_WIDTH
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        for (const offset of [-ACTIVE_EDGE_OFFSET, ACTIVE_EDGE_OFFSET]) {
          drawOffsetClosedPolyline(ctx, samples, offset)
        }
      } else {
        ctx.strokeStyle = HALO_COLOR
        ctx.lineWidth = 5
        ctx.stroke()
        ctx.strokeStyle = color.stroke
        ctx.lineWidth = 2
        ctx.stroke()
      }

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

  const drawProjectedMesh = useCallback((ctx: CanvasRenderingContext2D, outer: RectPath, innerPaths: RectPath[], divisions: number, color: string) => {
    const safeDivisions = Math.max(2, Math.min(40, Math.round(divisions)))
    const layout = buildNestedMeshLayout(outer, innerPaths)
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

    const addUnique = (values: number[], value: number) => {
      if (!values.some((existing) => Math.abs(existing - value) < 1e-6)) values.push(value)
    }
    const gridXs: number[] = []
    const gridYs: number[] = []
    for (let i = 0; i <= safeDivisions; i++) {
      gridXs.push((layout.width * i) / safeDivisions)
      gridYs.push((layout.height * i) / safeDivisions)
    }
    for (const rect of layout.rects.slice(1)) {
      addUnique(gridXs, rect.x0)
      addUnique(gridXs, rect.x1)
      addUnique(gridYs, rect.y0)
      addUnique(gridYs, rect.y1)
    }
    gridXs.sort((a, b) => a - b)
    gridYs.sort((a, b) => a - b)

    const lineSamples = Math.max(32, safeDivisions * 3)
    for (const x of gridXs) {
      const points: Point[] = []
      for (let i = 0; i <= lineSamples; i++) {
        points.push(transformNestedMesh(layout, [x, (layout.height * i) / lineSamples]))
      }
      drawMeshLine(points)
    }
    for (const y of gridYs) {
      const points: Point[] = []
      for (let i = 0; i <= lineSamples; i++) {
        points.push(transformNestedMesh(layout, [(layout.width * i) / lineSamples, y]))
      }
      drawMeshLine(points)
    }

    ctx.setLineDash([])
    ctx.globalAlpha = 0.95
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    const smallest = layout.rects[layout.rects.length - 1]
    const center = transformNestedMesh(layout, [(smallest.x0 + smallest.x1) / 2, (smallest.y0 + smallest.y1) / 2])
    const [cx, cy] = imageToScreen(center[0], center[1])
    ctx.beginPath()
    ctx.arc(cx, cy, 3, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
  }, [imageToScreen])

  const drawDraft = useCallback((ctx: CanvasRenderingContext2D, points: Point[]) => {
    if (points.length === 0) return
    const color = colorForRectangle(-1, null)
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
      rectangles: currentRectangles,
      draft: currentDraft,
      activeRectangleIndex: currentActiveRectangleIndex,
      showMesh: meshVisible,
      meshDivisions: curMeshDivisions,
      meshColor: curMeshColor
    } = propsRef.current
    const derived = deriveRectangleRoles(currentRectangles)
    const currentDrag = dragRef.current
    const editingRectangle = currentDrag?.kind === 'node' || currentDrag?.kind === 'handle'
      ? currentDrag.rectangleIndex
      : null
    if (derived.outerPath && meshVisible) {
      let effectiveMeshColor = curMeshColor
      if (curMeshColor === INVERSE_MESH_COLOR && img) {
        const key = `${src}|${imageWidth}x${imageHeight}|${derived.innerPaths.map(pathCacheKey).join('~')}`
        if (inverseColorRef.current?.key !== key) {
          inverseColorRef.current = {
            key,
            color: inverseInnerAverageColor(img, derived.innerPaths, imageWidth, imageHeight)
          }
        }
        effectiveMeshColor = inverseColorRef.current.color
      }
      drawProjectedMesh(ctx, derived.outerPath, derived.innerPaths, curMeshDivisions, effectiveMeshColor)
    }
    currentRectangles.forEach((path, index) => {
      drawPath(ctx, path, index, derived.outerIndex, currentActiveRectangleIndex, editingRectangle, 1)
    })
    drawDraft(ctx, currentDraft)

    const hover = hoverSegmentRef.current
    if (hover && currentActiveRectangleIndex === hover.rectangleIndex) {
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
  }, [containerSize, imageReady, rectangles, draft, activeRectangleIndex, tool, hideGuides, showMesh, meshDivisions, meshColor, editDragKey, requestDraw])

  const findSegmentHit = useCallback((rectangleIndex: number, screenPoint: Point): HoverSegment => {
    const path = pathForIndex(rectangleIndex)
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
          best = { rectangleIndex, segmentIndex: i, point, tangent }
        }
        prev = cur
      }
    }
    return best
  }, [imageToScreen, pathForIndex])

  const findSegmentHitAny = useCallback((screenPoint: Point): HoverSegment => {
    const { activeRectangleIndex: activeIndex, rectangles: currentRectangles } = propsRef.current
    const indices = activeIndex === null
      ? currentRectangles.map((_, index) => index)
      : [activeIndex, ...currentRectangles.map((_, index) => index).filter((index) => index !== activeIndex)]
    let best: HoverSegment = null
    let bestDistance = SEGMENT_HIT_RADIUS
    for (const rectangleIndex of indices) {
      const hit = findSegmentHit(rectangleIndex, screenPoint)
      if (!hit) continue
      const screenHit = imageToScreen(hit.point[0], hit.point[1])
      const hitDistance = distance(screenPoint, screenHit)
      if (hitDistance < bestDistance) {
        bestDistance = hitDistance
        best = hit
      }
    }
    return best
  }, [findSegmentHit, imageToScreen])

  const findEditHitForRectangle = useCallback((rectangleIndex: number, screenPoint: Point): Drag => {
    const path = pathForIndex(rectangleIndex)
    if (!path) return null
    for (let i = 0; i < path.nodes.length; i++) {
      const node = path.nodes[i]
      if (node.corner) continue
      const out = imageToScreen(node.point[0] + node.handle[0], node.point[1] + node.handle[1])
      const inn = imageToScreen(node.point[0] - node.handle[0], node.point[1] - node.handle[1])
      if (distance(screenPoint, out) <= HANDLE_HIT_RADIUS) return { kind: 'handle', rectangleIndex, nodeIndex: i, side: 'out' }
      if (distance(screenPoint, inn) <= HANDLE_HIT_RADIUS) return { kind: 'handle', rectangleIndex, nodeIndex: i, side: 'in' }
    }
    for (let i = 0; i < path.nodes.length; i++) {
      const node = path.nodes[i]
      const p = imageToScreen(node.point[0], node.point[1])
      if (distance(screenPoint, p) <= NODE_HIT_RADIUS) return { kind: 'node', rectangleIndex, nodeIndex: i }
    }
    return null
  }, [imageToScreen, pathForIndex])

  const findEditHit = useCallback((screenPoint: Point): Drag => {
    const { activeRectangleIndex: activeIndex, rectangles: currentRectangles } = propsRef.current
    if (activeIndex !== null) {
      const activeHit = findEditHitForRectangle(activeIndex, screenPoint)
      if (activeHit) return activeHit
    }
    for (let i = 0; i < currentRectangles.length; i++) {
      if (i === activeIndex) continue
      const hit = findEditHitForRectangle(i, screenPoint)
      if (hit) return hit
    }
    return null
  }, [findEditHitForRectangle])

  const findNodeHit = useCallback((rectangleIndex: number, screenPoint: Point): { rectangleIndex: number; nodeIndex: number; corner: boolean } | null => {
    const path = pathForIndex(rectangleIndex)
    if (!path) return null
    for (let i = 0; i < path.nodes.length; i++) {
      const node = path.nodes[i]
      const p = imageToScreen(node.point[0], node.point[1])
      if (distance(screenPoint, p) <= NODE_HIT_RADIUS) return { rectangleIndex, nodeIndex: i, corner: node.corner }
    }
    return null
  }, [imageToScreen, pathForIndex])

  const findDeleteHit = useCallback((screenPoint: Point) => {
    const { activeRectangleIndex: activeIndex, rectangles: currentRectangles } = propsRef.current
    const indices = activeIndex === null
      ? currentRectangles.map((_, index) => index)
      : [activeIndex, ...currentRectangles.map((_, index) => index).filter((index) => index !== activeIndex)]
    for (const rectangleIndex of indices) {
      const hit = findNodeHit(rectangleIndex, screenPoint)
      if (hit) return hit
    }
    return null
  }, [findNodeHit])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const screenPoint: Point = [e.clientX - rect.left, e.clientY - rect.top]

      if (e.button === 2) {
        e.preventDefault()
        const deleteHit = findDeleteHit(screenPoint)
        if (deleteHit) {
          onDeleteNode(deleteHit.rectangleIndex, deleteHit.nodeIndex)
          requestDraw()
        }
        return
      }

      if (isRectangleTool(tool)) {
        if (propsRef.current.draft.length > 0) {
          onAppendCorner(clampPoint(screenToImage(screenPoint[0], screenPoint[1]), imageWidth, imageHeight))
          requestDraw()
          return
        }

        const editHit = findEditHit(screenPoint)
        if (editHit && editHit.kind !== 'pan') {
          onActivateRectangle(editHit.rectangleIndex)
          dragRef.current = editHit
          setEditDragKey(`${editHit.kind}:${editHit.rectangleIndex}:${editHit.nodeIndex}`)
          canvas.setPointerCapture(e.pointerId)
          return
        }

        const segmentHit = findSegmentHitAny(screenPoint)
        if (segmentHit) {
          const node: BezierNode = {
            point: clampPoint(segmentHit.point, imageWidth, imageHeight),
            handle: defaultNodeHandle(segmentHit.tangent),
            corner: false
          }
          const path = pathForIndex(segmentHit.rectangleIndex)
          const insertAt = path && segmentHit.segmentIndex === path.nodes.length - 1 ? path.nodes.length : segmentHit.segmentIndex + 1
          onInsertNode(segmentHit.rectangleIndex, segmentHit.segmentIndex, node)
          dragRef.current = { kind: 'node', rectangleIndex: segmentHit.rectangleIndex, nodeIndex: insertAt }
          setEditDragKey(`node:${segmentHit.rectangleIndex}:${insertAt}`)
          canvas.setPointerCapture(e.pointerId)
          requestDraw()
          return
        }

        onAppendCorner(clampPoint(screenToImage(screenPoint[0], screenPoint[1]), imageWidth, imageHeight))
        requestDraw()
        return
      }

      dragRef.current = { kind: 'pan', lastX: screenPoint[0], lastY: screenPoint[1] }
      setEditDragKey('')
      canvas.setPointerCapture(e.pointerId)
    },
    [
      findEditHit,
      findDeleteHit,
      findSegmentHitAny,
      imageHeight,
      imageWidth,
      onActivateRectangle,
      onAppendCorner,
      onDeleteNode,
      onInsertNode,
      pathForIndex,
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
        const drawingDraft = propsRef.current.draft.length > 0
        const editHit = isRectangleTool(tool) && !drawingDraft ? findEditHit(screenPoint) : null
        const segmentHit = isRectangleTool(tool) && !drawingDraft && !editHit ? findSegmentHitAny(screenPoint) : null
        hoverSegmentRef.current = segmentHit
        if (editHit?.kind === 'node' || editHit?.kind === 'handle') canvas.style.cursor = 'grab'
        else if (segmentHit) canvas.style.cursor = 'copy'
        else if (isRectangleTool(tool)) canvas.style.cursor = 'crosshair'
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
        onNodeChange(drag.rectangleIndex, drag.nodeIndex, imagePoint)
        return
      }
      if (drag.kind === 'handle') {
        const path = pathForIndex(drag.rectangleIndex)
        const node = path?.nodes[drag.nodeIndex]
        if (!node) return
        const nextHandle = drag.side === 'out'
          ? sub(imagePoint, node.point)
          : sub(node.point, imagePoint)
        onHandleChange(drag.rectangleIndex, drag.nodeIndex, nextHandle)
      }
    },
    [
      findEditHit,
      findSegmentHitAny,
      imageHeight,
      imageWidth,
      onHandleChange,
      onNodeChange,
      pathForIndex,
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
      setEditDragKey('')
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
        const nextScale = Math.max(0.05, Math.min(40, v.scale * factor))
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
        onContextMenu={(e) => e.preventDefault()}
        style={{ display: 'block', touchAction: 'none' }}
      />
    </div>
  )
})
