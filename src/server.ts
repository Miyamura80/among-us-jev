import { JevClient } from "@/agents/jev-client";
import { OpenRouterClient } from "@/agents/openrouter-client";
import { AgentOrchestrator } from "@/agents/orchestrator";
import { createGame } from "@/game/engine";
import { observeGame } from "@/game/observation";
import { GameRuntime } from "@/game/runtime";
import type { GameSettings, GameState } from "@/game/types";
import { serveStaticSite } from "@/static-site";

const JSON_HEADERS = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
};

function json(value: unknown, status = 200): Response {
    return Response.json(value, { status, headers: JSON_HEADERS });
}

export function serializeGameState(
    state: GameState,
    viewerId: string | null,
    revealRoles = false,
    overview = false,
): object {
    const observation = viewerId ? observeGame(state, viewerId) : null;
    const viewer = state.players.find((player) => player.id === viewerId);
    const visibleIds = new Set([
        ...(viewerId ? [viewerId] : []),
        ...(observation?.players.map((player) => player.id) ?? []),
    ]);
    const restrictVision = viewerId !== null && state.phase === "action" && !overview;
    return {
        ...state,
        meeting: state.meeting
            ? {
                  ...state.meeting,
                  discussionSecondsRemaining:
                      state.meeting.stage === "discussion"
                          ? Math.max(
                                0,
                                Math.ceil(
                                    ((state.meeting.discussionEndsAtMs ?? Date.now()) -
                                        Date.now()) /
                                        1_000,
                                ),
                            )
                          : 0,
              }
            : null,
        players: state.players.map((player) => ({
            ...player,
            role:
                revealRoles ||
                player.id === viewerId ||
                state.phase === "finished" ||
                (viewer?.role === "impostor" && player.role === "impostor")
                    ? player.role
                    : null,
            position:
                !restrictVision || visibleIds.has(player.id) ? player.position : null,
            roomId: !restrictVision || visibleIds.has(player.id) ? player.roomId : null,
            memory: player.id === viewerId || revealRoles ? player.memory : undefined,
        })),
        bodies: restrictVision && observation ? observation.bodies : state.bodies,
        tasks: state.tasks.filter(
            (task) =>
                revealRoles || task.ownerId === viewerId || state.phase === "finished",
        ),
    };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
    try {
        return (await request.json()) as Record<string, unknown>;
    } catch {
        return {};
    }
}

