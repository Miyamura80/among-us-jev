import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import type { RemoteGame, RemoteSession } from "../src/remote"

const testWindow = new Window({ url: "http://localhost" })
Object.assign(globalThis, {
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
  Event: testWindow.Event,
  MutationObserver: testWindow.MutationObserver,
  ResizeObserver: testWindow.ResizeObserver,
})

const { render, fireEvent, cleanup, act } = await import("@testing-library/react")
const { ServerGameView } = await import("../src/ServerGameView")
const { MeetingView } = await import("../src/MeetingView")
const { SystemTwoTelemetry } = await import("../src/SystemTwoTelemetry")
const { ShipMapFloor } = await import("../src/ShipMapFloor")

const stationGroups = (container: HTMLElement) => [...container.getElementsByTagName("g")].filter((element) => element.getAttribute("role") === "button")
const highlightedReporters = (container: HTMLElement) => [...container.getElementsByTagName("div")].filter((element) => element.getAttribute("class")?.split(" ").includes("meeting-reporter"))
const ballotRows = (container: HTMLElement) => [...container.getElementsByTagName("div")].filter((element) => element.getAttribute("class") === "ballot-row")
const tallyRow = (container: HTMLElement) => [...container.getElementsByTagName("div")].find((element) => element.getAttribute("class") === "ballot-tally-row")
const stationsWithStatus = (container: HTMLElement, status: string) => stationGroups(container).filter((element) => element.getAttribute("class")?.split(" ").includes(status))
const stationByLabel = (container: HTMLElement, label: string) => {
  const station = stationGroups(container).find((element) => element.getAttribute("aria-label") === label)
  if (!station) throw new Error(`Expected station: ${label}`)
  return station
}

test("ship task stations follow the current stage and clear completed highlights", () => {
  const fuel = { kind: "fuel", roomIds: ["storage", "upper-engine", "lower-engine"], stage: 0, completed: false }
  try {
    const view = render(<ShipMapFloor tasks={[fuel]} />)
    expect(stationByLabel(view.container, "Fill fuel can · pending")).toBeDefined()
    expect(stationsWithStatus(view.container, "pending")).toHaveLength(1)
    view.rerender(<ShipMapFloor tasks={[{ ...fuel, stage: 1 }]} />)
    expect(stationByLabel(view.container, "Fill fuel can · complete")).toBeDefined()
    expect(stationByLabel(view.container, "Fuel engine · pending")).toBeDefined()
    expect(stationsWithStatus(view.container, "pending")).toHaveLength(1)
    view.rerender(<ShipMapFloor tasks={[{ ...fuel, stage: 2, completed: true }]} />)
    expect(stationsWithStatus(view.container, "pending")).toHaveLength(0)
    expect(stationsWithStatus(view.container, "complete")).toHaveLength(3)
  } finally { cleanup() }
})

test("unassigned task stations remain recognizable and reveal details by keyboard or touch", () => {
  try {
    const view = render(<ShipMapFloor />)
    expect(stationsWithStatus(view.container, "pending")).toHaveLength(0)
    const scan = stationByLabel(view.container, "Submit scan")
    expect(scan.getAttribute("aria-pressed")).toBe("false")
    fireEvent.keyDown(scan, { key: "Enter" })
    expect(scan.getAttribute("aria-pressed")).toBe("true")
    expect(scan.getElementsByTagName("text")[0]?.textContent).toBe("Submit scan")
    fireEvent.click(scan)
    expect(scan.getAttribute("aria-pressed")).toBe("false")
    expect(scan.getElementsByTagName("text")).toHaveLength(0)
    expect(stationByLabel(view.container, "Clear asteroids")).toBeDefined()
    expect(stationByLabel(view.container, "Chart course")).toBeDefined()
    expect(stationByLabel(view.container, "Swipe card")).toBeDefined()
  } finally { cleanup() }
})

