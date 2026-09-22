import { ACTION, ACTION_COUNT } from "@/game/action-space";
import {
    MOVEMENT_DIRECTIONS,
    ROOMS,
    VENTS,
    centerOf,
    isWalkable,
    roomAt,
} from "@/game/map";
import { trimMemoryEvents } from "@/game/memory";
import { crowdedKillWitness } from "@/game/murder";
import { observeGame } from "@/game/observation";
import type {
    AgentMemory,
    DiscussionMessage,
    GameSettings,
    GameState,
    MemoryEvent,
    PlayerState,
    SabotageKind,
    StepResult,
    TaskKind,
    TaskState,
} from "@/game/types";

const DEFAULT_SETTINGS: GameSettings = {
    playerCount: 10,
    impostorCount: 2,
    humanPlayers: 1,
    killCooldownTicks: 30,
    discussionTicks: 450,
    tasksPerCrewmate: 4,
    visionRadius: 190,
    systemTwoModel: "deepseek/deepseek-v4.1-flash",
};
export const FIRST_KILL_DELAY_MS = 60_000;
const PLAYER_NAMES = [
    "Rook",
    "Mira",
    "Pico",
    "Vanta",
    "Sol",
    "Kite",
    "Echo",
    "Nova",
    "Moss",
    "Orbit",
    "Pixel",
    "Rune",
    "Fable",
    "Lux",
    "Aster",
];
const COLORS = [
    "red",
    "cyan",
    "lime",
    "yellow",
    "pink",
    "orange",
    "white",
    "purple",
    "blue",
    "coral",
    "mint",
    "brown",
    "gray",
    "banana",
    "rose",
];
const TASKS: { kind: TaskKind; rooms: string[] }[] = [
    { kind: "wires", rooms: ["electrical", "admin", "navigation"] },
    { kind: "card-swipe", rooms: ["admin"] },
    { kind: "upload", rooms: ["weapons", "communications"] },
    { kind: "asteroids", rooms: ["weapons"] },
    { kind: "fuel", rooms: ["storage", "upper-engine", "lower-engine"] },
    { kind: "manifolds", rooms: ["reactor"] },
    { kind: "navigation", rooms: ["navigation"] },
    { kind: "scan", rooms: ["medbay"] },
];

function seeded(seed: number): () => number {
    let value = seed || 1;
    return () => {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        return (value >>> 0) / 4_294_967_296;
    };
}

function initialMemory(): AgentMemory {
    return {
        events: [],
        suspicions: {},
        lastPlannedAtMs: 0,
        postKillEscape: null,
        plan: {
            goal: "Orient in Cafeteria",
            targetRoom: "cafeteria",
            rationale: "The round just started",
            validUntilTick: 0,
        },
    };
}

function seedInitialPlans(players: PlayerState[], tasks: TaskState[]): void {
    for (const [index, player] of players.entries()) {
        const firstTask = tasks.find((task) => task.ownerId === player.id);
        const targetRoom =
            firstTask?.roomIds[0] ??
            ROOMS[(index * 3 + 1) % ROOMS.length]?.id ??
            "weapons";
        player.memory.plan = {
            goal: firstTask ? `Reach ${firstTask.kind}` : "Patrol the ship",
            targetRoom,
            rationale: "Initial autonomous route while System 2 plans",
            alternative: {
                goal: "Take a public alternate route",
                targetRoom: targetRoom === "admin" ? "cafeteria" : "admin",
                rationale: "Avoid a blocked or unsafe route",
                trigger: "The primary route is blocked or a visible threat appears",
            },
            active: "A",
            validUntilTick: 0,
        };
    }
}

