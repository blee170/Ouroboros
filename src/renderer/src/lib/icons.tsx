import type { SVGProps } from 'react'

/**
 * The chrome's action icons: one stroke family, 16px, currentColor. Card *kinds* keep their text glyphs
 * (✦ ◎ ✧ 🎼 …) because those also live in titles, prompts and the README; everything that is an action
 * (open, save, tidy, settings…) is drawn here so the bar is one weight and one colour.
 */
export type IconName =
  | 'help'
  | 'folder'
  | 'window'
  | 'plus'
  | 'chevron'
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
  | 'revert'
  | 'external'
  | 'panel'
  | 'check'
  | 'copy'
  | 'pencil'
  | 'moon'
  | 'stop'

const PATHS: Record<IconName, string> = {
  moon: 'M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z',
  stop: 'M5 5h10v10H5z',
  check: 'M4 10.5l4 4 8-9',
  copy: 'M7 7h9v9H7zM4 13V4h9',
  pencil: 'M4 16l1-4 8-8 3 3-8 8zM12 5l3 3',
  folder: 'M3 5.5A1.5 1.5 0 0 1 4.5 4h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 7v5.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 12.5z',
  window: 'M3 6h9v8H3zM7 6V4.5A1.5 1.5 0 0 1 8.5 3H16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-3',
  plus: 'M10 4v12M4 10h12',
  chevron: 'M5 8l5 5 5-5',
  sparkles: 'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6zM16 14l.7 1.8 1.8.7-1.8.7L16 19l-.7-1.8-1.8-.7 1.8-.7z',
  save: 'M4 4h9l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM7 4v4h5V4M6 16v-5h8v5',
  broom: 'M13 3l4 4-6 6-4-4zM7 9l-3.5 3.5a2 2 0 0 0 0 2.8l1.2 1.2a2 2 0 0 0 2.8 0L11 13M4 17h6',
  grid: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z',
  undo: 'M4 9h8a4 4 0 0 1 0 8H8M4 9l3-3M4 9l3 3',
  settings: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
  brief: 'M5 3h7l4 4v10H5zM12 3v4h4M8 11h5M8 14h5',
  pin: 'M8 3h4l-1 4 3 3v1H6v-1l3-3zM10 11v6',
  volume: 'M3 8h3l4-3v10l-4-3H3zM13 7a4 4 0 0 1 0 6M15 5a7 7 0 0 1 0 10',
  image: 'M3 4h14v12H3zM3 13l4-4 3 3 2-2 5 5M13 7h.01',
  clip: 'M15 9l-6 6a3 3 0 0 1-4.2-4.2l7-7a2 2 0 0 1 2.8 2.8l-7 7a1 1 0 0 1-1.4-1.4L12 6',
  refresh: 'M16 10a6 6 0 1 1-1.8-4.2M16 3v4h-4',
  close: 'M5 5l10 10M15 5L5 15',
  search: 'M9 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM13 13l4 4',
  down: 'M10 4v12M5 11l5 5 5-5',
  revert: 'M4 7h8a4 4 0 0 1 0 8H9M4 7l3-3M4 7l3 3',
  external: 'M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8',
  panel: 'M3 4h14v12H3zM12 4v12',
  help: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM7.9 8.2a2.2 2.2 0 0 1 4.3.5c0 1.4-2.2 1.7-2.2 3.1M10 14.6h.01'
}

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  )
}
