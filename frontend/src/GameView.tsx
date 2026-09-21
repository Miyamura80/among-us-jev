import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowsOut, Brain, ChatsCircle, Crosshair, Eye, Flag, HandPalm, Lightning, MapTrifold, Megaphone, Skull, Warning, X } from "@phosphor-icons/react"
import { Crewmate } from "./Crewmate"
import { ShipMapFloor } from "./ShipMapFloor"
import { ACTION, ROOMS, actionLabel, buildActionMask, getRoom, nearestRoomTarget, type GameConfig, type GameState, type Player, type Point } from "./game"

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
interface GameViewProps { initialState: GameState; config: GameConfig; onExit: () => void }

function planFor(player: Player, state: GameState) {
  const target = nearestRoomTarget(player, state)
  return { target, goal: player.role === "impostor" ? `Shadow a target near ${target.label}` : `Complete route through ${target.label}`, rationale: player.role === "impostor" ? "Maintain cover; isolate before acting" : "Nearest unfinished objective with a safe path" }
}

function moveToward(position: Point, target: Point, speed: number) {
  const dx = target.x - position.x
  const dy = target.y - position.y
  if (Math.hypot(dx, dy) < 8) return { position, actionId: ACTION.STOP }
  const angle = Math.atan2(dy, dx)
  const actionId = ((Math.round(angle / (Math.PI / 4)) + 2 + 8) % 8) + 1
  return { position: { x: clamp(position.x + Math.cos(angle) * speed, 20, 975), y: clamp(position.y + Math.sin(angle) * speed, 35, 690) }, actionId }
}

