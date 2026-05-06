import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { buildFillSampleRegions, Canvas, CanvasHandle } from './components/Canvas'
import type { BezierNode, DewarpProgress, FillShape, Point, Quad, RectPath, Tool } from '../shared/types'

type Loaded = {
  path: string
  width: number
  height: number
  dataUrl: string
  method?: string
}

const DEBUG_OUTLINES_KEY = 'serigraphica.manualOutlines.v3'
const LEGACY_DEBUG_OUTLINES_KEY = 'serigraphica.manualOutlines.v2'
const MESH_COLORS = ['inverse', '#ffffff', '#ff4d4d', '#ffd84d', '#5ee05e', '#4de8ff', '#4d79ff', '#ff5cff', '#000000'] as const
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

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const intersects = ((a[1] > point[1]) !== (b[1] > point[1])) &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / ((b[1] - a[1]) || 1e-9) + a[0]
    if (intersects) inside = !inside
  }
  return inside
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)
  return abC * abD < 0 && cdA * cdB < 0
}

function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.some((point) => pointInPolygon(point, b)) || b.some((point) => pointInPolygon(point, a))) return true
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true
    }
  }
  return false
}

function overlapsAnyFillShape(candidate: FillShape, shapes: FillShape[], ignoreIndex: number | null = null): boolean {
  return shapes.some((shape, index) => index !== ignoreIndex && polygonsOverlap(candidate.points, shape.points))
}

