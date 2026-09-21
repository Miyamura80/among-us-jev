import {
    type ActionDecision,
    JevClient,
    type SpeakDecision,
    isolatedKillAction,
} from "@/agents/jev-client";
import {
    closestLegalMove,
    fallbackAction,
    saferVentAction,
    urgentBodyAction,
    urgentPostKillEscapeAction,
    urgentVentMeetingAction,
    visibleCrew,
} from "@/agents/movement";
import { OpenRouterClient } from "@/agents/openrouter-client";
import { ACTION } from "@/game/action-space";
import { ROOMS } from "@/game/map";
import { trimMemoryEvents } from "@/game/memory";
import { observeGame } from "@/game/observation";
import { activePlan } from "@/game/plan";
import type {
    AgentPlan,
    DiscussionMessage,
    GameState,
    MemoryEvent,
    Observation,
    PlayerState,
} from "@/game/types";

export {
    movementFallback,
    spreadMove,
    taskFallback,
    urgentBodyAction,
    urgentPostKillEscapeAction,
} from "@/agents/movement";

export interface AgentTurn {
    playerId: string;
    observation: Observation;
    decision: ActionDecision;
}

export interface SystemTwoEvent {
    stage: "planning" | "discussing" | "voting";
    status: "working" | "success" | "fallback";
    detail: string;
    atMs: number;
}

export type SystemTwoObserver = (event: SystemTwoEvent) => void;

export const SYSTEM_TWO_REPLAN_INTERVAL_MS = 20_000;
const IMPOSTOR_REPLAN_INTERVAL_MS = 10_000;
const IMPOSTOR_ARRIVAL_REPLAN_MS = 3_000;
const IMPOSTOR_ROOM_DWELL_TICKS = 9;
const MAX_CONCURRENT_PLANS = 4;
const RECENT_ROOMS_LIMIT = 6;

interface ImpostorProgress {
    roomId: string;
    enteredAtTick: number;
    recentRooms: string[];
}

function planIntervalMs(
    player: PlayerState,
    observation: Observation,
    progress: ImpostorProgress | null,
): number {
    if (player.role !== "impostor") return SYSTEM_TWO_REPLAN_INTERVAL_MS;
    const emptyRoom = visibleCrew(observation).length === 0;
    if (
        emptyRoom &&
        (player.roomId === activePlan(player.memory.plan).targetRoom ||
            (progress &&
                observation.tick - progress.enteredAtTick >= IMPOSTOR_ROOM_DWELL_TICKS))
    )
        return IMPOSTOR_ARRIVAL_REPLAN_MS;
    return IMPOSTOR_REPLAN_INTERVAL_MS;
}

function explorationRoom(
    player: PlayerState,
    recentRooms: string[],
    tick: number,
    avoidRoom?: string,
): string {
    const fresh = ROOMS.filter(
        (room) =>
            room.id !== player.roomId &&
            room.id !== avoidRoom &&
            !recentRooms.includes(room.id),
    );
    const options =
        fresh.length > 0
            ? fresh
            : ROOMS.filter(
                  (room) => room.id !== player.roomId && room.id !== avoidRoom,
              );
    const index = (tick + Number(player.id.split("-").at(-1)) * 3) % options.length;
    return options[index]?.id ?? "cafeteria";
}

function emitSystemTwo(
    observer: SystemTwoObserver | undefined,
    stage: SystemTwoEvent["stage"],
    status: SystemTwoEvent["status"],
    detail: string,
): void {
    observer?.({ stage, status, detail, atMs: Date.now() });
}

function recordVisibleEvents(player: PlayerState, observation: Observation): void {
    const additions: MemoryEvent[] = [];
    for (const visible of observation.players) {
        additions.push({
            tick: observation.tick,
            kind: "sighting",
            summary: `Saw ${visible.name} in ${visible.roomId}`,
        });
    }
    for (const body of observation.bodies) {
        additions.push({
            tick: observation.tick,
            kind: "body",
            summary: `Saw a body in ${body.roomId}`,
        });
    }
    const existing = new Set(
        player.memory.events.map((event) => `${event.tick}:${event.summary}`),
    );
    player.memory.events.push(
        ...additions.filter((event) => !existing.has(`${event.tick}:${event.summary}`)),
    );
    player.memory.events = trimMemoryEvents(player.memory.events);
}

