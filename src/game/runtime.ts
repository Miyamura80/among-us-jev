import { setTimeout as delay } from "node:timers/promises";

import type { SpeakDecision } from "@/agents/jev-client";
import {
    type AgentOrchestrator,
    type AgentTurn,
    type SystemTwoEvent,
    movementFallback,
    spreadMove,
    taskFallback,
    urgentBodyAction,
} from "@/agents/orchestrator";
import { ACTION } from "@/game/action-space";
import { advanceGame, appendDiscussion, resolveVotes, stepGame } from "@/game/engine";
import { MOVEMENT_DIRECTIONS, nextWaypoint } from "@/game/map";
import { trimMemoryEvents } from "@/game/memory";
import { observeGame } from "@/game/observation";
import { activePlan } from "@/game/plan";
import type {
    AgentMemory,
    AgentPlan,
    DiscussionMessage,
    GameState,
    Observation,
    PlayerState,
    StepResult,
} from "@/game/types";

function latestPostKillEscape(
    planned: AgentMemory["postKillEscape"],
    live: AgentMemory["postKillEscape"],
): AgentMemory["postKillEscape"] {
    if (!live) return planned;
    if (!planned || live.atTick > planned.atTick) return structuredClone(live);
    return planned;
}

function mergeAgentMemory(planned: AgentMemory, live: AgentMemory): AgentMemory {
    const merged = structuredClone(planned);
    if (live.lastPlannedAtMs > merged.lastPlannedAtMs) {
        merged.plan = structuredClone(live.plan);
        merged.lastPlannedAtMs = live.lastPlannedAtMs;
    }
    merged.postKillEscape = latestPostKillEscape(
        merged.postKillEscape,
        live.postKillEscape,
    );
    for (const event of live.events.filter(
        (candidate) => candidate.kind === "kill" || candidate.kind === "vent",
    )) {
        const existing = merged.events.find(
            (candidate) =>
                candidate.kind === event.kind &&
                candidate.tick === event.tick &&
                candidate.killerId === event.killerId &&
                candidate.victimId === event.victimId &&
                candidate.ventUserId === event.ventUserId,
        );
        if (existing) {
            if (event.reported) existing.reported = true;
            continue;
        }
        merged.events.push(event);
    }
    merged.events = trimMemoryEvents(merged.events);
    for (const event of merged.events.filter(
        (candidate) => candidate.kind === "kill" || candidate.kind === "vent",
    )) {
        const suspectId = event.killerId ?? event.ventUserId;
        if (suspectId)
            merged.suspicions[suspectId] = Math.max(
                merged.suspicions[suspectId] ?? 0,
                live.suspicions[suspectId] ?? 1,
            );
    }
    return merged;
}

type AgentController = Pick<AgentOrchestrator, "decide" | "discuss"> &
    Partial<Pick<AgentOrchestrator, "vote" | "shouldSpeak">>;

interface SpeakerCandidate extends SpeakDecision {
    playerId: string;
}

export function selectSpeaker(
    candidates: SpeakerCandidate[],
    random = Math.random,
): string | null {
    const willing = candidates.filter(
        (candidate) => candidate.speak && Number.isFinite(candidate.confidence),
    );
    if (willing.length === 0) return null;
    const highest = Math.max(...willing.map((candidate) => candidate.confidence));
    const tied = willing.filter((candidate) => candidate.confidence === highest);
    return (
        tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]?.playerId ??
        null
    );
}

export interface SystemTwoTelemetry extends SystemTwoEvent {
    startedAtMs: number;
    latencyMs: number | null;
}

const DISCUSSION_WINDOW_MS = 30_000;
const MIN_DISCUSSION_MESSAGES = 10;
const VOTE_REVEAL_INTERVAL_MS = 1_300;
const FINAL_BALLOT_HOLD_MS = 2_000;

