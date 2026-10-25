/** Vite's `?raw` import: the file's text, embedded at build time. */
declare module '*.md?raw' {
  const content: string
  export default content
}
