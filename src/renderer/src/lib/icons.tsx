import type { LucideIcon, LucideProps } from 'lucide-react'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Brush,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  ExternalLink,
  FileText,
  Folder,
  History,
  Image,
  LayoutGrid,
  Maximize2,
  Moon,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pencil,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Sparkles,
  Square,
  Star,
  Undo2,
  Volume2,
  X
} from 'lucide-react'

/**
 * The chrome's icons: one family (lucide), one weight, currentColor. Card kinds have their own icons in
 * lib/cardKinds.ts and states their glyph in lib/StateGlyph.tsx; everything that is an action (open, save,
 * tidy, settings…) is named here so a call site says what it means, not which drawing it wants.
 */
export type IconName =
  | 'help'
  | 'folder'
  | 'window'
  | 'plus'
  | 'chevron'
  | 'back'
  | 'forward'
  | 'sparkles'
  | 'save'
  | 'broom'
  | 'grid'
  | 'undo'
  | 'settings'
  | 'brief'
  | 'pin'
  | 'volume'
  | 'image'
  | 'clip'
  | 'refresh'
  | 'close'
  | 'search'
  | 'down'
  | 'up'
  | 'revert'
  | 'restore'
  | 'snapshot'
  | 'external'
  | 'expand'
  | 'star'
  | 'panel'
  | 'panelLeft'
  | 'check'
  | 'copy'
  | 'pencil'
  | 'moon'
  | 'stop'
  | 'play'

const ICONS: Record<IconName, LucideIcon> = {
  help: CircleHelp,
  folder: Folder,
  window: AppWindow,
  plus: Plus,
  chevron: ChevronDown,
  back: ChevronLeft,
  forward: ChevronRight,
  sparkles: Sparkles,
  save: Save,
  broom: Brush,
  grid: LayoutGrid,
  undo: Undo2,
  settings: Settings,
  brief: FileText,
  pin: Pin,
  volume: Volume2,
  image: Image,
  clip: Paperclip,
  refresh: RefreshCw,
  close: X,
  search: Search,
  down: ArrowDown,
  up: ArrowUp,
  revert: RotateCcw,
  restore: History,
  snapshot: Camera,
  external: ExternalLink,
  expand: Maximize2,
  star: Star,
  panel: PanelRight,
  panelLeft: PanelLeft,
  check: Check,
  copy: Copy,
  pencil: Pencil,
  moon: Moon,
  stop: Square,
  play: Play
}

export function Icon({ name, size = 16, className, ...rest }: { name: IconName; size?: number } & Omit<LucideProps, 'size' | 'ref'>) {
  const L = ICONS[name]
  return <L className={className ? `ico ${className}` : 'ico'} size={size} aria-hidden="true" focusable="false" {...rest} />
}
