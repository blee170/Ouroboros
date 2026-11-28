import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../src/main/diagnostics', () => ({ log: vi.fn() }))
vi.mock('../src/main/updater', () => ({ decryptToken: () => undefined, encryptToken: () => undefined }))

const { synthesize } = await import('../src/main/tts')
const { MAX_TTS_CHARS } = await import('../src/shared/tts')

/**
 * Voicebox as main sees it: the profile list, its settings, a generation, the clip. The generation is done at once,
 * or with `msPerChar` only after that long a character of its text (a slow voice).
 */
function voicebox(msPerChar = 0): { sent: string[]; fetch: ReturnType<typeof vi.fn> } {
  const sent: string[] = []
  let doneAt = 0
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/profiles')) return json([{ id: 'p1', name: 'Sohee', default_engine: 'qwen', language: 'ko' }])
    if (url.endsWith('/settings/generation')) return json({ autoplay_on_generate: false })
    if (url.endsWith('/generate')) {
      const text = (JSON.parse(String(init?.body)) as { text: string }).text
      sent.push(text)
      doneAt = Date.now() + text.length * msPerChar
      return json({ id: 'g1', status: msPerChar ? 'generating' : 'completed' })
    }
    if (url.endsWith('/history/g1')) return json({ id: 'g1', status: Date.now() >= doneAt ? 'completed' : 'generating' })
    if (url.endsWith('/audio/g1')) return new Response(new TextEncoder().encode('RIFF....WAVE'), { status: 200 })
    return new Response('not found', { status: 404 })
  })
  return { sent, fetch }
}

describe('main synthesize: one request never loses text', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('a text of the most one request carries reaches the engine whole', async () => {
    const vb = voicebox()
    vi.stubGlobal('fetch', vb.fetch)
    const text = '가'.repeat(MAX_TTS_CHARS)
    const r = await synthesize({ ttsEngine: 'voicebox', ttsVoice: 'Sohee' } as never, text)
    expect(r.ok).toBe(true)
    expect(vb.sent).toEqual([text])
  })

  it('a longer text is refused, not cut: nothing goes out and the error says why', async () => {
    const vb = voicebox()
    vi.stubGlobal('fetch', vb.fetch)
    const r = await synthesize({ ttsEngine: 'voicebox', ttsVoice: 'Sohee' } as never, '가'.repeat(MAX_TTS_CHARS) + ' 마케팅 보고서')
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.error).toContain(String(MAX_TTS_CHARS))
    expect(vb.fetch).not.toHaveBeenCalled()
  })
})

describe('main synthesize: a slow local voice gets time for the whole text', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a text made at 1.58 s a character (the slowest measured, Sohee on a shared GPU) still finishes, up to the longest text main takes', async () => {
    for (const n of [80, MAX_TTS_CHARS]) {
      const vb = voicebox(1580)
      vi.stubGlobal('fetch', vb.fetch)
      const r = synthesize({ ttsEngine: 'voicebox', ttsVoice: 'Sohee' } as never, '가'.repeat(n))
      await vi.advanceTimersByTimeAsync(n * 1580 + 2000)
      const out = await r
      expect(out.ok, `${n} characters: ${out.ok ? '' : out.error}`).toBe(true)
    }
  })

  it('a clip that never finishes is still given up, and Voicebox is told to stop making it', async () => {
    const vb = voicebox(Infinity)
    vi.stubGlobal('fetch', vb.fetch)
    const r = synthesize({ ttsEngine: 'voicebox', ttsVoice: 'Sohee' } as never, '가'.repeat(80))
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    const out = await r
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.error).toContain('not finished')
    expect(vb.fetch.mock.calls.some(([url]) => String(url).endsWith('/generate/g1/cancel'))).toBe(true)
  })
})