export function GameView({ initialState, config, onExit }: GameViewProps) {
  const [game, setGame] = useState(initialState)
  const [viewId, setViewId] = useState(config.mode === "human" ? 0 : 1)
  const [showMap, setShowMap] = useState(false)
  const [showIntel, setShowIntel] = useState(true)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [discussion, setDiscussion] = useState(18)
  const keys = useRef(new Set<string>())
  const task = game.tasks.find((item) => item.id === taskId)
  const viewed = game.players[viewId] ?? game.players[0]!
  const human = game.players.find((player) => player.human)
  const mask = useMemo(() => buildActionMask(game, viewed.id), [game, viewed.id])
  const legalCount = mask.filter(Boolean).length

  const startMeeting = useCallback((reason: string) => {
    setDiscussion(18)
    setGame((current) => ({ ...current, phase: "meeting", meetingReason: reason, meetingLog: [`Rook: I tracked movement around ${current.players[1]?.room ?? "Cafeteria"}.`, "Mira: Give locations. Short answers.", "Vanta: I have no hard evidence yet."] }))
  }, [])

  const performKill = useCallback((killerId: number) => {
    setGame((current) => {
      const killer = current.players[killerId]
      if (!killer || killer.role !== "impostor" || killer.cooldown > 0) return current
      const target = current.players.find((candidate) => candidate.alive && candidate.role === "crewmate" && distance(candidate.position, killer.position) < 62)
      if (!target) return current
      return { ...current, bodies: [...current.bodies, { playerId: target.id, position: target.position, room: target.room }], players: current.players.map((player) => player.id === target.id ? { ...player, alive: false } : player.id === killer.id ? { ...player, cooldown: 22 } : player) }
    })
  }, [])

  useEffect(() => {
    const down = (event: KeyboardEvent) => { keys.current.add(event.key.toLowerCase()); if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(event.key.toLowerCase())) event.preventDefault() }
    const up = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase())
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up) }
  }, [])

  useEffect(() => {
    if (game.phase !== "action") return
    const timer = window.setInterval(() => {
      setGame((current) => {
        let next = { ...current, tick: current.tick + 1, sabotageTimer: current.sabotage ? current.sabotageTimer - 0.1 : 0 }
        next.players = current.players.map((player) => {
          if (!player.alive) return player
          if (player.human) {
            const dx = Number(keys.current.has("d") || keys.current.has("arrowright")) - Number(keys.current.has("a") || keys.current.has("arrowleft"))
            const dy = Number(keys.current.has("s") || keys.current.has("arrowdown")) - Number(keys.current.has("w") || keys.current.has("arrowup"))
            if (dx === 0 && dy === 0) return { ...player, cooldown: Math.max(0, player.cooldown - 0.1) }
            const magnitude = Math.hypot(dx, dy)
            const position = { x: clamp(player.position.x + (dx / magnitude) * 3.2 * config.speed, 20, 975), y: clamp(player.position.y + (dy / magnitude) * 3.2 * config.speed, 35, 690) }
            return { ...player, position, room: getRoom(position), cooldown: Math.max(0, player.cooldown - 0.1) }
          }
          const plan = planFor(player, current)
          const moved = moveToward(player.position, { x: plan.target.x + plan.target.width / 2, y: plan.target.y + plan.target.height / 2 }, (1.15 + (player.id % 3) * 0.17) * config.speed)
          const replan = current.tick % Math.max(20, config.planningInterval * 10) === player.id % 10
          return { ...player, position: moved.position, room: getRoom(moved.position), cooldown: Math.max(0, player.cooldown - 0.1), thought: replan ? { goal: plan.goal, rationale: plan.rationale, actionId: moved.actionId, actionLabel: actionLabel(moved.actionId), updatedAt: current.tick } : { ...player.thought, actionId: moved.actionId, actionLabel: actionLabel(moved.actionId) } }
        })
        next.tasks = current.tasks.map((task) => {
          if (task.completed) return task
          const agentAtTask = next.players.some((player) => !player.human && player.alive && player.role === "crewmate" && distance(player.position, task.position) < 16)
          return agentAtTask ? { ...task, completed: true } : task
        })
        if (!next.sabotage && current.tick > 120 && current.tick % 450 === 0 && next.players.some((player) => !player.human && player.alive && player.role === "impostor")) {
          next = { ...next, sabotage: ["reactor", "oxygen", "lights"][Math.floor(current.tick / 450) % 3] as GameState["sabotage"], sabotageTimer: 30 }
        }
        if (next.sabotage) {
          const repairRoom = next.sabotage === "reactor" ? "reactor" : next.sabotage === "lights" ? "electrical" : "admin"
          if (next.players.some((player) => player.alive && player.role === "crewmate" && player.room === repairRoom)) next = { ...next, sabotage: null, sabotageTimer: 0 }
        }
        const reporter = next.players.find((player) => !player.human && player.alive && player.role === "crewmate" && next.bodies.some((body) => distance(body.position, player.position) < 52))
        if (reporter && current.tick % 12 === 0) next = { ...next, phase: "meeting", meetingReason: `${reporter.name} reported a body in ${reporter.room}.`, meetingLog: [`${reporter.name}: Body in ${reporter.room}.`, "Rook: State your route.", "Mira: Comparing claims against my observation log."] }
        if (next.sabotage && next.sabotageTimer <= 0) next = { ...next, phase: "finished", winner: "impostor" }
        const crew = next.players.filter((player) => player.alive && player.role === "crewmate").length
        const impostors = next.players.filter((player) => player.alive && player.role === "impostor").length
        if (impostors === 0) next = { ...next, phase: "finished", winner: "crewmate" }
        else if (impostors >= crew) next = { ...next, phase: "finished", winner: "impostor" }
        return next
      })
      if (Math.random() < 0.015) setGame((current) => { const killer = current.players.find((player) => !player.human && player.alive && player.role === "impostor" && player.cooldown <= 0); if (killer) window.setTimeout(() => performKill(killer.id), 0); return current })
    }, 100)
    return () => window.clearInterval(timer)
  }, [config.planningInterval, config.speed, game.phase, performKill])

  useEffect(() => {
    if (game.phase !== "meeting") return
    const timer = window.setInterval(() => setDiscussion((value) => value > 0 ? value - 1 : 0), 1000)
    return () => window.clearInterval(timer)
  }, [game.phase])

  const nearestTask = viewed.role === "crewmate" ? game.tasks.find((candidate) => !candidate.completed && distance(candidate.position, viewed.position) < 75) : undefined
  const nearBody = game.bodies.find((body) => distance(body.position, viewed.position) < 75)
  useEffect(() => {
    if (!viewed.human || game.phase !== "action") return
    const interact = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "e" && nearestTask) setTaskId(nearestTask.id)
      if (event.key.toLowerCase() === "r" && nearBody) startMeeting(`${viewed.name} reported a body in ${viewed.room}.`)
    }
    window.addEventListener("keydown", interact)
    return () => window.removeEventListener("keydown", interact)
  }, [game.phase, nearBody, nearestTask, startMeeting, viewed.human, viewed.name, viewed.room])
  const completeTask = (cell: number) => {
    if (!task || cell !== task.targetCell) return
    setGame((current) => { const tasks = current.tasks.map((candidate) => candidate.id === task.id ? { ...candidate, completed: true } : candidate); const allDone = tasks.every((candidate) => candidate.completed); return { ...current, tasks, phase: allDone ? "finished" : current.phase, winner: allDone ? "crewmate" : current.winner } })
    setTaskId(null)
  }
  const vote = (targetId: number) => {
    setGame((current) => { const target = current.players[targetId]; if (!target) return current; const players = current.players.map((player) => player.id === targetId ? { ...player, alive: false } : player); const impostors = players.filter((player) => player.alive && player.role === "impostor").length; return { ...current, players, phase: impostors === 0 ? "finished" : "action", winner: impostors === 0 ? "crewmate" : null, bodies: [], meetingLog: [...current.meetingLog, `${target.name} was ejected.`] } })
  }

  if (game.phase === "finished") return <EndScreen game={game} onExit={onExit} />
  if (game.phase === "meeting") return <Meeting game={game} discussion={discussion} revealRoles={config.revealRoles} autonomous={config.mode === "agents"} onVote={vote} onSkip={() => setGame((current) => ({ ...current, phase: "action", bodies: [] }))} />

  return <main className="game-shell">
    <header className="game-topbar"><button className="wordmark compact" onClick={onExit}><span className="signal-dot" /> MIRA/OS</button><div className="task-meter"><span>CREW PROGRESS</span><div><i style={{ width: `${(game.tasks.filter((item) => item.completed).length / game.tasks.length) * 100}%` }} /></div><b>{game.tasks.filter((item) => item.completed).length}/{game.tasks.length}</b></div>{game.sabotage && <div className="sabotage-alert"><Warning weight="fill" /> {game.sabotage.toUpperCase()} · {Math.ceil(game.sabotageTimer)}s</div>}<div className="top-actions"><button onClick={() => setShowMap((value) => !value)} aria-label="Toggle map"><MapTrifold /></button><button onClick={() => setShowIntel((value) => !value)} aria-label="Toggle agent intelligence"><Brain /></button><button onClick={onExit} aria-label="Leave game"><X /></button></div></header>
    <section className="game-layout"><div className="viewport"><div className="map-stage"><ShipMapFloor activeRoomId={viewed.room} tasks={game.tasks.map((item) => ({ kind: item.id === "card" ? "card-swipe" : item.id, roomIds: [item.room], stage: 0, completed: item.completed }))} />
      {game.bodies.map((body) => { const victim = game.players[body.playerId]; return victim ? <div key={body.playerId} className="map-entity body" style={{ left: `${body.position.x / 10}%`, top: `${body.position.y / 7.2}%` }}><Crewmate color={victim.color} dead small /></div> : null })}
      {game.players.filter((player) => player.alive).map((player) => <button key={player.id} className={`map-entity player ${player.id === viewId ? "viewed" : ""}`} style={{ left: `${player.position.x / 10}%`, top: `${player.position.y / 7.2}%` }} onClick={() => config.mode === "agents" && setViewId(player.id)} aria-label={`View ${player.name}`}><span>{player.name}</span><Crewmate color={player.color} small /></button>)}<div className="vignette" />{showMap && <div className="map-overlay"><MapTrifold size={26} /><b>{ROOMS.find((room) => room.id === viewed.room)?.label}</b><span>Task markers are shown in amber</span></div>}</div>
      <div className="identity-card"><Crewmate color={viewed.color} small /><div><span>{viewed.human ? "YOUR FEED" : "SPECTATING"}</span><strong>{viewed.name}</strong></div>{(viewed.human || config.revealRoles || !viewed.alive) && <em className={viewed.role}>{viewed.role}</em>}</div><div className="controls-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>move</span><kbd>E</kbd><span>use</span></div>
      <div className="action-dock"><button disabled={!nearBody} onClick={() => startMeeting(`${viewed.name} reported a body in ${viewed.room}.`)}><Megaphone weight="fill" /><span>Report</span></button><button className="primary-action" disabled={!nearestTask} onClick={() => nearestTask && setTaskId(nearestTask.id)}><HandPalm weight="fill" /><span>Use</span></button>{viewed.role === "impostor" && <button className="danger-action" onClick={() => performKill(viewed.id)} disabled={viewed.cooldown > 0}><Skull weight="fill" /><span>{viewed.cooldown > 0 ? Math.ceil(viewed.cooldown) : "Kill"}</span></button>}{viewed.room === "cafeteria" && <button onClick={() => startMeeting(`${viewed.name} called an emergency meeting.`)}><Warning weight="fill" /><span>Meeting</span></button>}</div></div>
      {showIntel && <aside className="intel-panel"><div className="panel-heading"><div><span>LIVE COGNITION</span><h2>{viewed.human ? "Action telemetry" : viewed.name}</h2></div><span className="live-pill"><i /> LIVE</span></div><div className="architecture"><div className="thought system2"><span><Brain weight="fill" /> SYSTEM 2</span><b>{viewed.model}</b><p>{viewed.human ? "Human-directed intent" : viewed.thought.goal}</p><small>{viewed.human ? "Keyboard and direct UI control" : viewed.thought.rationale}</small></div><div className="handoff"><i /><span>goal vector</span><i /></div><div className="thought system1"><span><Lightning weight="fill" /> SYSTEM 1</span><b>Jev policy</b><div className="action-code"><strong>{viewed.human ? "-" : viewed.thought.actionId}</strong><code>{viewed.human ? "DIRECT_CONTROL" : viewed.thought.actionLabel}</code></div></div></div><div className="mask-card"><div><span>ACTION MASK</span><b>{legalCount} / 255 enabled</b></div><div className="mask-strip">{Array.from({ length: 51 }, (_, index) => <i key={index} className={mask[index * 5] ? "on" : ""} />)}</div><button onClick={() => setShowMap(true)}><ArrowsOut /> Inspect observation</button></div><div className="roster"><div className="section-label"><span>OBS.PLAYERS</span><b>{game.players.filter((player) => player.alive).length} alive</b></div>{game.players.map((player, index) => <button key={player.id} className={!player.alive ? "dead" : player.id === viewId ? "selected" : ""} onClick={() => (!human?.alive || config.mode === "agents") && setViewId(player.id)}><span className={`color-dot ${player.color}`} /><b>{index}</b><span>{player.name}</span>{!player.alive && <Skull />}{config.revealRoles && <em>{player.role === "impostor" ? "IMP" : "CREW"}</em>}</button>)}</div></aside>}
    </section>{task && <TaskModal task={task} onCell={completeTask} onClose={() => setTaskId(null)} />}
  </main>
}