export function createGame(
    settings: Partial<GameSettings> = {},
    seed = Date.now(),
): GameState {
    const resolved = { ...DEFAULT_SETTINGS, ...settings };
    if (resolved.playerCount < 4 || resolved.playerCount > 15) {
        throw new Error("playerCount must be between 4 and 15");
    }
    if (resolved.impostorCount < 1 || resolved.impostorCount > 3) {
        throw new Error("impostorCount must be between 1 and 3");
    }
    const random = seeded(seed);
    const roleOrder = Array.from({ length: resolved.playerCount }, (_, index) => index);
    for (let index = roleOrder.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [roleOrder[index], roleOrder[swapIndex]] = [
            roleOrder[swapIndex] ?? index,
            roleOrder[index] ?? swapIndex,
        ];
    }
    const impostors = new Set(roleOrder.slice(0, resolved.impostorCount));
    const spawn = centerOf("cafeteria");
    const players: PlayerState[] = Array.from(
        { length: resolved.playerCount },
        (_, index) => ({
            id: `player-${index}`,
            name:
                index < resolved.humanPlayers
                    ? `Human ${index + 1}`
                    : (PLAYER_NAMES[index] ?? `Unit ${index}`),
            role: impostors.has(index) ? "impostor" : "crewmate",
            human: index < resolved.humanPlayers,
            alive: true,
            connected: true,
            position: {
                x: spawn.x + ((index % 5) - 2) * 24,
                y: spawn.y + (Math.floor(index / 5) - 1) * 25,
            },
            roomId: "cafeteria",
            color: COLORS[index] ?? "gray",
            killCooldown: resolved.killCooldownTicks,
            emergencyMeetings: 1,
            ventId: null,
            taskIds: [],
            memory: initialMemory(),
        }),
    );
    const tasks: TaskState[] = [];
    for (const player of players.filter((candidate) => candidate.role === "crewmate")) {
        for (let index = 0; index < resolved.tasksPerCrewmate; index += 1) {
            const playerIndex = players.indexOf(player);
            const definition = TASKS[(playerIndex * 2 + index * 3) % TASKS.length];
            if (!definition) continue;
            const id = `${player.id}-task-${index}`;
            player.taskIds.push(id);
            tasks.push({
                id,
                ownerId: player.id,
                kind: definition.kind,
                roomIds: definition.rooms,
                stage: 0,
                completed: false,
                targetCell: Math.floor(random() * 64),
                cursor: 0,
                pressed: false,
            });
        }
    }
    seedInitialPlans(players, tasks);
    return {
        id: crypto.randomUUID(),
        seed,
        tick: 0,
        firstKillAtMs: Date.now() + FIRST_KILL_DELAY_MS,
        phase: "action",
        players,
        tasks,
        bodies: [],
        doors: ROOMS.map((room) => ({
            id: `door-${room.id}`,
            roomId: room.id,
            closedUntilTick: 0,
        })),
        sabotage: null,
        sabotageDeadline: null,
        meeting: null,
        ejection: null,
        winner: null,
        settings: resolved,
    };
}

function movePlayer(player: PlayerState, actionId: number): void {
    const delta = MOVEMENT_DIRECTIONS[actionId];
    if (!delta) return;
    const proposed = {
        x: player.position.x + delta.x * 8,
        y: player.position.y + delta.y * 8,
    };
    if (!isWalkable(proposed)) return;
    player.position = proposed;
    player.roomId = roomAt(proposed);
}

function beginMeeting(
    state: GameState,
    reporter: PlayerState,
    reason: string,
    bodyId: string | null,
): void {
    state.phase = "meeting";
    state.meeting = {
        reason,
        reporterId: reporter.id,
        bodyId,
        startedAtTick: state.tick,
        stage: "discussion",
        transcript: [],
        votes: {},
        endsAtTick: state.tick + state.settings.discussionTicks,
        discussionEndsAtMs:
            Date.now() +
            (state.players.some((player) => player.human && player.alive)
                ? 90_000
                : 30_000),
        awaitingSpeechIndex: null,
    };
    if (bodyId) {
        const body = state.bodies.find((candidate) => candidate.playerId === bodyId);
        if (body) body.reported = true;
    }
    for (const player of state.players) {
        player.memory.postKillEscape = null;
        for (const event of player.memory.events) {
            if (event.kind === "vent") event.reported = true;
        }
    }
}

