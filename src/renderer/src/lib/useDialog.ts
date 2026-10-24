import { useEffect } from 'react'

/** Every dialog closes on Escape; a text field inside keeps its own Escape (the picker, a title being edited). */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      // fields that save on blur must save before the dialog unmounts (a backdrop click blurred them; a key does not)
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}
