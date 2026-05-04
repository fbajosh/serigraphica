import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Canvas, CanvasHandle } from './components/Canvas'
import type { BezierNode, Point, Quad, RectPath, Role, Tool } from '../shared/types'

type Loaded = {
  path: string
  width: number
  height: number
  dataUrl: string
}

type DraftState = { outer: Point[]; inner: Point[] }

const DEBUG_OUTLINES_KEY = 'serigraphica.manualOutlines.v2'
const DEFAULT_ACCENT_COLOR = '#ff5e5e'
const MESH_COLORS = ['inverse', '#ffffff', '#ff4d4d', '#ffd84d', '#5ee05e', '#4de8ff', '#4d79ff', '#ff5cff', '#000000'] as const
const MESH_COLOR_LABELS = ['Inverse', 'White', 'Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta', 'Black'] as const

type SavedManualOutline = {
  version: 2
  filename: string
  savedAt: string
  imageWidth: number
  imageHeight: number
  outerPath: RectPath | null
  innerPath: RectPath | null
}

type SavedManualOutlineMeta = {
  savedAt: string
  imageWidth: number
  imageHeight: number
  outerNodes: number
  innerNodes: number
}

function imageFilename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function readDebugOutlineStore(): Record<string, SavedManualOutline> {
  try {
    const raw = window.localStorage.getItem(DEBUG_OUTLINES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeDebugOutlineStore(store: Record<string, SavedManualOutline>) {
  window.localStorage.setItem(DEBUG_OUTLINES_KEY, JSON.stringify(store))
}

function getSavedDebugOutline(filename: string): SavedManualOutline | null {
  return readDebugOutlineStore()[filename] ?? null
}

function getSavedDebugOutlineMeta(filename: string): SavedManualOutlineMeta | null {
  const saved = getSavedDebugOutline(filename)
  if (!saved) return null
  return {
    savedAt: saved.savedAt,
    imageWidth: saved.imageWidth,
    imageHeight: saved.imageHeight,
    outerNodes: saved.outerPath?.nodes.length ?? 0,
    innerNodes: saved.innerPath?.nodes.length ?? 0
  }
}

function pathFromCorners(corners: Point[]): RectPath {
  const nodes = corners.slice(0, 4).map((point): BezierNode => ({
    point,
    handle: [0, 0],
    corner: true
  }))
  return { nodes, cornerIndices: [0, 1, 2, 3] }
}

function defaultPath(width: number, height: number, role: Role): RectPath {
  const insetX = width * (role === 'outer' ? 0.08 : 0.22)
  const insetY = height * (role === 'outer' ? 0.08 : 0.22)
  return pathFromCorners([
    [insetX, insetY],
    [width - insetX, insetY],
    [width - insetX, height - insetY],
    [insetX, height - insetY]
  ])
}

function pathCorners(path: RectPath | null): Quad | null {
  if (!path) return null
  const corners = path.cornerIndices.map((index) => path.nodes[index]?.point)
  if (corners.some((point) => !point)) return null
  return corners as Quad
}

function movePathNode(path: RectPath, index: number, point: Point): RectPath {
  return {
    ...path,
    nodes: path.nodes.map((node, i) => (i === index ? { ...node, point } : node))
  }
}

function setPathHandle(path: RectPath, index: number, handle: Point): RectPath {
  return {
    ...path,
    nodes: path.nodes.map((node, i) => (i === index ? { ...node, handle } : node))
  }
}

function insertPathNode(path: RectPath, segmentIndex: number, node: BezierNode): RectPath {
  const insertAt = segmentIndex === path.nodes.length - 1 ? path.nodes.length : segmentIndex + 1
  const nodes = [...path.nodes]
  nodes.splice(insertAt, 0, node)
  const cornerIndices = path.cornerIndices.map((cornerIndex) => (
    insertAt < path.nodes.length && cornerIndex >= insertAt ? cornerIndex + 1 : cornerIndex
  )) as [number, number, number, number]
  return { nodes, cornerIndices }
}

function roleLabel(role: Role): string {
  return role === 'outer' ? 'Outer' : 'Inner'
}

export function App() {
  const [image, setImage] = useState<Loaded | null>(null)
  const [tool, setTool] = useState<Tool>('pen-outer')
  const [outerPath, setOuterPath] = useState<RectPath | null>(null)
  const [innerPath, setInnerPath] = useState<RectPath | null>(null)
  const [drafts, setDrafts] = useState<DraftState>({ outer: [], inner: [] })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Open an image to begin')
  const [hideGuides, setHideGuides] = useState(false)
  const [showMesh, setShowMesh] = useState(false)
  const [meshDivisions, setMeshDivisions] = useState(10)
  const [meshColorIndex, setMeshColorIndex] = useState(0)
  const [dragActive, setDragActive] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugMessage, setDebugMessage] = useState('')
  const [savedDebugOutline, setSavedDebugOutline] = useState<SavedManualOutlineMeta | null>(null)
  const canvasRef = useRef<CanvasHandle>(null)
  const filename = image ? imageFilename(image.path) : ''

  const refreshSavedDebugOutline = useCallback((targetFilename: string) => {
    setSavedDebugOutline(getSavedDebugOutlineMeta(targetFilename))
  }, [])

  const applyLoadedImage = useCallback((res: Loaded) => {
    setImage(res)
    setOuterPath(null)
    setInnerPath(null)
    setDrafts({ outer: [], inner: [] })
    setTool('pen-outer')
    setShowMesh(false)
    setMeshColorIndex(0)
    setDebugMessage('')
    refreshSavedDebugOutline(imageFilename(res.path))
    setStatus('Outer Pen: click four outer corners in order around the paper')
  }, [refreshSavedDebugOutline])

  const handleOpen = useCallback(async () => {
    setBusy(true)
    setStatus('Opening image...')
    try {
      const res = await window.serigraphica.openImage()
      if (!res) {
        setStatus('Ready')
        return
      }
      applyLoadedImage(res)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [applyLoadedImage])

  const handleCanvasDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    let imagePath = ''
    try {
      imagePath = window.serigraphica.filePathForDrop(file)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
      return
    }
    if (!imagePath) {
      setStatus('Could not read dropped file path')
      return
    }
    setBusy(true)
    setStatus('Opening dropped image...')
    try {
      const res = await window.serigraphica.openImagePath(imagePath)
      applyLoadedImage(res)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [applyLoadedImage])

  const pathForRole = useCallback((role: Role) => (role === 'outer' ? outerPath : innerPath), [innerPath, outerPath])

  const setPathForRole = useCallback((role: Role, next: RectPath | null) => {
    if (role === 'outer') setOuterPath(next)
    else setInnerPath(next)
  }, [])

  const handleStartDefaultPath = useCallback((role: Role) => {
    if (!image) return
    setPathForRole(role, defaultPath(image.width, image.height, role))
    setDrafts((prev) => ({ ...prev, [role]: [] }))
    setTool(role === 'outer' ? 'pen-outer' : 'pen-inner')
    setStatus(`${roleLabel(role)} path initialized. Drag nodes, drag yellow handles, or click a segment to add a node.`)
  }, [image, setPathForRole])

  const handleClearPath = useCallback((role: Role) => {
    setPathForRole(role, null)
    setDrafts((prev) => ({ ...prev, [role]: [] }))
    setTool(role === 'outer' ? 'pen-outer' : 'pen-inner')
    setStatus(`${roleLabel(role)} path cleared`)
  }, [setPathForRole])

  const handleAppendCorner = useCallback((role: Role, point: Point) => {
    if (pathForRole(role)) return
    const next = [...drafts[role], point]
    if (next.length >= 4) {
      setPathForRole(role, pathFromCorners(next))
      setDrafts((prev) => ({ ...prev, [role]: [] }))
      const nextRole: Role = role === 'outer' ? 'inner' : 'outer'
      setTool(role === 'outer' ? 'pen-inner' : 'pen-outer')
      setStatus(`${roleLabel(role)} path created. ${roleLabel(nextRole)} Pen is now active.`)
    } else {
      setDrafts((prev) => ({ ...prev, [role]: next }))
      setStatus(`${roleLabel(role)} Pen: click corner ${next.length + 1} of 4`)
    }
  }, [drafts, pathForRole, setPathForRole])

  const handleNodeChange = useCallback((role: Role, index: number, point: Point) => {
    const setter = role === 'outer' ? setOuterPath : setInnerPath
    setter((prev) => (prev ? movePathNode(prev, index, point) : prev))
  }, [])

  const handleHandleChange = useCallback((role: Role, index: number, handle: Point) => {
    const setter = role === 'outer' ? setOuterPath : setInnerPath
    setter((prev) => (prev ? setPathHandle(prev, index, handle) : prev))
  }, [])

  const handleInsertNode = useCallback((role: Role, segmentIndex: number, node: BezierNode) => {
    const setter = role === 'outer' ? setOuterPath : setInnerPath
    setter((prev) => (prev ? insertPathNode(prev, segmentIndex, node) : prev))
    setStatus(`${roleLabel(role)} node added`)
  }, [])

  const handleExport = useCallback(async () => {
    if (!image || !outerPath) return
    const corners = pathCorners(outerPath)
    if (!corners) {
      setStatus('Outer path does not have four corner nodes')
      return
    }
    setBusy(true)
    setStatus('Exporting...')
    try {
      const out = await window.serigraphica.exportCorrected(image.path, corners, 92)
      setStatus(`Exported ${out.outputWidth}x${out.outputHeight} -> ${out.outputPath}`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [image, outerPath])

  const handleProjectMesh = useCallback(() => {
    if (!outerPath) {
      setStatus('Create the outer path before projecting the mesh')
      return
    }
    setShowMesh((visible) => {
      const next = !visible
      setStatus(next ? 'Projected mesh inside the outer path' : 'Mesh hidden')
      return next
    })
  }, [outerPath])

  const handleSaveDebugOutlines = useCallback(() => {
    if (!image) return
    const targetFilename = imageFilename(image.path)
    try {
      const store = readDebugOutlineStore()
      store[targetFilename] = {
        version: 2,
        filename: targetFilename,
        savedAt: new Date().toISOString(),
        imageWidth: image.width,
        imageHeight: image.height,
        outerPath,
        innerPath
      }
      writeDebugOutlineStore(store)
      refreshSavedDebugOutline(targetFilename)
      setDebugMessage(`Saved manual paths for ${targetFilename}`)
      setStatus(`Saved manual paths for ${targetFilename}`)
    } catch (err) {
      const message = `Save failed: ${(err as Error).message}`
      setDebugMessage(message)
      setStatus(message)
    }
  }, [image, innerPath, outerPath, refreshSavedDebugOutline])

  const handleLoadDebugOutlines = useCallback(() => {
    if (!image) return
    const targetFilename = imageFilename(image.path)
    const saved = getSavedDebugOutline(targetFilename)
    if (!saved) {
      setDebugMessage(`No saved paths for ${targetFilename}`)
      return
    }
    setOuterPath(saved.outerPath)
    setInnerPath(saved.innerPath)
    setDrafts({ outer: [], inner: [] })
    setTool('pen-outer')
    refreshSavedDebugOutline(targetFilename)
    const sizeWarning = saved.imageWidth !== image.width || saved.imageHeight !== image.height
      ? ' Dimensions differ from the open image.'
      : ''
    const message = `Loaded manual paths for ${targetFilename}.${sizeWarning}`
    setDebugMessage(message)
    setStatus(message)
  }, [image, refreshSavedDebugOutline])

  const handleDeleteDebugOutlines = useCallback(() => {
    if (!image) return
    const targetFilename = imageFilename(image.path)
    try {
      const store = readDebugOutlineStore()
      delete store[targetFilename]
      writeDebugOutlineStore(store)
      refreshSavedDebugOutline(targetFilename)
      setDebugMessage(`Deleted saved paths for ${targetFilename}`)
      setStatus(`Deleted manual paths for ${targetFilename}`)
    } catch (err) {
      const message = `Delete failed: ${(err as Error).message}`
      setDebugMessage(message)
      setStatus(message)
    }
  }, [image, refreshSavedDebugOutline])

  useEffect(() => {
    if (!image) {
      setSavedDebugOutline(null)
      setDebugMessage('')
      return
    }
    refreshSavedDebugOutline(imageFilename(image.path))
  }, [image, refreshSavedDebugOutline])

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
      } else if (e.key === 'v' || e.key === ' ') {
        setTool('pan')
      } else if (e.key === '1') {
        setTool('pen-outer')
      } else if (e.key === '2') {
        setTool('pen-inner')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [image])

  const outerCorners = pathCorners(outerPath)
  const hasAnyPath = Boolean(outerPath || innerPath || drafts.outer.length || drafts.inner.length)
  const meshSliderColor = MESH_COLORS[meshColorIndex] === 'inverse' ? DEFAULT_ACCENT_COLOR : MESH_COLORS[meshColorIndex]
  const meshColorPercent = `${(meshColorIndex / (MESH_COLORS.length - 1)) * 100}%`

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={handleOpen} disabled={busy}>Open</button>
        <span className="sep" />
        <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')} title="Pan/move (V)">Pan</ToolButton>
        <ToolButton active={tool === 'pen-outer'} onClick={() => setTool('pen-outer')} title="Outer Pen (1)" color="#ff5e5e">Outer Pen</ToolButton>
        <ToolButton active={tool === 'pen-inner'} onClick={() => setTool('pen-inner')} title="Inner Pen (2)" color="#4ea1ff">Inner Pen</ToolButton>
        <span className="sep" />
        <button onClick={() => handleStartDefaultPath('outer')} disabled={busy || !image}>New Outer</button>
        <button onClick={() => handleStartDefaultPath('inner')} disabled={busy || !image}>New Inner</button>
        <span className="sep" />
        <ToolButton active={hideGuides} onClick={() => setHideGuides((hidden) => !hidden)} title="Hide node handles">
          Hide Handles
        </ToolButton>
        <ToolButton active={showMesh} onClick={handleProjectMesh} title="Project mesh inside the outer path">
          Project Mesh
        </ToolButton>
        <span className="sep" />
        <button onClick={() => canvasRef.current?.fitToView()} disabled={!image}>Fit</button>
        <button onClick={() => canvasRef.current?.zoomToActualSize()} disabled={!image}>100%</button>
        <span style={{ flex: 1 }} />
        <button onClick={handleExport} disabled={busy || !image || !outerCorners}>Export</button>
        {image && <span className="filename">{filename}</span>}
      </div>

      <div
        className={`canvas-host${dragActive ? ' is-dragging' : ''}${!image ? ' is-empty' : ''}`}
        onClick={!image ? handleOpen : undefined}
        onDragEnter={(e) => {
          e.preventDefault()
          setDragActive(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragActive(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          const nextTarget = e.relatedTarget
          if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return
          setDragActive(false)
        }}
        onDrop={handleCanvasDrop}
      >
        {image ? (
          <Canvas
            ref={canvasRef}
            src={image.dataUrl}
            imageWidth={image.width}
            imageHeight={image.height}
            tool={tool}
            outerPath={outerPath}
            innerPath={innerPath}
            outerDraft={drafts.outer}
            innerDraft={drafts.inner}
            hideGuides={hideGuides}
            showMesh={showMesh}
            meshDivisions={meshDivisions}
            meshColor={MESH_COLORS[meshColorIndex]}
            onAppendCorner={handleAppendCorner}
            onNodeChange={handleNodeChange}
            onHandleChange={handleHandleChange}
            onInsertNode={handleInsertNode}
          />
        ) : (
          <div className="empty-state">Open an image to begin</div>
        )}
      </div>

      <div className="panel">
        <section>
          <h3>Active tool</h3>
          <div style={{ color: '#ccc' }}>
            {tool === 'pan' && 'Pan - drag empty canvas to move the view'}
            {tool === 'pen-outer' && 'Outer Pen - mark/edit the paper perimeter'}
            {tool === 'pen-inner' && 'Inner Pen - mark/edit the print perimeter'}
          </div>
        </section>
        <section>
          <h3>Manual paths</h3>
          <PathRow label="Outer" color="#ff5e5e" path={outerPath} draftCount={drafts.outer.length} />
          <PathRow label="Inner" color="#4ea1ff" path={innerPath} draftCount={drafts.inner.length} />
          <div className="path-actions">
            <button onClick={() => handleClearPath('outer')} disabled={!outerPath && drafts.outer.length === 0}>Clear Outer</button>
            <button onClick={() => handleClearPath('inner')} disabled={!innerPath && drafts.inner.length === 0}>Clear Inner</button>
          </div>
        </section>
        <section>
          <h3>Projected mesh</h3>
          <div className="row">
            <label>State</label>
            <span style={{ color: showMesh ? '#88ffcd' : '#666' }}>{showMesh ? 'visible' : 'hidden'}</span>
          </div>
          <div className="row">
            <label>Density</label>
            <span>{meshDivisions}x{meshDivisions}</span>
          </div>
          <input
            type="range"
            min={4}
            max={24}
            value={meshDivisions}
            onChange={(e) => setMeshDivisions(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <label>Color</label>
            <span style={{ color: meshSliderColor }}>
              {MESH_COLOR_LABELS[meshColorIndex]}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={MESH_COLORS.length - 1}
            step={1}
            value={meshColorIndex}
            onChange={(e) => setMeshColorIndex(Number(e.target.value))}
            className="color-slider"
            style={{
              '--slider-color': meshSliderColor,
              '--slider-fill': meshColorPercent
            } as React.CSSProperties & Record<'--slider-color' | '--slider-fill', string>}
          />
          <div style={{ color: '#888', fontSize: 11, marginTop: 6 }}>
            Mesh is projected from the curved outer boundary. It updates live as nodes and handles move.
          </div>
        </section>
        <section>
          <h3>How to mark</h3>
          <div style={{ color: '#888', lineHeight: 1.5 }}>
            Use Outer Pen and click four outer corners in order around the paper. Repeat with Inner Pen for the print rectangle.
            After a path exists, drag nodes to move them. Click directly on a path segment to add a yellow side node; drag its yellow handles to shape the curve.
          </div>
        </section>
        <section>
          <h3>Shortcuts</h3>
          <div style={{ color: '#888', lineHeight: 1.5 }}>
            1 Outer Pen, 2 Inner Pen, V or Space Pan. <br />
            Cmd+0 fit, Cmd+1 100%.
          </div>
        </section>
      </div>

      <div className="statusbar">{status}</div>
      <div className="debug-outlines">
        {debugOpen && (
          <div className="debug-modal" role="dialog" aria-label="Debug manual paths">
            <div className="debug-modal-header">
              <strong>Debug paths</strong>
              <button onClick={() => setDebugOpen(false)} aria-label="Close debug paths">x</button>
            </div>
            <div className="debug-modal-body">
              <div className="debug-row">
                <span>Filename</span>
                <b>{filename || 'No image'}</b>
              </div>
              <div className="debug-row">
                <span>Current</span>
                <b>{outerPath?.nodes.length ?? 0} outer / {innerPath?.nodes.length ?? 0} inner</b>
              </div>
              <div className="debug-row">
                <span>Saved</span>
                <b>
                  {savedDebugOutline
                    ? `${savedDebugOutline.outerNodes} outer / ${savedDebugOutline.innerNodes} inner`
                    : 'None'}
                </b>
              </div>
              {savedDebugOutline && (
                <>
                  <div className="debug-row">
                    <span>Saved at</span>
                    <b>{new Date(savedDebugOutline.savedAt).toLocaleString()}</b>
                  </div>
                  <div className="debug-row">
                    <span>Size</span>
                    <b>{savedDebugOutline.imageWidth}x{savedDebugOutline.imageHeight}</b>
                  </div>
                </>
              )}
              {debugMessage && <div className="debug-message">{debugMessage}</div>}
              <div className="debug-actions">
                <button onClick={handleSaveDebugOutlines} disabled={!image || !hasAnyPath}>Save</button>
                <button onClick={handleLoadDebugOutlines} disabled={!image || !savedDebugOutline}>Load</button>
                <button onClick={handleDeleteDebugOutlines} disabled={!image || !savedDebugOutline}>Delete</button>
              </div>
            </div>
          </div>
        )}
        <button className="debug-fab" onClick={() => setDebugOpen((open) => !open)}>
          Debug
        </button>
      </div>
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

function PathRow({
  label,
  color,
  path,
  draftCount
}: {
  label: string
  color: string
  path: RectPath | null
  draftCount: number
}) {
  const text = path ? `${path.nodes.length} nodes` : draftCount ? `${draftCount}/4 corners` : 'not started'
  return (
    <div className="row">
      <label>{label}</label>
      <span style={{ color: path || draftCount ? color : '#666' }}>{text}</span>
    </div>
  )
}
