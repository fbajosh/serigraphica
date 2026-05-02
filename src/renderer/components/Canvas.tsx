import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { Quad, Point, Tool, Role, Stroke, RectShape, Polyline } from '../../shared/types'

const HANDLE_RADIUS = 8 // screen px
const HANDLE_HIT_RADIUS = 14 // screen px

const COLORS: Record<Role, { stroke: string; fill: string; paint: string }> = {
  outer: { stroke: '#ff5e5e', fill: 'rgba(255, 94, 94, 0.10)', paint: 'rgba(255, 94, 94, 0.20)' },
  inner: { stroke: '#4ea1ff', fill: 'rgba(78, 161, 255, 0.10)', paint: 'rgba(78, 161, 255, 0.20)' }
}
const HALO_COLOR = 'rgba(0, 0, 0, 0.85)'

type Props = {
  src: string
  imageWidth: number
  imageHeight: number
  tool: Tool
  brushRadius: number  // image-space radius
  strokes: { outer: Stroke[]; inner: Stroke[] }
  outerShape: RectShape | null
  innerShape: RectShape | null
  onAddStroke: (role: Role, stroke: Stroke) => void
  onCornerChange: (role: Role, index: number, p: Point) => void
}

export type CanvasHandle = {
  fitToView: () => void
  zoomToActualSize: () => void
}

type View = { tx: number; ty: number; scale: number }

type Drag =
  | { kind: 'pan'; lastX: number; lastY: number }
  | { kind: 'corner'; role: Role; index: number }
  | { kind: 'paint'; role: Role; points: Point[] }
  | null

const ROLES: Role[] = ['outer', 'inner']