/** Owns autonomous simulation time; HTTP requests only read or apply human input. */
export class GameRuntime {
    private current: GameState;
    private version = 0;
    private actionEpoch = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private movementTimer: ReturnType<typeof setInterval> | null = null;
    private readonly movementOrders = new Map<
        string,
        { actionId: number; untilMs: number }
    >();
    private readonly taskWaits = new Map<
        string,
        { taskKey: string; sinceMs: number; lastAttemptMs: number }
    >();
    private readonly systemTwo = new Map<string, SystemTwoTelemetry>();
    private readonly systemTwoEvents = new Map<string, SystemTwoTelemetry[]>();
    private thinking = false;
    private running = false;
    private readonly agents: AgentController;
    private readonly intervalMs: number;
    private readonly movementIntervalMs: number;
    private readonly discussionWindowMs: number;
    private readonly minimumDiscussionMessages: number;
    private readonly voteRevealIntervalMs: number;
    private readonly finalBallotHoldMs: number;
    private ballotRevealFinished = false;
    private discussionWaitAbort: AbortController | null = null;

    constructor(
        initial: GameState,
        agents: AgentController,
        intervalMs = 900,
        movementIntervalMs = 100,
        discussionWindowMs = DISCUSSION_WINDOW_MS,
        voteRevealIntervalMs = VOTE_REVEAL_INTERVAL_MS,
        finalBallotHoldMs = FINAL_BALLOT_HOLD_MS,
        minimumDiscussionMessages = discussionWindowMs >= 5_000
            ? MIN_DISCUSSION_MESSAGES
            : 0,
    ) {
        this.current = initial;
        this.minimumDiscussionMessages = minimumDiscussionMessages;
        this.agents = agents;
        this.intervalMs = intervalMs;
        this.movementIntervalMs = movementIntervalMs;
        this.discussionWindowMs = discussionWindowMs;
        this.voteRevealIntervalMs = voteRevealIntervalMs;
        this.finalBallotHoldMs = finalBallotHoldMs;
    }

    get state(): GameState {
        return this.current;
    }

    get revision(): number {
        return this.version;
    }

    get systemTwoTelemetry(): Record<string, SystemTwoTelemetry> {
        return Object.fromEntries(this.systemTwo);
    }

    get systemTwoHistory(): Record<string, SystemTwoTelemetry[]> {
        return Object.fromEntries(this.systemTwoEvents);
    }

    private recordSystemTwo(playerId: string, event: SystemTwoEvent): void {
        const previous = this.systemTwo.get(playerId);
        const startedAtMs =
            event.status === "working"
                ? event.atMs
                : (previous?.startedAtMs ?? event.atMs);
        const telemetry = {
            ...event,
            startedAtMs,
            latencyMs: event.status === "working" ? null : event.atMs - startedAtMs,
        };
        this.systemTwo.set(playerId, telemetry);
        const history = this.systemTwoEvents.get(playerId) ?? [];
        history.push(telemetry);
        this.systemTwoEvents.set(playerId, history.slice(-12));
        this.version += 1;
    }

    start(): void {
        if (this.timer || this.current.phase === "finished") return;
        this.running = true;
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
        this.timer.unref?.();
        this.movementTimer = setInterval(
            () => this.moveAgents(),
            this.movementIntervalMs,
        );
        this.movementTimer.unref?.();
    }

    stop(): void {
        this.running = false;
        this.discussionWaitAbort?.abort();
        this.discussionWaitAbort = null;
        if (this.timer) clearInterval(this.timer);
        if (this.movementTimer) clearInterval(this.movementTimer);
        this.timer = null;
        this.movementTimer = null;
    }

    stepHuman(playerId: string, actionId: number): StepResult {
        const player = this.current.players.find(
            (candidate) => candidate.id === playerId,
        );
        if (!player?.human) {
            return {
                state: this.current,
                accepted: false,
                actionId,
                events: [],
                error: "Only human players can submit actions",
            };
        }
        const result = stepGame(this.current, playerId, actionId);
        if (result.accepted) this.commit(result.state);
        return result;
    }