function completeTaskAction(task: TaskState, actionId: number): boolean {
    const clickable: TaskKind[] = ["wires", "asteroids", "manifolds", "navigation"];
    if (actionId >= ACTION.TASK_CLICK_START && actionId <= ACTION.TASK_CLICK_END) {
        return (
            clickable.includes(task.kind) &&
            actionId - ACTION.TASK_CLICK_START === task.targetCell
        );
    }
    if (actionId === ACTION.TASK_CURSOR_UP) task.cursor = Math.max(0, task.cursor - 8);
    if (actionId === ACTION.TASK_CURSOR_DOWN)
        task.cursor = Math.min(63, task.cursor + 8);
    if (actionId === ACTION.TASK_CURSOR_LEFT)
        task.cursor = Math.max(0, task.cursor - 1);
    if (actionId === ACTION.TASK_CURSOR_RIGHT)
        task.cursor = Math.min(63, task.cursor + 1);
    if (actionId === ACTION.TASK_PRESS) task.pressed = true;
    if (actionId === ACTION.TASK_RELEASE) {
        const wasPressed = task.pressed;
        task.pressed = false;
        return ["card-swipe", "fuel"].includes(task.kind) && wasPressed;
    }
    if (actionId === ACTION.TASK_CONFIRM) {
        return (
            ["scan", "upload"].includes(task.kind) || task.cursor === task.targetCell
        );
    }
    return false;
}

function checkWinner(state: GameState): void {
    reassignDeadCrewTasks(state);
    const aliveCrew = state.players.filter(
        (player) => player.alive && player.role === "crewmate",
    ).length;
    const aliveImpostors = state.players.filter(
        (player) => player.alive && player.role === "impostor",
    ).length;
    const crewTasks = state.tasks.filter((task) =>
        state.players.some(
            (player) => player.id === task.ownerId && player.role === "crewmate",
        ),
    );
    if (
        aliveImpostors === 0 ||
        (crewTasks.length > 0 && crewTasks.every((task) => task.completed))
    ) {
        state.phase = "finished";
        state.winner = "crewmate";
    } else if (aliveImpostors >= aliveCrew) {
        state.phase = "finished";
        state.winner = "impostor";
    }
}

function reassignDeadCrewTasks(state: GameState): void {
    const livingCrew = state.players.filter(
        (player) => player.alive && player.role === "crewmate",
    );
    if (livingCrew.length === 0) return;
    for (const task of state.tasks) {
        if (task.completed) continue;
        const owner = state.players.find((player) => player.id === task.ownerId);
        if (owner?.alive || owner?.role !== "crewmate") continue;
        const recipient = [...livingCrew].sort((left, right) => {
            const pending = (id: string) =>
                state.tasks.filter(
                    (candidate) => candidate.ownerId === id && !candidate.completed,
                ).length;
            return (
                pending(left.id) - pending(right.id) || left.id.localeCompare(right.id)
            );
        })[0];
        if (!recipient) continue;
        owner.taskIds = owner.taskIds.filter((id) => id !== task.id);
        recipient.taskIds.push(task.id);
        task.ownerId = recipient.id;
    }
}

interface ActionContext {
    state: GameState;
    player: PlayerState;
    observation: ReturnType<typeof observeGame>;
    actionId: number;
    events: MemoryEvent[];
}

function handleInteraction({
    actionId,
    events,
    observation,
    player,
    state,
}: ActionContext): void {
    if (actionId < ACTION.INTERACT_START || actionId > ACTION.INTERACT_END) return;
    const interaction = observation.interactionSlots[actionId - ACTION.INTERACT_START];
    if (interaction?.kind === "repair") {
        state.sabotage = null;
        state.sabotageDeadline = null;
        events.push({
            tick: state.tick,
            kind: "sabotage",
            summary: `${player.name} repaired ${interaction.entityId}`,
        });
    }
    if (interaction?.kind === "emergency") {
        player.emergencyMeetings -= 1;
        beginMeeting(state, player, `${player.name} called an emergency meeting`, null);
    }
}

function handleMeetingAction({
    actionId,
    observation,
    player,
    state,
}: ActionContext): void {
    if (actionId === ACTION.REPORT_BODY) {
        const body = observation.bodies.find(
            (candidate) =>
                Math.hypot(
                    candidate.position.x - player.position.x,
                    candidate.position.y - player.position.y,
                ) <= 64,
        );
        if (body) {
            const victim = state.players.find(
                (candidate) => candidate.id === body.playerId,
            );
            beginMeeting(
                state,
                player,
                `${player.name} reported ${victim ? `${victim.name}'s` : "an unknown player's"} body`,
                body.playerId,
            );
        }
    }
    if (actionId === ACTION.CALL_MEETING) {
        player.emergencyMeetings -= 1;
        beginMeeting(state, player, `${player.name} called an emergency meeting`, null);
    }
}

