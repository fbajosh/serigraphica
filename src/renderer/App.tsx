import { useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, CanvasHandle } from './components/Canvas'
import type { Point, Quad, Tool, Role, Stroke, RectShape, Polyline } from '../shared/types'

type Loaded = {
  path: string
  width: number
  height: number
  dataUrl: string
}

type StrokesState = { outer: Stroke[]; inner: Stroke[] }

const DEFAULT_BRUSH_FRAC = 0.012  // 1.2% of max dim → ~70px on a 6000px image

// When a corner is dragged, the two side polylines that touch it should
// stretch so their endpoints follow without warping the captured curvature
// somewhere unrelated. Linear blend: at the moving end the points get the
// full delta, at the far end zero, with a smooth ramp in between.
function rectShapeWithMovedCorner(shape: RectShape, index: number, p: Point): RectShape {
  const oldP = shape.corners[index]
  const dx = p[0] - oldP[0]
  const dy = p[1] - oldP[1]

  // Side `index` starts at this corner; side `(index+3)%4` ends at it.
  const outIdx = index
  const inIdx = (index + 3) % 4

  const lerpSideStart = (poly: Polyline): Polyline => {
    const n = poly.length
    const next: Polyline = poly.map((pt, i) => {
      const w = 1 - i / (n - 1)
      return [pt[0] + dx * w, pt[1] + dy * w] as Point
    })
    return next
  }
  const lerpSideEnd = (poly: Polyline): Polyline => {
    const n = poly.length
    const next: Polyline = poly.map((pt, i) => {
      const w = i / (n - 1)
      return [pt[0] + dx * w, pt[1] + dy * w] as Point
    })
    return next
  }

  const sides: [Polyline, Polyline, Polyline, Polyline] = [...shape.sides] as [Polyline, Polyline, Polyline, Polyline]
  sides[outIdx] = lerpSideStart(sides[outIdx])
  sides[inIdx] = lerpSideEnd(sides[inIdx])

  // Re-pin endpoints exactly to the moved corner so floating-point drift
  // doesn't leave a visible gap at the corner over many drag frames.
  sides[outIdx] = [...sides[outIdx]]
  sides[outIdx][0] = p
  sides[inIdx] = [...sides[inIdx]]
  sides[inIdx][sides[inIdx].length - 1] = p

  const corners: Quad = [...shape.corners] as Quad
  corners[index] = p
  return { corners, sides }
}

