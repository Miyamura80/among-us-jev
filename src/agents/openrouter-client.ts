import { ZodError, z } from "zod";

import type {
    AgentMemory,
    AgentPlan,
    DiscussionMessage,
    Observation,
} from "@/game/types";

const PlanOptionSchema = z.object({
    goal: z.string().min(1).max(180),
    targetRoom: z.string().min(1).max(40),
    rationale: z.string().min(1).max(240),
});

const PlanSchema = z.object({
    planA: PlanOptionSchema,
    planB: PlanOptionSchema.extend({ trigger: z.string().min(1).max(180) }),
    horizonTicks: z.number().int().min(20).max(600),
});

const DiscussionSchema = z.object({
    message: z
        .string()
        .min(1)
        .transform((value) => value.slice(0, 280)),
    voteFor: z.string().nullable(),
    suspicionUpdates: z.record(z.string(), z.number().min(0).max(1)).default({}),
    memoryNote: z
        .string()
        .transform((value) => value.trim().slice(0, 180))
        .nullable()
        .optional(),
});

const VoteSchema = z.object({
    voteFor: z.string(),
    rationale: z
        .string()
        .min(1)
        .transform((value) => value.slice(0, 240)),
    suspicionUpdates: z.record(z.string(), z.number().min(0).max(1)).default({}),
});

