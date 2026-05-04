import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('serigraphica', {
  openImage: () => ipcRenderer.invoke('open-image'),
  openImagePath: (imagePath: string) => ipcRenderer.invoke('open-image-path', imagePath),
  filePathForDrop: (file: Parameters<typeof webUtils.getPathForFile>[0]) => webUtils.getPathForFile(file),
  exportCorrected: (imagePath: string, corners: number[][], quality: number) =>
    ipcRenderer.invoke('export-corrected', imagePath, corners, quality)
})
