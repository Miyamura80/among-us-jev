import { ACTION, actionLabel, enabledActionIds } from "@/game/action-space";
import { MOVEMENT_DIRECTIONS, hasLineOfSight } from "@/game/map";
import { crowdedKillWitness } from "@/game/murder";
import type {
    AgentMemory,
    DiscussionMessage,
    Observation,
    PlanOption,
} from "@/game/types";

interface JevChoiceAnswer {
    type: "choice";
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
}

interface JevResponse {
    model: string;
    answers: {
        action?: JevChoiceAnswer;
        speak?: JevChoiceAnswer;
        plan?: JevChoiceAnswer;
    };
    usage?: { input_tokens: number; output_tokens: number };
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ActionDecision {
    actionId: number;
    confidence: number;
    source: "jev" | "fallback";
    probabilities: Record<string, number>;
    planChoice?: "A" | "B";
}

export interface SpeakDecision {
    speak: boolean;
    confidence: number;
    source: "jev" | "fallback";
}

function safeObservation(observation: Observation): object {
    return {
        tick: observation.tick,
        phase: observation.phase,
        visionRadius: observation.visionRadius,
        crewTaskProgress: observation.crewTaskProgress,
        self: observation.self,
        players: observation.players,
        knownImpostors: observation.knownImpostors,
        bodies: observation.bodies,
        interactions: observation.interactionSlots,
        vents: observation.ventSlots,
        sabotage: observation.sabotage,
        meetingReason: observation.meetingReason,
        meetingReporterId: observation.meetingReporterId,
        activeTask: observation.activeTask,
        taskProgress: observation.taskProgress,
    };
}

function movementDistance(left: number, right: number): number {
    const gap = Math.abs(left - right);
    return Math.min(gap, 8 - gap);
}

function sampleMovementAction(
    selected: number,
    fallback: number,
    legalActions: number[],
    probabilities: Record<string, number>,
    random: () => number,
): number {
    if (
        selected < 1 ||
        selected > 8 ||
        fallback < 1 ||
        fallback > 8 ||
        movementDistance(selected, fallback) > 1
    )
        return selected;
    const candidates = [
        selected,
        ...legalActions.filter(
            (actionId) =>
                actionId !== selected &&
                actionId >= 1 &&
                actionId <= 8 &&
                movementDistance(actionId, selected) === 1 &&
                movementDistance(actionId, fallback) <= 1,
        ),
    ];
    if (candidates.length === 1) return selected;
    const weights = candidates.map((actionId) => {
        const probability = probabilities[String(actionId)];
        const valid =
            typeof probability === "number" &&
            Number.isFinite(probability) &&
            probability > 0
                ? probability
                : 0;
        return Math.max(valid, actionId === selected ? 0.7 : 0.1);
    });
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let draw = Math.min(0.999_999, Math.max(0, random())) * total;
    for (const [index, weight] of weights.entries()) {
        draw -= weight;
        if (draw < 0) return candidates[index] ?? selected;
    }
    return selected;
}

function fallbackDecision(
    legalActions: number[],
    requestedAction: number,
    confidence: number,
): ActionDecision {
    return {
        actionId: legalActions.includes(requestedAction)
            ? requestedAction
            : (legalActions[0] ?? 0),
        confidence,
        source: "fallback",
        probabilities: {},
    };
}

function planQuestion(alternative?: PlanOption & { trigger: string }): object {
    if (!alternative) return {};
    return {
        plan: {
            type: "choice",
            instructions:
                "Choose A by default. Choose B only if planB.trigger is supported by the current private observation; do not infer unseen events. Re-evaluate every action step so B can activate or revert when conditions change. Then choose the action for the selected plan.",
            criteria: {
                A: "Follow the default plan A",
                B: "The observable trigger holds; follow plan B",
            },
        },
    };
}

function escapeCriterion(
    actionId: number,
    observation: Observation,
    body: Observation["bodies"][number],
): string | null {
    const label = actionLabel(actionId);
    const direction = MOVEMENT_DIRECTIONS[actionId];
    if (direction) {
        const currentDistance = Math.hypot(
            observation.self.position.x - body.position.x,
            observation.self.position.y - body.position.y,
        );
        const nextDistance = Math.hypot(
            observation.self.position.x + direction.x * 8 - body.position.x,
            observation.self.position.y + direction.y * 8 - body.position.y,
        );
        return `${label}: ${nextDistance > currentDistance ? "ESCAPE, increases" : "AVOID, decreases"} distance from nearby body`;
    }
    if (actionId >= ACTION.VENT_START && actionId <= ACTION.VENT_END) {
        const vent = observation.ventSlots[actionId - ACTION.VENT_START];
        if (observation.self.ventId === null)
            return `${label}: ESCAPE, enter vent and travel away next`;
        return vent?.id === observation.self.ventId
            ? `${label}: AVOID, exits vent beside the body`
            : `${label}: ESCAPE, travel to linked vent away from body`;
    }
    if (
        actionId === ACTION.REPORT_BODY ||
        actionId === ACTION.NOOP ||
        actionId === ACTION.STOP
    )
        return `${label}: AVOID; leave the nearby body instead`;
    return null;
}

function credibleWitnesses(
    observation: Observation,
    targetId: string,
): Observation["players"] {
    const target = observation.players.find((player) => player.id === targetId);
    if (!target) return [];
    const teammates = new Set(observation.knownImpostors.map((player) => player.id));
    const participants = [
        observation.self.position,
        ...observation.players.map((player) => player.position),
    ];
    return observation.players.filter(
        (player) =>
            player.id !== targetId &&
            !teammates.has(player.id) &&
            Math.hypot(
                player.position.x - target.position.x,
                player.position.y - target.position.y,
            ) <= observation.visionRadius &&
            Math.hypot(
                player.position.x - observation.self.position.x,
                player.position.y - observation.self.position.y,
            ) <= observation.visionRadius &&
            hasLineOfSight(player.position, target.position) &&
            hasLineOfSight(player.position, observation.self.position) &&
            !crowdedKillWitness(
                observation.self.position,
                target.position,
                player.position,
                participants,
            ),
    );
}

function killCriterion(actionId: number, observation: Observation): string | null {
    if (actionId < ACTION.KILL_START || actionId > ACTION.KILL_END) return null;
    const target = observation.players[actionId - ACTION.KILL_START];
    if (!target) return null;
    const witnesses = credibleWitnesses(observation, target.id);
    const label = actionLabel(actionId);
    const completedFraction =
        observation.crewTaskProgress.total > 0
            ? observation.crewTaskProgress.completed /
              observation.crewTaskProgress.total
            : 0;
    const urgency =
        completedFraction >= 0.9
            ? " CREW TASKS CRITICAL: take more risk before task loss"
            : completedFraction >= 0.75
              ? " CREW TASKS HIGH: shorten the hunt"
              : "";
    return witnesses.length === 0
        ? `${label}: ISOLATED LEGAL KILL or obscured crowd kill of ${target.id}; choose now before they leave.${urgency}`
        : `${label}: WITNESSED KILL RISK; ${witnesses.map((player) => player.id).join(", ")} can see both players.${urgency}`;
}

function taskUrgencyInstruction(observation: Observation): string {
    const { completed, total } = observation.crewTaskProgress;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return `crewTaskProgress is the GLOBAL crew win counter: ${completed}/${total} (${percentage}%). taskProgress is only your own tasks. For impostors, shorten hunts above 50%, prioritize a legal kill over further stalking above 75%, and accept moderate exposure above 90% rather than losing to tasks. Never wait if an unwitnessed kill is already legal. The action mask and post-kill escape priority still apply.`;
}

/** Take an unwitnessed or tightly crowded legal kill before the opportunity passes. */
export function isolatedKillAction(observation: Observation): number | null {
    if (observation.self.role !== "impostor") return null;
    if (
        observation.bodies.some(
            (body) =>
                !body.reported &&
                Math.hypot(
                    observation.self.position.x - body.position.x,
                    observation.self.position.y - body.position.y,
                ) <= 80,
        )
    )
        return null;
    for (let actionId = ACTION.KILL_START; actionId <= ACTION.KILL_END; actionId += 1) {
        if (!observation.actionMask[actionId]) continue;
        const target = observation.players[actionId - ACTION.KILL_START];
        if (target && credibleWitnesses(observation, target.id).length === 0)
            return actionId;
    }
    return null;
}

function actionCriterion(actionId: number, observation: Observation): string {
    const label = actionLabel(actionId);
    if (observation.self.role !== "impostor")
        return `${label}: a currently legal action`;
    const nearbyBody = observation.bodies.find(
        (body) =>
            !body.reported &&
            Math.hypot(
                observation.self.position.x - body.position.x,
                observation.self.position.y - body.position.y,
            ) <= 80,
    );
    if (nearbyBody && observation.self.killCooldown > 0) {
        const cue = escapeCriterion(actionId, observation, nearbyBody);
        if (cue) return cue;
    }
    const killCue = killCriterion(actionId, observation);
    if (killCue) return killCue;
    return `${label}: a currently legal action`;
}

export class JevClient {
    readonly endpoint = "https://api.typesafe.ai/v1/systemone";
    private readonly apiKey: string;
    private readonly openRouterApiKey: string;
    private typesafeRejected = false;
    private readonly fetcher: Fetcher;
    private readonly random: () => number;