function handleKill({ actionId, observation, player, state }: ActionContext): void {
    if (actionId < ACTION.KILL_START || actionId > ACTION.KILL_END) return;
    const visible = observation.players[actionId - ACTION.KILL_START];
    const target = state.players.find((candidate) => candidate.id === visible?.id);
    if (!target) return;
    const witnesses = state.players.filter((candidate) => {
        if (
            !candidate.alive ||
            candidate.role !== "crewmate" ||
            candidate.id === target.id
        )
            return false;
        const seen = observeGame(state, candidate.id).players;
        return (
            seen.some((seenPlayer) => seenPlayer.id === player.id) &&
            seen.some((seenPlayer) => seenPlayer.id === target.id)
        );
    });
    const participants = state.players
        .filter((candidate) => candidate.alive && candidate.ventId === null)
        .map((candidate) => candidate.position);
    target.alive = false;
    player.killCooldown = state.settings.killCooldownTicks;
    player.memory.postKillEscape = {
        victimId: target.id,
        roomId: target.roomId,
        position: { ...target.position },
        atTick: state.tick,
    };
    state.bodies.push({
        playerId: target.id,
        position: { ...target.position },
        roomId: target.roomId,
        reported: false,
        createdAtTick: state.tick,
    });
    for (const witness of witnesses) {
        const obscured = crowdedKillWitness(
            player.position,
            target.position,
            witness.position,
            participants,
        );
        witness.memory.events = trimMemoryEvents([
            ...witness.memory.events,
            {
                tick: state.tick,
                kind: "kill",
                killerId: obscured ? undefined : player.id,
                victimId: target.id,
                summary: obscured
                    ? `Saw ${target.name} (${target.id}) killed in a tightly packed group in ${target.roomId}; could not identify the killer`
                    : `Personally saw ${player.name} (${player.id}) kill ${target.name} (${target.id}) in ${target.roomId}`,
            },
        ]);
        if (!obscured) witness.memory.suspicions[player.id] = 1;
    }
}

function handleVent({ actionId, observation, player, state }: ActionContext): void {
    if (actionId < ACTION.VENT_START || actionId > ACTION.VENT_END) return;
    const slot = observation.ventSlots[actionId - ACTION.VENT_START];
    const vent = VENTS.find((candidate) => candidate.id === slot?.id);
    if (!vent) return;
    const entering = player.ventId === null;
    const witnesses = entering ? visibleVentWitnesses(state, player.id) : [];
    player.ventId = player.ventId === vent.id ? null : vent.id;
    player.position = { ...vent.position };
    player.roomId = vent.roomId;
    const seenBy = entering ? witnesses : visibleVentWitnesses(state, player.id);
    for (const witness of seenBy) {
        witness.memory.events = trimMemoryEvents([
            ...witness.memory.events,
            {
                tick: state.tick,
                kind: "vent",
                ventUserId: player.id,
                summary: `Personally saw ${player.name} (${player.id}) ${entering ? "enter" : "exit"} a vent in ${vent.roomId}`,
                reported: false,
            },
        ]);
        witness.memory.suspicions[player.id] = 1;
    }
}

function visibleVentWitnesses(state: GameState, ventUserId: string): PlayerState[] {
    return state.players.filter(
        (candidate) =>
            candidate.alive &&
            candidate.role === "crewmate" &&
            observeGame(state, candidate.id).players.some(
                (visible) => visible.id === ventUserId,
            ),
    );
}

function handleSabotageAndDoor({ actionId, state }: ActionContext): void {
    if (actionId >= ACTION.SABOTAGE_START && actionId < ACTION.SABOTAGE_START + 4) {
        const kinds: SabotageKind[] = ["reactor", "oxygen", "lights", "communications"];
        state.sabotage = kinds[actionId - ACTION.SABOTAGE_START] ?? "lights";
        state.sabotageDeadline = state.tick + 300;
    }
    if (actionId >= ACTION.DOOR_START && actionId <= ACTION.DOOR_END) {
        const door = state.doors[actionId - ACTION.DOOR_START];
        if (door) door.closedUntilTick = state.tick + 100;
    }
}