test("observer telemetry reveals both plans and Jev's active choice", () => {
  const player: RemoteGame["players"][number] = {
    id: "agent-1", name: "Echo", role: "crewmate", human: false,
    alive: true, connected: true, position: { x: 500, y: 135 },
    roomId: "cafeteria", color: "cyan", killCooldown: 0,
    memory: { events: [], suspicions: {}, plan: {
      goal: "Finish task", targetRoom: "navigation", rationale: "Next task", validUntilTick: 100,
      alternative: { goal: "Avoid suspect", targetRoom: "admin", rationale: "Safer route", trigger: "suspect nearby" },
      active: "B",
    } },
  }
  const game: RemoteGame = {
    id: "plan-game", tick: 10, revision: 1, systemTwo: {}, systemTwoHistory: {}, firstKillAtMs: 0,
    phase: "action", players: [player], tasks: [], bodies: [], settings: { visionRadius: 190, systemTwoModel: "test-model" },
    sabotage: null, sabotageDeadline: null, meeting: null, ejection: null, winner: null,
  }
  try {
    const view = render(<SystemTwoTelemetry game={game} playerId={player.id} />)
    const summary = [...view.container.getElementsByTagName("summary")].find((element) => element.textContent?.includes("active B"))
    expect(summary).toBeDefined()
    if (!summary) throw new Error("Expected plan details")
    fireEvent.click(summary)
    expect(view.container.textContent).toContain("Finish task")
    expect(view.container.textContent).toContain("Avoid suspect")
    expect(view.container.textContent).toContain("suspect nearby")
  } finally {
    cleanup()
  }
})

