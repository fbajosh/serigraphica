import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('serigraphica', {
  openImage: () => ipcRenderer.invoke('open-image'),
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
