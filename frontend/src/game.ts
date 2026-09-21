import { ROOMS as SHARED_ROOMS } from "../../src/game/map"

export const ACTION_COUNT = 255

export const ACTION = {
  NOOP: 0, MOVE_N: 1, MOVE_NE: 2, MOVE_E: 3, MOVE_SE: 4, MOVE_S: 5, MOVE_SW: 6, MOVE_W: 7, MOVE_NW: 8, STOP: 9,
  INTERACT_START: 10, REPORT_BODY: 18, CALL_MEETING: 19, KILL_START: 20, ABILITY_START: 35, VENT_START: 50,
  SABOTAGE_START: 60, DOOR_START: 80, TASK_CLICK_START: 100, TASK_CURSOR_START: 164, TASK_PRESS: 168,
  TASK_RELEASE: 169, TASK_CONFIRM: 170, TASK_CANCEL: 171,
} as const

export type Role = "crewmate" | "impostor"
export type Phase = "lobby" | "action" | "meeting" | "finished"
export type Color = "red" | "cyan" | "lime" | "yellow" | "pink" | "orange" | "white" | "purple" | "blue" | "coral" | "mint" | "brown" | "gray" | "banana" | "rose"
export interface Point { x: number; y: number }
export interface Room { id: string; label: string; x: number; y: number; width: number; height: number }
export interface Task { id: string; label: string; room: string; position: Point; completed: boolean; targetCell: number }
export interface AgentThought { goal: string; rationale: string; actionId: number; actionLabel: string; updatedAt: number }
export interface Player { id: number; name: string; color: Color; role: Role; human: boolean; alive: boolean; position: Point; room: string; model: string; thought: AgentThought; cooldown: number; vote?: number }
export interface GameConfig { mode: "human" | "agents"; playerCount: number; impostorCount: number; system2Model: string; system2Endpoint: string; planningInterval: number; speed: number; revealRoles: boolean }
export interface GameState { phase: Phase; tick: number; players: Player[]; tasks: Task[]; bodies: { playerId: number; position: Point; room: string }[]; sabotage: null | "reactor" | "oxygen" | "lights"; sabotageTimer: number; meetingReason: string; meetingLog: string[]; winner: null | Role; emergencyMeetings: number }

export const ROOMS: Room[] = SHARED_ROOMS
export const COLORS: Color[] = ["red", "cyan", "lime", "yellow", "pink", "orange", "white", "purple", "blue", "coral", "mint", "brown", "gray", "banana", "rose"]
const NAMES = ["You", "Rook", "Mira", "Pico", "Vanta", "Sol", "Kite", "Echo", "Nova", "Moss", "Orbit", "Pixel", "Rune", "Fable", "Lux"]
export const DEFAULT_CONFIG: GameConfig = { mode: "human", playerCount: 10, impostorCount: 2, system2Model: "deepseek/deepseek-v4.1-flash", system2Endpoint: "https://openrouter.ai/api/v1", planningInterval: 8, speed: 1, revealRoles: false }
const roomCenter = (room: Room): Point => ({ x: room.x + room.width / 2, y: room.y + room.height / 2 })

export function getRoom(position: Point): string {
  let closest = ROOMS[0]
  let best = Number.POSITIVE_INFINITY
  for (const room of ROOMS) {
    const center = roomCenter(room)
    const candidate = Math.hypot(position.x - center.x, position.y - center.y)
    if (candidate < best) { best = candidate; closest = room }
  }
  return closest?.id ?? "cafeteria"
}

export function createGame(config: GameConfig): GameState {
  const spawn = roomCenter(ROOMS[0]!)
  const impostors = new Set<number>()
  for (let i = 0; i < config.impostorCount; i += 1) impostors.add(config.mode === "human" ? config.playerCount - 1 - i : i)
  const players = Array.from({ length: config.playerCount }, (_, id): Player => ({
    id, name: config.mode === "human" && id === 0 ? "You" : NAMES[id] ?? `Unit ${id}`, color: COLORS[id] ?? "gray",
    role: impostors.has(id) ? "impostor" : "crewmate", human: config.mode === "human" && id === 0, alive: true,
    position: { x: spawn.x + ((id % 5) - 2) * 24, y: spawn.y + (Math.floor(id / 5) - 1) * 25 }, room: "cafeteria",
    model: config.system2Model, thought: { goal: "Orient in Cafeteria", rationale: "Round has just started", actionId: 0, actionLabel: "NOOP", updatedAt: 0 }, cooldown: 0,
  }))
  const seeds: [string, string, string, number][] = [["wires", "Fix wiring", "electrical", 22], ["card", "Swipe card", "admin", 41], ["scan", "Submit scan", "medbay", 11], ["asteroids", "Clear asteroids", "weapons", 54], ["upload", "Upload data", "communications", 33], ["fuel", "Fuel engines", "storage", 6]]
  const tasks = seeds.map(([id, label, roomId, targetCell]) => ({ id, label, room: roomId, position: roomCenter(ROOMS.find((room) => room.id === roomId)!), completed: false, targetCell }))
  return { phase: "action", tick: 0, players, tasks, bodies: [], sabotage: null, sabotageTimer: 0, meetingReason: "", meetingLog: [], winner: null, emergencyMeetings: 1 }
}

