export type * from '@serigraphica/editor/types'
import type { SerigraphicaAPI } from '@serigraphica/editor'
declare global { interface Window { serigraphica: SerigraphicaAPI } }