export function createGameServer(port = Number(process.env.PORT ?? 3001)) {
    const games = new Map<string, GameRuntime>();
    const agents = new AgentOrchestrator();
    const present = (
        game: GameRuntime,
        viewerId: string | null,
        revealRoles = false,
        overview = false,
    ) => ({
        ...serializeGameState(game.state, viewerId, revealRoles, overview),
        revision: game.revision,
        systemTwo: Object.fromEntries(
            Object.entries(game.systemTwoTelemetry).filter(
                ([playerId]) => overview || revealRoles || playerId === viewerId,
            ),
        ),
        systemTwoHistory: Object.fromEntries(
            Object.entries(game.systemTwoHistory).filter(
                ([playerId]) => overview || revealRoles || playerId === viewerId,
            ),
        ),
    });

    return Bun.serve({
        hostname: "0.0.0.0",
        port,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keeping the small HTTP route table together makes endpoint authorization and response shaping auditable.
        async fetch(request) {
            if (request.method === "OPTIONS")
                return new Response(null, { headers: JSON_HEADERS });
            const url = new URL(request.url);
            const parts = url.pathname.split("/").filter(Boolean);

            if (request.method === "GET" && url.pathname === "/api/health") {
                return json({
                    ok: true,
                    providers: agents.status,
                    activeGames: games.size,
                });
            }
            if (request.method === "POST" && url.pathname === "/api/games") {
                const body = await readBody(request);
                const userKey =
                    typeof body.openRouterApiKey === "string"
                        ? body.openRouterApiKey.trim()
                        : "";
                if (!userKey) return json({ error: "Enter an OpenRouter key" }, 400);
                if (!userKey.startsWith("sk-or-"))
                    return json({ error: "Enter a valid OpenRouter key" }, 400);
                let keyResponse: Response;
                try {
                    keyResponse = await fetch("https://openrouter.ai/api/v1/key", {
                        headers: { Authorization: `Bearer ${userKey}` },
                        signal: AbortSignal.timeout(5_000),
                    });
                } catch {
                    return json(
                        { error: "Could not verify the OpenRouter key. Try again." },
                        503,
                    );
                }
                if (!keyResponse.ok)
                    return json(
                        {
                            error:
                                keyResponse.status === 401
                                    ? "OpenRouter rejected this key"
                                    : "Could not verify the OpenRouter key",
                        },
                        keyResponse.status === 401 ? 401 : 503,
                    );
                const settings = (body.settings ?? {}) as Partial<GameSettings>;
                const seed = typeof body.seed === "number" ? body.seed : Date.now();
                try {
                    const game = createGame(settings, seed);
                    const gameAgents = new AgentOrchestrator(
                        new JevClient(
                            process.env.TYPESAFE_API_KEY ?? "",
                            fetch,
                            Math.random,
                            userKey,
                        ),
                        new OpenRouterClient(userKey, game.settings.systemTwoModel),
                    );
                    const runtime = new GameRuntime(game, gameAgents);
                    games.set(game.id, runtime);
                    const expiry = setTimeout(
                        () => {
                            games.get(game.id)?.stop();
                            games.delete(game.id);
                        },
                        2 * 60 * 60_000,
                    );
                    expiry.unref?.();
                    runtime.onFinished(() => {
                        clearTimeout(expiry);
                        games.delete(game.id);
                    });
                    runtime.start();
                    const viewerId =
                        game.players.find((player) => player.human)?.id ?? null;
                    return json(
                        {
                            game: present(runtime, viewerId, body.revealRoles === true),
                            viewerId,
                        },
                        201,
                    );
                } catch (error) {
                    return json(
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Invalid settings",
                        },
                        400,
                    );
                }
            }
            if (parts[0] !== "api") return serveStaticSite(request);
            if (parts[1] !== "games" || !parts[2]) {
                return json({ error: "Not found" }, 404);
            }
            const gameId = parts[2];
            const runtime = games.get(gameId);
            if (!runtime) return json({ error: "Unknown game" }, 404);
            const viewerId = url.searchParams.get("viewerId");
            const revealRoles = url.searchParams.get("revealRoles") === "true";
            const overview = url.searchParams.get("overview") === "true";

            if (request.method === "GET" && parts.length === 3) {
                return json({
                    game: present(runtime, viewerId, revealRoles, overview),
                });
            }
            if (request.method === "GET" && parts[3] === "observations" && parts[4]) {
                try {
                    return json({ observation: observeGame(runtime.state, parts[4]) });
                } catch (error) {
                    return json(
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Observation failed",
                        },
                        400,
                    );
                }
            }
            if (request.method === "POST" && parts[3] === "step") {
                const body = await readBody(request);
                if (
                    typeof body.playerId !== "string" ||
                    typeof body.actionId !== "number"
                ) {
                    return json(
                        { error: "playerId and numeric actionId are required" },
                        400,
                    );
                }
                const result = runtime.stepHuman(body.playerId, body.actionId);
                return json(
                    {
                        ...result,
                        state: present(runtime, body.playerId, revealRoles),
                    },
                    result.accepted ? 200 : 409,
                );
            }
            if (request.method === "POST" && parts[3] === "tick")
                return json({ error: "Game ticks run autonomously" }, 410);
            if (request.method === "POST" && parts[3] === "speak") {
                const body = await readBody(request);
                if (typeof body.playerId !== "string" || typeof body.text !== "string")
                    return json({ error: "playerId and text are required" }, 400);
                if (!runtime.speakHuman(body.playerId, body.text))
                    return json(
                        {
                            error: "Only a living human can speak during discussion (1–500 characters)",
                        },
                        403,
                    );
                return json({ game: present(runtime, body.playerId, revealRoles) });
            }
            if (request.method === "POST" && parts[3] === "speech-complete") {
                const body = await readBody(request);
                if (
                    typeof body.playerId !== "string" ||
                    typeof body.startedAtTick !== "number" ||
                    typeof body.messageIndex !== "number"
                )
                    return json(
                        {
                            error: "playerId, startedAtTick and messageIndex are required",
                        },
                        400,
                    );
                if (
                    !runtime.acknowledgeSpeech(
                        body.playerId,
                        body.startedAtTick,
                        body.messageIndex,
                    )
                )
                    return json(
                        { error: "Speech acknowledgement was not accepted" },
                        403,
                    );
                return json({ ok: true });
            }
            if (request.method === "POST" && parts[3] === "vote") {
                const body = await readBody(request);
                if (typeof body.playerId !== "string") {
                    return json({ error: "playerId is required" }, 400);
                }
                const accepted = runtime.voteHuman(
                    body.playerId,
                    typeof body.targetId === "string" ? body.targetId : null,
                );
                if (!accepted)
                    return json({ error: "Only living human players can vote" }, 403);
                return json({
                    game: present(runtime, body.playerId, revealRoles),
                });
            }
            return json({ error: "Not found" }, 404);
        },
    });
}