interface OpenRouterResponse {
    id?: string;
    model?: string;
    usage?: {
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
    };
    openrouter_metadata?: {
        endpoints?: { available?: { provider?: string; selected?: boolean }[] };
    };
    choices?: {
        message?: { content?: string | null };
        finish_reason?: string | null;
    }[];
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CompletionStage = "planning" | "discussing" | "voting";

function completionTokenLimit(stage: CompletionStage, attempt: number): number {
    if (stage === "discussing") return 300;
    return attempt === 0 ? 1_800 : 3_600;
}

function completionTimeoutMs(stage: CompletionStage): number {
    if (stage === "planning") return 40_000;
    if (stage === "discussing") return 2_000;
    return 30_000;
}

function logCompletion(details: Record<string, string | number | null>): void {
    console.info(JSON.stringify({ event: "openrouter_completion", ...details }));
}

function isRecoverableResponseError(error: unknown): boolean {
    return (
        error instanceof SyntaxError ||
        error instanceof ZodError ||
        (error instanceof Error && error.message === "Model response was truncated")
    );
}

function logSuccessfulResponse(
    stage: CompletionStage,
    model: string,
    attempt: number,
    startedAt: number,
    response: Response,
    payload: OpenRouterResponse,
): void {
    const provider =
        payload.openrouter_metadata?.endpoints?.available?.find(
            (endpoint) => endpoint.selected,
        )?.provider ?? null;
    logCompletion({
        stage,
        model: payload.model ?? model,
        attempt,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        requestId:
            response.headers.get("x-request-id") ??
            response.headers.get("x-generation-id") ??
            payload.id ??
            null,
        provider,
        finishReason: payload.choices?.[0]?.finish_reason ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        reasoningTokens:
            payload.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    });
}

export interface DiscussionDecision {
    message: string;
    voteFor: string | null;
    suspicionUpdates: Record<string, number>;
    memoryNote?: string | null;
}

export interface VoteDecision {
    voteFor: string;
    rationale: string;
    suspicionUpdates: Record<string, number>;
}

function failureReason(error: unknown): string {
    if (error instanceof Error && error.message.startsWith("OpenRouter returned ")) {
        return error.message;
    }
    if (error instanceof Error && error.name === "TimeoutError") {
        return "OpenRouter timed out";
    }
    if (error instanceof ZodError) {
        const field = error.issues[0]?.path.join(".") || "response";
        return `Model response failed validation: ${field}`;
    }
    if (error instanceof SyntaxError) return "Model response was not valid JSON";
    if (error instanceof Error && error.message === "OpenRouter returned no content") {
        return error.message;
    }
    if (error instanceof Error && error.message === "Model response was truncated") {
        return error.message;
    }
    return "Model response invalid or unavailable";
}

function parseModelJson(content: string): unknown {
    try {
        return JSON.parse(content) as unknown;
    } catch {
        for (
            let start = content.indexOf("{");
            start >= 0;
            start = content.indexOf("{", start + 1)
        ) {
            const parsed = parseObjectAt(content, start);
            if (parsed !== undefined) return parsed;
        }
        throw new SyntaxError("Model response was not valid JSON");
    }
}

function parseObjectAt(content: string, start: number): unknown {
    for (
        let end = content.indexOf("}", start + 1);
        end >= 0;
        end = content.indexOf("}", end + 1)
    ) {
        try {
            return JSON.parse(content.slice(start, end + 1)) as unknown;
        } catch {
            // A later closing brace may finish this JSON object.
        }
    }
    return undefined;
}

function stripObservation(observation: Observation): object {
    return {
        tick: observation.tick,
        phase: observation.phase,
        self: observation.self,
        knownImpostors: observation.knownImpostors,
        visiblePlayers: observation.players,
        visibleBodies: observation.bodies,
        interactions: observation.interactionSlots,
        sabotage: observation.sabotage,
        meetingReason: observation.meetingReason,
        meetingReporterId: observation.meetingReporterId,
        taskProgress: observation.taskProgress,
        crewTaskProgress: observation.crewTaskProgress,
        nextTask: observation.nextTask,
    };
}

function relevantMemory(
    memory: AgentMemory,
    recentCount: number,
): AgentMemory["events"] {
    return memory.events.filter(
        (event, index) =>
            event.kind === "kill" ||
            event.kind === "vent" ||
            index >= memory.events.length - recentCount,
    );
}

function impostorGuidance(observation: Observation): string {
    const crewProgress = observation.crewTaskProgress;
    const completion =
        crewProgress.total > 0
            ? Math.round((crewProgress.completed / crewProgress.total) * 100)
            : 0;
    return observation.self.role === "impostor"
        ? ` Impostor: look like crew and prioritize avoiding detection, but act before tasks finish. knownImpostors are teammates, never targets or witnesses. taskProgress is your own tasks, NOT global crew progress; crewTaskProgress is the global crew win-condition counter (${crewProgress.completed}/${crewProgress.total}, ${completion}% complete). As it rises, take more risk: above 50%, shorten hunts; above 75%, favor an immediate legal kill over another long pursuit; above 90%, accept some exposure when waiting would likely lose to tasks, but never ignore a certain eyewitness. Post-kill escape still overrides task urgency. Check self.killCooldown, visible crewmates, bodies, and sabotage. If an unreported body is near you and cooldown has reset after a kill, planA.goal must be 'Leave body room now'; choose a different targetRoom away from the corpse, not sabotage, another kill, or a report. While cooldown drains, if a living crewmate is currently visible or remembered from a recent sighting, choose ONE living crewmate by ID to shadow very closely at walking distance, ideally within kill range when safe, preferably a straggler. Close the gap rather than trailing from across the room; match their route and use nearby tasks as cover. Never claim to know their current position after sight is lost. If the target joins a group or disappears, planB should route to a fresh search area or another observed straggler. Do not stand motionless on top of the target or block their path. If a living crewmate is visibly alone within kill range and killing is legal, planA.goal must name that immediate kill, even if your previous target was elsewhere; do not wait for perfect isolation or a replan. Two impostors with one isolated crewmate is safe: your knownImpostors teammate is not a hostile witness. In a tightly bunched group of at least five living players including you and the victim, a legal kill can be hard to attribute to you; take it if no outside crewmate has clear sight of both you and the victim. Close witnesses still see a murder and can report it, so escape immediately. Avoid clear visible witnesses outside the cluster. Enter or exit a vent only when no living crewmate has line of sight: a witness can identify you and call a meeting. Prefer ordinary walking while crew are nearby; use vents for unseen repositioning or escape. If no sabotage is active and no immediate kill exists, use SABOTAGE_2 (lights) only when it creates cover for a nearby hunt; do not repeatedly sabotage instead of finding stragglers. Never request sabotage while one is active. Old sightings are uncertain; targetRoom must lead toward live crew, not an empty current room or intermediate vent. recentRooms is your own travel history. After one empty sweep or repeated time in the same room, choose a different room; leave vents promptly. If no crewmate is visible, target an unvisited room outside recentRooms; do not send another plan to the current empty room. Make each new plan continue the hunt from the previous plan rather than repeating it. Never expose your role or teammate.`
        : "";
}

function impostorMeetingGuidance(observation: Observation): string {
    return observation.self.role === "impostor"
        ? " Impostor: protect knownImpostors, look like crew, and prioritize avoiding detection; deception is allowed."
        : "";
}

export class OpenRouterClient {
    readonly endpoint = "https://openrouter.ai/api/v1/chat/completions";
    readonly model: string;
    private readonly apiKey: string;
    private readonly fetcher: Fetcher;

    constructor(
        apiKey = process.env.OPENROUTER_API_KEY ?? "",
        model = "deepseek/deepseek-v4.1-flash",
        fetcher: Fetcher = fetch,
    ) {
        this.apiKey = apiKey;
        this.model = model;
        this.fetcher = fetcher;
    }

    get configured(): boolean {
        return this.apiKey.length > 0;
    }

