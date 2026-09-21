import type { RemoteGame } from "../frontend/src/remote";

const BASE_URL = "http://127.0.0.1:3001";
const maxSeconds = Number(Bun.argv[2] ?? 360);
const seed = Number(Bun.argv[3] ?? Date.now());
const playerCount = Number(Bun.argv[4] ?? 8);
const impostorCount = Number(Bun.argv[5] ?? 2);

interface Snapshot {
    atSecond: number;
    tick: number;
    phase: RemoteGame["phase"];
    players: {
        id: string;
        room: string | null;
        alive: boolean;
        x: number | null;
        y: number | null;
        goal: string | null;
    }[];
}

async function requestGame(path: string, init?: RequestInit): Promise<RemoteGame> {
    const response = await fetch(`${BASE_URL}${path}`, init);
    if (!response.ok) throw new Error(`Game server returned ${response.status}`);
    const payload = (await response.json()) as { game: RemoteGame };
    return payload.game;
}

const game = await requestGame("/api/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        seed,
        settings: { playerCount, impostorCount, humanPlayers: 0 },
        revealRoles: true,
    }),
});
const startedAt = Date.now();
const timeline: { second: number; event: string; detail: unknown }[] = [];
const snapshots: Snapshot[] = [];
const telemetrySeen = new Set<string>();
const telemetry: {
    second: number;
    playerId: string;
    stage: string;
    status: string;
    detail: string;
    latencyMs: number | null;
}[] = [];
const previousPositions = new Map<string, { x: number; y: number; atMs: number }>();
const stationaryWarnings: {
    second: number;
    playerId: string;
    room: string | null;
    goal: string | null;
}[] = [];
let previous = game;
let latest = game;
let lastSnapshotAt = 0;
let lastProgressAt = 0;

console.log(
    JSON.stringify({
        event: "started",
        gameId: game.id,
        seed,
        playerCount,
        impostorCount,
    }),
);
while (Date.now() - startedAt < maxSeconds * 1000) {
    await Bun.sleep(1_000);
    latest = await requestGame(`/api/games/${game.id}?overview=true&revealRoles=true`);
    const second = Math.round((Date.now() - startedAt) / 1000);
    if (latest.phase !== previous.phase) {
        timeline.push({ second, event: "phase", detail: latest.phase });
        console.log(JSON.stringify({ second, phase: latest.phase, tick: latest.tick }));
    }
    for (const body of latest.bodies) {
        if (!previous.bodies.some((older) => older.playerId === body.playerId))
            timeline.push({ second, event: "kill", detail: body.playerId });
    }
    const previousTurns = previous.meeting?.transcript.length ?? 0;
    for (const message of latest.meeting?.transcript.slice(previousTurns) ?? [])
        timeline.push({ second, event: "speech", detail: message });
    if (latest.ejection && !previous.ejection)
        timeline.push({ second, event: "ejection", detail: latest.ejection });
    const completed = latest.tasks.filter((task) => task.completed).length;
    const previousCompleted = previous.tasks.filter((task) => task.completed).length;
    if (completed > previousCompleted)
        timeline.push({
            second,
            event: "tasks",
            detail: { completed, total: latest.tasks.length },
        });
    for (const [playerId, events] of Object.entries(latest.systemTwoHistory)) {
        for (const event of events) {
            const key = `${playerId}:${event.atMs}:${event.stage}:${event.status}`;
            if (telemetrySeen.has(key)) continue;
            telemetrySeen.add(key);
            telemetry.push({
                second,
                playerId,
                stage: event.stage,
                status: event.status,
                detail: event.detail,
                latencyMs: event.latencyMs,
            });
        }
    }
    if (latest.phase === "action") {
        for (const player of latest.players.filter(
            (candidate) => candidate.alive && candidate.position,
        )) {
            const position = player.position;
            if (!position) continue;
            const prior = previousPositions.get(player.id);
            if (!prior || Math.hypot(position.x - prior.x, position.y - prior.y) >= 8) {
                previousPositions.set(player.id, { ...position, atMs: Date.now() });
            } else if (Date.now() - prior.atMs >= 15_000) {
                stationaryWarnings.push({
                    second,
                    playerId: player.id,
                    room: player.roomId,
                    goal: player.memory?.plan.goal ?? null,
                });
                previousPositions.set(player.id, { ...position, atMs: Date.now() });
            }
        }
    }
    if (second - lastSnapshotAt >= 10) {
        snapshots.push({
            atSecond: second,
            tick: latest.tick,
            phase: latest.phase,
            players: latest.players.map((player) => ({
                id: player.id,
                room: player.roomId,
                alive: player.alive,
                x: player.position ? Math.round(player.position.x) : null,
                y: player.position ? Math.round(player.position.y) : null,
                goal: player.memory?.plan.goal ?? null,
            })),
        });
        lastSnapshotAt = second;
    }
    if (second - lastProgressAt >= 30) {
        console.log(
            JSON.stringify({
                second,
                tick: latest.tick,
                phase: latest.phase,
                alive: latest.players.filter((player) => player.alive).length,
                tasks: `${completed}/${latest.tasks.length}`,
                speeches: latest.meeting?.transcript.length ?? 0,
                fallbackEvents: telemetry.filter((event) => event.status === "fallback")
                    .length,
            }),
        );
        lastProgressAt = second;
    }
    previous = latest;
    if (latest.phase === "finished") break;
}

console.log(
    JSON.stringify({
        event: "report",
        gameId: game.id,
        seed,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        winner: latest.winner,
        finalPhase: latest.phase,
        tick: latest.tick,
        roles: latest.players.map((player) => ({
            id: player.id,
            name: player.name,
            role: player.role,
        })),
        tasksCompleted: latest.tasks.filter((task) => task.completed).length,
        tasksTotal: latest.tasks.length,
        timeline,
        stationaryWarnings,
        telemetry,
        snapshots,
    }),
);