function witnessedKill(player: PlayerState, state: GameState): MemoryEvent | undefined {
    return [...player.memory.events]
        .reverse()
        .find(
            (event) =>
                event.kind === "kill" &&
                state.players.some(
                    (candidate) => candidate.id === event.killerId && candidate.alive,
                ),
        );
}

function witnessedUnidentifiedKill(
    player: PlayerState,
    state: GameState,
): MemoryEvent | undefined {
    return [...player.memory.events]
        .reverse()
        .find(
            (event) =>
                event.kind === "kill" &&
                !event.killerId &&
                event.victimId === state.meeting?.bodyId,
        );
}

function witnessedVent(player: PlayerState, state: GameState): MemoryEvent | undefined {
    return [...player.memory.events]
        .reverse()
        .find(
            (event) =>
                event.kind === "vent" &&
                state.players.some(
                    (candidate) => candidate.id === event.ventUserId && candidate.alive,
                ),
        );
}

function witnessVote(
    suspectId: string | undefined,
    aliveIds: string[],
    proposed: string | null,
): string | null {
    return suspectId && aliveIds.includes(suspectId) ? suspectId : proposed;
}

function fallbackDiscussionText(
    state: GameState,
    player: PlayerState,
    transcript: DiscussionMessage[],
    testimony: string | null,
): string {
    if (transcript.some((message) => message.playerId === player.id)) {
        const lastOther = [...transcript]
            .reverse()
            .find((message) => message.playerId !== player.id);
        const name = state.players.find(
            (candidate) => candidate.id === lastOther?.playerId,
        )?.name;
        return name
            ? `${name}, can you clarify what you personally saw? I cannot corroborate that yet.`
            : "Can anyone share a firsthand sighting from before the report?";
    }
    if (testimony) return testimony;
    if (state.meeting?.reporterId === player.id && state.meeting.bodyId) {
        const victim = state.players.find(
            (candidate) => candidate.id === state.meeting?.bodyId,
        );
        return `I found ${victim?.name ?? "someone"}'s body in ${player.roomId}.`;
    }
    return `I was in ${player.roomId}. ${player.memory.events.at(-1)?.summary ?? "I did not witness the reported event."}`;
}

function continueHuntFromEmptyRoom(
    plan: AgentPlan,
    player: PlayerState,
    observation: Observation,
    recentRooms: string[],
    stalled: boolean,
): AgentPlan {
    if (
        player.role !== "impostor" ||
        visibleCrew(observation).length > 0 ||
        (plan.targetRoom !== player.roomId &&
            (!stalled || plan.targetRoom !== player.memory.plan.targetRoom))
    )
        return plan;
    const targetRoom = explorationRoom(
        player,
        recentRooms,
        observation.tick,
        stalled ? player.memory.plan.targetRoom : undefined,
    );
    return {
        ...plan,
        goal: `Sweep ${targetRoom} for isolated crew`,
        targetRoom,
        rationale: "Current room is empty; continue the hunt",
    };
}

async function refreshPlan(
    state: GameState,
    player: PlayerState,
    observation: Observation,
    systemTwo: OpenRouterClient,
    onSystemTwo?: SystemTwoObserver,
    minimumIntervalMs = SYSTEM_TWO_REPLAN_INTERVAL_MS,
    recentRooms: string[] = [],
    stalled = false,
): Promise<void> {
    const task = state.tasks.find(
        (candidate) => candidate.ownerId === player.id && !candidate.completed,
    );
    if (
        player.memory.lastPlannedAtMs > 0 &&
        Date.now() - player.memory.lastPlannedAtMs < minimumIntervalMs
    )
        return;
    emitSystemTwo(onSystemTwo, "planning", "working", "Choosing a route");
    let failure = "Provider did not return a usable plan";
    const plan = await systemTwo.plan(
        observation,
        player.memory,
        state.settings.systemTwoModel,
        (reason) => {
            failure = reason;
        },
        recentRooms,
    );
    if (plan) {
        player.memory.plan = continueHuntFromEmptyRoom(
            plan,
            player,
            observation,
            recentRooms,
            stalled,
        );
        player.memory.lastPlannedAtMs = Date.now();
        emitSystemTwo(onSystemTwo, "planning", "success", player.memory.plan.goal);
        return;
    }
    const patrolIndex = Math.floor(
        state.tick / 35 + Number(player.id.split("-").at(-1)),
    );
    const patrolRoom = ROOMS[patrolIndex % ROOMS.length];
    const fallbackRoom =
        player.role === "impostor"
            ? explorationRoom(player, recentRooms, state.tick)
            : (patrolRoom?.id ?? "cafeteria");
    player.memory.plan = {
        goal: task
            ? `Complete ${task.kind}`
            : player.role === "impostor"
              ? "Patrol and look for an isolated crewmate"
              : "Observe nearby players",
        targetRoom: task?.roomIds[task.stage] ?? fallbackRoom,
        rationale: "Local fallback plan based on private state",
        alternative: {
            goal: "Take a different public route",
            targetRoom: patrolRoom?.id === "admin" ? "cafeteria" : "admin",
            rationale: "Avoid a blocked or unsafe primary route",
            trigger: "The primary route is blocked or a high-suspicion player appears",
        },
        active: "A",
        validUntilTick: state.tick + (task ? 50 : 35),
    };
    player.memory.lastPlannedAtMs = Date.now();
    emitSystemTwo(onSystemTwo, "planning", "fallback", failure);
}

