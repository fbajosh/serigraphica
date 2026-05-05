import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { Canvas, CanvasHandle } from './components/Canvas'
import type { BezierNode, DewarpProgress, Point, Quad, RectPath, Tool } from '../shared/types'

type Loaded = {
  path: string
  width: number
  height: number
  dataUrl: string
}

const DEBUG_OUTLINES_KEY = 'serigraphica.manualOutlines.v3'
const LEGACY_DEBUG_OUTLINES_KEY = 'serigraphica.manualOutlines.v2'
const DEFAULT_ACCENT_COLOR = '#ff5e5e'
const MESH_COLORS = ['inverse', '#ffffff', '#ff4d4d', '#ffd84d', '#5ee05e', '#4de8ff', '#4d79ff', '#ff5cff', '#000000'] as const
const MESH_COLOR_LABELS = ['Inverse', 'White', 'Red', 'Yellow', 'Green', 'Cyan', 'Blue', 'Magenta', 'Black'] as const
const RECTANGLE_COLORS = ['#ff5e5e', '#4ea1ff', '#4de8ff', '#5ee05e', '#ffd84d', '#ff5cff'] as const

type SavedManualOutline = {
  version: 3
  filename: string
  savedAt: string
  imageWidth: number
  imageHeight: number
  rectangles: RectPath[]
}

type LegacySavedManualOutline = {
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
  rectangleNodes: number[]
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
  const saved = readDebugOutlineStore()[filename]
  if (saved) return saved
  try {
    const raw = window.localStorage.getItem(LEGACY_DEBUG_OUTLINES_KEY)
    const legacyStore = raw ? JSON.parse(raw) as Record<string, LegacySavedManualOutline> : {}
    const legacy = legacyStore[filename]
    if (!legacy) return null
    return {
      version: 3,
      filename,
      savedAt: legacy.savedAt,
      imageWidth: legacy.imageWidth,
      imageHeight: legacy.imageHeight,
      rectangles: [legacy.outerPath, legacy.innerPath].filter(Boolean) as RectPath[]
    }
  } catch {
    return null
  }
}