    private async complete<T>(
        stage: CompletionStage,
        system: string,
        input: object,
        model: string,
        schema: z.ZodType<T>,
    ): Promise<T> {
        if (!this.configured) throw new Error("OPENROUTER_API_KEY is not configured");
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const raw = await this.requestCompletion(
                    stage,
                    attempt === 0
                        ? system
                        : `${system} Your previous answer was incomplete or invalid. Retry with one short, complete JSON object and no other text.`,
                    input,
                    model,
                    attempt,
                );
                return schema.parse(raw);
            } catch (error) {
                lastError = error;
                if (isRecoverableResponseError(error)) {
                    logCompletion({
                        stage,
                        model,
                        attempt,
                        status: "invalid_response",
                        reason: failureReason(error),
                    });
                }
                if (!isRecoverableResponseError(error)) throw error;
            }
        }
        throw lastError;
    }

    private async requestCompletion(
        stage: CompletionStage,
        system: string,
        input: object,
        model: string,
        attempt: number,
    ): Promise<unknown> {
        const startedAt = Date.now();
        const deepseek = model.startsWith("deepseek/deepseek-v4.1-flash");
        let response: Response;
        try {
            response = await this.fetcher(this.endpoint, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://github.com/Miyamura80/among-us-jev",
                    "X-OpenRouter-Title": "Among Us Jev",
                    "X-OpenRouter-Metadata": "enabled",
                },
                body: JSON.stringify({
                    model,
                    temperature: attempt === 0 ? 0.3 : 0,
                    max_tokens: completionTokenLimit(stage, attempt),
                    ...(deepseek
                        ? {
                              reasoning: { enabled: false },
                              provider: { sort: "throughput" },
                          }
                        : {}),
                    response_format: { type: "json_object" },
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: JSON.stringify(input) },
                    ],
                }),
                signal: AbortSignal.timeout(completionTimeoutMs(stage)),
            });
        } catch (error) {
            logCompletion({
                stage,
                model,
                attempt,
                status: error instanceof Error ? error.name : "fetch_error",
                elapsedMs: Date.now() - startedAt,
                requestId: null,
            });
            throw error;
        }
        const requestId =
            response.headers.get("x-request-id") ??
            response.headers.get("x-generation-id");
        if (!response.ok) {
            logCompletion({
                stage,
                model,
                attempt,
                status: response.status,
                elapsedMs: Date.now() - startedAt,
                requestId,
            });
            throw new Error(`OpenRouter returned ${response.status}`);
        }
        const payload = (await response.json()) as OpenRouterResponse;
        const choice = payload.choices?.[0];
        logSuccessfulResponse(stage, model, attempt, startedAt, response, payload);
        const content = choice?.message?.content;
        if (!content) {
            if (choice?.finish_reason === "length")
                throw new Error("Model response was truncated");
            throw new Error("OpenRouter returned no content");
        }
        try {
            return parseModelJson(content);
        } catch (error) {
            if (choice?.finish_reason === "length") {
                throw new Error("Model response was truncated");
            }
            throw error;
        }
    }

    async plan(
        observation: Observation,
        memory: AgentMemory,
        model = this.model,
        onFailure?: (reason: string) => void,
        recentRooms: string[] = [],
    ): Promise<AgentPlan | null> {
        try {
            const raw = await this.complete(
                "planning",
                `You are System 2 for a social-deduction game agent. Use only private observation and memory; do not invent roles, locations, events, or current visibility from old sightings. Copy player IDs and room IDs exactly. Never target dead players. A memory event of kind kill is firsthand murder evidence: retain the killer as a strong suspect and report the victim's body. Crew: keep at most 3 evidence-backed living suspects, preserving each ID's own score. Following or loitering alone is weak evidence. Avoid a currently visible suspect with suspicion >=0.6; name their ID in goal and route away, even if nextTask is nearby. Otherwise pursue nextTask.roomId. After tasks, search new rooms for bodies. Pair only with a currently visible low-suspicion player; do not claim an unseen buddy is with you or camp one room.${impostorGuidance(observation)} Give planA as the default and planB as a distinct fallback. planB.trigger must be a SHORT observable future condition, not an explanation: e.g. "sabotage starts", "target leaves sight", or "suspect appears". Jev checks the trigger each step. Output one complete JSON object only: {"planA":{"goal":"short action","targetRoom":"room ID","rationale":"short reason"},"planB":{"goal":"short fallback","targetRoom":"room ID","rationale":"short reason","trigger":"short observable condition"},"horizonTicks":60}. Each goal/trigger under 90 characters; each rationale under 100 characters; each targetRoom under 40 characters. Use only valid room IDs. No prose or Markdown.`,
                {
                    observation: stripObservation(observation),
                    recentMemory: relevantMemory(memory, 20),
                    suspicions: memory.suspicions,
                    recentRooms,
                },
                model,
                PlanSchema,
            );
            const parsed = raw;
            return {
                ...parsed.planA,
                alternative: parsed.planB,
                active: "A",
                validUntilTick: observation.tick + parsed.horizonTicks,
            };
        } catch (error) {
            onFailure?.(failureReason(error));
            return null;
        }
    }

    async discuss(
        observation: Observation,
        memory: AgentMemory,
        transcript: DiscussionMessage[],
        alivePlayerIds: string[],
        model = this.model,
        onFailure?: (reason: string) => void,
    ): Promise<DiscussionDecision | null> {
        try {
            const raw = await this.complete(
                "discussing",
                `Speak once in a live discussion. Address the latest relevant claim or question, then add a firsthand fact, a concrete contradiction, or a focused question that moves the timeline forward. Do not repeat your own earlier line. self.id is YOU; sightings omit yourself. A recentMemory event with kind kill and killerId means you personally identified the killer: state this directly, including victim, room and tick. A kill event without killerId means you saw a crowded murder but could NOT identify the killer; say so and do not invent an accusation. A kind vent event means you personally saw that player enter or exit a vent; this match has no Engineer role, so state the witnessed ID, room, and action clearly. Otherwise lead with your strongest firsthand fact about this death: last victim-alive sighting, first body sighting, or someone entering/leaving between them, with room and tick. If reporting, name victim and room; seeing a body alone is not seeing a kill. If relaying another person's claim, name the source; a repeated claim is not independent corroboration. Never call someone "alone" if you were there too. If you lack a death-window fact, ask who last saw the victim; do not invent testimony. An emergency meeting is not a body report.${impostorMeetingGuidance(observation)} Output exactly one ASCII JSON object immediately, then stop after }: {"message":"one sentence under 180 chars","voteFor":null,"suspicionUpdates":{},"memoryNote":null}. voteFor is an alive ID or null; at most 2 numeric suspicion scores 0..1; memoryNote under 80 chars or null.`,
                {
                    observation: stripObservation(observation),
                    recentMemory: relevantMemory(memory, 30),
                    suspicions: memory.suspicions,
                    transcript,
                    alivePlayerIds,
                },
                model,
                DiscussionSchema,
            );
            const parsed = raw;
            return {
                ...parsed,
                voteFor:
                    parsed.voteFor && alivePlayerIds.includes(parsed.voteFor)
                        ? parsed.voteFor
                        : null,
            };
        } catch (error) {
            onFailure?.(failureReason(error));
            return null;
        }
    }

    async vote(
        observation: Observation,
        memory: AgentMemory,
        transcript: DiscussionMessage[],
        alivePlayerIds: string[],
        model = this.model,
        onFailure?: (reason: string) => void,
    ): Promise<VoteDecision | null> {
        if (alivePlayerIds.length === 0) return null;
        try {
            const raw = await this.complete(
                "voting",
                `Cast one vote about this death using private observations and the transcript. self.id is YOU; sightings omit yourself. A recentMemory event with kind kill and killerId is your own direct identification; vote for its living killer. A kill event without killerId only proves a crowded murder occurred, not who did it. A kind vent event is your own direct sighting of vent use; this match has no Engineer role, so vote for that living vent user. If crew, compare independent firsthand last-alive, first-body, and entry/exit timelines before blaming a reporter. Repetition of one claim is not corroboration. A nearby room label does not alone disprove line of sight. Missing sightings or an alibi gap are not affirmative evidence; never say "only X lacked coverage" unless every living player's whereabouts are established. Preserve earlier death-linked evidence against live suspects unless stronger evidence overturns it. Proximity, reporting delay, or unrelated contradictions alone are not proof. Ignore dead or ejected suspects.${impostorMeetingGuidance(observation)} Output exactly one ASCII JSON object immediately, then stop after }: {"voteFor":"player-ID","rationale":"one sentence under 100 chars","suspicionUpdates":{}}. voteFor must be one alivePlayerIds ID, never skip; at most 2 numeric suspicion scores 0..1.`,
                {
                    observation: stripObservation(observation),
                    recentMemory: relevantMemory(memory, 30),
                    suspicions: memory.suspicions,
                    completeTranscript: transcript,
                    alivePlayerIds,
                },
                model,
                VoteSchema,
            );
            const parsed = raw;
            return alivePlayerIds.includes(parsed.voteFor) ? parsed : null;
        } catch (error) {
            onFailure?.(failureReason(error));
            return null;
        }
    }
}