    constructor(
        apiKey = process.env.TYPESAFE_API_KEY ?? "",
        fetcher: Fetcher = fetch,
        random = Math.random,
        openRouterApiKey = "",
    ) {
        this.apiKey = apiKey;
        this.openRouterApiKey = openRouterApiKey;
        this.fetcher = fetcher;
        this.random = random;
    }

    get configured(): boolean {
        return this.apiKey.length > 0 || this.openRouterApiKey.length > 0;
    }

    private async request(body: object, timeoutMs: number): Promise<Response> {
        const signal = AbortSignal.timeout(timeoutMs);
        if (this.apiKey && !this.typesafeRejected) {
            try {
                const response = await this.fetcher(this.endpoint, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ ...body, model: "jev-latest" }),
                    signal,
                });
                if (response.ok || !this.openRouterApiKey) return response;
                if (response.status === 401 || response.status === 403)
                    this.typesafeRejected = true;
            } catch (error) {
                if (!this.openRouterApiKey) throw error;
            }
        }
        return this.fetcher("https://openrouter.ai/api/alpha/decisions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.openRouterApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...body, model: "~typesafe/jev-latest" }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }

    async shouldSpeak(
        observation: Observation,
        memory: AgentMemory,
        transcript: DiscussionMessage[],
        priorTurns: number,
    ): Promise<SpeakDecision> {
        const fallback: SpeakDecision = {
            speak:
                priorTurns === 0 &&
                memory.events.some(
                    (event) => event.kind === "kill" || event.kind === "body",
                ),
            confidence: priorTurns === 0 ? 0.55 : 0,
            source: "fallback",
        };
        if (!this.configured) return fallback;
        try {
            const response = await this.request(
                {
                    state: {
                        observation: safeObservation(observation),
                        recentMemory: memory.events.filter(
                            (event, index) =>
                                event.kind === "kill" ||
                                index >= memory.events.length - 12,
                        ),
                        suspicions: memory.suspicions,
                        transcript: transcript.slice(-12),
                        priorTurns,
                    },
                    questions: {
                        speak: {
                            type: "choice",
                            instructions:
                                "Should this agent speak now? Choose SPEAK only if this agent has new firsthand evidence, a meaningful contradiction, a relevant question, or a useful response to the public transcript. Being unspoken is not a reason to speak; generic whereabouts and repetition are not useful. A direct eyewitness kill is important. Choose SILENT if there is nothing material to add, even on the first turn. Rank confidence by novelty and evidentiary value, not by attendance.",
                            criteria: {
                                SPEAK: "Contribute a useful statement now",
                                SILENT: "Stay quiet and listen for now",
                            },
                        },
                    },
                },
                600,
            );
            if (!response.ok) return fallback;
            const payload = (await response.json()) as JevResponse;
            const answer = payload.answers.speak;
            if (!answer || !["SPEAK", "SILENT"].includes(answer.choice))
                return fallback;
            return {
                speak: answer.choice === "SPEAK",
                confidence: Number.isFinite(answer.confidence)
                    ? Math.max(0, Math.min(1, answer.confidence))
                    : 0,
                source: "jev",
            };
        } catch {
            return fallback;
        }
    }

    async chooseAction(
        observation: Observation,
        strategicGoal: string,
        fallbackAction: number,
        alternative?: PlanOption & { trigger: string },
        alternativeFallback = fallbackAction,
        primary?: PlanOption,
    ): Promise<ActionDecision> {
        const legalActions = enabledActionIds(observation.actionMask);
        if (!this.configured || legalActions.length <= 1) {
            return fallbackDecision(legalActions, fallbackAction, 1);
        }
        const criteria = Object.fromEntries(
            legalActions.map((actionId) => [
                String(actionId),
                actionCriterion(actionId, observation),
            ]),
        );
        try {
            const response = await this.request(
                {
                    state: {
                        strategicGoal,
                        planA: primary ?? { goal: strategicGoal },
                        planB: alternative ?? null,
                        observation: safeObservation(observation),
                    },
                    questions: {
                        ...planQuestion(alternative),
                        action: {
                            type: "choice",
                            instructions: [
                                "Choose exactly one legal action. Tactical priorities override plan A or B; knownImpostors are teammates, never kill targets. Never infer hidden witnesses.",
                                "IMPOSTOR ESCAPE PRIORITY: if killCooldown is positive and an unreported body is in your room, leave NOW. On the very next action after a kill, move away immediately and keep moving toward another room; do not pause, fake a task, self-report, double back, or keep following the old kill plan. Choose movement that increases distance from the body and heads toward the nearest safe exit. Use a vent only if no living crewmate can see the entry or exit; if you enter, travel to a linked vent instead of popping back out beside the body. Continue escaping on every action until you have left the murder room, even after the body is no longer within interaction range.",
                                "ISOLATED KILL IS THE DEFAULT: if KILL_PLAYER_i is legal and its living crewmate target has no visible credible witness able to identify you, kill immediately. If you have been beside the same isolated target for several seconds, that is urgent, not a reason to keep following. Do not wait for a better setup, fake a task, replan, or move away. A visible but distant crewmate who cannot see both of you is not a witness. A nearby fellow impostor in knownImpostors is your teammate, not a witness: when it is two impostors and one isolated crewmate, kill the crewmate. The action mask already confirms kill range and cooldown.",
                                "CROWD KILL EXCEPTION: if five or more living players including you and the victim are tightly bunched together, close witnesses see the death but cannot reliably identify the killer. Take the legal kill if nobody outside that cluster has clear sight of both you and the victim. Do not mistake a loosely spread group for cover. Do not kill in clear view of a certain eyewitness when crew tasks are low. As crew tasks near completion, accept moderate exposure to avoid losing. If the selected goal names a legal SABOTAGE_i and no sabotage is active, choose it only after checking kill and escape opportunities.",
                                "CLOSE PURSUIT: when your impostor plan names a visible crewmate to follow, walk very close to them and close the gap toward kill range; do not shadow them from across the room. Keep moving with their route unless a legal kill, escape, or safer plan B overrides it. Avoid standing still on top of them.",
                                "VENT_SLOT_i is observation.vents[i]; the current vent exits, a linked vent travels. Prefer walking near crew, never enter a vent merely to reach your current room, and never idle while hidden. Otherwise follow the selected plan.",
                                taskUrgencyInstruction(observation),
                            ].join(" "),
                            criteria,
                        },
                    },
                },
                2_500,
            );
            if (!response.ok) throw new Error(`Jev returned ${response.status}`);
            const payload = (await response.json()) as JevResponse;
            const answer = payload.answers.action;
            const planChoice =
                alternative && payload.answers.plan?.choice === "B" ? "B" : "A";
            const actionId = Number(answer?.choice);
            if (!answer || !legalActions.includes(actionId)) {
                throw new Error("Jev returned an illegal action");
            }
            const sampledAction = sampleMovementAction(
                actionId,
                planChoice === "B" ? alternativeFallback : fallbackAction,
                legalActions,
                answer.probabilities ?? {},
                this.random,
            );
            return {
                actionId: sampledAction,
                confidence:
                    sampledAction === actionId
                        ? answer.confidence
                        : (answer.probabilities?.[String(sampledAction)] ?? 0),
                source: "jev",
                probabilities: answer.probabilities ?? {},
                planChoice,
            };
        } catch {
            return fallbackDecision(legalActions, fallbackAction, 0);
        }
    }
}