export class AgentOrchestrator {
    private readonly jev: JevClient;
    private readonly systemTwo: OpenRouterClient;
    private readonly planning = new Set<string>();
    private readonly impostorProgress = new Map<string, ImpostorProgress>();

    constructor(jev = new JevClient(), systemTwo = new OpenRouterClient()) {
        this.jev = jev;
        this.systemTwo = systemTwo;
    }

    get status(): { jev: boolean; openRouter: boolean; model: string } {
        return {
            jev: this.jev.configured,
            openRouter: this.systemTwo.configured,
            model: this.systemTwo.model,
        };
    }

    private trackImpostorProgress(
        state: GameState,
        player: PlayerState,
    ): ImpostorProgress | null {
        if (player.role !== "impostor") return null;
        const key = `${state.id}:${player.id}`;
        const previous = this.impostorProgress.get(key);
        if (previous?.roomId === player.roomId) return previous;
        const progress = {
            roomId: player.roomId,
            enteredAtTick: state.tick,
            recentRooms: [...(previous?.recentRooms ?? []), player.roomId].slice(
                -RECENT_ROOMS_LIMIT,
            ),
        };
        this.impostorProgress.set(key, progress);
        return progress;
    }

    private schedulePlan(
        state: GameState,
        player: PlayerState,
        observation: Observation,
        onSystemTwo: SystemTwoObserver | undefined,
        onPlanReady: (plan: AgentPlan, atMs: number) => void,
        minimumIntervalMs: number,
        recentRooms: string[],
        stalled: boolean,
    ): void {
        const key = `${state.id}:${player.id}`;
        if (
            this.planning.has(key) ||
            this.planning.size >= MAX_CONCURRENT_PLANS ||
            (player.memory.lastPlannedAtMs > 0 &&
                Date.now() - player.memory.lastPlannedAtMs < minimumIntervalMs)
        )
            return;
        this.planning.add(key);
        const plannedPlayer = structuredClone(player);
        const request = refreshPlan(
            state,
            plannedPlayer,
            observation,
            this.systemTwo,
            onSystemTwo,
            minimumIntervalMs,
            recentRooms,
            stalled,
        );
        const requestedAtMs = Date.now();
        player.memory.lastPlannedAtMs = requestedAtMs;
        void request
            .then(() =>
                onPlanReady(
                    structuredClone(plannedPlayer.memory.plan),
                    Math.max(plannedPlayer.memory.lastPlannedAtMs, requestedAtMs + 1),
                ),
            )
            .catch((error) => {
                console.error("Background System 2 plan failed", error);
            })
            .finally(() => this.planning.delete(key));
    }