    voteHuman(playerId: string, targetId: string | null): boolean {
        const player = this.current.players.find(
            (candidate) => candidate.id === playerId,
        );
        if (!player?.human || !player.alive || this.current.meeting?.stage !== "voting")
            return false;
        const votes = { ...this.current.meeting.votes, [playerId]: targetId };
        const next = structuredClone(this.current);
        if (next.meeting) next.meeting.votes = votes;
        this.commit(next);
        this.finishBallotIfReady();
        return true;
    }

    private finishBallotIfReady(): void {
        if (!this.ballotRevealFinished || this.current.meeting?.stage !== "voting")
            return;
        const votes = this.current.meeting.votes;
        const allHumansVoted = this.current.players
            .filter((player) => player.human && player.alive)
            .every((player) => player.id in votes);
        if (allHumansVoted) this.commit(resolveVotes(this.current, votes));
    }

    private commit(next: GameState): void {
        if (next.phase !== this.current.phase) this.actionEpoch += 1;
        if (next.phase !== "meeting") this.ballotRevealFinished = false;
        this.current = next;
        this.version += 1;
        if (next.phase === "finished") this.stop();
    }

    private moveAgents(): void {
        if (this.current.phase !== "action") return;
        const actorIds = this.current.players
            .filter((player) => !player.human && player.alive)
            .map((player) => player.id);
        for (const playerId of actorIds) {
            this.moveAgent(playerId);
            if (this.current.phase !== "action") break;
        }
    }

    private moveAgent(playerId: string): void {
        const player = this.current.players.find(
            (candidate) => candidate.id === playerId,
        );
        if (!player) return;
        const observation = observeGame(this.current, playerId);
        const urgentAction = urgentBodyAction(observation, player);
        if (urgentAction !== null) {
            const result = stepGame(this.current, playerId, urgentAction);
            if (result.accepted) this.commit(result.state);
            return;
        }
        if (observation.activeTask) {
            this.progressStalledTask(playerId, observation);
            return;
        }
        this.taskWaits.delete(playerId);
        if (this.shouldPauseForAction(observation)) return;
        const actionId = this.movementAction(player, observation);
        if (actionId < ACTION.MOVE_N || actionId > ACTION.MOVE_NW) return;
        const result = stepGame(this.current, playerId, actionId);
        if (result.accepted) this.commit(result.state);
    }

    private shouldPauseForAction(observation: Observation): boolean {
        return (
            observation.actionMask[ACTION.REPORT_BODY] ||
            observation.actionMask
                .slice(ACTION.KILL_START, ACTION.KILL_END + 1)
                .some(Boolean)
        );
    }

    private progressStalledTask(playerId: string, observation: Observation): void {
        const task = observation.activeTask;
        if (!task) return;
        const now = Date.now();
        const taskKey = `${task.id}:${task.stage}:${task.pressed}`;
        const wait = this.taskWaits.get(playerId);
        if (!wait || wait.taskKey !== taskKey) {
            this.taskWaits.set(playerId, {
                taskKey,
                sinceMs: now,
                lastAttemptMs: 0,
            });
            return;
        }
        if (now - wait.sinceMs < 1_000 || now - wait.lastAttemptMs < 400) return;
        const actionId = taskFallback(observation);
        if (actionId === null || !observation.actionMask[actionId]) return;
        wait.lastAttemptMs = now;
        const result = stepGame(this.current, playerId, actionId);
        if (result.accepted) this.commit(result.state);
    }

    private movementAction(player: PlayerState, observation: Observation): number {
        const order = this.movementOrders.get(player.id);
        if (order && order.untilMs > Date.now()) {
            if (order.actionId === ACTION.NOOP || order.actionId === ACTION.STOP)
                return ACTION.STOP;
            if (this.isUsefulMove(player.id, order.actionId, observation.actionMask))
                return spreadMove(
                    observation,
                    player,
                    order.actionId,
                    nextWaypoint(
                        player.position,
                        activePlan(player.memory.plan).targetRoom,
                    ),
                );
        }
        return movementFallback(observation, player);
    }

