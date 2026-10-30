import { describe, expect, it } from 'vitest'
import { DEFAULT_STYLE, GEMINI_TTS_MODEL, buildTtsRequest, geminiAudioData, looksLikeAudio, ttsError, voiceboxAutoplay, ttsSettings, wavFromPcm16, VOICEBOX_URL, voiceboxGeneration, voiceboxProfile, voiceboxUrl } from '@shared/tts'

describe('looksLikeAudio / wavFromPcm16', () => {
  it('accepts RIFF for wav and ID3 or an MPEG frame for mp3, rejects JSON/HTML bodies', () => {
    const txt = (s: string): Uint8Array => new TextEncoder().encode(s)
    expect(looksLikeAudio(txt('RIFF....WAVE'), 'audio/wav')).toBe(true)
    expect(looksLikeAudio(txt('{"error":1}'), 'audio/wav')).toBe(false)
    expect(looksLikeAudio(txt('ID3....'), 'audio/mpeg')).toBe(true)
    expect(looksLikeAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg')).toBe(true)
    expect(looksLikeAudio(txt('<html>'), 'audio/mpeg')).toBe(false)
    expect(looksLikeAudio(new Uint8Array(0), 'audio/wav')).toBe(false)
  })

  it('wraps raw PCM in a 44-byte header that looksLikeAudio accepts, with the right sizes and rate', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6])
    const wav = wavFromPcm16(pcm)
    const v = new DataView(wav.buffer)
    expect(wav.length).toBe(50)
    expect(looksLikeAudio(wav, 'audio/wav')).toBe(true)
    expect(v.getUint32(4, true)).toBe(36 + 6)
    expect(v.getUint32(24, true)).toBe(24_000)
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(40, true)).toBe(6)
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('ttsSettings', () => {
  it('defaults to the Windows voice and fills in each engine’s default voice and style', () => {
    expect(ttsSettings({})).toEqual({ engine: 'windows', voice: '', style: '' })
    // Gemini's steadiest delivery is no style at all (Google: style text per call makes the voice drift)
    expect(ttsSettings({ ttsEngine: 'gemini' })).toEqual({ engine: 'gemini', voice: 'Kore', style: '' })
    expect(ttsSettings({ ttsEngine: 'openai' })).toMatchObject({ engine: 'openai', style: DEFAULT_STYLE })
    expect(ttsSettings({ ttsEngine: 'openai', ttsVoice: ' nova ', ttsStyle: 'excited' })).toEqual({ engine: 'openai', voice: 'nova', style: 'excited' })
    expect(ttsSettings({ ttsEngine: 'bogus' as never }).engine).toBe('windows')
  })
})

describe('buildTtsRequest', () => {
  const s = { voice: 'Kore', style: 'warm' }

  it('Gemini: no style sends no annotation', () => {
    const body = JSON.parse(buildTtsRequest('gemini', 'hi', { engine: 'gemini', voice: 'Kore', style: '' }, 'k').body)
    expect(body.input[0].content[0]).toEqual({ type: 'text', text: 'hi' })
  })
  it('Gemini: Interactions API, key in a header, verbatim text with a style annotation', () => {
    const r = buildTtsRequest('gemini', '총괄 작업이 끝났습니다.', { engine: 'gemini', ...s }, 'KEY')
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(r.url).not.toContain('KEY')
    expect(r.headers['x-goog-api-key']).toBe('KEY')
    expect(r.response).toBe('gemini-json')
    expect(r.mime).toBe('audio/wav')
    expect(JSON.parse(r.body)).toEqual({
      model: GEMINI_TTS_MODEL,
      input: [{ type: 'user_input', content: [{ type: 'text', text: '총괄 작업이 끝났습니다.', annotations: [{ type: 'speech_metadata', style: 'warm' }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] }
    })
  })

  it('OpenAI: bearer key, gpt-4o-mini-tts with instructions, mp3 bytes back', () => {
    const r = buildTtsRequest('openai', 'Conductor finished.', { engine: 'openai', voice: 'coral', style: 'warm' }, 'sk-1')
    expect(r.headers.authorization).toBe('Bearer sk-1')
    expect(r.response).toBe('bytes')
    expect(r.mime).toBe('audio/mpeg')
    expect(JSON.parse(r.body)).toEqual({ model: 'gpt-4o-mini-tts', input: 'Conductor finished.', voice: 'coral', instructions: 'warm', response_format: 'mp3' })
  })

  it('ElevenLabs: voice id in the path (escaped), xi-api-key, multilingual model', () => {
    const r = buildTtsRequest('elevenlabs', 'hi', { engine: 'elevenlabs', voice: 'ab/c d', style: 'ignored' }, 'xi')
    expect(r.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/ab%2Fc%20d?output_format=mp3_44100_128')
    expect(r.headers['xi-api-key']).toBe('xi')
    expect(JSON.parse(r.body)).toEqual({ text: 'hi', model_id: 'eleven_multilingual_v2' })
  })

  it('Voicebox: POST /generate on the loopback (not /speak, which also plays the clip through Voicebox), with the profile id and engine', () => {
    // measured against Voicebox 0.5.0 on 2026-10-30: /generate answers {id, status: "generating"} at once and plays nothing
    const r = buildTtsRequest('voicebox', '총괄 작업이 끝났습니다.', { engine: 'voicebox', voice: 'Sohee', style: 'ignored' }, '', { id: 'c1af', engine: 'qwen_custom_voice', language: 'ko' })
    expect(r.url).toBe(`${VOICEBOX_URL}/generate`)
    expect(new URL(r.url).hostname).toBe('127.0.0.1')
    expect(Object.keys(r.headers)).toEqual(['content-type'])
    expect(r.response).toBe('voicebox-json')
    expect(r.mime).toBe('audio/wav')
    expect(JSON.parse(r.body)).toEqual({ profile_id: 'c1af', text: '총괄 작업이 끝났습니다.', engine: 'qwen_custom_voice', language: 'ko' })
    expect(() => buildTtsRequest('voicebox', 'hi', { engine: 'voicebox', voice: 'Sohee', style: '' }, '')).toThrow(/profile/)
  })

  it("Voicebox: finds the Settings profile in Voicebox's list by name or id, with the engine /generate insists on", () => {
    const list = [
      { id: 'c1af', name: 'Sohee', language: 'ko', voice_type: 'preset', preset_engine: 'qwen_custom_voice', default_engine: 'qwen_custom_voice' },
      { id: '3ac3', name: 'Sky', language: 'en', voice_type: 'preset', preset_engine: 'kokoro', default_engine: null },
      { id: 'b2b2', name: 'Brian', language: 'ko', voice_type: 'cloned', preset_engine: null, default_engine: null },
      { id: 'd4d4', name: 'Odd', language: 'en', voice_type: 'preset', preset_engine: 'kokoro', default_engine: 'something-custom' }
    ]
    // the preset's engine is the binding one; a free-text default_engine /generate would refuse is not passed
    expect(voiceboxProfile(list, 'Odd')).toEqual({ id: 'd4d4', engine: 'kokoro', language: 'en' })
    expect(voiceboxProfile(list, 'sohee')).toEqual({ id: 'c1af', engine: 'qwen_custom_voice', language: 'ko' })
    expect(voiceboxProfile(list, 'Sky')).toEqual({ id: '3ac3', engine: 'kokoro', language: 'en' })
    expect(voiceboxProfile(list, 'b2b2')).toEqual({ id: 'b2b2', engine: 'qwen', language: 'ko' })
    expect(voiceboxProfile(list, 'Nobody')).toBeUndefined()
    expect(voiceboxProfile(list, '')).toBeUndefined()
    expect(voiceboxProfile({ detail: 'nope' }, 'Sky')).toBeUndefined()
  })

  it('Voicebox: reads the generation record, and names the audio route', () => {
    expect(voiceboxGeneration({ id: 'g1', status: 'generating', error: null })).toEqual({ id: 'g1', status: 'generating', error: undefined })
    expect(voiceboxGeneration({ id: 'g1', status: 'completed' })).toEqual({ id: 'g1', status: 'completed', error: undefined })
    expect(voiceboxGeneration({ id: 'g1', status: 'failed', error: 'CUDA out of memory' })).toEqual({ id: 'g1', status: 'failed', error: 'CUDA out of memory' })
    expect(voiceboxGeneration({ id: 'g1', status: 'not_found' })).toEqual({ id: 'g1', status: 'failed', error: 'not_found' })
    expect(voiceboxGeneration({ id: 'g1', status: 'cancelled' })).toEqual({ id: 'g1', status: 'failed', error: 'cancelled' })
    // the CUDA backend reports loading_model before generating on its first clip; anything that is not an end state is still in progress
    expect(voiceboxGeneration({ id: 'g1', status: 'loading_model', error: null })).toEqual({ id: 'g1', status: 'generating', error: undefined })
    expect(voiceboxGeneration({ id: 'g1', status: 'queued' })).toEqual({ id: 'g1', status: 'generating', error: undefined })
    expect(voiceboxGeneration({ status: 'generating' })).toBeUndefined()
    expect(voiceboxGeneration('nope')).toBeUndefined()
    expect(voiceboxUrl('history', 'a b/c')).toBe(`${VOICEBOX_URL}/history/a%20b%2Fc`)
    expect(voiceboxUrl('audio', 'g1')).toBe(`${VOICEBOX_URL}/audio/g1`)
    expect(voiceboxUrl('cancel', 'g1')).toBe(`${VOICEBOX_URL}/generate/g1/cancel`)
  })

  it('Voicebox has no default voice of its own in Settings (main asks for a profile name)', () => {
    expect(ttsSettings({ ttsEngine: 'voicebox' })).toMatchObject({ engine: 'voicebox', voice: '' })
  })
})

describe('geminiAudioData', () => {
  it('takes the last audio part of the model output, or the output_audio shortcut', () => {
    const json = {
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
        { type: 'model_output', content: [{ type: 'audio', data: 'AAA=' }, { type: 'audio', data: 'BBB=' }] }
      ]
    }
    expect(geminiAudioData(json)).toBe('BBB=')
    expect(geminiAudioData({ output_audio: { data: 'CCC=' } })).toBe('CCC=')
    expect(geminiAudioData({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no audio' }] }] })).toBeUndefined()
    expect(geminiAudioData(null)).toBeUndefined()
  })
})

describe('ttsError', () => {
  it('names the engine and the reason, unwrapping the JSON message and squashing the rest to one short line', () => {
    expect(ttsError('gemini', 401, '{\n "error": {\n  "message": "API key not valid" } }')).toBe('Gemini TTS (Google AI Studio key, free tier): key rejected (401). API key not valid')
    // Gemini answers a bad key with 400 (inside an array), not 401
    expect(ttsError('gemini', 400, '[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]')).toBe('Gemini TTS (Google AI Studio key, free tier): key rejected (400). API key not valid. Please pass a valid API key.')
    expect(ttsError('elevenlabs', 401, '{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}')).toMatch(/key rejected \(401\)\. Invalid API key$/)
    expect(ttsError('openai', 429, 'x'.repeat(500))).toMatch(/quota \(429\)\. x{200}$/)
    expect(ttsError('elevenlabs', 500, '')).toContain('HTTP 500')
  })

  it("reads Voicebox's Autoplay switch and counts anything else as off", () => {
    expect(voiceboxAutoplay({ max_chunk_chars: 3000, crossfade_ms: 50, normalize_audio: true, autoplay_on_generate: true })).toBe(true)
    expect(voiceboxAutoplay({ autoplay_on_generate: false })).toBe(false)
    expect(voiceboxAutoplay({ autoplay_on_generate: 'true' })).toBe(false)
    expect(voiceboxAutoplay({})).toBe(false)
    expect(voiceboxAutoplay(null)).toBe(false)
    expect(voiceboxAutoplay('nope')).toBe(false)
  })
})
