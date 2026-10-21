/// <reference types="vite/client" />
import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { src?: string; partition?: string; allowpopups?: boolean; preload?: string },
        HTMLElement
      >
    }
  }
}
