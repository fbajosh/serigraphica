import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('serigraphica', {
  openImage: () => ipcRenderer.invoke('open-image'),
  openImagePath: (imagePath: string) => ipcRenderer.invoke('open-image-path', imagePath),
  filePathForDrop: (file: Parameters<typeof webUtils.getPathForFile>[0]) => webUtils.getPathForFile(file),
  exportCorrected: (imagePath: string, corners: number[][], quality: number) =>
    ipcRenderer.invoke('export-corrected', imagePath, corners, quality),
  exportCorrectedAs: (imagePath: string, corners: number[][], quality: number) =>
    ipcRenderer.invoke('export-corrected-as', imagePath, corners, quality),
  previewCorrected: (imagePath: string, corners: number[][], quality: number) =>
    ipcRenderer.invoke('preview-corrected', imagePath, corners, quality),
  exportDewarped: (imagePath: string, rectangles: unknown[], quality: number, outputBasePath?: string, fillShapes?: unknown[], fillSampleRegions?: unknown[]) =>
    ipcRenderer.invoke('export-dewarped', imagePath, rectangles, quality, outputBasePath, fillShapes, fillSampleRegions),
  exportDewarpedAs: (imagePath: string, rectangles: unknown[], quality: number, outputBasePath?: string, fillShapes?: unknown[], fillSampleRegions?: unknown[]) =>
    ipcRenderer.invoke('export-dewarped-as', imagePath, rectangles, quality, outputBasePath, fillShapes, fillSampleRegions),
  previewDewarped: (imagePath: string, rectangles: unknown[], quality: number, outputBasePath?: string) =>
    ipcRenderer.invoke('preview-dewarped', imagePath, rectangles, quality, outputBasePath),
  previewFilled: (imagePath: string, fillShapes: unknown[], quality: number, fillSampleRegions?: unknown[]) =>
    ipcRenderer.invoke('preview-filled', imagePath, fillShapes, quality, fillSampleRegions),
  cancelDewarp: () => ipcRenderer.invoke('cancel-dewarp'),
  onDewarpProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on('dewarp-progress', listener)
    return () => ipcRenderer.removeListener('dewarp-progress', listener)
  }
})