    async decide(
        state: GameState,
        playerId: string,
        onSystemTwo?: SystemTwoObserver,
        onPlanReady?: (plan: AgentPlan, atMs: number) => void,
    ): Promise<AgentTurn> {
        const player = state.players.find((candidate) => candidate.id === playerId);
        if (!player) throw new Error(`Unknown player ${playerId}`);
        const observation = observeGame(state, playerId);
        const progress = this.trackImpostorProgress(state, player);
        recordVisibleEvents(player, observation);
        const urgentAction = urgentBodyAction(observation, player);
        if (urgentAction !== null) {
            return {
                playerId,
                observation,
                decision: {
                    actionId: urgentAction,
                    confidence: 1,
                    source: "fallback",
                    probabilities: {},
                },
            };
        }
        const escapeAction = urgentPostKillEscapeAction(observation, player);
        if (escapeAction !== null) {
            return {
                playerId,
                observation,
                decision: {
                    actionId: escapeAction,
                    confidence: 1,
                    source: "fallback",
                    probabilities: {},
                },
            };
        }
        const witnessed = witnessedKill(player, state);
        const body = observation.bodies.find(
            (candidate) => candidate.playerId === witnessed?.victimId,
        );
        if (body) {
            const actionId = observation.actionMask[ACTION.REPORT_BODY]
                ? ACTION.REPORT_BODY
                : closestLegalMove(observation, player, body.position);
            return {
                playerId,
                observation,
                decision: {
                    actionId,
                    confidence: 1,
                    source: "fallback",
                    probabilities: {},
                },
            };
        }
        const ventMeeting = urgentVentMeetingAction(observation, player);
        if (ventMeeting !== null) {
            return {
                playerId,
                observation,
                decision: {
                    actionId: ventMeeting,
                    confidence: 1,
                    source: "fallback",
                    probabilities: {},
                },
            };
        }
        const isolatedKill = isolatedKillAction(observation);
        if (isolatedKill !== null) {
            return {
                playerId,
                observation,
                decision: {
                    actionId: isolatedKill,
                    confidence: 1,
                    source: "fallback",
                    probabilities: {},
                },
            };
        }
        const minimumIntervalMs = planIntervalMs(player, observation, progress);
        const recentRooms = progress?.recentRooms ?? [];
        const stalled =
            player.role === "impostor" &&
            progress !== null &&
            state.tick - progress.enteredAtTick >= IMPOSTOR_ROOM_DWELL_TICKS;
        if (onPlanReady)
            this.schedulePlan(
                state,
                player,
                observation,
                onSystemTwo,
                onPlanReady,
                minimumIntervalMs,
                recentRooms,
                stalled,
            );
        else
            await refreshPlan(
                state,
                player,
                observation,
                this.systemTwo,
                onSystemTwo,
                minimumIntervalMs,
                recentRooms,
                stalled,
            );
        player.memory.plan.active = "A";
        const fallback = fallbackAction(observation, player);
        const alternative = player.memory.plan.alternative;
        let alternativeFallback = fallback;
        if (alternative) {
            player.memory.plan.active = "B";
            alternativeFallback = fallbackAction(observation, player);
            player.memory.plan.active = "A";
        }
        const decision = await this.jev.chooseAction(
            observation,
            player.memory.plan.goal,
            fallback,
            alternative,
            alternativeFallback,
            player.memory.plan,
        );
        player.memory.plan.active = decision.planChoice ?? "A";
        const saferAction = saferVentAction(observation, player, decision.actionId);
        if (saferAction !== null) {
            decision.actionId = saferAction;
            decision.source = "fallback";
            decision.confidence = 1;
        }
        return { playerId, observation, decision };
    }

    async discuss(
        state: GameState,
        playerId: string,
        transcript: DiscussionMessage[],
        onSystemTwo?: SystemTwoObserver,
    ): Promise<{ message: DiscussionMessage; voteFor: string | null }> {
        const player = state.players.find((candidate) => candidate.id === playerId);
        if (!player) throw new Error(`Unknown player ${playerId}`);
        const observation = observeGame(state, playerId);
        const aliveIds = state.players
            .filter((candidate) => candidate.alive && candidate.id !== playerId)
            .map((candidate) => candidate.id);
        emitSystemTwo(onSystemTwo, "discussing", "working", "Reading the transcript");
        let failure = "Provider did not return a usable statement";
        const decision = await this.systemTwo.discuss(
            observation,
            player.memory,
            transcript,
            aliveIds,
            state.settings.systemTwoModel,
            (reason) => {
                failure = reason;
            },
        );
        const witnessed = witnessedKill(player, state);
        const unidentified = witnessedUnidentifiedKill(player, state);
        const vented = witnessedVent(player, state);
        const suspectId = witnessed?.killerId ?? vented?.ventUserId;
        const testimony =
            witnessed?.summary ?? unidentified?.summary ?? vented?.summary ?? null;
        if (decision) {
            emitSystemTwo(onSystemTwo, "discussing", "success", decision.message);
            player.memory.suspicions = {
                ...player.memory.suspicions,
                ...decision.suspicionUpdates,
            };
            if (suspectId) player.memory.suspicions[suspectId] = 1;
            if (decision.memoryNote) {
                player.memory.events.push({
                    tick: state.tick,
                    kind: "meeting",
                    summary: decision.memoryNote,
                });
                player.memory.events = trimMemoryEvents(player.memory.events);
            }
            return {
                message: {
                    playerId,
                    text: testimony
                        ? `${testimony}. ${decision.message}`.slice(0, 280)
                        : decision.message,
                },
                voteFor: witnessVote(suspectId, aliveIds, decision.voteFor),
            };
        }
        emitSystemTwo(onSystemTwo, "discussing", "fallback", failure);
        const suspected = aliveIds
            .map((id) => ({ id, suspicion: player.memory.suspicions[id] ?? 0 }))
            .sort((left, right) => right.suspicion - left.suspicion)[0];
        return {
            message: {
                playerId,
                text: fallbackDiscussionText(state, player, transcript, testimony),
            },
            voteFor: witnessVote(
                suspectId,
                aliveIds,
                suspected && suspected.suspicion > 0.55 ? suspected.id : null,
            ),
        };
    }

