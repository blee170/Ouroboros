import { useState } from 'react'
import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'
import { speak, voiceFor } from '@/lib/speak'
import { useBoard } from '@/store/board'
import { ttsSettings } from '@shared/tts'
import { EnginesPanel } from './EnginesPanel'

const REPO = 'https://github.com/blee170/Ouroboros'
const LINKS = [
  { label: 'First-hour tutorial', url: `${REPO}/blob/main/docs/TUTORIAL.md`, hint: 'the long version of the steps below' },
  { label: 'README', url: `${REPO}#readme`, hint: 'every feature, settings, security' },
  { label: 'Changelog', url: `${REPO}/blob/main/CHANGELOG.md`, hint: 'what each version changed' }
]

const STEPS: Array<{ title: string; text: string }> = [
  { title: 'Add a card', text: 'New card in the title bar adds your default agent; its arrow (or a right-click on the canvas) lists Codex, Gemini, Grok, Conductor, Terminal, Browser, Note. A card is a real terminal running the CLI in your project folder; answer its first "trust this folder?" like in any terminal.' },
  { title: 'Read the status', text: 'A turning ring = working, an orange ? = needs you, a green check = done. The sidebar lists every card by state, what needs you first; the status bar counts them. Click either to jump. Zoom out and a card shows its last reply in large type.' },
  { title: 'Draw a line', text: 'Drag a card\'s right port to another\'s left port. When the first card finishes a reply, the line types it into the second (Auto), or you press ▶ (Manual). The Inspector edits the template and a condition such as PASS or /SCORE: 9/.' },
  { title: 'Check the diff', text: 'The +n −m badge on a card opens its uncommitted changes: per-file diff, discard, "ask the card to review". Read diffs, not replies.' },
  { title: 'Snapshot before risk', text: 'Inspector → Work → Snapshot takes a git checkpoint of the folder without touching your tree. Restore brings it back, and a restore saves a "before restore" snapshot first, so it can be undone.' },
  { title: 'Conduct', text: 'A Conductor card gets the board as tools: it creates workers (on their own worktrees), wires report lines, runs plan → implement → review → score, and waits for your APPROVED BY OWNER before anything leaves the machine. Give it one small goal at a time.' },
  { title: 'Leave', text: 'Finished turns are announced by toast or voice (Settings). For hours away, Autonomous mode (the moon in the title bar) keeps the board working with deny rules and parks every question for you; a morning report lands on the canvas. First night: 4 hours, low-stakes tasks.' }
]

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+J', 'jump to a card (type to narrow, ↑↓, Enter)'],
  ['Ctrl+Shift+N', 'next card that needs you, then unread finished turns'],
  ['Ctrl+1 … 9', 'jump to a card in sidebar order'],
  ['Ctrl+S', 'save the board now (it auto-saves too)'],
  ['Ctrl+V', 'paste a screenshot into a Claude card as an image'],
  ['Ctrl+C', 'copy the selection in a terminal (no selection: interrupt)'],
  ['Esc', 'close a dialog']
]

/** First run only: pick the engine (which CLI new cards run) and hear what an announcement sounds like. */
function SetupSteps() {
  const settings = useBoard((s) => s.settings)
  const setSettings = useBoard((s) => s.setSettings)
  const [msg, setMsg] = useState('')
  const test = async (): Promise<void> => {
    const tts = ttsSettings(settings)
    const ko = tts.engine !== 'windows' || Boolean(voiceFor('ko'))
    setMsg('Playing…')
    const r = await speak({ kind: 'finished', title: ko ? '총괄' : 'Conductor', lang: ko ? 'ko' : 'en' })
    setMsg(r.error ? `${r.error} — the Windows voice spoke instead.` : r.note ? r.note : 'That is what a finished turn sounds like. Voice, toast and who gets announced: Settings.')
  }
  return (
    <div className="settings-section first setup-steps">
      <h4>Set up</h4>
      <EnginesPanel compact />
      <div className="row">
        <label className="row">
          Announce
          <select value={settings.announce ?? 'conductor'} onChange={(e) => void setSettings({ announce: e.target.value as 'off' | 'conductor' | 'all' })}>
            <option value="conductor">Conductor replies</option>
            <option value="all">every card</option>
            <option value="off">off</option>
          </select>
        </label>
        <button className="btn small" onClick={() => void test()}>
          <Icon name="volume" size={13} /> Play a test announcement
        </button>
        {msg && <span className="hint">{msg}</span>}
      </div>
    </div>
  )
}

/**
 * The first-run guide: the first hour in seven steps, the shortcuts, and the links to the long versions. Opens by
 * itself once (settings.tourSeen), then with two setup steps (engine, a test announcement); from ? in the title
 * bar after that.
 */
export function HelpDialog({ onClose, firstRun = false }: { onClose: () => void; firstRun?: boolean }) {
  useEscape(onClose)
  const open = (url: string) => (ev: React.MouseEvent): void => {
    ev.preventDefault()
    void window.ouroboros.shell.openExternal(url)
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-dialog" role="dialog" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="help-title">
          <Icon name="help" /> Your first hour
        </h3>
        <div className="hint">Every agent is a card, cards are real terminals, lines carry one card's finished reply into the next, and a Conductor can run the board for you. The app calls no model itself: it runs the CLIs you are signed in to.</div>
        {firstRun && <SetupSteps />}
        <div className={`settings-section${firstRun ? '' : ' first'}`}>
          <ol className="help-steps">
            {STEPS.map((s) => (
              <li key={s.title}>
                <b>{s.title}.</b> {s.text}
              </li>
            ))}
          </ol>
        </div>
        <div className="settings-section">
          <h4>Shortcuts</h4>
          <table className="help-keys">
            <tbody>
              {SHORTCUTS.map(([k, what]) => (
                <tr key={k}>
                  <td>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="settings-section">
          <h4>Read more</h4>
          <ul className="help-links">
            {LINKS.map((l) => (
              <li key={l.url}>
                <a href={l.url} onClick={open(l.url)}>
                  {l.label}
                </a>{' '}
                <span className="hint">— {l.hint}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="row right">
          <span className="hint">This opens again from ? in the title bar.</span>
          {/* no autoFocus: focusing the last control scrolls the dialog to its bottom and hides the title */}
          <button className="btn primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
