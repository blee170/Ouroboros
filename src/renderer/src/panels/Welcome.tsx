import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'
import { EnginesPanel } from './EnginesPanel'

export function Welcome() {
  const openProject = useBoard((s) => s.openProject)
  const [recent, setRecent] = useState<string[]>([])
  useEffect(() => {
    void window.ouroboros.workspace.recent().then(setRecent)
  }, [])
  const pick = async (): Promise<void> => {
    const root = await window.ouroboros.workspace.openProject()
    if (root) await openProject(root)
  }
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>◎ Ouroboros</h1>
        <p className="muted">A canvas for conducting many Claude Code sessions at once. Open a project folder to start; its board is saved as <code>.ouroboros.json</code> inside. Each window holds one project; open more windows for other work.</p>
        <button className="btn primary" onClick={() => void pick()}>
          Open project folder
        </button>
        <div className="block">
          <div className="muted small">Setup</div>
          <EnginesPanel compact />
        </div>
        {recent.length > 0 && (
          <div className="block">
            <div className="muted small">Recent</div>
            {recent.map((r) => (
              <div key={r} className="recent-row">
                <button className="link" title="Open here (Ctrl+click: new window)" onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? void window.ouroboros.window.open(r) : void openProject(r))}>
                  {r}
                </button>
                <button className="icon-btn" title="Open in a new window" onClick={() => void window.ouroboros.window.open(r)}>
                  ⧉
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
