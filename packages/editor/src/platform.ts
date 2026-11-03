import type { ReactNode } from 'react'
import type { LoadedImage, RectPath, SerigraphicaAPI } from './types'

export type SavedGuides = {
  width: number
  height: number
  rectangles: RectPath[]
  centerHorizontal: boolean
  centerVertical: boolean
}

export type GuideStore = {
  load: (image: LoadedImage) => SavedGuides | null
  save: (image: LoadedImage, guides: SavedGuides) => void
  clear?: () => void
}

export type EditorProps = {
  api: SerigraphicaAPI
  guides?: GuideStore
  titlebarStart?: ReactNode
  renderPrivacyNotice?: (clearSavedLines: () => void) => ReactNode
  formats?: readonly ('jpg' | 'png')[]
  mode?: 'browser' | 'desktop'
  allowExportAs?: boolean
  emptyHint?: ReactNode
}
