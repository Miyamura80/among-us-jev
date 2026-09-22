import { useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowRight, Brain, Megaphone, Prohibit, SpeakerHigh } from "@phosphor-icons/react"
import { Crewmate } from "./Crewmate"
import { ShipMapFloor } from "./ShipMapFloor"
import { formatDiscussionTime } from "./meeting-time"
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

export function MeetingView({ game, human, observerMode = false, onVote, onSpeak, onSpeechComplete }: {
  game: RemoteGame
  human?: RemotePlayer
  observerMode?: boolean
  onVote: (targetId: string | null) => void
  onSpeak?: (text: string) => Promise<void>
  onSpeechComplete?: (startedAtTick: number, messageIndex: number) => Promise<void>
}) {
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState("")
  const chatRef = useRef<HTMLDivElement>(null)
  const meeting = game.meeting
  const pendingSpeechIndex = human?.alive && meeting?.stage === "discussion" ? meeting.awaitingSpeechIndex : null
  const pendingSpeechText = pendingSpeechIndex == null ? null : meeting?.transcript[pendingSpeechIndex]?.text
  const meetingStartTick = meeting?.startedAtTick
  const bodyReported = Boolean(meeting?.bodyId)
  useEffect(() => {
    if (pendingSpeechIndex == null || !pendingSpeechText || !onSpeechComplete || meetingStartTick === undefined) return
    const spokenText = formatDiscussionTime(pendingSpeechText, meetingStartTick, bodyReported)
    const readingTimeMs = Math.min(20_000, Math.max(3_000, spokenText.split(/\s+/).length * 450))
    let finished = false
    let fallbackTimer: number | undefined
    const finish = () => {
      if (finished) return
      finished = true
      void onSpeechComplete(meetingStartTick, pendingSpeechIndex)
    }
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      fallbackTimer = window.setTimeout(finish, readingTimeMs)
      return () => window.clearTimeout(fallbackTimer)
    }
    const utterance = new SpeechSynthesisUtterance(spokenText)
    utterance.rate = 0.95
    let started = false
    utterance.onstart = () => { started = true }
    utterance.onend = finish
    utterance.onerror = () => { fallbackTimer = window.setTimeout(finish, readingTimeMs) }
    try { window.speechSynthesis.speak(utterance) }
    catch { fallbackTimer = window.setTimeout(finish, readingTimeMs) }
    const startupTimer = window.setTimeout(() => {
      if (started || finished || fallbackTimer !== undefined) return
      window.speechSynthesis.cancel()
      fallbackTimer = window.setTimeout(finish, readingTimeMs)
    }, 5_000)
    return () => {
      utterance.onstart = null
      utterance.onend = null
      utterance.onerror = null
      window.clearTimeout(startupTimer)
      window.clearTimeout(fallbackTimer)
      window.speechSynthesis.cancel()
    }
  }, [bodyReported, meetingStartTick, onSpeechComplete, pendingSpeechIndex, pendingSpeechText])
  useEffect(() => {
    if (chatRef.current && typeof chatRef.current.scrollTo === "function") chatRef.current.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" })
  }, [meeting?.transcript.length])
  if (!meeting) return null
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || !onSpeak || sending) return
    setSending(true)
    setSendError("")
    try {
      await onSpeak(message)
      setDraft("")
    } catch (caught) {
      setSendError(caught instanceof Error ? caught.message : "Message could not be sent")
    } finally {
      setSending(false)
    }
  }
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
  return <main className={`meeting-screen ${human?.alive ? "human-meeting" : ""}`}>
    <header><span className="signal-dot" /> SYSTEM 2 {voting ? "VOTING" : "DISCUSSION"} <b>{voting ? "BALLOT OPEN" : `VOTING IN ${secondsToVote}s`}</b></header>
    <div className="meeting-grid">
      <section className="meeting-copy">
        <span>PUBLIC CLAIMS · {meeting.transcript.length} TURNS</span>
        <h1>{victim ? <>Body<br />reported.</> : <>Emergency<br />meeting.</>}</h1>
        <p>{meeting.reason}</p>
        {victim && <div className="meeting-victim"><Crewmate color={victim.color as Color} dead /><span><small>BODY FOUND</small><strong>{victim.name}</strong></span></div>}
        <div className="chat-log" ref={chatRef} aria-live="polite">
          {meeting.transcript.length === 0 && <p className="meeting-waiting">{speakers.length ? `${speakers.length} agents are forming statements…` : "Waiting for the first statement…"}</p>}
          {meeting.transcript.map((message, index) => { const speaker = game.players.find((player) => player.id === message.playerId); const isReporter = message.playerId === meeting.reporterId; return <div className={`${isRevealedImpostor(speaker) ? "impostor-revealed " : ""}${isReporter ? "meeting-reporter" : ""}`} key={`${message.playerId}-${index}`}>{isReporter ? <Megaphone weight="fill" aria-hidden="true" /> : <Brain weight="fill" />}<span><b>{speaker?.name}:</b> {formatDiscussionTime(message.text, meeting.startedAtTick, Boolean(meeting.bodyId))}</span>{index === pendingSpeechIndex && <small className="meeting-speaking"><SpeakerHigh weight="fill" aria-hidden="true" /> Speaking</small>}{isReporter && <small className="meeting-reporter-tag">{reporterLabel}</small>}</div> })}
          {!voting && meeting.transcript.length > 0 && <p className="meeting-waiting">Discussion remains open.</p>}
        </div>
        {human?.alive && !voting && onSpeak && <form className="meeting-composer" onSubmit={(event) => void submit(event)}>
          <label htmlFor="meeting-message">Your message</label>
          <div><textarea id="meeting-message" value={draft} maxLength={500} rows={2} placeholder="Share what you saw…" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /><button type="submit" disabled={!draft.trim() || sending}>{sending ? "Sending…" : "Send"}</button></div>
          {sendError && <p role="alert">{sendError}</p>}
        </form>}
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