export function App() {
  const [image, setImage] = useState<Loaded | null>(null)
  const [tool, setTool] = useState<Tool>('pen-rectangle')
  const [rectangles, setRectangles] = useState<RectPath[]>([])
  const [activeRectangleIndex, setActiveRectangleIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState<Point[]>([])
  const [fillShapes, setFillShapes] = useState<FillShape[]>([])
  const [fillDraft, setFillDraft] = useState<Point[]>([])
  const [activeFillShapeIndex, setActiveFillShapeIndex] = useState<number | null>(null)
  const [filledImage, setFilledImage] = useState<Loaded | null>(null)
  const [fillDirty, setFillDirty] = useState(false)
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
  const dewarpCancelRequestedRef = useRef(false)
  const filename = image ? imageFilename(image.path) : ''

  const refreshSavedDebugOutline = useCallback((targetFilename: string) => {
    setSavedDebugOutline(getSavedDebugOutlineMeta(targetFilename))
  }, [])

  const applyLoadedImage = useCallback((res: Loaded) => {
    const targetFilename = imageFilename(res.path)
    const saved = getSavedDebugOutline(targetFilename)
    const savedRectangles = saved?.rectangles ?? []
    setImage(res)
    setRectangles(savedRectangles)
    setActiveRectangleIndex(savedRectangles.length ? 0 : null)
    setDraft([])
    setFillShapes([])
    setFillDraft([])
    setActiveFillShapeIndex(null)
    setFilledImage(null)
    setFillDirty(false)
    setTool('pen-rectangle')
    setShowMesh(savedRectangles.length > 0)
    setMeshColorIndex(0)
    setZoomLevel(1)
    setDewarpPreview(null)
    const sizeWarning = saved && (saved.imageWidth !== res.width || saved.imageHeight !== res.height)
      ? ' Dimensions differ from the open image.'
      : ''
    setDebugMessage(saved ? `Loaded saved paths for ${targetFilename}.${sizeWarning}` : '')
    refreshSavedDebugOutline(targetFilename)
    setStatus(saved
      ? `Loaded saved paths for ${targetFilename}.${sizeWarning}`
      : 'Draw: click four corners around the next rectangle')
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

  const handleDrawMode = useCallback(() => {
    if (!image) return
    setFillDraft([])
    setTool('pen-rectangle')
    setStatus(draft.length ? `Draw: click corner ${draft.length + 1} of 4` : 'Draw: click empty canvas to start a rectangle')
  }, [draft.length, image])

  const handlePanMode = useCallback(() => {
    if (!image) return
    setDraft([])
    setFillDraft([])
    setTool('pan')
    setStatus('Pan - drag empty canvas to move the view')
  }, [image])

  const clearDewarpOutputs = useCallback(() => {
    setDewarpPreview(null)
    setFilledImage(null)
    setFillDirty(false)
  }, [])

  const markFillDirty = useCallback(() => {
    setFillDirty((wasDirty) => wasDirty || Boolean(filledImage))
  }, [filledImage])

  const handleFillAddMode = useCallback(() => {
    if (!image) return
    if (!dewarpPreview) {
      setStatus('Dewarp before drawing fill masks')
      return
    }
    setTool('fill')
    setDraft([])
    setStatus(fillDraft.length ? `Fill: click point ${fillDraft.length + 1} of 4` : 'Fill: click four points around the object to remove')
  }, [dewarpPreview, fillDraft.length, image])

  const handleResetAll = useCallback(() => {
    setRectangles([])
    setActiveRectangleIndex(null)
    setDraft([])
    clearDewarpOutputs()
    setShowMesh(false)
    setTool('pen-rectangle')
    setStatus('Reset all rectangles')
  }, [clearDewarpOutputs])

  const handleAppendCorner = useCallback((point: Point) => {
    const next = [...draft, point]
    if (next.length >= 4) {
      const path = pathFromCorners(next)
      setRectangles((prev) => [...prev, path])
      setActiveRectangleIndex(rectangles.length)
      setDraft([])
      setShowMesh(true)
      setStatus('Rectangle created. Click empty canvas to draw another, or edit nodes/edges.')
    } else {
      if (next.length === 1) setActiveRectangleIndex(null)
      setDraft(next)
      setStatus(`Draw: click corner ${next.length + 1} of 4`)
    }
  }, [draft, rectangles.length])

  const handleDeleteRectangle = useCallback((rectangleIndex: number) => {
    const nextRectangles = rectangles.filter((_, index) => index !== rectangleIndex)
    setRectangles(nextRectangles)
    setDraft([])
    clearDewarpOutputs()
    setShowMesh(nextRectangles.length > 0 ? showMesh : false)
    setActiveRectangleIndex((activeIndex) => {
      if (activeIndex === null) return null
      if (activeIndex === rectangleIndex) return null
      return activeIndex > rectangleIndex ? activeIndex - 1 : activeIndex
    })
    setStatus('Rectangle deleted')
  }, [clearDewarpOutputs, rectangles, showMesh])

  const handleNodeChange = useCallback((rectangleIndex: number, nodeIndex: number, point: Point) => {
    setRectangleAt(rectangleIndex, (path) => movePathNode(path, nodeIndex, point))
    setActiveRectangleIndex(rectangleIndex)
    clearDewarpOutputs()
  }, [clearDewarpOutputs, setRectangleAt])

  const handleHandleChange = useCallback((rectangleIndex: number, nodeIndex: number, handle: Point) => {
    setRectangleAt(rectangleIndex, (path) => setPathHandle(path, nodeIndex, handle))
    setActiveRectangleIndex(rectangleIndex)
    clearDewarpOutputs()
  }, [clearDewarpOutputs, setRectangleAt])

  const handleInsertNode = useCallback((rectangleIndex: number, segmentIndex: number, node: BezierNode) => {
    setRectangleAt(rectangleIndex, (path) => insertPathNode(path, segmentIndex, node))
    setActiveRectangleIndex(rectangleIndex)
    clearDewarpOutputs()
    setStatus('Rectangle node added')
  }, [clearDewarpOutputs, setRectangleAt])

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
    clearDewarpOutputs()
    setStatus('Rectangle node deleted')
  }, [clearDewarpOutputs, rectangles, setRectangleAt])

  const handleAppendFillPoint = useCallback((point: Point) => {
    const next = [...fillDraft, point]
    if (next.length >= 4) {
      const shape: FillShape = { points: next.slice(0, 4) as Quad }
      if (overlapsAnyFillShape(shape, fillShapes)) {
        setStatus('Fill shapes cannot overlap')
        return
      }
      setFillShapes((prev) => [...prev, shape])
      setActiveFillShapeIndex(fillShapes.length)
      setFillDraft([])
      markFillDirty()
      setStatus('Fill shape added. Click again to start another fill shape.')
      return
    }
    setFillDraft(next)
    setActiveFillShapeIndex(null)
    setStatus(`Fill: click point ${next.length + 1} of 4`)
  }, [fillDraft, fillShapes, markFillDirty])

  const handleFillPointChange = useCallback((shapeIndex: number, pointIndex: number, point: Point) => {
    const current = fillShapes[shapeIndex]
    if (!current) return
    const points = current.points.map((existing, index) => (index === pointIndex ? point : existing)) as Quad
    const nextShape: FillShape = { points }
    if (overlapsAnyFillShape(nextShape, fillShapes, shapeIndex)) {
      setStatus('Fill shapes cannot overlap')
      return
    }
    setFillShapes((prev) => prev.map((shape, index) => (index === shapeIndex ? nextShape : shape)))
    setActiveFillShapeIndex(shapeIndex)
    markFillDirty()
  }, [fillShapes, markFillDirty])

  const handleDeleteFillPoint = useCallback((shapeIndex: number | null, pointIndex: number) => {
    if (shapeIndex === null) {
      setFillDraft((prev) => prev.filter((_, index) => index !== pointIndex))
      setStatus('Fill point deleted')
      return
    }
    setFillShapes((prev) => prev.filter((_, index) => index !== shapeIndex))
    setActiveFillShapeIndex(null)
    markFillDirty()
    setStatus('Fill shape deleted')
  }, [markFillDirty])

  const handleResetFill = useCallback(() => {
    setFillShapes([])
    setFillDraft([])
    setActiveFillShapeIndex(null)
    setFilledImage(null)
    setFillDirty(false)
    setStatus('Fill shapes reset')
  }, [])

  const handleFillAction = useCallback(async () => {
    if (!image) return
    if (filledImage && !fillDirty) {
      setFilledImage(null)
      setStatus('Fill removed')
      return
    }
    if (fillShapes.length === 0) {
      setStatus('Add at least one fill shape first')
      return
    }
    if (!dewarpPreview) {
      setStatus('Dewarp before running Fill')
      return
    }
    setBusy(true)
    setStatus(filledImage ? 'Refilling image...' : 'Filling image...')
    try {
      const filled = await window.serigraphica.previewFilled(dewarpPreview.path, fillShapes, 98, buildFillSampleRegions(rectangles))
      setFilledImage(filled)
      setFillDirty(false)
      setTool('pan')
      setStatus(`Fill preview ${filled.width}x${filled.height}${filled.method ? ` (${filled.method})` : ''}`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [dewarpPreview, fillDirty, fillShapes, filledImage, image, rectangles])

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
      const exportFillShapes = filledImage || fillDirty ? fillShapes : []
      const out = await window.serigraphica.exportDewarped(image.path, rectangles, 92, image.path, exportFillShapes, buildFillSampleRegions(rectangles))
      setStatus(`Exported ${out.outputWidth}x${out.outputHeight} -> ${out.outputPath}`)
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [fillDirty, fillShapes, filledImage, image, rectangles])

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
      const exportFillShapes = filledImage || fillDirty ? fillShapes : []
      const out = await window.serigraphica.exportDewarpedAs(image.path, rectangles, 92, image.path, exportFillShapes, buildFillSampleRegions(rectangles))
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
  }, [fillDirty, fillShapes, filledImage, image, rectangles])

  const handleDewarp = useCallback(async () => {
    if (dewarpProgress) {
      dewarpCancelRequestedRef.current = true
      setStatus('Cancelling dewarp...')
      try {
        await window.serigraphica.cancelDewarp()
      } catch (err) {
        setStatus(`Error: ${(err as Error).message}`)
      }
      return
    }
    if (!image) return
    if (dewarpPreview) {
      setDewarpPreview(null)
      setDewarpProgress(null)
      setTool('pan')
      setStatus('Returned to original image')
      return
    }
    if (rectangles.length < 2) {
      setStatus('Create at least two rectangles for mesh dewarp')
      return
    }
    setBusy(true)
    dewarpCancelRequestedRef.current = false
    setDewarpProgress({ percent: 0, stage: 'Starting', operation: 'preview' })
    setStatus('Generating dewarp preview...')
    try {
      const preview = await window.serigraphica.previewDewarped(image.path, rectangles, 92, image.path)
      setDewarpPreview(preview)
      setFillDirty(Boolean(filledImage))
      setStatus(`Dewarp preview ${preview.width}x${preview.height}`)
    } catch (err) {
      setStatus(dewarpCancelRequestedRef.current ? 'Dewarp cancelled' : `Error: ${(err as Error).message}`)
    } finally {
      dewarpCancelRequestedRef.current = false
      setDewarpProgress(null)
      setBusy(false)
    }
  }, [dewarpPreview, dewarpProgress, filledImage, image, rectangles])

  const handleProjectMesh = useCallback(() => {
    if (rectangles.length < 1) {
      setStatus('Create at least one rectangle before projecting the mesh')
      return
    }
    if (dewarpPreview) {
      setDewarpPreview(null)
      setDewarpProgress(null)
      setShowMesh(true)
      setTool('pan')
      setStatus('Returned to projected mesh')
      return
    }
    setShowMesh((visible) => {
      const next = !visible
      setStatus(next ? 'Mesh shown' : 'Mesh hidden')
      return next
    })
  }, [dewarpPreview, rectangles.length])

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
      } else if (e.key === 'Backspace' && draft.length > 0) {
        e.preventDefault()
        setDraft((prev) => {
          const next = prev.slice(0, -1)
          setStatus(next.length ? `Draw: click corner ${next.length + 1} of 4` : 'Draw: click corner 1 of 4')
          return next
        })
      } else if (e.key === 'Backspace' && fillDraft.length > 0) {
        e.preventDefault()
        setFillDraft((prev) => {
          const next = prev.slice(0, -1)
          setStatus(next.length ? `Fill: click point ${next.length + 1} of 4` : 'Fill: click point 1 of 4')
          return next
        })
      } else if (e.key === 'Escape' && draft.length > 0) {
        e.preventDefault()
        setDraft([])
        setStatus('Incomplete rectangle cancelled')
      } else if (e.key === 'Escape' && fillDraft.length > 0) {
        e.preventDefault()
        setFillDraft([])
        setStatus('Incomplete fill shape cancelled')
      } else if (e.key === 'v' || e.key === ' ') {
        setTool('pan')
      } else if (e.key === 'a' || e.key === 'd') {
        handleDrawMode()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft.length, fillDraft.length, handleDrawMode, image])

  const derivedRectangles = deriveRectangles(rectangles)
  const outerCorners = pathCorners(derivedRectangles.outerPath)
  const hasAnyPath = Boolean(rectangles.length || draft.length)
  const dewarpActive = Boolean(dewarpPreview)
  const activeFilledImage = dewarpActive && filledImage && !fillDirty ? filledImage : null
  const displayImage = activeFilledImage ?? dewarpPreview ?? image
  const displayFilename = dewarpActive ? `${filename} preview` : filename
  const meshVisibleInCanvas = showMesh && !dewarpActive
  const fillOverlayVisible = dewarpActive && !activeFilledImage
  const fillButtonLabel = filledImage ? (fillDirty ? 'Refill' : 'Unfill') : 'Fill'
  const fillActionEnabled = !busy && ((filledImage && !fillDirty) || (dewarpActive && fillShapes.length > 0))
  const dewarpButtonLabel = dewarpProgress
    ? `Dewarping...${Math.round(Math.max(0, Math.min(100, dewarpProgress.percent)))}%`
    : 'Dewarp'
  const dewarpButtonClass = dewarpProgress ? 'dewarp-button dewarp-button--busy' : 'dewarp-button'

  return (
    <div className="app">
      <div className="app-titlebar">
        <div className="app-title">Serigraphica</div>
        <div className="titlebar-status">{status}</div>
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
            tool={activeFilledImage ? 'pan' : dewarpActive ? (tool === 'fill' ? 'fill' : 'pan') : tool === 'fill' ? 'pan' : tool}
            rectangles={dewarpActive ? [] : rectangles}
            draft={dewarpActive ? [] : draft}
            fillShapes={fillOverlayVisible ? fillShapes : []}
            fillDraft={fillOverlayVisible ? fillDraft : []}
            activeFillShapeIndex={fillOverlayVisible ? activeFillShapeIndex : null}
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
            onAppendFillPoint={handleAppendFillPoint}
            onFillPointChange={handleFillPointChange}
            onDeleteFillPoint={handleDeleteFillPoint}
            onActivateFillShape={setActiveFillShapeIndex}
          />
        ) : (
          <div className="empty-state">Open an image to begin</div>
        )}
      </div>

      <div className="panel">
        <section className="panel-workflow-section">
          <h3>File</h3>
          <div className="path-actions file-actions">
            <button onClick={handleOpen} disabled={busy}>Open</button>
            <input className="filename-input" type="text" value={filename || 'No image'} readOnly />
          </div>
        </section>
        <section className="panel-workflow-section">
          <h3>Window</h3>
          <div className="path-actions">
            <span className="view-pill">{Math.round(zoomLevel * 100)}%</span>
            <button onClick={() => canvasRef.current?.fitToView()} disabled={!image}>Fit</button>
            <button onClick={() => canvasRef.current?.zoomToActualSize()} disabled={!image}>100%</button>
          </div>
        </section>
        <section className="panel-workflow-section">
          <h3>Guides</h3>
          <div className="path-actions guide-tool-actions">
            <ToolButton active={tool === 'pen-rectangle'} onClick={handleDrawMode} disabled={!image} title="Draw rectangles">
              Draw
            </ToolButton>
            <ToolButton active={tool === 'pan'} onClick={handlePanMode} disabled={!image} title="Pan/move">
              Pan
            </ToolButton>
          </div>
          <div className="rectangle-list-box">
            {rectangles.length === 0 && !draft.length && (
              <div className="rectangle-list-empty">none</div>
            )}
            {rectangles.map((path, index) => (
              <PathRow
                key={index}
                label={rectangleLabel(index, derivedRectangles.outerIndex, derivedRectangles.innerIndices)}
                color={rectangleColor(index, derivedRectangles.outerIndex)}
                path={path}
                draftCount={0}
                active={activeRectangleIndex === index}
                onDelete={() => handleDeleteRectangle(index)}
              />
            ))}
            {draft.length > 0 && (
              <PathRow label="Draft" color="#4ea1ff" path={null} draftCount={draft.length} active />
            )}
          </div>
          <div className="path-actions guide-line-actions">
            <button onClick={handleResetAll} disabled={!hasAnyPath}>Reset Lines</button>
            <button onClick={handleSaveDebugOutlines} disabled={!image || rectangles.length === 0}>Save Lines</button>
          </div>
          <div className="path-actions guide-display-actions">
            <ToolButton active={showMesh} onClick={handleProjectMesh} title="Project mesh using both rectangles">
              {showMesh ? 'Hide Mesh' : 'Show Mesh'}
            </ToolButton>
            <ToolButton active={hideGuides} onClick={() => setHideGuides((hidden) => !hidden)} title="Hide node handles">
              Hide Handles
            </ToolButton>
          </div>
        </section>
        <section className="panel-workflow-section">
          <h3>Mesh</h3>
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
          <ToolButton active={dewarpActive} onClick={handleDewarp} disabled={!image || rectangles.length < 2 || (busy && !dewarpProgress)} title="Toggle dewarp preview" className={`${dewarpButtonClass} mesh-dewarp-button`}>
            {dewarpButtonLabel}
          </ToolButton>
        </section>
        <section className="panel-workflow-section">
          <h3>Fill</h3>
          <div className="row">
            <label>Shapes</label>
            <span>{fillShapes.length}{fillDraft.length ? ` + ${fillDraft.length}/4 draft` : ''}</span>
          </div>
          <div className="path-actions fill-actions">
            <ToolButton active={dewarpActive && tool === 'fill'} onClick={handleFillAddMode} disabled={!dewarpActive || busy} title="Add fill shape">
              Add
            </ToolButton>
            <button onClick={handleResetFill} disabled={!fillShapes.length && !fillDraft.length && !filledImage}>Reset</button>
            <button
              className={fillActionEnabled ? 'fill-run-button fill-run-button--enabled' : 'fill-run-button'}
              onClick={handleFillAction}
              disabled={!fillActionEnabled}
            >
              {fillButtonLabel}
            </button>
          </div>
        </section>
        <section className="panel-workflow-section">
          <h3>Export</h3>
          <div className="path-actions export-actions">
            <button onClick={handleExport} disabled={busy || !image || !outerCorners}>Export</button>
            <button onClick={handleExportAs} disabled={busy || !image || !outerCorners}>Export As</button>
          </div>
        </section>
      </div>

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
  active = false,
  onDelete
}: {
  label: string
  color: string
  path: RectPath | null
  draftCount: number
  active?: boolean
  onDelete?: () => void
}) {
  const text = path ? `${path.nodes.length} nodes` : draftCount ? `${draftCount}/4 corners` : 'not started'
  return (
    <div className="row path-row">
      <label>{active ? `${label} *` : label}</label>
      <span className="path-row-meta" style={{ color: path || draftCount ? color : '#666' }}>
        {text}
        {onDelete && (
          <button
            type="button"
            className="path-delete"
            title={`Delete ${label}`}
            onClick={onDelete}
            aria-label={`Delete ${label}`}
          >
            ×
          </button>
        )}
      </span>
    </div>
  )
}