function TaskModal({ task, onCell, onClose }: { task: GameState["tasks"][number]; onCell: (cell: number) => void; onClose: () => void }) {
  return <div className="modal-backdrop"><section className="task-console"><header><div><span>MAINTENANCE PANEL</span><h2>{task.label}</h2></div><button onClick={onClose}><X /></button></header><p>Locate the unstable node. Signal strength increases near the fault.</p><div className="task-grid">{Array.from({ length: 64 }, (_, index) => { const row = Math.floor(index / 8); const col = index % 8; const tr = Math.floor(task.targetCell / 8); const tc = task.targetCell % 8; const heat = Math.max(0, 4 - Math.abs(row - tr) - Math.abs(col - tc)); return <button key={index} style={{ opacity: 0.25 + heat * 0.18 }} onClick={() => onCell(index)} aria-label={`Task cell ${index}`}><span /></button> })}</div><footer><code>ACTION 100–163 · TASK_CLICK_0..63</code><span>Click the brightest node</span></footer></section></div>
}

function Meeting({ game, discussion, revealRoles, autonomous, onVote, onSkip }: { game: GameState; discussion: number; revealRoles: boolean; autonomous: boolean; onVote: (id: number) => void; onSkip: () => void }) {
  const resolved = useRef(false)
  useEffect(() => {
    if (!autonomous || discussion > 0 || resolved.current) return
    resolved.current = true
    const candidates = game.players.filter((player) => player.alive)
    const suspected = candidates.find((player) => player.role === "impostor") ?? candidates[0]
    if (suspected) onVote(suspected.id)
  }, [autonomous, discussion, game.players, onVote])
  return <main className="meeting-screen"><header><span className="signal-dot" /> INCIDENT REVIEW <b>{discussion}s</b></header><div className="meeting-grid"><section className="meeting-copy"><span>MEETING 01</span><h1>Talk fast.<br />Trust slowly.</h1><p>{game.meetingReason}</p><div className="chat-log">{game.meetingLog.map((line) => <div key={line}><ChatsCircle weight="fill" /><span>{line}</span></div>)}</div></section><section className="vote-panel"><div className="section-label"><span>VOTE TO EJECT</span><b>{game.players.filter((player) => player.alive).length} connected</b></div><div className="vote-grid">{game.players.filter((player) => player.alive).map((player) => <button key={player.id} onClick={() => onVote(player.id)}><Crewmate color={player.color} small /><span>{player.name}</span>{revealRoles && <em>{player.role}</em>}<Flag weight="fill" /></button>)}</div><button className="skip-vote" onClick={onSkip}>Skip vote</button></section></div></main>
}

function EndScreen({ game, onExit }: { game: GameState; onExit: () => void }) {
  const winner = game.winner ?? "crewmate"
  return <main className={`end-screen ${winner}`}><div className="end-orbit"><Crosshair /></div><span>SIMULATION COMPLETE</span><h1>{winner === "crewmate" ? "Crew holds the ship." : "The signal went dark."}</h1><p>{winner === "crewmate" ? "Every impostor was removed or all objectives were completed." : "Impostors reached parity with the surviving crew."}</p><div className="survivors">{game.players.filter((player) => player.role === winner).map((player) => <Crewmate key={player.id} color={player.color} small />)}</div><button onClick={onExit}><Eye weight="fill" /> Return to control room</button></main>
}