function paintRoleFromTool(tool: Tool): Role | null {
  if (tool === 'paint-outer') return 'outer'
  if (tool === 'paint-inner') return 'inner'
  return null
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  {
    src,
    imageWidth,
    imageHeight,
    tool,
    brushRadius,
    strokes,
    outerShape,
    innerShape,
    onAddStroke,
    onCornerChange
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const viewRef = useRef<View>({ tx: 0, ty: 0, scale: 1 })
  const dragRef = useRef<Drag>(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [imageReady, setImageReady] = useState(false)
  const [cursorPos, setCursorPos] = useState<Point | null>(null)

  const propsRef = useRef({ tool, brushRadius, strokes, outerShape, innerShape })
  propsRef.current = { tool, brushRadius, strokes, outerShape, innerShape }

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
  }, [containerSize, imageWidth, imageHeight])

  const zoomToActualSize = useCallback(() => {
    const { w, h } = containerSize
    viewRef.current = {
      scale: 1,
      tx: (w - imageWidth) / 2,
      ty: (h - imageHeight) / 2
    }
    requestDraw()
  }, [containerSize, imageWidth, imageHeight])

  useEffect(() => {
    if (imageReady && containerSize.w > 0) fitToView()
  }, [imageReady, containerSize.w, containerSize.h, fitToView])

  useImperativeHandle(ref, () => ({ fitToView, zoomToActualSize }), [fitToView, zoomToActualSize])

  const drawScheduledRef = useRef(false)
  const cursorRef = useRef<Point | null>(cursorPos)
  cursorRef.current = cursorPos

  const drawShape = useCallback(
    (ctx: CanvasRenderingContext2D, shape: RectShape, color: { stroke: string; fill: string }) => {
      const { tx, ty, scale } = viewRef.current
      ctx.beginPath()
      for (let s = 0; s < 4; s++) {
        const side = shape.sides[s]
        for (let i = 0; i < side.length; i++) {
          const sx = side[i][0] * scale + tx
          const sy = side[i][1] * scale + ty
          if (s === 0 && i === 0) ctx.moveTo(sx, sy)
          else ctx.lineTo(sx, sy)
        }
      }
      ctx.closePath()
      ctx.fillStyle = color.fill
      ctx.fill()
      // Dark halo, then bright line on top — readable against any color paint.
      ctx.lineJoin = 'round'
      ctx.strokeStyle = HALO_COLOR
      ctx.lineWidth = 5
      ctx.stroke()
      ctx.strokeStyle = color.stroke
      ctx.lineWidth = 2
      ctx.stroke()
      // Corner handles with the same halo treatment.
      for (const [cx, cy] of shape.corners) {
        const sx = cx * scale + tx
        const sy = cy * scale + ty
        ctx.beginPath()
        ctx.arc(sx, sy, HANDLE_RADIUS + 2, 0, Math.PI * 2)
        ctx.fillStyle = HALO_COLOR
        ctx.fill()
        ctx.beginPath()
        ctx.arc(sx, sy, HANDLE_RADIUS, 0, Math.PI * 2)
        ctx.fillStyle = color.stroke
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    },
    []
  )

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

    const { tool: curTool, brushRadius: curRadius, strokes: curStrokes, outerShape: os, innerShape: is } = propsRef.current

    // Painted strokes
    for (const role of ROLES) {
      ctx.fillStyle = COLORS[role].paint
      const list = curStrokes[role]
      for (const stroke of list) {
        const r = stroke.radius * scale
        for (const [px, py] of stroke.points) {
          ctx.beginPath()
          ctx.arc(px * scale + tx, py * scale + ty, r, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
    const drag = dragRef.current
    if (drag?.kind === 'paint') {
      ctx.fillStyle = COLORS[drag.role].paint
      const r = curRadius * scale
      for (const [px, py] of drag.points) {
        ctx.beginPath()
        ctx.arc(px * scale + tx, py * scale + ty, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // Rectangles
    if (os) drawShape(ctx, os, COLORS.outer)
    if (is) drawShape(ctx, is, COLORS.inner)

    // Brush preview ring
    const role = paintRoleFromTool(curTool)
    if (role && cursorRef.current) {
      const [cx, cy] = cursorRef.current
      ctx.beginPath()
      ctx.arc(cx, cy, curRadius * scale, 0, Math.PI * 2)
      ctx.strokeStyle = COLORS[role].stroke
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [containerSize, imageWidth, imageHeight, drawShape])

  const requestDraw = useCallback(() => {
    if (drawScheduledRef.current) return
    drawScheduledRef.current = true
    requestAnimationFrame(draw)
  }, [draw])

  useEffect(() => {
    requestDraw()
  }, [containerSize, imageReady, strokes, outerShape, innerShape, brushRadius, tool, requestDraw])

  const screenToImage = useCallback((sx: number, sy: number): Point => {
    const { tx, ty, scale } = viewRef.current
    return [(sx - tx) / scale, (sy - ty) / scale]
  }, [])
  const imageToScreen = useCallback((ix: number, iy: number): Point => {
    const { tx, ty, scale } = viewRef.current
    return [ix * scale + tx, iy * scale + ty]
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const role = paintRoleFromTool(tool)

      if (role) {
        const ip = screenToImage(x, y)
        dragRef.current = { kind: 'paint', role, points: [ip] }
        canvas.setPointerCapture(e.pointerId)
        requestDraw()
        return
      }

      for (const r of ROLES) {
        const shape = r === 'outer' ? outerShape : innerShape
        if (!shape) continue
        for (let i = 0; i < 4; i++) {
          const [hx, hy] = imageToScreen(shape.corners[i][0], shape.corners[i][1])
          const dx = x - hx
          const dy = y - hy
          if (dx * dx + dy * dy <= HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS) {
            dragRef.current = { kind: 'corner', role: r, index: i }
            canvas.setPointerCapture(e.pointerId)
            return
          }
        }
      }
      dragRef.current = { kind: 'pan', lastX: x, lastY: y }
      canvas.setPointerCapture(e.pointerId)
    },
    [tool, outerShape, innerShape, screenToImage, imageToScreen, requestDraw]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setCursorPos([x, y])

      const drag = dragRef.current
      if (!drag) {
        if (paintRoleFromTool(tool)) {
          canvas.style.cursor = 'crosshair'
        } else {
          let onHandle = false
          for (const r of ROLES) {
            const shape = r === 'outer' ? outerShape : innerShape
            if (!shape) continue
            for (let i = 0; i < 4; i++) {
              const [hx, hy] = imageToScreen(shape.corners[i][0], shape.corners[i][1])
              const dx = x - hx
              const dy = y - hy
              if (dx * dx + dy * dy <= HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS) {
                onHandle = true
                break
              }
            }
            if (onHandle) break
          }
          canvas.style.cursor = onHandle ? 'grab' : 'default'
        }
        requestDraw()
        return
      }
      if (drag.kind === 'pan') {
        viewRef.current.tx += x - drag.lastX
        viewRef.current.ty += y - drag.lastY
        drag.lastX = x
        drag.lastY = y
        requestDraw()
        return
      }
      if (drag.kind === 'corner') {
        const [ix, iy] = screenToImage(x, y)
        onCornerChange(drag.role, drag.index, [
          Math.max(0, Math.min(imageWidth, ix)),
          Math.max(0, Math.min(imageHeight, iy))
        ])
        return
      }
      if (drag.kind === 'paint') {
        const ip = screenToImage(x, y)
        const last = drag.points[drag.points.length - 1]
        const dx = ip[0] - last[0]
        const dy = ip[1] - last[1]
        if (dx * dx + dy * dy >= (brushRadius * 0.25) ** 2) {
          drag.points.push(ip)
          requestDraw()
        }
        return
      }
    },
    [tool, outerShape, innerShape, screenToImage, imageToScreen, imageWidth, imageHeight, onCornerChange, brushRadius, requestDraw]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (canvas?.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      const drag = dragRef.current
      dragRef.current = null
      if (drag?.kind === 'paint' && drag.points.length > 0) {
        onAddStroke(drag.role, { points: drag.points, radius: brushRadius })
      }
      requestDraw()
    },
    [brushRadius, onAddStroke, requestDraw]
  )

  const onPointerLeave = useCallback(() => {
    setCursorPos(null)
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

// Suppress unused-import warnings — both types are part of the public Canvas
// surface area through state shapes the parent consumes.
export type { Quad, Polyline }