    async shouldSpeak(
        state: GameState,
        playerId: string,
        transcript: DiscussionMessage[],
    ): Promise<SpeakDecision> {
        const player = state.players.find((candidate) => candidate.id === playerId);
        if (!player) throw new Error(`Unknown player ${playerId}`);
        if (
            (witnessedKill(player, state) ||
                witnessedUnidentifiedKill(player, state) ||
                witnessedVent(player, state)) &&
            !transcript.some((message) => message.playerId === playerId)
        )
            return { speak: true, confidence: 1, source: "fallback" };
        return this.jev.shouldSpeak(
            observeGame(state, playerId),
            player.memory,
            transcript,
            transcript.filter((message) => message.playerId === playerId).length,
        );
    }

    async vote(
        state: GameState,
        playerId: string,
        transcript: DiscussionMessage[],
        onSystemTwo?: SystemTwoObserver,
    ): Promise<string> {
        const player = state.players.find((candidate) => candidate.id === playerId);
        if (!player) throw new Error(`Unknown player ${playerId}`);
        const aliveIds = state.players
            .filter((candidate) => candidate.alive && candidate.id !== playerId)
            .map((candidate) => candidate.id);
        if (aliveIds.length === 0) throw new Error("No legal vote targets");
        const observation = observeGame(state, playerId);
        const witnessed = witnessedKill(player, state);
        const vented = witnessedVent(player, state);
        const suspectId = witnessed?.killerId ?? vented?.ventUserId;
        emitSystemTwo(
            onSystemTwo,
            "voting",
            "working",
            "Weighing the complete discussion",
        );
        let failure = "Provider did not return a usable vote";
        const decision = await this.systemTwo.vote(
            observation,
            player.memory,
            transcript,
            aliveIds,
            state.settings.systemTwoModel,
            (reason) => {
                failure = reason;
            },
        );
        if (decision) {
            emitSystemTwo(onSystemTwo, "voting", "success", decision.rationale);
            player.memory.suspicions = {
                ...player.memory.suspicions,
                ...decision.suspicionUpdates,
            };
            if (suspectId) player.memory.suspicions[suspectId] = 1;
            player.memory.events.push({
                tick: state.tick,
                kind: "meeting",
                summary: `Voted for ${decision.voteFor}: ${decision.rationale}`,
            });
            player.memory.events = trimMemoryEvents(player.memory.events);
            return (
                witnessVote(suspectId, aliveIds, decision.voteFor) ?? decision.voteFor
            );
        }
        emitSystemTwo(onSystemTwo, "voting", "fallback", failure);
        if (suspectId && aliveIds.includes(suspectId)) return suspectId;
        const ranked = aliveIds
            .map((id) => ({ id, suspicion: player.memory.suspicions[id] ?? 0 }))
            .sort((left, right) => right.suspicion - left.suspicion);
        const mostSuspicious = ranked[0];
        if (mostSuspicious && mostSuspicious.suspicion > 0) return mostSuspicious.id;
        const hash = [...player.id].reduce(
            (total, character) => total + character.charCodeAt(0),
            state.tick,
        );
        const fallbackTarget = aliveIds[hash % aliveIds.length] ?? aliveIds[0];
        if (!fallbackTarget) throw new Error("No legal vote targets");
        return fallbackTarget;
    }
}
