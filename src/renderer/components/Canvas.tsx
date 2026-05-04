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

const ROLES: Role[] = ['outer', 'inner']

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
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [imageReady, setImageReady] = useState(false)

  const propsRef = useRef({ tool, outerPath, innerPath, outerDraft, innerDraft, hideGuides })
  propsRef.current = { tool, outerPath, innerPath, outerDraft, innerDraft, hideGuides }

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
    requestDraw()
  }, [containerSize, imageWidth, imageHeight, requestDraw])

  const zoomToActualSize = useCallback(() => {
    const { w, h } = containerSize
    viewRef.current = {
      scale: 1,
      tx: (w - imageWidth) / 2,
      ty: (h - imageHeight) / 2
    }
    requestDraw()
  }, [containerSize, imageWidth, imageHeight, requestDraw])

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

    const { tool: curTool, outerPath: op, innerPath: ip, outerDraft: od, innerDraft: id } = propsRef.current
    const activeRole = roleFromTool(curTool)
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
  }, [containerSize, drawDraft, drawPath, imageHeight, imageToScreen, imageWidth])
  drawRef.current = draw

  useEffect(() => {
    requestDraw()
  }, [containerSize, imageReady, outerPath, innerPath, outerDraft, innerDraft, tool, hideGuides, requestDraw])

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
      } else {
        viewRef.current.tx -= e.deltaX
        viewRef.current.ty -= e.deltaY
      }
      requestDraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [requestDraw])

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
