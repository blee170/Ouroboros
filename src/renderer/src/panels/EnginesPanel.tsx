import { useEffect, useState } from 'react'
import type { EngineInfo } from '@shared/protocol'
import { normalizeEngine, type AgentEngine } from '@shared/types'
import { useBoard } from '@/store/board'
import { Icon } from '@/lib/icons'
import { ENGINE_ICON } from '@/lib/cardKinds'

function EngineIcon({ engine }: { engine: AgentEngine }) {
  const I = ENGINE_ICON[engine]
  return <I className="ico" size={14} aria-hidden="true" />
}
const FALLBACK: EngineInfo[] = (
  [
    ['claude', 'Claude Code', 'claude'],
    ['codex', 'OpenAI Codex CLI (ChatGPT)', 'codex login'],
    ['gemini', 'Gemini CLI (Google)', 'gemini']
  ] as Array<[AgentEngine, string, string]>
).map(([engine, label, loginCommand]) => ({ engine, label, installed: true, installCommand: '', loginCommand, signupUrl: '', needsNode: engine !== 'claude', nodeAvailable: true }))

/**
 * "Which AI do you use?" setup: shows whether claude / codex / gemini are installed and signed in,
 * the install and sign-in commands (copyable), and lets the user pick the default engine. A ChatGPT
 * or Gemini subscriber never needs Claude.
 */
export function EnginesPanel({ compact = false }: { compact?: boolean }) {
  const settings = useBoard((s) => s.settings)
  const setSettings = useBoard((s) => s.setSettings)
  const projectRoot = useBoard((s) => s.projectRoot)
  const addNode = useBoard((s) => s.addNode)
  const [engines, setEngines] = useState<EngineInfo[] | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  const refresh = (): void => {
    setError('')
    void window.ouroboros.engines.detect()
      .then(setEngines)
      .catch((err: Error) => {
        // keep the radios usable even when detection itself failed
        setError(`Could not check the CLIs: ${err?.message ?? String(err)}`)
        setEngines(FALLBACK)
      })
  }
  useEffect(refresh, [])
  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(text)
      setTimeout(() => setCopied(''), 1500)
    })
  }
  const signIn = (e: EngineInfo): void => {
    // a terminal card running the CLI's sign-in: the browser-based login opens from there
    addNode('terminal', { title: `Sign in: ${e.label}`, initialCommand: e.loginCommand })
  }
  const current = settings.defaultEngine ?? 'claude'
  return (
    <div className={`engines${compact ? ' compact' : ''}`}>
      <div className="row between">
        <div className="muted small">Which AI do you use? Cards run the CLI you are signed in to; your own plan pays for it.</div>
        <button className="icon-btn" title="Re-check" aria-label="Re-check installed CLIs" onClick={refresh}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {!engines && <div className="muted small">Checking installed CLIs…</div>}
      {error && <div className="muted small">{error}</div>}
      {engines && (
        <ul className="engine-list">
          {engines.map((e) => (
            <li key={e.engine} className={e.installed ? 'ok' : 'missing'}>
              <label className="engine-pick" title="Use this engine for new agent and conductor cards">
                <input type="radio" name="defaultEngine" checked={current === e.engine} disabled={!e.installed} onChange={() => void setSettings({ defaultEngine: normalizeEngine(e.engine) })} />
                <span className="engine-name">
                  <EngineIcon engine={e.engine} /> {e.label}
                </span>
              </label>
              <span className={`engine-state ${e.installed ? (e.signedIn === false ? 'warn' : 'good') : 'bad'}`}>
                {e.installed ? `installed${e.version ? ` v${e.version}` : ''}${e.signedIn === true ? ' · signed in' : e.signedIn === false ? ' · not signed in' : ''}` : 'not installed'}
              </span>
              {!e.installed && (
                <div className="engine-help">
                  {e.needsNode && !e.nodeAvailable && (
                    <div className="muted small">
                      Needs Node.js first: <a href="https://nodejs.org/" onClick={(ev) => (ev.preventDefault(), void window.ouroboros.shell.openExternal('https://nodejs.org/'))}>nodejs.org</a> (LTS), then reopen Ouroboros.
                    </div>
                  )}
                  <code className="cmd">{e.installCommand}</code>
                  <button className="btn small" onClick={() => copy(e.installCommand)}>
                    {copied === e.installCommand ? 'Copied' : 'Copy'}
                  </button>
                  <span className="muted small"> → run it in PowerShell, then Re-check (if it still says not installed, restart Ouroboros so it sees the new PATH)</span>
                </div>
              )}
              {e.installed && e.signedIn !== true && (
                <div className="engine-help">
                  <code className="cmd">{e.loginCommand}</code>
                  {projectRoot ? (
                    <button className="btn small" onClick={() => signIn(e)}>
                      Open sign-in terminal
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => copy(e.loginCommand)}>
                      {copied === e.loginCommand ? 'Copied' : 'Copy'}
                    </button>
                  )}
                  <span className="muted small">
                    {' '}
                    (no account yet: <a href={e.signupUrl} onClick={(ev) => (ev.preventDefault(), void window.ouroboros.shell.openExternal(e.signupUrl))}>{e.signupUrl.replace('https://', '')}</a>)
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="muted small">
        The selected engine is used for new agent and Conductor cards; any card can switch engine in the Inspector. All engines get the same status, lines, reports and board tools.
      </div>
    </div>
  )
}
