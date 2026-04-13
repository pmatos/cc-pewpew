import { useEffect, useState } from 'react'
import type { Session } from '../shared/types'
import BroadcastBar from './components/BroadcastBar'
import LaneHeader from './components/LaneHeader'
import Terminal from './components/Terminal'

function parseSessionIds(): string[] {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('sessions')
  return raw ? raw.split(',').filter(Boolean) : []
}

export default function SwimLanesApp() {
  const [sessionIds] = useState(parseSessionIds)
  const [sessions, setSessions] = useState<Session[]>([])

  useEffect(() => {
    window.api.getSessions().then((all) => {
      setSessions(all.filter((s) => sessionIds.includes(s.id)))
    })

    const unsub = window.api.onSessionsUpdated((all) => {
      setSessions((all as Session[]).filter((s) => sessionIds.includes(s.id)))
    })

    return unsub
  }, [sessionIds])

  const handleRevive = async (id: string) => {
    await window.api.reviveSession(id)
  }

  return (
    <div className="swim-lanes-app">
      <BroadcastBar sessionIds={sessionIds} />
      <div className="lanes-container">
        {sessionIds.map((id) => {
          const session = sessions.find((s) => s.id === id)
          const isDead = session?.status === 'dead' || session?.status === 'error'

          return (
            <div key={id} className="lane">
              <LaneHeader session={session} />
              <div className="lane-terminal">
                {isDead ? (
                  <div className="dead-session-overlay">
                    <div className="dead-session-content">
                      <div className="dead-session-icon">&#x1f480;</div>
                      <h3>Session terminated</h3>
                      <p>Terminal was lost. You can restart it in the same worktree.</p>
                      <button className="dead-session-restart" onClick={() => handleRevive(id)}>
                        Restart terminal
                      </button>
                    </div>
                  </div>
                ) : (
                  <Terminal sessionId={id} />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