export function actionLabel(actionId: number): string {
  const movement = ["NOOP", "MOVE_N", "MOVE_NE", "MOVE_E", "MOVE_SE", "MOVE_S", "MOVE_SW", "MOVE_W", "MOVE_NW", "STOP"]
  if (actionId <= 9) return movement[actionId] ?? "NOOP"
  if (actionId <= 17) return `INTERACT_SLOT_${actionId - 10}`
  if (actionId === 18) return "REPORT_BODY"
  if (actionId === 19) return "CALL_EMERGENCY_MEETING"
  if (actionId <= 34) return `KILL_PLAYER_${actionId - 20}`
  if (actionId <= 49) return `ABILITY_PLAYER_${actionId - 35}`
  if (actionId <= 59) return `VENT_SLOT_${actionId - 50}`
  if (actionId <= 79) return `SABOTAGE_${actionId - 60}`
  if (actionId <= 99) return `DOOR_${actionId - 80}`
  if (actionId <= 163) return `TASK_CLICK_${actionId - 100}`
  if (actionId <= 167) return ["TASK_CURSOR_UP", "TASK_CURSOR_DOWN", "TASK_CURSOR_LEFT", "TASK_CURSOR_RIGHT"][actionId - 164] ?? "TASK_CURSOR"
  if (actionId <= 171) return ["TASK_PRESS", "TASK_RELEASE", "TASK_CONFIRM", "TASK_CANCEL"][actionId - 168] ?? "TASK"
  return `RESERVED_${actionId}`
}

export function buildActionMask(state: GameState, playerId: number): boolean[] {
  const mask = Array.from({ length: ACTION_COUNT }, () => false)
  const player = state.players[playerId]
  if (!player || !player.alive || state.phase !== "action") { mask[ACTION.NOOP] = true; return mask }
  for (let id = 0; id <= 9; id += 1) mask[id] = true
  const near = (point: Point, range = 72) => Math.hypot(player.position.x - point.x, player.position.y - point.y) <= range
  state.tasks.filter((task) => !task.completed && near(task.position)).slice(0, 8).forEach((_, index) => { mask[ACTION.INTERACT_START + index] = true })
  if (state.bodies.some((body) => near(body.position))) mask[ACTION.REPORT_BODY] = true
  if (player.room === "cafeteria" && state.emergencyMeetings > 0) mask[ACTION.CALL_MEETING] = true
  if (player.role === "impostor" && player.cooldown <= 0) state.players.forEach((target) => { if (target.alive && target.role === "crewmate" && near(target.position, 60)) mask[ACTION.KILL_START + target.id] = true })
  if (player.role === "impostor") {
    for (let id = ACTION.SABOTAGE_START; id < ACTION.SABOTAGE_START + 3; id += 1) mask[id] = state.sabotage === null
    if (["security", "electrical", "navigation"].includes(player.room)) mask[ACTION.VENT_START] = true
  }
  return mask
}

export function nearestRoomTarget(player: Player, state: GameState): Room {
  if (player.role === "crewmate" && state.sabotage) {
    const emergencyRoom = state.sabotage === "reactor" ? "reactor" : state.sabotage === "lights" ? "electrical" : "admin"
    return ROOMS.find((room) => room.id === emergencyRoom) ?? ROOMS[0]!
  }
  const available = player.role === "crewmate" ? state.tasks.filter((task) => !task.completed) : state.players.filter((target) => target.alive && target.role === "crewmate" && target.id !== player.id).map((target) => ({ room: target.room }))
  const planningWindow = Math.floor(state.tick / 80)
  const roomId = available[(player.id + planningWindow) % Math.max(available.length, 1)]?.room ?? "cafeteria"
  return ROOMS.find((room) => room.id === roomId) ?? ROOMS[0]!
}