test("agent ticks continue while a human holds a movement key", async () => {
  const player: RemoteGame["players"][number] = {
    id: "player-0", name: "Human 1", role: "crewmate", human: true,
    alive: true, connected: true, position: { x: 500, y: 135 },
    roomId: "cafeteria", color: "red", killCooldown: 0,
  }
  let game: RemoteGame = {
    id: "test-game", tick: 0, revision: 0, systemTwo: {}, systemTwoHistory: {}, firstKillAtMs: Date.now() + 240_000,
    phase: "action", players: [player], tasks: [], bodies: [], settings: { visionRadius: 190, systemTwoModel: "unbiased/pareto" },
    sabotage: null, sabotageDeadline: null, meeting: null, ejection: null, winner: null,
  }
  const session: RemoteSession = { game, viewerId: player.id, revealRoles: false }
  const originalFetch = globalThis.fetch
  let steps = 0
  let reads = 0
  let observations = 0
  let tickPosts = 0
  const serverTimer = setInterval(() => {
    game = { ...game, tick: game.tick + 1, revision: game.revision + 1 }
  }, 350)
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path.includes("/observations/")) {
      observations += 1
      return Response.json({ observation: {
        self: { id: player.id, role: "crewmate", alive: true, roomId: "cafeteria", killCooldown: 0, ventId: null },
        players: [], knownImpostors: [], bodies: [], interactionSlots: [], ventSlots: [], meetingReason: null, meetingReporterId: null, activeTask: null,
        actionMask: Array.from({ length: 255 }, (_, index) => index <= 9),
        taskProgress: { completed: 0, total: 0 },
      } })
    }
    if (path.includes("/step")) {
      steps += 1
      game = { ...game, revision: game.revision + 1, players: [{ ...player, position: { x: 500, y: 135 - steps * 8 } }] }
      return Response.json({ state: game })
    }
    if (path.includes("/tick")) {
      tickPosts += 1
      return Response.json({ error: "Client must not drive ticks" }, { status: 410 })
    }
    if (path.includes("/api/games/test-game?")) {
      reads += 1
      return Response.json({ game })
    }
    return Response.json({ error: "Unexpected request" }, { status: 404 })
  }
  try {
    render(<ServerGameView initialSession={session} onExit={() => {}} />)
    fireEvent.keyDown(window, { key: "w" })
    for (let index = 0; index < 20 && (steps <= 4 || game.tick < 2 || reads < 2 || observations <= 1); index += 1) {
      await Bun.sleep(100)
    }
    fireEvent.keyUp(window, { key: "w" })
    expect(steps).toBeGreaterThan(4)
    expect(game.tick).toBeGreaterThanOrEqual(2)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(observations).toBeGreaterThan(1)
    expect(tickPosts).toBe(0)
  } finally {
    clearInterval(serverTimer)
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test("vent travel uses the selected context-sensitive slot", async () => {
  const player: RemoteGame["players"][number] = {
    id: "player-0", name: "You", role: "impostor", human: true,
    alive: true, connected: true, position: { x: 260, y: 380 },
    roomId: "security", color: "red", killCooldown: 0,
  }
  let game: RemoteGame = {
    id: "vent-game", tick: 10, revision: 1, systemTwo: {}, systemTwoHistory: {}, firstKillAtMs: 0,
    phase: "action", players: [player], tasks: [], bodies: [], settings: { visionRadius: 190, systemTwoModel: "unbiased/pareto" },
    sabotage: null, sabotageDeadline: null, meeting: null, ejection: null, winner: null,
  }
  const session: RemoteSession = { game, viewerId: player.id, revealRoles: false }
  const originalFetch = globalThis.fetch
  let submittedAction = -1
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.includes("/observations/")) return Response.json({ observation: {
      self: { id: player.id, role: "impostor", alive: true, roomId: "security", killCooldown: 0, ventId: "vent-security" },
      players: [], knownImpostors: [], bodies: [], interactionSlots: [],
      ventSlots: [{ slot: 0, id: "vent-security", roomId: "security" }, { slot: 1, id: "vent-electrical", roomId: "electrical" }],
      meetingReason: null, meetingReporterId: null, activeTask: null,
      actionMask: Array.from({ length: 255 }, (_, index) => index === 0 || index === 50 || index === 51),
      taskProgress: { completed: 0, total: 0 },
    } })
    if (path.includes("/step")) {
      submittedAction = (JSON.parse(String(init?.body)) as { actionId: number }).actionId
      game = { ...game, revision: game.revision + 1 }
      return Response.json({ state: game })
    }
    if (path.includes("/api/games/vent-game?")) return Response.json({ game })
    return Response.json({ error: "Unexpected request" }, { status: 404 })
  }
  try {
    const view = render(<ServerGameView initialSession={session} onExit={() => {}} />)
    await act(async () => { await Bun.sleep(30) })
    expect(view.container.textContent).toContain("To Electrical")
    const travel = [...view.container.getElementsByTagName("button")].find((button) => button.textContent?.includes("To Electrical"))
    if (!travel) throw new Error("Expected linked vent action")
    fireEvent.click(travel)
    await act(async () => { await Bun.sleep(10) })
    expect(submittedAction).toBe(51)
    expect(view.container.textContent).toContain("Exit")
  } finally {
    cleanup()
    globalThis.fetch = originalFetch
  }
})

