/**
 * Checks for a drawing a reply carries (chat view): what a reference or a piece of CSS inside an SVG may say.
 * Pure, so the rules are tested without a DOM; the renderer's sanitiser (lib/visuals.ts) applies them.
 */

/** Pure: a reference that stays inside the drawing (`#id`). Anything else (a URL, a path, `javascript:`) would make the window fetch or run something. */
export function localRef(value: string): boolean {
  return /^#[^\s"'<>()\\]+$/.test(value.trim())
}

const LOCAL_URL = /url\(\s*(["']?)#[^\s"'<>()\\]+\1\s*\)/gi

/**
 * Pure: CSS (a stylesheet, a `style` attribute, a presentation attribute such as `fill`) that loads nothing:
 * every `url()` points inside the drawing, and there is no `@import`, `image()`, `image-set()` or old script
 * hook. A backslash is refused outright: CSS escapes can spell `url(` without the letters.
 */
export function cssLoadsNothing(css: string): boolean {
  if (css.includes('\\')) return false
  const rest = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(LOCAL_URL, ' ')
  return !/url\s*\(|@import|image-set\s*\(|\bimage\s*\(|expression\s*\(|-moz-binding|behavior\s*:|javascript:/i.test(rest)
}

/**
 * Pure: a file: URL that names another machine (`file://host/share/x`, what `//host/share/x` or a UNC path becomes
 * on a page loaded from disk). Windows fetches it over SMB and offers the owner's sign-in to that machine, and the
 * page's CSP does not stop it ('self' on a file: page matches every file: URL; checked in Electron 45). `ownHost`:
 * the machine the app itself is loaded from, when that is a share.
 */
export function remoteFileUrl(url: string, ownHost = ''): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' && u.host !== '' && u.host.toLowerCase() !== ownHost.toLowerCase()
  } catch {
    return false
  }
}

/** Config keys a diagram may not set for itself (`%%{init}%%`, front matter): they put CSS or markup into the drawing. */
export const MERMAID_LOCKED = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS', 'fontFamily', 'altFontFamily', 'theme', 'themeVariables', 'darkMode', 'dompurifyConfig'] as const

/**
 * Pure: Mermaid source with the HTML in it made plain text. Mermaid 12.2 in strict mode still hands a label's
 * markup to an HTML parser (in a test an `onerror` in a label made the page's CSP report a blocked inline
 * handler), so no tag gets that far: every `<` that opens a tag is escaped, except a line break (`<br>`, which
 * Mermaid treats as a new line) and Mermaid's own `<<annotation>>`. Arrows (`<--`, `<|--`) do not open a tag.
 */
export function plainMermaid(code: string): string {
  return code.replace(/(?<!<)<(?!br\s*\/?>)(?=[a-z/!?])/gi, '&lt;')
}