    private isUsefulMove(playerId: string, actionId: number, mask: boolean[]): boolean {
        if (actionId < ACTION.MOVE_N || actionId > ACTION.MOVE_NW || !mask[actionId])
            return false;
        const player = this.current.players.find(
            (candidate) => candidate.id === playerId,
        );
        const direction = MOVEMENT_DIRECTIONS[actionId];
        if (!player || !direction) return false;
        const waypoint = nextWaypoint(
            player.position,
            activePlan(player.memory.plan).targetRoom,
        );
        return (
            direction.x * (waypoint.x - player.position.x) +
                direction.y * (waypoint.y - player.position.y) >
            0
        );
    }

    private async tick(): Promise<void> {
        if (!this.running || this.thinking || this.current.phase === "finished") return;
        this.thinking = true;
        this.commit(advanceGame(this.current));
        const snapshot = structuredClone(this.current);
        try {
            if (snapshot.phase === "action") await this.actAgents(snapshot);
            else if (
                snapshot.phase === "meeting" &&
                snapshot.meeting?.stage === "discussion"
            ) {
                await this.discuss(snapshot);
            }
        } catch (error) {
            console.error("Autonomous game tick failed", error);
        } finally {
            this.thinking = false;
        }
    }

    private async actAgents(snapshot: GameState): Promise<void> {
        const actionEpoch = this.actionEpoch;
        const actors = snapshot.players.filter(
            (player) => !player.human && player.alive,
        );
        const turns = await Promise.all(
            actors.map((player) =>
                this.agents.decide(
                    snapshot,
                    player.id,
                    (event) => this.recordSystemTwo(player.id, event),
                    (plan, atMs) =>
                        this.applyCompletedPlan(
                            snapshot.id,
                            actionEpoch,
                            player.id,
                            plan,
                            atMs,
                        ),
                ),
            ),
        );
        if (!this.running || this.current.phase !== "action") return;
        for (const turn of turns) {
            this.applyAgentTurn(snapshot, turn);
            if (this.current.phase !== "action") break;
        }
    }

    private applyCompletedPlan(
        gameId: string,
        actionEpoch: number,
        playerId: string,
        plan: AgentPlan,
        atMs: number,
    ): void {
        if (
            !this.running ||
            this.current.id !== gameId ||
            this.current.phase !== "action" ||
            this.actionEpoch !== actionEpoch
        )
            return;
        const current = this.current.players.find((player) => player.id === playerId);
        if (!current?.alive || current.memory.lastPlannedAtMs > atMs) return;
        const next = structuredClone(this.current);
        const player = next.players.find((candidate) => candidate.id === playerId);
        if (!player) return;
        player.memory.plan = plan;
        player.memory.lastPlannedAtMs = atMs;
        this.commit(next);
    }

    private applyAgentTurn(snapshot: GameState, turn: AgentTurn): void {
        const planned = snapshot.players.find((player) => player.id === turn.playerId);
        const live = this.current.players.find((player) => player.id === turn.playerId);
        if (!planned || !live?.alive) return;
        live.memory = mergeAgentMemory(planned.memory, live.memory);
        const result = stepGame(this.current, turn.playerId, turn.decision.actionId);
        if (!result.accepted) return;
        this.commit(result.state);
        const moving =
            turn.decision.actionId >= ACTION.MOVE_N &&
            turn.decision.actionId <= ACTION.MOVE_NW;
        this.movementOrders.set(turn.playerId, {
            actionId: moving ? turn.decision.actionId : ACTION.STOP,
            untilMs: Date.now() + (moving ? 4_000 : 350),
        });
    }

