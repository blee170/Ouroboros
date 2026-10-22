import type { OuroborosApi } from '../shared/protocol'

declare global {
  interface Window {
    ouroboros: OuroborosApi
  }
}

export {}
