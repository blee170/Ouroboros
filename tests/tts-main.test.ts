import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('../src/main/diagnostics', () => ({ log: vi.fn() }))
vi.mock('../src/main/updater', () => ({ decryptToken: () => undefined, encryptToken: () => undefined }))

const { synthesize } = await import('../src/main/tts')
const { MAX_TTS_CHARS } = await import('../src/shared/tts')

/** Voicebox as main sees it: the profile list, its settings, a generation that is done at once, the clip. */
function voicebox(): { sent: string[]; fetch: ReturnType<typeof vi.fn> } {
  const sent: string[] = []
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/profiles')) return json([{ id: 'p1', name: 'Sohee', default_engine: 'qwen', language: 'ko' }])
    if (url.endsWith('/settings/generation')) return json({ autoplay_on_generate: false })
    if (url.endsWith('/generate')) {
      sent.push((JSON.parse(String(init?.body)) as { text: string }).text)
      return json({ id: 'g1', status: 'completed' })
    }
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