test("meeting shows streamed discussion before human voting opens", () => {
  const human: RemoteGame["players"][number] = {
    id: "human", name: "You", role: "crewmate", human: true,
    alive: true, connected: true, position: { x: 500, y: 135 },
    roomId: "cafeteria", color: "red", killCooldown: 0,
  }
  const agent = (id: string, name: string, color: string): RemoteGame["players"][number] => ({
    ...human, id, name, color, human: false,
  })
  const game: RemoteGame = {
    id: "meeting-game", tick: 52, revision: 2, firstKillAtMs: 0,
    systemTwo: { "agent-2": { stage: "discussing", status: "working", detail: "Reading the transcript", atMs: Date.now(), startedAtMs: Date.now(), latencyMs: null } },
    systemTwoHistory: {}, settings: { visionRadius: 190, systemTwoModel: "unbiased/pareto" },
    phase: "meeting", players: [human, agent("agent-1", "Echo", "cyan"), agent("agent-2", "Mira", "pink")],
    tasks: [], bodies: [], sabotage: null, sabotageDeadline: null, ejection: null, winner: null,
    meeting: { reason: "Echo called an emergency meeting", reporterId: "agent-1", bodyId: null, stage: "discussion", transcript: [{ playerId: "agent-1", text: "I called this meeting." }], votes: {}, discussionSecondsRemaining: 30 },
  }
  try {
    const view = render(<MeetingView game={game} human={human} onVote={() => {}} />)
    expect(view.container.textContent).toContain("VOTING IN 30s")
    expect(view.container.textContent).toContain("Discussion remains open.")
    expect(view.container.textContent).toContain("Mira")
    expect(view.container.textContent).toContain("CALLER")
    expect(highlightedReporters(view.container)).toHaveLength(2)
    expect(view.container.textContent).not.toContain("Skip vote")
    expect(view.container.innerHTML).toContain("The Skeld deck map")
    expect(view.container.textContent).toContain("O2")
    const meetingText = view.container.textContent ?? ""
    expect(meetingText.indexOf("SHIP MAP")).toBeGreaterThan(meetingText.indexOf("LIVE BALLOT"))
    view.rerender(<MeetingView game={{ ...game, meeting: { ...game.meeting!, stage: "voting" } }} human={human} onVote={() => {}} />)
    expect(view.container.textContent).toContain("Skip vote")
    view.rerender(<MeetingView game={{ ...game, meeting: { ...game.meeting!, stage: "voting", votes: { human: "agent-1" } } }} human={human} onVote={() => {}} />)
    expect(tallyRow(view.container)?.getAttribute("aria-label")).toBe("Echo: 1 vote")
    expect(tallyRow(view.container)?.getElementsByTagName("i")).toHaveLength(1)
    view.rerender(<MeetingView game={{ ...game, meeting: { ...game.meeting!, stage: "voting", votes: { human: "agent-1", "agent-2": "agent-1" } } }} human={human} onVote={() => {}} />)
    expect(tallyRow(view.container)?.getAttribute("aria-label")).toBe("Echo: 2 votes")
    expect(tallyRow(view.container)?.getElementsByTagName("i")).toHaveLength(2)
    expect(ballotRows(view.container)).toHaveLength(2)
    const bodyGame: RemoteGame = {
      ...game,
      players: [human, agent("agent-1", "Echo", "cyan"), { ...agent("agent-2", "Mira", "pink"), role: "impostor" }, { ...agent("agent-3", "Nova", "lime"), alive: false }],
      meeting: { ...game.meeting!, reason: "Echo reported Nova's body", bodyId: "agent-3", stage: "discussion" },
    }
    view.rerender(<MeetingView game={bodyGame} human={human} onVote={() => {}} />)
    expect(view.container.textContent).toContain("Echo reported Nova's body")
    expect(view.container.textContent).toContain("REPORTER")
    expect(highlightedReporters(view.container)).toHaveLength(2)
    expect(view.container.innerHTML).toContain("meeting-victim")
    expect(view.container.textContent).toContain("Nova")
    expect(view.container.innerHTML).not.toContain("impostor-revealed")
    view.rerender(<MeetingView game={bodyGame} human={human} observerMode onVote={() => {}} />)
    expect(view.container.innerHTML.match(/impostor-revealed/g)).toHaveLength(1)
    expect(view.container.textContent).toContain("Mira")
    const impostorReporter = {
      ...bodyGame,
      meeting: { ...bodyGame.meeting!, reporterId: "agent-2", transcript: [{ playerId: "agent-2", text: "I found Nova." }] },
    }
    view.rerender(<MeetingView game={impostorReporter} human={human} observerMode onVote={() => {}} />)
    expect(highlightedReporters(view.container).filter((element) => element.getAttribute("class")?.includes("impostor-revealed"))).toHaveLength(2)
  } finally {
    cleanup()
  }
})