export function App() {
  const [image, setImage] = useState<Loaded | null>(null)
  const [tool, setTool] = useState<Tool>('paint-outer')
  const [brushRadius, setBrushRadius] = useState(60)
  const [strokes, setStrokes] = useState<StrokesState>({ outer: [], inner: [] })
  const [outerShape, setOuterShape] = useState<RectShape | null>(null)
  const [innerShape, setInnerShape] = useState<RectShape | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Open an image to begin')
  const canvasRef = useRef<CanvasHandle>(null)

  const handleOpen = useCallback(async () => {
    setBusy(true)
    setStatus('Opening image…')
    try {
      const res = await window.serigraphica.openImage()
      if (!res) {
        setStatus('Ready')
        return
      }
      setImage(res)
      setStrokes({ outer: [], inner: [] })
      setOuterShape(null)
      setInnerShape(null)
      setBrushRadius(Math.max(20, Math.round(Math.max(res.width, res.height) * DEFAULT_BRUSH_FRAC)))
      setTool('paint-outer')
      setStatus('Paint along the outer paper edges, then "Derive rectangles"')
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const handleAddStroke = useCallback((role: Role, stroke: Stroke) => {
    setStrokes((prev) => ({ ...prev, [role]: [...prev[role], stroke] }))
  }, [])

  const handleClearStrokes = useCallback((role: Role) => {
    setStrokes((prev) => ({ ...prev, [role]: [] }))
    if (role === 'outer') setOuterShape(null)
    else setInnerShape(null)
  }, [])

  const handleClearAll = useCallback(() => {
    setStrokes({ outer: [], inner: [] })
    setOuterShape(null)
    setInnerShape(null)
  }, [])

  const handleUndoStroke = useCallback(() => {
    setStrokes((prev) => {
      const role: Role = tool === 'paint-inner' ? 'inner' : 'outer'
      const list = prev[role]
      if (list.length === 0) return prev
      return { ...prev, [role]: list.slice(0, -1) }
    })
  }, [tool])

  const handleDerive = useCallback(async () => {
    if (!image) return
    if (strokes.outer.length === 0 && strokes.inner.length === 0) {
      setStatus('Paint some strokes first')
      return
    }
    setBusy(true)
    setStatus('Deriving rectangles…')
    try {
      const res = await window.serigraphica.deriveFromStrokes(
        image.path,
        image.width,
        image.height,
        strokes.outer,
        strokes.inner
      )
      if (res.outer) setOuterShape(res.outer)
      if (res.inner) setInnerShape(res.inner)
      const got: string[] = []
      if (res.outer) got.push('outer')
      if (res.inner) got.push('inner')
      setStatus(got.length ? `Derived: ${got.join(' + ')}` : 'No rectangle could be derived')
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [image, strokes])

  const handleAutoDetect = useCallback(async () => {
    if (!image) return
    setBusy(true)
    setStatus('Auto-detecting…')
    try {
      const det = await window.serigraphica.detectOuterRect(image.path)
      // Auto-detect returns straight 4-corner quad; synthesize 2-pt sides so
      // the canvas/draw pipeline stays uniform with derived shapes.
      const c = det.corners
      const sides: [Polyline, Polyline, Polyline, Polyline] = [
        [c[0], c[1]],
        [c[1], c[2]],
        [c[2], c[3]],
        [c[3], c[0]]
      ]
      setOuterShape({ corners: c, sides })
      setStatus(`Auto-detected (confidence ${(det.confidence * 100).toFixed(0)}%)`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [image])

  const handleCornerChange = useCallback((role: Role, index: number, p: Point) => {
    if (role === 'outer') {
      setOuterShape((prev) => (prev ? rectShapeWithMovedCorner(prev, index, p) : prev))
    } else {
      setInnerShape((prev) => (prev ? rectShapeWithMovedCorner(prev, index, p) : prev))
    }
  }, [])

  const handleExport = useCallback(async () => {
    if (!image || !outerShape) return
    setBusy(true)
    setStatus('Exporting…')
    try {
      const out = await window.serigraphica.exportCorrected(image.path, outerShape.corners, 92)
      setStatus(`Exported ${out.outputWidth}×${out.outputHeight} → ${out.outputPath}`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [image, outerShape])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!image) return
      if (e.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        canvasRef.current?.fitToView()
      } else if (e.key === '1' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        canvasRef.current?.zoomToActualSize()
      } else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleUndoStroke()
      } else if (e.key === 'v' || e.key === ' ') {
        setTool('pan')
      } else if (e.key === '1') {
        setTool('paint-outer')
      } else if (e.key === '2') {
        setTool('paint-inner')
      } else if (e.key === '[') {
        setBrushRadius((r) => Math.max(5, Math.round(r * 0.85)))
      } else if (e.key === ']') {
        setBrushRadius((r) => Math.min(500, Math.round(r * 1.18)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [image, handleUndoStroke])

  const totalStrokes = strokes.outer.length + strokes.inner.length
  const isPainting = tool === 'paint-outer' || tool === 'paint-inner'
  const activeRole: Role = tool === 'paint-inner' ? 'inner' : 'outer'

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={handleOpen} disabled={busy}>Open</button>
        <span className="sep" />
        <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')} title="Pan/move (V)">↔︎</ToolButton>
        <ToolButton active={tool === 'paint-outer'} onClick={() => setTool('paint-outer')} title="Paint outer paper edges (1)" color="#ff5e5e">Outer</ToolButton>
        <ToolButton active={tool === 'paint-inner'} onClick={() => setTool('paint-inner')} title="Paint inner print edges (2)" color="#4ea1ff">Inner</ToolButton>
        <span className="sep" />
        <button onClick={handleDerive} disabled={busy || !image || totalStrokes === 0}>Derive rectangles</button>
        <button onClick={handleAutoDetect} disabled={busy || !image} title="Auto-detect (no painting)">Auto-detect</button>
        <span className="sep" />
        <button onClick={() => canvasRef.current?.fitToView()} disabled={!image}>Fit</button>
        <button onClick={() => canvasRef.current?.zoomToActualSize()} disabled={!image}>100%</button>
        <span style={{ flex: 1 }} />
        <button onClick={handleExport} disabled={busy || !image || !outerShape}>Export</button>
        {image && <span className="filename">{image.path.split('/').pop()}</span>}
      </div>

      <div className="canvas-host">
        {image ? (
          <Canvas
            ref={canvasRef}
            src={image.dataUrl}
            imageWidth={image.width}
            imageHeight={image.height}
            tool={tool}
            brushRadius={brushRadius}
            strokes={strokes}
            outerShape={outerShape}
            innerShape={innerShape}
            onAddStroke={handleAddStroke}
            onCornerChange={handleCornerChange}
          />
        ) : (
          <div className="empty-state">Open an image to begin</div>
        )}
      </div>

      <div className="panel">
        <section>
          <h3>Active tool</h3>
          <div style={{ color: '#ccc' }}>
            {tool === 'pan' && 'Pan — drag to move, drag corners to adjust'}
            {tool === 'paint-outer' && 'Painting outer paper edges'}
            {tool === 'paint-inner' && 'Painting inner print edges'}
          </div>
        </section>
        {isPainting && (
          <section>
            <h3>Brush</h3>
            <div className="row">
              <label>Radius</label>
              <span>{brushRadius}px</span>
            </div>
            <input
              type="range"
              min={5}
              max={Math.round((image?.width ?? 1500) * 0.05)}
              value={brushRadius}
              onChange={(e) => setBrushRadius(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>[ and ] to resize</div>
          </section>
        )}
        <section>
          <h3>Strokes</h3>
          <div className="row">
            <label>Outer</label>
            <span>{strokes.outer.length}</span>
          </div>
          <div className="row">
            <label>Inner</label>
            <span>{strokes.inner.length}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button onClick={handleUndoStroke} disabled={!strokes[activeRole].length}>Undo</button>
            <button onClick={() => handleClearStrokes(activeRole)} disabled={!strokes[activeRole].length}>
              Clear {activeRole}
            </button>
            <button onClick={handleClearAll} disabled={totalStrokes === 0}>Clear all</button>
          </div>
        </section>
        <section>
          <h3>Rectangles</h3>
          <div className="row">
            <label>Outer (paper)</label>
            <span style={{ color: outerShape ? '#ff5e5e' : '#666' }}>{outerShape ? '✓' : '—'}</span>
          </div>
          <div className="row">
            <label>Inner (print)</label>
            <span style={{ color: innerShape ? '#4ea1ff' : '#666' }}>{innerShape ? '✓' : '—'}</span>
          </div>
          <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>
            Boundary curves snap to the strongest local gradient inside the brush band.
            Export uses the outer rectangle as the crop reference.
          </div>
        </section>
        <section>
          <h3>Help</h3>
          <div style={{ color: '#888', lineHeight: 1.5 }}>
            Pinch to zoom, two-finger pan. <br />
            1/2 paint tools, V pan. <br />
            ⌘Z undo stroke, ⌘0 fit, ⌘1 100%.
          </div>
        </section>
      </div>

      <div className="statusbar">{status}</div>
    </div>
  )
}

function ToolButton({
  active,
  color,
  onClick,
  title,
  children
}: {
  active: boolean
  color?: string
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: active ? (color ?? '#3a3a3a') : '#2a2a2a',
        borderColor: active ? (color ?? '#666') : '#444',
        color: active ? '#fff' : '#ddd'
      }}
    >
      {children}
    </button>
  )
}
