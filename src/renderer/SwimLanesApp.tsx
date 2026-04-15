import { useEffect, useState, useCallback } from 'react'
import type { Session } from '../shared/types'
import BroadcastBar from './components/BroadcastBar'
import LaneHeader from './components/LaneHeader'
import Terminal from './components/Terminal'
import ReviewOverlay from './components/ReviewOverlay'

function parseSessionIds(): string[] {
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('sessions')
  return raw ? raw.split(',').filter(Boolean) : []
}

export default function SwimLanesApp() {
  const [sessionIds] = useState(parseSessionIds)
  const [sessions, setSessions] = useState<Session[]>([])
  const [focusedLane, setFocusedLane] = useState<string | null>(null)
  const [reviewOpenLanes, setReviewOpenLanes] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.api.getSessions().then((all) => {
      setSessions(all.filter((s) => sessionIds.includes(s.id)))
    })

    const unsub = window.api.onSessionsUpdated((all) => {
      setSessions((all as Session[]).filter((s) => sessionIds.includes(s.id)))
    })

    return unsub
  }, [sessionIds])

  const toggleReview = useCallback((laneId: string) => {
    setReviewOpenLanes((prev) => {
      const next = new Set(prev)
      if (next.has(laneId)) {
        next.delete(laneId)
        setTimeout(() => {
          const term = document.querySelector<HTMLElement>(
            `[data-lane-id="${laneId}"] .xterm-helper-textarea`
          )
          term?.focus()
        }, 420)
      } else {
        next.add(laneId)
      }
      return next
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'r') {
        e.preventDefault()
        e.stopPropagation()
        if (focusedLane) {
          toggleReview(focusedLane)
        }
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [focusedLane, toggleReview])

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
          const isReviewOpen = reviewOpenLanes.has(id)

          return (
            <div key={id} className="lane" data-lane-id={id} onClick={() => setFocusedLane(id)}>
              <LaneHeader session={session} focused={focusedLane === id} />
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
                  <div className="flip-container">
                    <div className={`flip-inner${isReviewOpen ? ' flipped' : ''}`}>
                      <div className="flip-front">
                        <Terminal sessionId={id} />
                      </div>
                      <div className="flip-back">
                        {isReviewOpen && (
                          <ReviewOverlay sessionId={id} onClose={() => toggleReview(id)} />
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