    private async collectStatements(
        snapshot: GameState,
        agents: PlayerState[],
        transcript: DiscussionMessage[],
        votes: Record<string, string | null>,
        deadlineAtMs: number,
    ): Promise<void> {
        const maxTurns = Math.max(
            this.minimumDiscussionMessages,
            Math.min(12, Math.max(4, agents.length * 2)),
        );
        const reporterId = snapshot.meeting?.reporterId;
        const reporter = snapshot.players.find(
            (player) => player.id === reporterId && player.alive,
        );
        if (reporter?.human) this.openHumanReport(snapshot, reporter, transcript);
        for (
            let attempt = 0;
            transcript.length < maxTurns && attempt < maxTurns * 2;
            attempt += 1
        ) {
            if (
                !this.running ||
                this.current.meeting?.stage !== "discussion" ||
                Date.now() >= deadlineAtMs
            )
                break;
            const speakerId =
                transcript.length === 0 && reporter && !reporter.human
                    ? reporter.id
                    : await this.chooseSpeaker(
                          snapshot,
                          agents,
                          transcript,
                          transcript.length < this.minimumDiscussionMessages,
                      );
            if (!speakerId || Date.now() >= deadlineAtMs) break;
            const decision = await this.agents.discuss(
                snapshot,
                speakerId,
                [...transcript],
                (event) => this.recordSystemTwo(speakerId, event),
            );
            if (
                !this.publishStatement(
                    snapshot,
                    transcript,
                    votes,
                    speakerId,
                    decision,
                    deadlineAtMs,
                )
            )
                break;
        }
    }

    private openHumanReport(
        snapshot: GameState,
        reporter: PlayerState,
        transcript: DiscussionMessage[],
    ): void {
        const victim = snapshot.players.find(
            (player) => player.id === snapshot.meeting?.bodyId,
        );
        const body = snapshot.bodies.find(
            (candidate) => candidate.playerId === victim?.id,
        );
        const message = {
            playerId: reporter.id,
            text: victim
                ? `I reported ${victim.name}'s body in ${body?.roomId ?? "an unknown room"}.`
                : "I called this emergency meeting.",
        };
        transcript.push(message);
        this.commit(appendDiscussion(this.current, [message]));
    }

    private async chooseSpeaker(
        snapshot: GameState,
        agents: PlayerState[],
        transcript: DiscussionMessage[],
        requireReply: boolean,
    ): Promise<string | null> {
        const candidates = await Promise.all(
            agents.map(async (player): Promise<SpeakerCandidate> => {
                const decision = this.agents.shouldSpeak
                    ? await this.agents.shouldSpeak(snapshot, player.id, transcript)
                    : {
                          speak: false,
                          confidence: 0,
                          source: "fallback" as const,
                      };
                return { playerId: player.id, ...decision };
            }),
        );
        const volunteer = selectSpeaker(candidates);
        if (volunteer || !requireReply) return volunteer;
        const lastSpeaker = transcript.at(-1)?.playerId;
        const eligible = candidates.filter(
            (candidate) => candidate.playerId !== lastSpeaker,
        );
        const pool = eligible.length > 0 ? eligible : candidates;
        pool.sort((left, right) => {
            const leftTurns = transcript.filter(
                (message) => message.playerId === left.playerId,
            ).length;
            const rightTurns = transcript.filter(
                (message) => message.playerId === right.playerId,
            ).length;
            return leftTurns - rightTurns || right.confidence - left.confidence;
        });
        return pool[0]?.playerId ?? null;
    }

    private publishStatement(
        snapshot: GameState,
        transcript: DiscussionMessage[],
        votes: Record<string, string | null>,
        speakerId: string,
        decision: { message: DiscussionMessage; voteFor: string | null },
        deadlineAtMs: number,
    ): boolean {
        if (Date.now() >= deadlineAtMs || this.current.meeting?.stage !== "discussion")
            return false;
        const message = { ...decision.message, playerId: speakerId };
        if (
            transcript.some(
                (prior) =>
                    prior.playerId === message.playerId && prior.text === message.text,
            )
        )
            return true;
        transcript.push(message);
        votes[message.playerId] = decision.voteFor;
        if (this.running && this.current.meeting?.stage === "discussion") {
            const next = appendDiscussion(this.current, [message]);
            const live = next.players.find((player) => player.id === message.playerId);
            const deliberated = snapshot.players.find(
                (player) => player.id === message.playerId,
            );
            if (live && deliberated) live.memory = structuredClone(deliberated.memory);
            this.commit(next);
        }
        return true;
    }