function handleTask({
    actionId,
    events,
    observation,
    player,
    state,
}: ActionContext): void {
    if (actionId < ACTION.TASK_CLICK_START || actionId > ACTION.TASK_CANCEL) return;
    const task = observation.activeTask
        ? state.tasks.find((candidate) => candidate.id === observation.activeTask?.id)
        : undefined;
    if (!task || !completeTaskAction(task, actionId)) return;
    task.stage += 1;
    task.cursor = 0;
    task.pressed = false;
    task.targetCell = (task.targetCell * 13 + 17) % 64;
    task.completed = task.stage >= task.roomIds.length;
    events.push({
        tick: state.tick,
        kind: "task",
        summary: `${player.name} advanced ${task.kind}`,
    });
}

function executeAction(context: ActionContext): void {
    if (context.actionId >= ACTION.MOVE_N && context.actionId <= ACTION.MOVE_NW)
        movePlayer(context.player, context.actionId);
    handleInteraction(context);
    handleMeetingAction(context);
    handleKill(context);
    handleVent(context);
    handleSabotageAndDoor(context);
    handleTask(context);
}

export function stepGame(
    input: GameState,
    playerId: string,
    actionId: number,
): StepResult {
    const state = structuredClone(input);
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player)
        return {
            state,
            accepted: false,
            actionId,
            events: [],
            error: "Unknown player",
        };
    if (!Number.isInteger(actionId) || actionId < 0 || actionId >= ACTION_COUNT)
        return {
            state,
            accepted: false,
            actionId,
            events: [],
            error: "Action ID must be between 0 and 254",
        };
    const observation = observeGame(state, playerId);
    if (!observation.actionMask[actionId])
        return {
            state,
            accepted: false,
            actionId,
            events: [],
            error: "Action is masked",
        };
    const events: MemoryEvent[] = [];
    executeAction({ state, player, observation, actionId, events });
    player.memory.events.push(...events);
    player.memory.events = trimMemoryEvents(player.memory.events);
    checkWinner(state);
    return { state, accepted: true, actionId, events };
}

export function advanceGame(input: GameState, ticks = 1): GameState {
    const state = structuredClone(input);
    for (let index = 0; index < ticks; index += 1) {
        state.tick += 1;
        for (const player of state.players) {
            player.killCooldown = Math.max(0, player.killCooldown - 1);
        }
        if (state.sabotageDeadline !== null && state.tick >= state.sabotageDeadline) {
            state.phase = "finished";
            state.winner = "impostor";
        }
    }
    if (
        state.phase === "ejection" &&
        state.ejection &&
        Date.now() >= state.ejection.endsAtMs
    ) {
        state.phase = "action";
        state.meeting = null;
        state.ejection = null;
        for (const player of state.players) {
            player.position = centerOf("cafeteria");
            if (player.alive && player.role === "impostor")
                player.killCooldown = state.settings.killCooldownTicks;
        }
        checkWinner(state);
    } else if (state.phase !== "ejection") {
        checkWinner(state);
    }
    return state;
}

export function appendDiscussion(
    input: GameState,
    messages: DiscussionMessage[],
): GameState {
    const state = structuredClone(input);
    if (state.phase !== "meeting" || !state.meeting) return state;
    state.meeting.transcript.push(...messages);
    return state;
}

export function resolveVotes(
    input: GameState,
    votes: Record<string, string | null>,
): GameState {
    const state = structuredClone(input);
    if (state.phase !== "meeting" || !state.meeting) return state;
    const counts = new Map<string, number>();
    for (const [voterId, targetId] of Object.entries(votes)) {
        if (!state.players.some((player) => player.id === voterId && player.alive))
            continue;
        if (targetId !== null) counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
    }
    const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]);
    let ejectedId: string | null = null;
    if (ordered[0] && ordered[0][1] > (ordered[1]?.[1] ?? 0)) {
        const ejected = state.players.find(
            (player) => player.id === ordered[0]?.[0] && player.alive,
        );
        if (ejected) {
            ejected.alive = false;
            ejectedId = ejected.id;
            reassignDeadCrewTasks(state);
        }
    }
    state.bodies = [];
    state.phase = "ejection";
    state.ejection = {
        votes: { ...votes },
        ejectedId,
        endsAtMs: Date.now() + 4_500,
    };
    return state;
}
