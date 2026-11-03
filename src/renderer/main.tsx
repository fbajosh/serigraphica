import React from 'react'
import { createRoot } from 'react-dom/client'
import { SerigraphicaEditor } from '@serigraphica/editor'
import { desktopGuides } from './desktopGuides'
import '@serigraphica/editor/styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SerigraphicaEditor api={window.serigraphica} guides={desktopGuides} mode="desktop" allowExportAs />
  </React.StrictMode>
)
