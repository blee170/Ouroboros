import { useEffect, useState } from 'react'
import { useBoard } from '@/store/board'

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
        <p className="muted">A canvas for conducting many Claude Code sessions at once. Open a project folder to start; its board is saved as <code>.ouroboros.json</code> inside.</p>
        <button className="btn primary" onClick={() => void pick()}>
          Open project folder
        </button>
        {recent.length > 0 && (
          <div className="block">
            <div className="muted small">Recent</div>
            {recent.map((r) => (
              <button key={r} className="link" onClick={() => void openProject(r)}>
                {r}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
