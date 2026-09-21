import { ArrowRight, Brain, Megaphone, Prohibit } from "@phosphor-icons/react"
import { Crewmate } from "./Crewmate"
import { ShipMapFloor } from "./ShipMapFloor"
import type { Color } from "./game"
import type { RemoteGame, RemotePlayer } from "./remote"

function Ballot({ game, votes, observerMode = false }: { game: RemoteGame; votes: Record<string, string | null>; observerMode?: boolean }) {
  const player = (id: string) => game.players.find((candidate) => candidate.id === id)
  const entries = Object.entries(votes)
  const targets = game.players.filter((candidate) => candidate.alive).map((candidate) => ({
    player: candidate,
    voters: entries.filter(([, targetId]) => targetId === candidate.id).map(([voterId]) => voterId),
  })).filter((candidate) => candidate.voters.length > 0)
  return <div className="ballot-ledger">
    <div className="section-label"><span>LIVE BALLOT</span><b>{entries.length}/{game.players.filter((candidate) => candidate.alive).length} cast</b></div>
    {targets.length > 0 && <div className="ballot-tally" aria-live="polite" aria-label="Current vote totals">{targets.map(({ player: target, voters }) =>
      <div className="ballot-tally-row" key={target.id} aria-label={`${target.name}: ${voters.length} ${voters.length === 1 ? "vote" : "votes"}`}>
        <Crewmate color={target.color as Color} small /><strong className={observerMode && target.role === "impostor" ? "impostor-name" : undefined}>{target.name}</strong>
        <div className="ballot-pips" aria-hidden="true">{voters.map((voterId) => <i key={voterId} />)}</div><b>{voters.length}</b>
      </div>
    )}</div>}
    {entries.length === 0 ? <p>{game.meeting?.stage === "discussion" ? "Voting opens after discussion." : "Votes appear here as they are cast."}</p> : entries.map(([voterId, targetId]) => {
      const voter = player(voterId)
      const target = targetId ? player(targetId) : undefined
      if (!voter) return null
      return <div className="ballot-row" key={voterId}>
        <Crewmate color={voter.color as Color} small /><strong className={observerMode && voter.role === "impostor" ? "impostor-name" : undefined}>{voter.name}</strong><ArrowRight />
        {target ? <><Crewmate color={target.color as Color} small /><span className={observerMode && target.role === "impostor" ? "impostor-name" : undefined}>{target.name}</span></> : <><Prohibit /><span>Skipped</span></>}
      </div>
    })}
  </div>
}

export function MeetingView({ game, human, observerMode = false, onVote }: {
  game: RemoteGame
  human?: RemotePlayer
  observerMode?: boolean
  onVote: (targetId: string | null) => void
}) {
  const meeting = game.meeting
  if (!meeting) return null
  const selectedVote = human ? meeting.votes[human.id] : undefined
  const agents = game.players.filter((player) => player.alive && !player.human)
  const roster = game.players.filter((player) => player.alive)
  const speakers = agents.filter((player) => game.systemTwo[player.id]?.stage === "discussing" && game.systemTwo[player.id]?.status === "working")
  const spoken = new Set(meeting.transcript.map((message) => message.playerId))
  const voting = meeting.stage === "voting"
  const secondsToVote = meeting.discussionSecondsRemaining ?? 0
  const victim = meeting.bodyId ? game.players.find((player) => player.id === meeting.bodyId) : null
  const reporterLabel = meeting.bodyId ? "REPORTER" : "CALLER"
  const isRevealedImpostor = (player: RemotePlayer | undefined) => observerMode && player?.role === "impostor"
  return <main className="meeting-screen">
    <header><span className="signal-dot" /> SYSTEM 2 {voting ? "VOTING" : "DISCUSSION"} <b>{voting ? `TICK ${game.tick}` : `VOTING IN ${secondsToVote}s`}</b></header>
    <div className="meeting-grid">
      <section className="meeting-copy">
        <span>PUBLIC CLAIMS · {meeting.transcript.length} TURNS</span>
        <h1>{victim ? <>Body<br />reported.</> : <>Emergency<br />meeting.</>}</h1>
        <p>{meeting.reason}</p>
        {victim && <div className="meeting-victim"><Crewmate color={victim.color as Color} dead /><span><small>BODY FOUND</small><strong>{victim.name}</strong></span></div>}
        <div className="chat-log" aria-live="polite">
          {meeting.transcript.length === 0 && <p className="meeting-waiting">{speakers.length ? `${speakers.length} agents are forming statements…` : "Waiting for the first statement…"}</p>}
          {meeting.transcript.map((message, index) => { const speaker = game.players.find((player) => player.id === message.playerId); const isReporter = message.playerId === meeting.reporterId; return <div className={`${isRevealedImpostor(speaker) ? "impostor-revealed " : ""}${isReporter ? "meeting-reporter" : ""}`} key={`${message.playerId}-${index}`}>{isReporter ? <Megaphone weight="fill" aria-hidden="true" /> : <Brain weight="fill" />}<span><b>{speaker?.name}:</b> {message.text}</span>{isReporter && <small className="meeting-reporter-tag">{reporterLabel}</small>}</div> })}
          {!voting && meeting.transcript.length > 0 && <p className="meeting-waiting">Discussion remains open.</p>}
        </div>
      </section>
      <section className="vote-panel">
        <div className="section-label"><span>{voting ? "VOTE TO EJECT" : "DISCUSSION ROSTER"}</span><b>{game.players.filter((player) => player.alive).length} connected</b></div>
        {human?.alive && voting ? <>
          <div className="vote-grid">{game.players.filter((player) => player.alive && player.id !== human.id).map((player) => <button className={`${selectedVote === player.id ? "selected " : ""}${player.id === meeting.reporterId ? "meeting-reporter" : ""}`} key={player.id} onClick={() => onVote(player.id)}><Crewmate color={player.color as Color} small /><span>{player.name}</span><ArrowRight weight="bold" /></button>)}</div>
          <button className={selectedVote === null ? "skip-vote selected" : "skip-vote"} onClick={() => onVote(null)}>Skip vote</button>
        </> : <div className="meeting-roster">{roster.map((player) => <div className={`${isRevealedImpostor(player) ? "impostor-revealed " : ""}${player.id === meeting.reporterId ? "meeting-reporter" : ""}`} key={player.id}><Crewmate color={player.color as Color} small /><span>{player.name}</span>{player.id === meeting.reporterId && <small className="meeting-reporter-tag"><Megaphone weight="fill" aria-hidden="true" />{reporterLabel}</small>}<em>{spoken.has(player.id) ? "Spoken" : speakers.some((speaker) => speaker.id === player.id) ? "Thinking" : voting ? "Voting" : "Waiting"}</em></div>)}</div>}
        <Ballot game={game} votes={meeting.votes} observerMode={observerMode} />
        <div className="meeting-map"><div className="section-label"><span>SHIP MAP</span><b>THE SKELD</b></div><ShipMapFloor /></div>
      </section>
    </div>
  </main>
}

export { Ballot }
