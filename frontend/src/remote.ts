import type { GameConfig } from "./game"

export interface RemotePlayer {
  id: string
  name: string
  role: "crewmate" | "impostor" | null
  human: boolean
  alive: boolean
  connected: boolean
  position: { x: number; y: number } | null
  roomId: string | null
  color: string
  killCooldown: number
  memory?: {
    plan: {
      goal: string; targetRoom: string; rationale: string; validUntilTick: number
      alternative?: { goal: string; targetRoom: string; rationale: string; trigger: string }
      active?: "A" | "B"
    }
    events: { tick: number; kind: string; summary: string }[]
    suspicions: Record<string, number>
  }
}

export interface RemoteTask {
  id: string
  ownerId: string
  kind: string
  roomIds: string[]
  stage: number
  completed: boolean
  targetCell: number
  cursor: number
  pressed: boolean
}

export interface RemoteGame {
  id: string
  tick: number
  revision: number
  systemTwo: Record<string, {
    stage: "planning" | "discussing" | "voting"
    status: "working" | "success" | "fallback"
    detail: string
    atMs: number
    startedAtMs: number
    latencyMs: number | null
  }>
  systemTwoHistory: Record<string, RemoteGame["systemTwo"][string][]>
  settings: { visionRadius: number; systemTwoModel: string }
  firstKillAtMs: number
  phase: "action" | "meeting" | "ejection" | "finished"
  players: RemotePlayer[]
  tasks: RemoteTask[]
  bodies: { playerId: string; position: { x: number; y: number }; roomId: string; reported: boolean; createdAtTick: number }[]
  sabotage: string | null
  sabotageDeadline: number | null
  meeting: null | {
    reason: string
    reporterId: string
    bodyId: string | null
    startedAtTick?: number
    stage: "discussion" | "voting"
    transcript: { playerId: string; text: string }[]
    votes: Record<string, string | null>
    discussionEndsAtMs?: number
    discussionSecondsRemaining?: number
    awaitingSpeechIndex?: number | null
  }
  ejection: null | {
    votes: Record<string, string | null>
    ejectedId: string | null
    endsAtMs: number
  }
  winner: "crewmate" | "impostor" | null
}

export interface RemoteObservation {
  self: { id: string; role: "crewmate" | "impostor"; alive: boolean; roomId: string; killCooldown: number; ventId: string | null }
  knownImpostors: { id: string; name: string; alive: boolean }[]
  players: { slot: number; id: string; name: string; roomId: string; distance: number }[]
  bodies: RemoteGame["bodies"]
  interactionSlots: { slot: number; kind: "task" | "emergency" | "repair"; entityId: string; label: string }[]
  ventSlots: { slot: number; id: string; roomId: string }[]
  meetingReason: string | null
  meetingReporterId: string | null
  activeTask: RemoteTask | null
  actionMask: boolean[]
  taskProgress: { completed: number; total: number }
}

export interface RemoteSession {
  game: RemoteGame
  viewerId: string | null
  revealRoles: boolean
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } })
  const payload = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Server returned ${response.status}`)
  return payload
}

export async function createRemoteGame(config: GameConfig, openRouterApiKey: string): Promise<RemoteSession> {
  const payload = await api<{ game: RemoteGame; viewerId: string | null }>("/api/games", {
    method: "POST",
    body: JSON.stringify({ openRouterApiKey, settings: { playerCount: config.playerCount, impostorCount: config.impostorCount, humanPlayers: config.mode === "human" ? 1 : 0, systemTwoModel: config.system2Model }, revealRoles: config.mode === "agents" }),
  })
  return { ...payload, revealRoles: config.mode === "agents" }
}

function query(session: RemoteSession, viewerId = session.viewerId, overview = false): string {
  const params = new URLSearchParams()
  if (viewerId) params.set("viewerId", viewerId)
  if (session.revealRoles || overview) params.set("revealRoles", "true")
  if (overview) params.set("overview", "true")
  return params.toString()
}

export async function getRemoteGame(session: RemoteSession, viewerId = session.viewerId, overview = false): Promise<RemoteGame> {
  const payload = await api<{ game: RemoteGame }>(`/api/games/${session.game.id}?${query(session, viewerId, overview)}`)
  return payload.game
}

export async function stepRemoteGame(session: RemoteSession, playerId: string, actionId: number): Promise<RemoteGame> {
  const payload = await api<{ state: RemoteGame }>(`/api/games/${session.game.id}/step?${query(session, playerId)}`, { method: "POST", body: JSON.stringify({ playerId, actionId }) })
  return payload.state
}

export async function observeRemoteGame(session: RemoteSession, playerId: string): Promise<RemoteObservation> {
  const payload = await api<{ observation: RemoteObservation }>(`/api/games/${session.game.id}/observations/${playerId}`)
  return payload.observation
}

export async function voteRemoteGame(session: RemoteSession, playerId: string, targetId: string | null): Promise<RemoteGame> {
  const payload = await api<{ game: RemoteGame }>(`/api/games/${session.game.id}/vote?${query(session, playerId)}`, { method: "POST", body: JSON.stringify({ playerId, targetId }) })
  return payload.game
}

export async function speakRemoteGame(session: RemoteSession, playerId: string, text: string): Promise<RemoteGame> {
  const payload = await api<{ game: RemoteGame }>(`/api/games/${session.game.id}/speak?${query(session, playerId)}`, { method: "POST", body: JSON.stringify({ playerId, text }) })
  return payload.game
}

export async function acknowledgeRemoteSpeech(session: RemoteSession, playerId: string, startedAtTick: number, messageIndex: number): Promise<void> {
  await api<{ ok: true }>(`/api/games/${session.game.id}/speech-complete?${query(session, playerId)}`, { method: "POST", body: JSON.stringify({ playerId, startedAtTick, messageIndex }) })
}
