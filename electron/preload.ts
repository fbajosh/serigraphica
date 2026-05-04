import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('serigraphica', {
  openImage: () => ipcRenderer.invoke('open-image'),
  openImagePath: (imagePath: string) => ipcRenderer.invoke('open-image-path', imagePath),
  filePathForDrop: (file: Parameters<typeof webUtils.getPathForFile>[0]) => webUtils.getPathForFile(file),
  restartFitEngine: () => ipcRenderer.invoke('restart-fit-engine'),
  detectOuterRect: (imagePath: string) => ipcRenderer.invoke('detect-outer-rect', imagePath),
  deriveFromStrokes: (
    imagePath: string,
    imageWidth: number,
    imageHeight: number,
    outerStrokes: unknown[],
    innerStrokes: unknown[]
  ) => ipcRenderer.invoke('derive-from-strokes', imagePath, imageWidth, imageHeight, outerStrokes, innerStrokes),
  exportCorrected: (imagePath: string, corners: number[][], quality: number) =>
    ipcRenderer.invoke('export-corrected', imagePath, corners, quality)
})
