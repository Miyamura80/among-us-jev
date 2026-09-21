import { useEffect, useState } from "react"
import type { RemoteGame } from "./remote"

export function SystemTwoTelemetry({ game, playerId, activeTask }: {
  game: RemoteGame
  playerId: string
  activeTask?: string | null
}) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  const current = game.systemTwo?.[playerId]
  const history = game.systemTwoHistory?.[playerId] ?? []
  const plan = game.players.find((player) => player.id === playerId)?.memory?.plan
  const elapsed = current?.status === "working" && now > 0
    ? `${((now - current.startedAtMs) / 1000).toFixed(1)}s`
    : current?.latencyMs !== null && current?.latencyMs !== undefined
      ? `${(current.latencyMs / 1000).toFixed(1)}s`
      : "-"
  return <div className="system-two-telemetry">
    <div className="telemetry-status"><i className={current?.status ?? "idle"} /><strong>{current ? `${current.stage} · ${current.status}` : "Awaiting first plan"}</strong><span>{elapsed}</span></div>
    {current && <p>{current.detail}</p>}
    {activeTask && <div className="telemetry-task">Task UI active · {activeTask}</div>}
    {plan?.alternative && <details><summary>Plan A / B · active {plan.active ?? "A"}</summary><div className="telemetry-plan-options"><p><b>A · default</b> {plan.goal} → {plan.targetRoom}</p><p><b>B · if {plan.alternative.trigger}</b> {plan.alternative.goal} → {plan.alternative.targetRoom}</p></div></details>}
    <details><summary>Thinking timeline · {history.length} events</summary><div className="telemetry-timeline">{history.slice().reverse().map((event, index) => <div key={`${event.atMs}-${index}`}>
      <span>{new Date(event.atMs).toLocaleTimeString()}</span><b className={event.status}>{event.stage} · {event.status}</b><p>{event.detail}</p>
    </div>)}</div></details>
    <details><summary>Fleet activity</summary><div className="telemetry-fleet">{game.players.filter((player) => !player.human).map((player) => {
      const agent = game.systemTwo?.[player.id]
      return <div key={player.id}><span>{player.name}</span><b className={agent?.status ?? "idle"}>{agent ? `${agent.stage} · ${agent.status}` : "pending"}</b></div>
    })}</div></details>
  </div>
}
