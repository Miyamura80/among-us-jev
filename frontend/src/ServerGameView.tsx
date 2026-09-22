import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Brain, Eye, HandPalm, Lightning, Megaphone, Skull, Warning, X } from "@phosphor-icons/react"
import { Crewmate } from "./Crewmate"
import { MapPlayer } from "./MapPlayer"
import { VisionFog } from "./VisionFog"
import { BodyMarker } from "./BodyMarker"
import { EjectionView } from "./EjectionView"
import { MeetingView } from "./MeetingView"
import { ShipMapFloor } from "./ShipMapFloor"
import { SystemTwoTelemetry } from "./SystemTwoTelemetry"
import { actionLabel } from "./game"
import { ROOMS } from "../../src/game/map"
import { acknowledgeRemoteSpeech, getRemoteGame, observeRemoteGame, speakRemoteGame, stepRemoteGame, voteRemoteGame, type RemoteGame, type RemoteObservation, type RemotePlayer, type RemoteSession } from "./remote"

const MOVEMENT: Record<string, number> = { w: 1, arrowup: 1, d: 3, arrowright: 3, s: 5, arrowdown: 5, a: 7, arrowleft: 7 }
export function ServerGameView({ initialSession, onExit }: { initialSession: RemoteSession; onExit: () => void }) {
  const [session, setSession] = useState(initialSession)
  const [viewId, setViewId] = useState(initialSession.viewerId ?? initialSession.game.players[0]?.id ?? "")
  const [observation, setObservation] = useState<RemoteObservation | null>(null)
  const [taskOpen, setTaskOpen] = useState(false)
  const [error, setError] = useState("")
  const busy = useRef(false)
  const polling = useRef(false)
  const actionVersion = useRef(0)
  const sessionRef = useRef(initialSession)
  const renderedViewId = useRef(initialSession.viewerId)
  const keys = useRef(new Set<string>())
  const mapStageRef = useRef<HTMLDivElement>(null)
  const [mapScale, setMapScale] = useState(1)
  const game = session.game
  const viewed = game.players.find((player) => player.id === viewId) ?? game.players[0]
  const actorId = viewed?.human ? viewed.id : undefined
  const human = game.players.find((player) => player.human)
  const observerMode = !human || !human.alive
  const visiblePlayers = game.players.filter((player): player is RemotePlayer & { position: { x: number; y: number } } => player.alive && player.position !== null)

  const refreshObservation = useCallback(async (playerId: string) => {
    try { setObservation(await observeRemoteGame(session, playerId)) } catch (caught) { setError(caught instanceof Error ? caught.message : "Observation failed") }
  }, [session])

  useEffect(() => { if (viewId) void refreshObservation(viewId) }, [refreshObservation, viewId, game.tick])
  useLayoutEffect(() => {
    const stage = mapStageRef.current
    if (!stage) return
    const resize = () => { if (stage.clientWidth > 0) setMapScale(stage.clientWidth / 1000) }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    keys.current.clear()
    if (game.phase !== "action") return
    const down = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return
      keys.current.add(event.key.toLowerCase())
      if (MOVEMENT[event.key.toLowerCase()]) event.preventDefault()
    }
    const up = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase())
    window.addEventListener("keydown", down); window.addEventListener("keyup", up)
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up) }
  }, [game.phase])

  const update = useCallback((next: RemoteGame, payloadViewerId = renderedViewId.current) => {
    if (next.revision <= sessionRef.current.game.revision && payloadViewerId === renderedViewId.current) return
    sessionRef.current = { ...sessionRef.current, game: next }
    renderedViewId.current = payloadViewerId
    setSession(sessionRef.current)
  }, [])
  const speak = useCallback(async (text: string) => {
    if (!human?.id) throw new Error("No human player is available")
    update(await speakRemoteGame(sessionRef.current, human.id, text), human.id)
  }, [human?.id, update])
  const completeSpeech = useCallback(async (startedAtTick: number, messageIndex: number) => {
    if (!human?.id) return
    try { await acknowledgeRemoteSpeech(sessionRef.current, human.id, startedAtTick, messageIndex) } catch { /* Meeting may have ended while audio was playing. */ }
  }, [human?.id])
  const pollGame = useCallback(async () => {
    if (polling.current || busy.current) return
    polling.current = true
    const startedAtAction = actionVersion.current
    try {
      const next = await getRemoteGame(sessionRef.current, viewId, observerMode)
      if (!busy.current && actionVersion.current === startedAtAction) update(next, viewId)
      setError("")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Game refresh failed") } finally { polling.current = false }
  }, [observerMode, update, viewId])
  const act = useCallback(async (actionId: number) => {
    if (!actorId || busy.current) return
    busy.current = true
    actionVersion.current += 1
    try { update(await stepRemoteGame(sessionRef.current, actorId, actionId), actorId); setError("") } catch (caught) { setError(caught instanceof Error ? caught.message : "Action failed") } finally { busy.current = false }
  }, [actorId, update])
  const performTask = useCallback(async (task: NonNullable<RemoteObservation["activeTask"]>, cell = 0) => {
    if (["wires", "asteroids", "manifolds", "navigation"].includes(task.kind)) {
      await act(100 + cell)
    } else if (["scan", "upload"].includes(task.kind)) {
      await act(170)
    } else if (!busy.current) {
      busy.current = true
      actionVersion.current += 1
      try {
        const pressed = await stepRemoteGame(sessionRef.current, viewed.id, 168)
        const released = await stepRemoteGame({ ...sessionRef.current, game: pressed }, viewed.id, 169)
        update(released, viewed.id)
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Task gesture failed") } finally { busy.current = false }
    }
    setTaskOpen(false)
  }, [act, update, viewed.id])

  useEffect(() => {
    if (!human?.alive || game.phase !== "action") return
    const timer = window.setInterval(() => {
      const key = [...keys.current].find((candidate) => MOVEMENT[candidate] !== undefined)
      if (key) void act(MOVEMENT[key] ?? 0)
    }, 100)
    return () => window.clearInterval(timer)
  }, [act, game.phase, human?.alive])

  useEffect(() => {
    if (game.phase === "finished") return
    const timer = window.setInterval(() => void pollGame(), 250)
    return () => window.clearInterval(timer)
  }, [game.phase, pollGame])

  const legalCount = observation?.actionMask.filter(Boolean).length ?? 0
  const progress = useMemo(() => {
    const tasks = game.tasks
    return { done: tasks.filter((task) => task.completed).length, total: tasks.length }
  }, [game.tasks])
  if (!viewed) return null
  const displayedPlan = viewed.memory?.plan
  const activeOption = displayedPlan?.active === "B" && displayedPlan.alternative ? displayedPlan.alternative : displayedPlan
  if (game.phase === "finished") return <main className={`end-screen ${game.winner}`}><span>AUTHORITATIVE RESULT</span><h1>{game.winner === "crewmate" ? "Crew holds the ship." : "The signal went dark."}</h1><p>Resolved by the server simulation at tick {game.tick}.</p><button onClick={onExit}><Eye weight="fill" /> Return to control room</button></main>
  if (game.phase === "ejection") return <EjectionView game={game} />
  if (game.phase === "meeting") return <MeetingView game={game} human={human} observerMode={observerMode} onSpeak={speak} onSpeechComplete={completeSpeech} onVote={(targetId) => { if (human) void voteRemoteGame(session, human.id, targetId).then(update) }} />

  const firstInteraction = observation?.interactionSlots[0]
  const killId = observation?.actionMask.findIndex((enabled, id) => enabled && id >= 20 && id <= 34) ?? -1
  const ventOptions = observation?.ventSlots.filter((vent) => observation.actionMask[50 + vent.slot]) ?? []
  const canSabotage = observation?.actionMask[60] === true
  const visionRadius = game.sabotage === "lights" ? game.settings.visionRadius * .3 : game.settings.visionRadius
  const openingSeconds = Math.max(0, Math.ceil((game.firstKillAtMs - Date.now()) / 1000))
  return <main className="game-shell"><header className="game-topbar"><button className="wordmark compact" onClick={onExit}><span className="signal-dot" /> Jev Among Us</button><div className="task-meter"><span>PRIVATE TASKS</span><div><i style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%` }} /></div><b>{progress.done}/{progress.total}</b></div>{game.sabotage && <div className="sabotage-alert"><Warning weight="fill" /> {game.sabotage.toUpperCase()} · {Math.max(0, (game.sabotageDeadline ?? game.tick) - game.tick)}t</div>}<div className="top-actions"><span className="live-pill"><i /> SERVER</span><button onClick={onExit}><X /></button></div></header>
    <section className="game-layout"><div className="viewport"><div className="map-stage" ref={mapStageRef}><ShipMapFloor activeRoomId={viewed.roomId} tasks={game.tasks.filter((task) => task.ownerId === viewed.id)} />{game.bodies.filter((body) => !body.reported).map((body) => { const player = game.players.find((candidate) => candidate.id === body.playerId); return player ? <BodyMarker body={body} player={player} scale={mapScale} currentTick={game.tick} key={body.playerId} /> : null })}{visiblePlayers.map((player) => <MapPlayer key={player.id} player={player} scale={mapScale} viewed={player.id === viewId} canSelect={observerMode} onSelect={() => setViewId(player.id)} />)}{viewed.position && !observerMode && <VisionFog origin={viewed.position} radius={visionRadius} />}<div className="vignette" /></div>
      <div className={`identity-card ${observerMode ? "observer" : ""}`}><Crewmate color={viewed.color as never} small /><div><span>{observerMode ? "OBSERVER OVERVIEW · CLICK A PLAYER" : "YOUR PRIVATE OBSERVATION"}</span><strong>{viewed.name}</strong></div>{viewed.role && <em className={viewed.role}>{viewed.role}</em>}</div>{error && <div className="map-overlay"><Warning /><b>{error}</b></div>}{openingSeconds > 0 && <div className="opening-timer">Opening phase · first kill possible in {Math.floor(openingSeconds / 60)}:{String(openingSeconds % 60).padStart(2, "0")}</div>}{!observerMode && <div className="controls-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>server movement</span></div>}
      {viewed.human && viewed.alive && !observerMode && <div className="action-dock"><button disabled={!observation?.actionMask[18]} onClick={() => void act(18)}><Megaphone weight="fill" /><span>Report</span></button><button className="primary-action" disabled={!firstInteraction} onClick={() => firstInteraction?.kind === "task" ? setTaskOpen(true) : void act(10 + (firstInteraction?.slot ?? 0))}><HandPalm weight="fill" /><span>Use</span></button>{viewed.role === "impostor" && <button className="danger-action" disabled={killId < 0} onClick={() => void act(killId)}><Skull weight="fill" /><span>Kill</span></button>}{viewed.role === "impostor" && (ventOptions.length ? ventOptions.map((vent) => <button key={vent.id} onClick={() => void act(50 + vent.slot)}><Eye weight="fill" /><span>{observation?.self.ventId === null ? "Vent" : observation?.self.ventId === vent.id ? "Exit" : `To ${vent.id === "vent-hallway" ? "Hallway" : ROOMS.find((room) => room.id === vent.roomId)?.label ?? vent.roomId}`}</span></button>) : <button disabled><Eye weight="fill" /><span>Vent</span></button>)}{viewed.role === "impostor" && <button disabled={!canSabotage} onClick={() => void act(60)}><Warning weight="fill" /><span>Reactor</span></button>}</div>}</div>
      {observerMode && <aside className="intel-panel"><div className="panel-heading"><div><span>PRIVATE COGNITION</span><h2>{viewed.name}</h2></div><span className="live-pill"><i /> LIVE</span></div><div className="architecture"><div className="thought system2"><span><Brain weight="fill" /> SYSTEM 2</span><b>{game.settings.systemTwoModel}</b><p>{activeOption?.goal ?? "Private to this agent"}</p><small>{displayedPlan?.active === "B" ? "PLAN B · " : "PLAN A · "}{activeOption?.rationale ?? "Select this POV to inspect its permitted memory."}</small>{observerMode && <SystemTwoTelemetry game={game} playerId={viewed.id} activeTask={observation?.activeTask?.kind} />}</div><div className="handoff"><i /><span>typed goal</span><i /></div><div className="thought system1"><span><Lightning weight="fill" /> SYSTEM 1</span><b>Jev · masked choice</b><div className="action-code"><strong>{legalCount}</strong><code>OF 255 LEGAL</code></div></div></div><div className="mask-card"><div><span>ACTION MASK</span><b>{legalCount} / 255 enabled</b></div><div className="mask-strip">{Array.from({ length: 51 }, (_, index) => <i key={index} className={observation?.actionMask[index * 5] ? "on" : ""} />)}</div></div><div className="roster"><div className="section-label"><span>OBS.PLAYERS</span><b>{observation?.players.length ?? 0} visible</b></div>{observation?.players.map((player) => <button key={player.id}><span className="color-dot gray" /><b>{player.slot}</b><span>{player.name}</span><em>{Math.round(player.distance)}u</em></button>)}</div><details className="memory-details"><summary>Private memory</summary>{viewed.memory?.events.slice(-8).map((event) => <p key={`${event.tick}-${event.summary}`}><b>{event.tick}</b> {event.summary}</p>)}</details></aside>}
    </section>{taskOpen && observation?.activeTask && <div className="modal-backdrop"><section className="task-console"><header><div><span>{observation.activeTask.kind.toUpperCase()}</span><h2>Task interface</h2></div><button onClick={() => setTaskOpen(false)}><X /></button></header>{["wires", "asteroids", "manifolds", "navigation"].includes(observation.activeTask.kind) ? <div className="task-grid">{Array.from({ length: 64 }, (_, index) => <button key={index} style={{ opacity: index === observation.activeTask?.targetCell ? 1 : .25 }} onClick={() => void performTask(observation.activeTask!, index)}><span /></button>)}</div> : <button className="task-sequence-button" onClick={() => void performTask(observation.activeTask!)}><Lightning weight="fill" /><span>{["card-swipe", "fuel"].includes(observation.activeTask.kind) ? "Press and release control" : "Confirm system cycle"}</span></button>}<footer><code>{["scan", "upload"].includes(observation.activeTask.kind) ? actionLabel(170) : observation.activeTask.kind}</code><span>Server validated</span></footer></section></div>}
  </main>
}