    private async deliberateVotes(
        snapshot: GameState,
        agents: PlayerState[],
        transcript: DiscussionMessage[],
        votes: Record<string, string | null>,
    ): Promise<void> {
        if (!this.agents.vote) return;
        const deliberated = await Promise.all(
            agents.map(async (player) => ({
                playerId: player.id,
                voteFor: await this.agents.vote?.(
                    snapshot,
                    player.id,
                    transcript,
                    (event) => this.recordSystemTwo(player.id, event),
                ),
            })),
        );
        for (const result of deliberated) {
            if (result.voteFor) votes[result.playerId] = result.voteFor;
        }
    }

    private async waitForDiscussionDeadline(deadlineAtMs: number): Promise<boolean> {
        const controller = new AbortController();
        this.discussionWaitAbort = controller;
        try {
            await delay(Math.max(0, deadlineAtMs - Date.now()), undefined, {
                signal: controller.signal,
            });
        } catch {
            return false;
        } finally {
            if (this.discussionWaitAbort === controller)
                this.discussionWaitAbort = null;
        }
        return this.running && this.current.meeting?.stage === "discussion";
    }

    private openVoting(): boolean {
        if (!this.running || this.current.phase !== "meeting" || !this.current.meeting)
            return false;
        const next = structuredClone(this.current);
        if (!next.meeting) return false;
        next.meeting.stage = "voting";
        next.meeting.votes = {};
        this.commit(next);
        return true;
    }

    private async revealAgentVotes(
        agents: PlayerState[],
        votes: Record<string, string | null>,
    ): Promise<void> {
        for (const player of agents) {
            await Bun.sleep(this.voteRevealIntervalMs);
            if (!this.running || this.current.meeting?.stage !== "voting") return;
            const next = structuredClone(this.current);
            if (!next.meeting) return;
            next.meeting.votes[player.id] = votes[player.id] ?? null;
            this.commit(next);
        }
        await Bun.sleep(this.finalBallotHoldMs);
        if (!this.running || this.current.meeting?.stage !== "voting") return;
        this.ballotRevealFinished = true;
        this.finishBallotIfReady();
    }

    private async conductBallot(
        agents: PlayerState[],
        transcript: DiscussionMessage[],
        votes: Record<string, string | null>,
    ): Promise<void> {
        if (!this.openVoting()) return;
        const voteSnapshot = structuredClone(this.current);
        const finalVotes = { ...votes };
        await this.deliberateVotes(voteSnapshot, agents, [...transcript], finalVotes);
        if (!this.running || this.current.meeting?.stage !== "voting") return;
        const next = structuredClone(this.current);
        for (const player of next.players.filter((candidate) => !candidate.human)) {
            const deliberated = voteSnapshot.players.find(
                (candidate) => candidate.id === player.id,
            );
            if (deliberated) player.memory = structuredClone(deliberated.memory);
        }
        this.commit(next);
        await this.revealAgentVotes(agents, finalVotes);
    }

    private async discuss(snapshot: GameState): Promise<void> {
        const agents = snapshot.players.filter(
            (candidate) => !candidate.human && candidate.alive,
        );
        const transcript: DiscussionMessage[] = [];
        const votes: Record<string, string | null> = {};
        const deadlineAtMs =
            snapshot.meeting?.discussionEndsAtMs ??
            Date.now() + this.discussionWindowMs;
        void this.collectStatements(
            snapshot,
            agents,
            transcript,
            votes,
            deadlineAtMs,
        ).catch((error) => console.error("Agent discussion failed", error));
        if (!(await this.waitForDiscussionDeadline(deadlineAtMs))) return;
        await this.conductBallot(agents, transcript, votes);
    }
}
