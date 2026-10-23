import { Icon } from '@/lib/icons'
import { useEscape } from '@/lib/useDialog'

const REPO = 'https://github.com/blee170/Ouroboros'
const LINKS = [
  { label: 'First-hour tutorial', url: `${REPO}/blob/main/docs/TUTORIAL.md`, hint: 'the long version of the steps below' },
  { label: 'README', url: `${REPO}#readme`, hint: 'every feature, settings, security' },
  { label: 'Changelog', url: `${REPO}/blob/main/CHANGELOG.md`, hint: 'what each version changed' }
]

const STEPS: Array<{ title: string; text: string }> = [
  { title: 'Add a card', text: '+ Claude in the toolbar (or right-click the canvas for Codex, Gemini, Conductor, Terminal, Browser, Note). A card is a real terminal running the CLI in your project folder; answer its first "trust this folder?" like in any terminal.' },
  { title: 'Read the status', text: 'Blue = working, amber = needs you, green = done. The strip in the toolbar and the Roster list every card by state; click to jump. Zoom out and a card shows its last reply in large type.' },
  { title: 'Draw a line', text: 'Drag a card\'s right port to another\'s left port. When the first card finishes a reply, the line types it into the second (Auto), or you press ▶ (Manual). The Inspector edits the template and a condition such as PASS or /SCORE: 9/.' },
  { title: 'Check the diff', text: 'The +n −m badge on a card opens its uncommitted changes: per-file diff, discard, "ask the card to review". Read diffs, not replies.' },
  { title: 'Snapshot before risk', text: 'Inspector → Work → ⛁ Snapshot takes a git checkpoint of the folder without touching your tree. ⟲ restores it, and a restore saves a "before restore" snapshot first, so it can be undone.' },
  { title: 'Conduct', text: 'A Conductor card gets the board as tools: it creates workers (on their own worktrees), wires report lines, runs plan → implement → review → score, and waits for your APPROVED BY OWNER before anything leaves the machine. Give it one small goal at a time.' },
  { title: 'Leave', text: 'Finished turns are announced by toast or voice (⚙). For hours away, 🌙 Autonomous mode keeps the board working with deny rules and parks every question for you; a morning report lands on the canvas. First night: 4 hours, low-stakes tasks.' }
]

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+1 … 9', 'jump to a card'],
  ['Ctrl+F', 'find a card by title'],
  ['Ctrl+S', 'save the board now (it auto-saves too)'],
  ['Ctrl+V', 'paste a screenshot into a Claude card as an image'],
  ['Ctrl+C', 'copy the selection in a terminal (no selection: interrupt)'],
  ['Esc', 'close a dialog']
]

/**
 * The first-run guide: the first hour in seven steps, the shortcuts, and the links to the long versions. Opens by
 * itself once (settings.tourSeen) and from ? in the toolbar after that.
 */
export function HelpDialog({ onClose }: { onClose: () => void }) {
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
        <div className="settings-section first">
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
          <span className="hint">This opens again from ? in the toolbar.</span>
          {/* no autoFocus: focusing the last control scrolls the dialog to its bottom and hides the title */}
          <button className="btn primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
