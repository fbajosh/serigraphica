import { app, BrowserWindow, dialog, ipcMain, protocol, net } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, basename, extname } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve project root regardless of dev (out/main) or packaged location.
const projectRoot = join(__dirname, '..', '..')
const pythonScript = join(projectRoot, 'python', 'sidecar.py')
const venvPython = join(projectRoot, 'python', '.venv', 'bin', 'python3')
const outputDir = join(projectRoot, 'output')

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  onProgress?: (progress: DewarpProgress) => void
}

type DewarpProgress = {
  percent: number
  stage: string
}

type DewarpOperation = 'preview' | 'export' | 'export-as'

class Sidecar {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private buffer = ''

  start() {
    if (this.proc) return
    const python = existsSync(venvPython) ? venvPython : 'python3'
    const proc = spawn(python, ['-u', pythonScript], {
      cwd: projectRoot,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[sidecar] ${chunk}`)
    })
    proc.on('exit', (code, signal) => {
      console.error(`[sidecar] exited code=${code} signal=${signal}`)
      const err = new Error(`sidecar exited code=${code}`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      if (this.proc === proc) this.proc = null
    })
  }

  private onStdout(chunk: string) {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as { id: number; result?: unknown; error?: string; progress?: DewarpProgress }
        const pending = this.pending.get(msg.id)
        if (!pending) continue
        if (msg.progress) {
          pending.onProgress?.(msg.progress)
          continue
        }
        this.pending.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error))
        else pending.resolve(msg.result)
      } catch (err) {
        console.error('[sidecar] failed to parse line:', line, err)
      }
    }
  }

  call<T>(method: string, params: unknown, onProgress?: (progress: DewarpProgress) => void): Promise<T> {
    if (!this.proc) this.start()
    if (!this.proc) throw new Error('sidecar failed to start')
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params }) + '\n'
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
      this.proc!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  stop() {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  async restart() {
    const proc = this.proc
    if (!proc) {
      this.start()
      return
    }
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve())
      proc.kill()
      setTimeout(resolve, 1000)
    })
    if (this.proc === proc) this.proc = null
    this.start()
  }
}

const sidecar = new Sidecar()
const supportedImageExtensions = new Set(['.jpg', '.jpeg', '.png'])

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-image', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
])

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

// Custom protocol so the renderer can display arbitrary local files
// without inlining huge data URLs.
function registerLocalImageProtocol() {
  protocol.handle('local-image', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

async function loadImage(path: string) {
  if (!path) throw new Error('missing image path')
  const ext = extname(path).toLowerCase()
  if (!supportedImageExtensions.has(ext)) {
    throw new Error(`unsupported image type: ${ext || 'unknown'}`)
  }
  const meta = await sidecar.call<{ width: number; height: number }>('image_meta', { path })
  return {
    path,
    width: meta.width,
    height: meta.height,
    dataUrl: `local-image://localhost${path}`
  }
}

function correctedOutputPath(imagePath: string) {
  mkdirSync(outputDir, { recursive: true })
  const base = basename(imagePath, extname(imagePath))
  return join(outputDir, `${base}_corrected.jpg`)
}

function previewOutputPath(imagePath: string) {
  mkdirSync(outputDir, { recursive: true })
  const base = basename(imagePath, extname(imagePath))
  return join(outputDir, `.${base}_preview.jpg`)
}

async function exportCorrectedTo(imagePath: string, corners: number[][], quality: number, outputPath: string) {
  return sidecar.call('export_corrected', {
    path: imagePath,
    corners,
    output_path: outputPath,
    quality
  })
}

function dewarpProgressSender(evt: IpcMainInvokeEvent, operation: DewarpOperation) {
  return (progress: DewarpProgress) => {
    evt.sender.send('dewarp-progress', {
      ...progress,
      operation
    })
  }
}

async function exportDewarpedTo(
  imagePath: string,
  rectangles: unknown[],
  quality: number,
  outputPath: string,
  onProgress?: (progress: DewarpProgress) => void
) {
  return sidecar.call('export_dewarped', {
    path: imagePath,
    rectangles,
    output_path: outputPath,
    quality
  }, onProgress)
}

ipcMain.handle('open-image', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return loadImage(result.filePaths[0])
})

ipcMain.handle('open-image-path', async (_evt, imagePath: string) => {
  return loadImage(imagePath)
})

ipcMain.handle('export-corrected', async (_evt, imagePath: string, corners: number[][], quality: number) => {
  return exportCorrectedTo(imagePath, corners, quality, correctedOutputPath(imagePath))
})

ipcMain.handle('export-corrected-as', async (_evt, imagePath: string, corners: number[][], quality: number) => {
  const base = basename(imagePath, extname(imagePath))
  mkdirSync(outputDir, { recursive: true })
  const result = await dialog.showSaveDialog({
    title: 'Export corrected image',
    defaultPath: join(outputDir, `${base}_corrected.jpg`),
    filters: [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }]
  })
  if (result.canceled || !result.filePath) return null
  return exportCorrectedTo(imagePath, corners, quality, result.filePath)
})

ipcMain.handle('export-dewarped', async (evt, imagePath: string, rectangles: unknown[], quality: number) => {
  return exportDewarpedTo(imagePath, rectangles, quality, correctedOutputPath(imagePath), dewarpProgressSender(evt, 'export'))
})

ipcMain.handle('export-dewarped-as', async (evt, imagePath: string, rectangles: unknown[], quality: number) => {
  const base = basename(imagePath, extname(imagePath))
  mkdirSync(outputDir, { recursive: true })
  const result = await dialog.showSaveDialog({
    title: 'Export dewarped image',
    defaultPath: join(outputDir, `${base}_corrected.jpg`),
    filters: [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }]
  })
  if (result.canceled || !result.filePath) return null
  return exportDewarpedTo(imagePath, rectangles, quality, result.filePath, dewarpProgressSender(evt, 'export-as'))
})

ipcMain.handle('preview-corrected', async (_evt, imagePath: string, corners: number[][], quality: number) => {
  const outputPath = previewOutputPath(imagePath)
  const result = await exportCorrectedTo(imagePath, corners, quality, outputPath) as {
    outputWidth: number
    outputHeight: number
  }
  return {
    path: outputPath,
    width: result.outputWidth,
    height: result.outputHeight,
    dataUrl: `local-image://localhost${outputPath}?t=${Date.now()}`
  }
})

ipcMain.handle('preview-dewarped', async (evt, imagePath: string, rectangles: unknown[], quality: number) => {
  const outputPath = previewOutputPath(imagePath)
  const result = await exportDewarpedTo(imagePath, rectangles, quality, outputPath, dewarpProgressSender(evt, 'preview')) as {
    outputWidth: number
    outputHeight: number
  }
  return {
    path: outputPath,
    width: result.outputWidth,
    height: result.outputHeight,
    dataUrl: `local-image://localhost${outputPath}?t=${Date.now()}`
  }
})

app.whenReady().then(() => {
  registerLocalImageProtocol()
  sidecar.start()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sidecar.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sidecar.stop()
})