function getSavedDebugOutlineMeta(filename: string): SavedManualOutlineMeta | null {
  const saved = getSavedDebugOutline(filename)
  if (!saved) return null
  return {
    savedAt: saved.savedAt,
    imageWidth: saved.imageWidth,
    imageHeight: saved.imageHeight,
    rectangleNodes: saved.rectangles.map((path) => path.nodes.length)
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

function deletePathNode(path: RectPath, index: number): RectPath {
  const nodes = path.nodes.filter((_, i) => i !== index)
  const cornerIndices = path.cornerIndices.map((cornerIndex) => (
    cornerIndex > index ? cornerIndex - 1 : cornerIndex
  )) as [number, number, number, number]
  return { nodes, cornerIndices }
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

function deriveRectangles(rectangles: RectPath[]) {
  if (rectangles.length === 0) {
    return { outerIndex: null as number | null, outerPath: null as RectPath | null, innerIndices: [] as number[], innerPaths: [] as RectPath[] }
  }
  const sorted = rectangles
    .map((path, index) => ({ path, index, area: pathArea(path) }))
    .sort((a, b) => b.area - a.area)
  return {
    outerIndex: sorted[0].index,
    outerPath: sorted[0].path,
    innerIndices: sorted.slice(1).map((entry) => entry.index),
    innerPaths: sorted.slice(1).map((entry) => entry.path)
  }
}

function rectangleColor(index: number, outerIndex: number | null): string {
  if (index === outerIndex) return RECTANGLE_COLORS[0]
  return RECTANGLE_COLORS[(index % (RECTANGLE_COLORS.length - 1)) + 1]
}

function rectangleLabel(index: number, outerIndex: number | null, innerIndices: number[]): string {
  if (index === outerIndex) return 'Outer'
  const innerPosition = innerIndices.indexOf(index)
  return innerPosition >= 0 ? `Inner ${innerPosition + 1}` : `Rectangle ${index + 1}`
}

export function App() {
  const [image, setImage] = useState<Loaded | null>(null)
  const [tool, setTool] = useState<Tool>('pen-rectangle')
  const [rectangles, setRectangles] = useState<RectPath[]>([])
  const [activeRectangleIndex, setActiveRectangleIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<Point[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Open an image to begin')
  const [hideGuides, setHideGuides] = useState(false)
  const [showMesh, setShowMesh] = useState(false)
  const [meshDivisions, setMeshDivisions] = useState(10)
  const [meshColorIndex, setMeshColorIndex] = useState(0)
  const [zoomLevel, setZoomLevel] = useState(1)
  const [dewarpPreview, setDewarpPreview] = useState<Loaded | null>(null)
  const [dewarpProgress, setDewarpProgress] = useState<DewarpProgress | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [debugMessage, setDebugMessage] = useState('')
  const [savedDebugOutline, setSavedDebugOutline] = useState<SavedManualOutlineMeta | null>(null)
  const canvasRef = useRef<CanvasHandle>(null)
  const filename = image ? imageFilename(image.path) : ''

  const refreshSavedDebugOutline = useCallback((targetFilename: string) => {
    setSavedDebugOutline(getSavedDebugOutlineMeta(targetFilename))
  }, [])

  const applyLoadedImage = useCallback((res: Loaded) => {
    setImage(res)
    setRectangles([])
    setActiveRectangleIndex(null)
    setDraft([])
    setTool('pen-rectangle')
    setShowMesh(false)
    setMeshColorIndex(0)
    setZoomLevel(1)
    setDewarpPreview(null)
    setDebugMessage('')
    refreshSavedDebugOutline(imageFilename(res.path))
    setStatus('Add Rectangle: click four corners around the next rectangle')
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

  const setRectangleAt = useCallback((rectangleIndex: number, updater: (path: RectPath) => RectPath) => {
    setRectangles((prev) => prev.map((path, index) => (index === rectangleIndex ? updater(path) : path)))
  }, [])

  const handleAddRectangle = useCallback(() => {
    if (!image) return
    setDraft([])
    setActiveRectangleIndex(null)
    setTool('pen-rectangle')
    setDewarpPreview(null)
    setStatus('Add Rectangle: click corner 1 of 4')
  }, [image])

  const handleResetAll = useCallback(() => {
    setRectangles([])
    setActiveRectangleIndex(null)
    setDraft([])
    setDewarpPreview(null)
    setShowMesh(false)
    setTool('pen-rectangle')
    setStatus('Reset all rectangles')
  }, [])

  const handleAppendCorner = useCallback((point: Point) => {
    const next = [...draft, point]
    if (next.length >= 4) {
      const path = pathFromCorners(next)
      setRectangles((prev) => [...prev, path])
      setActiveRectangleIndex(rectangles.length)
      setDraft([])
      setStatus('Rectangle created. Drag nodes, add side nodes, or press Add Rectangle for another.')
    } else {
      setDraft(next)
      setStatus(`Add Rectangle: click corner ${next.length + 1} of 4`)
    }
  }, [draft, rectangles.length])

  const handleNodeChange = useCallback((rectangleIndex: number, nodeIndex: number, point: Point) => {
    setRectangleAt(rectangleIndex, (path) => movePathNode(path, nodeIndex, point))
    setActiveRectangleIndex(rectangleIndex)
    setDewarpPreview(null)
  }, [setRectangleAt])

  const handleHandleChange = useCallback((rectangleIndex: number, nodeIndex: number, handle: Point) => {
    setRectangleAt(rectangleIndex, (path) => setPathHandle(path, nodeIndex, handle))
    setActiveRectangleIndex(rectangleIndex)
    setDewarpPreview(null)
  }, [setRectangleAt])

  const handleInsertNode = useCallback((rectangleIndex: number, segmentIndex: number, node: BezierNode) => {
    setRectangleAt(rectangleIndex, (path) => insertPathNode(path, segmentIndex, node))
    setActiveRectangleIndex(rectangleIndex)
    setDewarpPreview(null)
    setStatus('Rectangle node added')
  }, [setRectangleAt])

  const handleDeleteNode = useCallback((rectangleIndex: number, nodeIndex: number) => {
    const path = rectangles[rectangleIndex]
    const node = path?.nodes[nodeIndex]
    if (!path || !node) return
    if (node.corner) {
      setStatus('Corner nodes cannot be deleted')
      return
    }
    setRectangleAt(rectangleIndex, (prevPath) => deletePathNode(prevPath, nodeIndex))
    setActiveRectangleIndex(rectangleIndex)
    setDewarpPreview(null)
    setStatus('Rectangle node deleted')
  }, [rectangles, setRectangleAt])

  const handleExport = useCallback(async () => {
    if (!image) return
    if (rectangles.length === 0) {
      setStatus('Create at least one rectangle first')
      return
    }
    setBusy(true)
    setDewarpProgress(null)
    setStatus(rectangles.length >= 2 ? 'Exporting dewarped image...' : 'Exporting perspective image...')
    try {
      const out = await window.serigraphica.exportDewarped(image.path, rectangles, 92)
      setStatus(`Exported ${out.outputWidth}x${out.outputHeight} -> ${out.outputPath}`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [image, rectangles])

  const handleExportAs = useCallback(async () => {
    if (!image) return
    if (rectangles.length === 0) {
      setStatus('Create at least one rectangle first')
      return
    }
    setBusy(true)
    setDewarpProgress(null)
    setStatus(rectangles.length >= 2 ? 'Exporting dewarped image...' : 'Exporting perspective image...')
    try {
      const out = await window.serigraphica.exportDewarpedAs(image.path, rectangles, 92)
      if (!out) {
        setStatus('Export cancelled')
        return
      }
      setStatus(`Exported ${out.outputWidth}x${out.outputHeight} -> ${out.outputPath}`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [image, rectangles])

  const handleDewarp = useCallback(async () => {
    if (!image) return
    if (dewarpPreview) {
      setDewarpPreview(null)
      setDewarpProgress(null)
      setStatus('Returned to original image')
      return
    }
    if (rectangles.length < 2) {
      setStatus('Create at least two rectangles for mesh dewarp')
      return
    }
    setBusy(true)
    setDewarpProgress({ percent: 0, stage: 'Starting', operation: 'preview' })
    setStatus('Generating dewarp preview...')
    try {
      const preview = await window.serigraphica.previewDewarped(image.path, rectangles, 92)
      setDewarpPreview(preview)
      setStatus(`Dewarp preview ${preview.width}x${preview.height}`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setDewarpProgress(null)
      setBusy(false)
    }
  }, [dewarpPreview, image, rectangles])

  const handleProjectMesh = useCallback(() => {
    if (rectangles.length < 2) {
      setStatus('Create at least two rectangles before projecting the mesh')
      return
    }
    setShowMesh((visible) => {
      const next = !visible
      setStatus(next ? 'Projected mesh using all rectangles' : 'Mesh hidden')
      return next
    })
  }, [rectangles.length])

  const handleSaveDebugOutlines = useCallback(() => {
    if (!image) return
    const targetFilename = imageFilename(image.path)
    try {
      const store = readDebugOutlineStore()
      store[targetFilename] = {
        version: 3,
        filename: targetFilename,
        savedAt: new Date().toISOString(),
        imageWidth: image.width,
        imageHeight: image.height,
        rectangles
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
  }, [image, rectangles, refreshSavedDebugOutline])

  const handleLoadDebugOutlines = useCallback(() => {
    if (!image) return
    const targetFilename = imageFilename(image.path)
    const saved = getSavedDebugOutline(targetFilename)
    if (!saved) {
      setDebugMessage(`No saved paths for ${targetFilename}`)
      return
    }
    setRectangles(saved.rectangles)
    setDraft([])
    setActiveRectangleIndex(saved.rectangles.length ? 0 : null)
    setTool('pen-rectangle')
    setShowMesh(false)
    setDewarpPreview(null)
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
    return window.serigraphica.onDewarpProgress((progress) => {
      if (progress.operation !== 'preview') return
      setDewarpProgress(progress)
    })
  }, [])

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
      } else if (e.key === 'a') {
        handleAddRectangle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleAddRectangle, image])

  const derivedRectangles = deriveRectangles(rectangles)
  const outerCorners = pathCorners(derivedRectangles.outerPath)
  const hasAnyPath = Boolean(rectangles.length || draft.length)
  const displayImage = dewarpPreview ?? image
  const dewarpActive = Boolean(dewarpPreview)
  const displayFilename = dewarpActive ? `${filename} preview` : filename
  const meshVisibleInCanvas = showMesh && !dewarpActive
  const meshSliderColor = MESH_COLORS[meshColorIndex] === 'inverse' ? DEFAULT_ACCENT_COLOR : MESH_COLORS[meshColorIndex]
  const meshLabelColor = MESH_COLORS[meshColorIndex] === 'inverse' ? '#fff' : meshSliderColor
  const meshColorPercent = `${(meshColorIndex / (MESH_COLORS.length - 1)) * 100}%`
  const dewarpButtonLabel = dewarpProgress
    ? `Dewarping...${Math.round(Math.max(0, Math.min(100, dewarpProgress.percent)))}%`
    : 'Dewarp'

  return (
    <div className="app">
      <div className="main-toolbar">
        <div className="toolbar-group">
          <button onClick={handleOpen} disabled={busy}>Open</button>
        </div>
        <span className="sep" />
        <div className="toolbar-group">
          <ToolButton active={tool === 'pen-rectangle'} onClick={handleAddRectangle} disabled={!image} title="Add rectangle (A)">
            Add
          </ToolButton>
          <ToolButton active={tool === 'pan'} onClick={() => setTool('pan')} title="Pan/move (V)">Pan</ToolButton>
          <button onClick={handleResetAll} disabled={!hasAnyPath}>Reset</button>
        </div>
        <span className="sep" />
        <div className="toolbar-group">
          <ToolButton active={showMesh} onClick={handleProjectMesh} title="Project mesh using both rectangles">
            Mesh
          </ToolButton>
          <ToolButton active={dewarpActive} onClick={handleDewarp} disabled={busy || !image || rectangles.length < 2} title="Toggle dewarp preview" className="dewarp-button">
            {dewarpButtonLabel}
          </ToolButton>
        </div>
        <span className="sep" />
        <div className="toolbar-group">
          <button onClick={handleExport} disabled={busy || !image || !outerCorners}>Export</button>
          <button onClick={handleExportAs} disabled={busy || !image || !outerCorners}>Export As</button>
        </div>
      </div>

      <div className="view-toolbar">
        <button onClick={() => canvasRef.current?.fitToView()} disabled={!image}>Fit</button>
        <button onClick={() => canvasRef.current?.zoomToActualSize()} disabled={!image}>100%</button>
        <span className="view-pill">{Math.round(zoomLevel * 100)}%</span>
        <span className="view-pill filename-pill">{displayFilename || 'No file'}</span>
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
        {displayImage ? (
          <Canvas
            key={displayImage.path}
            ref={canvasRef}
            src={displayImage.dataUrl}
            imageWidth={displayImage.width}
            imageHeight={displayImage.height}
            tool={dewarpActive ? 'pan' : tool}
            rectangles={dewarpActive ? [] : rectangles}
            draft={dewarpActive ? [] : draft}
            activeRectangleIndex={dewarpActive ? null : activeRectangleIndex}
            hideGuides={hideGuides}
            showMesh={meshVisibleInCanvas}
            meshDivisions={meshDivisions}
            meshColor={MESH_COLORS[meshColorIndex]}
            onViewChange={setZoomLevel}
            onAppendCorner={handleAppendCorner}
            onNodeChange={handleNodeChange}
            onHandleChange={handleHandleChange}
            onInsertNode={handleInsertNode}
            onDeleteNode={handleDeleteNode}
            onActivateRectangle={setActiveRectangleIndex}
          />
        ) : (
          <div className="empty-state">Open an image to begin</div>
        )}
      </div>

      <div className="panel">
        <section>
          <h3>Active tool</h3>
          <div style={{ color: '#ccc' }}>
            {dewarpActive && 'Dewarp preview - press Dewarp again to return to the original image'}
            {!dewarpActive && tool === 'pan' && 'Pan - drag empty canvas to move the view'}
            {!dewarpActive && tool === 'pen-rectangle' && (draft.length ? `Add Rectangle - click corner ${draft.length + 1} of 4` : 'Rectangle tool - edit active rectangle or press Add Rectangle for a new one')}
          </div>
        </section>
        <section>
          <h3>Rectangles</h3>
          {rectangles.length === 0 && !draft.length && (
            <div style={{ color: '#666' }}>none</div>
          )}
          {rectangles.map((path, index) => (
            <PathRow
              key={index}
              label={rectangleLabel(index, derivedRectangles.outerIndex, derivedRectangles.innerIndices)}
              color={rectangleColor(index, derivedRectangles.outerIndex)}
              path={path}
              draftCount={0}
              active={activeRectangleIndex === index}
            />
          ))}
          {draft.length > 0 && (
            <PathRow label="Draft" color="#4ea1ff" path={null} draftCount={draft.length} active />
          )}
          <div className="path-actions">
            <ToolButton active={hideGuides} onClick={() => setHideGuides((hidden) => !hidden)} title="Hide node handles">
              Hide Handles
            </ToolButton>
          </div>
        </section>
        <section>
          <h3>Projected mesh</h3>
          <div className="row">
            <label>State</label>
            <span style={{ color: meshVisibleInCanvas ? '#88ffcd' : '#666' }}>
              {meshVisibleInCanvas ? 'visible' : dewarpActive && showMesh ? 'hidden in preview' : 'hidden'}
            </span>
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
            <span style={{ color: meshLabelColor }}>
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
            Mesh derives the largest rectangle as outer and uses every smaller rectangle as a smooth interior constraint.
          </div>
        </section>
        <section>
          <h3>Shortcuts</h3>
          <div style={{ color: '#888', lineHeight: 1.5 }}>
            A Add Rectangle, V or Space Pan. <br />
            Cmd+0 fit, Cmd+1 100%.
          </div>
        </section>
        <section className="debug-section">
          <h3>File info</h3>
          <div className="debug-row">
            <span>Filename</span>
            <b>{filename || 'No image'}</b>
          </div>
          <div className="debug-row">
            <span>Current</span>
            <b>{rectangles.length} rectangles</b>
          </div>
          <div className="debug-row">
            <span>Saved</span>
            <b>
              {savedDebugOutline
                ? `${savedDebugOutline.rectangleNodes.length} rectangles`
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
            <button onClick={handleSaveDebugOutlines} disabled={!image || rectangles.length === 0}>Save</button>
            <button onClick={handleLoadDebugOutlines} disabled={!image || !savedDebugOutline}>Load</button>
            <button onClick={handleDeleteDebugOutlines} disabled={!image || !savedDebugOutline}>Delete</button>
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
  className,
  disabled = false,
  onClick,
  title,
  children
}: {
  active: boolean
  color?: string
  className?: string
  disabled?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      className={className}
      disabled={disabled}
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
  draftCount,
  active = false
}: {
  label: string
  color: string
  path: RectPath | null
  draftCount: number
  active?: boolean
}) {
  const text = path ? `${path.nodes.length} nodes` : draftCount ? `${draftCount}/4 corners` : 'not started'
  return (
    <div className="row">
      <label>{active ? `${label} *` : label}</label>
      <span style={{ color: path || draftCount ? color : '#666' }}>{text}</span>
    </div>
  )
}
