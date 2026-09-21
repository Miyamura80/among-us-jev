import { expect, test } from "bun:test";

import { JevClient } from "@/agents/jev-client";
import { OpenRouterClient } from "@/agents/openrouter-client";
import { AgentOrchestrator, type SystemTwoEvent } from "@/agents/orchestrator";
import { ACTION } from "@/game/action-space";
import { createGame } from "@/game/engine";
import { centerOf } from "@/game/map";
import { observeGame } from "@/game/observation";
import { GameRuntime, selectSpeaker } from "@/game/runtime";

test("the highest-confidence willing speaker wins, with random tie-breaking", () => {
    const candidates = [
        { playerId: "a", speak: true, confidence: 0.8, source: "jev" as const },
        { playerId: "b", speak: true, confidence: 0.8, source: "jev" as const },
        { playerId: "c", speak: false, confidence: 0.99, source: "jev" as const },
    ];
    expect(selectSpeaker(candidates, () => 0)).toBe("a");
    expect(selectSpeaker(candidates, () => 0.99)).toBe("b");
    expect(
        selectSpeaker([
            { playerId: "c", speak: false, confidence: 0.99, source: "jev" },
        ]),
    ).toBeNull();
});

test("agents move on the server without browser ticks or human input", async () => {
    const game = createGame({ playerCount: 5, impostorCount: 1, humanPlayers: 1 }, 41);
    const before = game.players
        .filter((player) => !player.human)
        .map((player) => ({ ...player.position }));
    const agents = new AgentOrchestrator(new JevClient(""), new OpenRouterClient(""));
    const runtime = new GameRuntime(game, agents, 10);
    runtime.start();
    try {
        await Bun.sleep(120);
        expect(runtime.state.tick).toBeGreaterThan(0);
        expect(
            runtime.state.players
                .filter((player) => !player.human)
                .some(
                    (player, index) =>
                        player.position.x !== before[index]?.x ||
                        player.position.y !== before[index]?.y,
                ),
        ).toBe(true);
    } finally {
        runtime.stop();
    }
});

test("agents keep moving while the next model decision is pending", async () => {
    const game = createGame({ playerCount: 5, impostorCount: 1, humanPlayers: 1 }, 31);
    const before = new Map(
        game.players.map((player) => [player.id, { ...player.position }]),
    );
    let modelResponses = 0;
    const agents = {
        async decide(state: typeof game, playerId: string) {
            await Bun.sleep(400);
            modelResponses += 1;
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async discuss(_state: typeof game, playerId: string) {
            return { message: { playerId, text: "No evidence yet." }, voteFor: null };
        },
    };
    const runtime = new GameRuntime(game, agents, 20, 40);
    runtime.start();
    try {
        await Bun.sleep(220);
        const distance = runtime.state.players
            .filter((player) => !player.human)
            .map((player) => {
                const start = before.get(player.id);
                return start
                    ? Math.hypot(
                          player.position.x - start.x,
                          player.position.y - start.y,
                      )
                    : 0;
            });
        expect(Math.max(...distance)).toBeGreaterThanOrEqual(8);
        expect(runtime.state.tick).toBeGreaterThan(0);
        expect(modelResponses).toBe(0);
    } finally {
        runtime.stop();
    }
});

test("background System 2 plans do not block ticks and use bounded concurrency", async () => {
    const game = createGame({ playerCount: 10, impostorCount: 2, humanPlayers: 0 }, 58);
    let inFlight = 0;
    let peakInFlight = 0;
    const requests: Record<string, unknown>[] = [];
    const model = new OpenRouterClient(
        "test-key",
        "deepseek/deepseek-v4.1-flash",
        async (_input, init) => {
            requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            await Bun.sleep(120);
            inFlight -= 1;
            return Response.json({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                planA: {
                                    goal: "Inspect Electrical",
                                    targetRoom: "electrical",
                                    rationale: "Check the next task",
                                },
                                planB: {
                                    goal: "Inspect Admin",
                                    targetRoom: "admin",
                                    rationale: "Use another route",
                                    trigger: "route blocked",
                                },
                                horizonTicks: 60,
                            }),
                        },
                    },
                ],
            });
        },
    );
    const runtime = new GameRuntime(
        game,
        new AgentOrchestrator(new JevClient(""), model),
        10,
        20,
    );
    runtime.start();
    try {
        await Bun.sleep(65);
        expect(runtime.state.tick).toBeGreaterThan(2);
        expect(peakInFlight).toBeLessThanOrEqual(4);
        expect(inFlight).toBeGreaterThan(0);
        await Bun.sleep(350);
        expect(
            runtime.state.players.some(
                (player) => player.memory.plan.goal === "Inspect Electrical",
            ),
        ).toBe(true);
        expect(requests[0]?.reasoning).toEqual({ enabled: false });
        expect(requests[0]?.provider).toEqual({ sort: "throughput" });
    } finally {
        runtime.stop();
    }
});

test("a witness keeps kill evidence when a pending agent turn commits", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 0 }, 43);
    const killer = game.players.find((player) => player.role === "impostor");
    const [victim, witness] = game.players.filter(
        (player) => player.role === "crewmate",
    );
    if (!killer || !victim || !witness) throw new Error("Expected players");
    game.players = [
        killer,
        victim,
        witness,
        ...game.players.filter(
            (player) => ![killer.id, victim.id, witness.id].includes(player.id),
        ),
    ];
    for (const player of [killer, victim, witness]) {
        player.position = centerOf("cafeteria");
        player.roomId = "cafeteria";
    }
    killer.killCooldown = 0;
    game.firstKillAtMs = Date.now() - 1;
    const agents = {
        async decide(state: typeof game, playerId: string) {
            const observation = observeGame(state, playerId);
            const victimSlot = observation.players.find(
                (player) => player.id === victim.id,
            )?.slot;
            return {
                playerId,
                observation,
                decision: {
                    actionId:
                        playerId === killer.id && victimSlot !== undefined
                            ? ACTION.KILL_START + victimSlot
                            : ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async discuss(_state: typeof game, playerId: string) {
            return { message: { playerId, text: "I saw nothing." }, voteFor: null };
        },
    };
    const runtime = new GameRuntime(game, agents, 10, 1_000);
    runtime.start();
    try {
        await Bun.sleep(60);
        const memory = runtime.state.players.find(
            (player) => player.id === witness.id,
        )?.memory;
        expect(memory?.events.find((event) => event.kind === "kill")?.killerId).toBe(
            killer.id,
        );
        expect(memory?.suspicions[killer.id]).toBe(1);
    } finally {
        runtime.stop();
    }
});

test("a crewmate finishes a stalled task even while Jev is slow", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 0 }, 17);
    const task = game.tasks.find(
        (candidate) => candidate.kind === "wires" && candidate.stage === 0,
    );
    const player = game.players.find((candidate) => candidate.id === task?.ownerId);
    if (!task || !player) throw new Error("Expected crewmate task");
    player.position = centerOf(task.roomIds[0] ?? "electrical");
    player.roomId = task.roomIds[0] ?? "electrical";
    const agents = {
        async decide(state: typeof game, playerId: string) {
            await Bun.sleep(2_000);
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async discuss(_state: typeof game, playerId: string) {
            return { message: { playerId, text: "No evidence yet." }, voteFor: null };
        },
    };
    const runtime = new GameRuntime(game, agents, 20, 50);
    runtime.start();
    try {
        await Bun.sleep(1_350);
        expect(
            runtime.state.tasks.find((candidate) => candidate.id === task.id)?.stage,
        ).toBeGreaterThan(0);
    } finally {
        runtime.stop();
    }
});

test("a nearby body pre-empts a crewmate's active task immediately", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 0 }, 17);
    const task = game.tasks.find(
        (candidate) => candidate.kind === "wires" && candidate.stage === 0,
    );
    const reporter = game.players.find((player) => player.id === task?.ownerId);
    const victim = game.players.find(
        (player) => player.role === "crewmate" && player !== reporter,
    );
    if (!task || !reporter || !victim) throw new Error("Expected crewmates");
    reporter.position = centerOf(task.roomIds[0] ?? "electrical");
    reporter.roomId = task.roomIds[0] ?? "electrical";
    victim.alive = false;
    game.bodies.push({
        playerId: victim.id,
        position: { ...reporter.position },
        roomId: reporter.roomId,
        reported: false,
        createdAtTick: game.tick,
    });
    expect(observeGame(game, reporter.id).activeTask?.id).toBe(task.id);
    const agents = new AgentOrchestrator(new JevClient(""), new OpenRouterClient(""));
    const runtime = new GameRuntime(game, agents, 10_000, 10);
    runtime.start();
    try {
        await Bun.sleep(80);
        expect(runtime.state.phase).toBe("meeting");
        expect(runtime.state.meeting?.reporterId).toBe(reporter.id);
        expect(runtime.state.meeting?.bodyId).toBe(victim.id);
    } finally {
        runtime.stop();
    }
});

test("publishes live System 2 telemetry while a plan is pending", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1 }, 31);
    const agents = {
        async decide(
            state: typeof game,
            playerId: string,
            onSystemTwo?: (event: SystemTwoEvent) => void,
        ) {
            onSystemTwo?.({
                stage: "planning",
                status: "working",
                detail: "Choosing a route",
                atMs: Date.now(),
            });
            await Bun.sleep(100);
            onSystemTwo?.({
                stage: "planning",
                status: "success",
                detail: "Head to Admin",
                atMs: Date.now(),
            });
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async discuss(_state: typeof game, playerId: string) {
            return { message: { playerId, text: "No evidence yet." }, voteFor: null };
        },
    };
    const runtime = new GameRuntime(game, agents, 500, 50);
    runtime.start();
    try {
        await Bun.sleep(530);
        expect(runtime.systemTwoTelemetry["player-1"]?.status).toBe("working");
        await Bun.sleep(120);
        expect(runtime.systemTwoTelemetry["player-1"]?.status).toBe("success");
        expect(runtime.systemTwoTelemetry["player-1"]?.latencyMs).toBeGreaterThan(0);
        expect(
            runtime.systemTwoHistory["player-1"]?.map((event) => event.status),
        ).toEqual(["working", "success"]);
    } finally {
        runtime.stop();
    }
});

test("a human move is preserved while agents are thinking", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 1 }, 13);
    const human = game.players.find((player) => player.human);
    if (!human) throw new Error("Expected human");
    const agents = {
        async decide(state: typeof game, playerId: string) {
            await Bun.sleep(70);
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async discuss(_state: typeof game, playerId: string) {
            return { message: { playerId, text: "No evidence yet." }, voteFor: null };
        },
    };
    const runtime = new GameRuntime(game, agents, 10);
    runtime.start();
    try {
        await Bun.sleep(25);
        const result = runtime.stepHuman(human.id, ACTION.MOVE_N);
        expect(result.accepted).toBe(true);
        await Bun.sleep(90);
        expect(
            runtime.state.players.find((player) => player.id === human.id)?.position.y,
        ).toBe(human.position.y - 8);
    } finally {
        runtime.stop();
    }
});

test("the reporter opens and other agents need not speak before voting", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 0 }, 33);
    const reporter = game.players[2];
    if (!reporter) throw new Error("Expected reporter");
    game.phase = "meeting";
    game.meeting = {
        reason: "Body reported",
        reporterId: reporter.id,
        bodyId: null,
        stage: "discussion",
        transcript: [],
        votes: {},
        endsAtTick: 100,
    };
    const transcriptLengths: number[] = [];
    const speakerIds: string[] = [];
    const voteTranscriptLengths: number[] = [];
    const agents = {
        async decide(state: typeof game, playerId: string) {
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async discuss(
            _state: typeof game,
            playerId: string,
            transcript: { playerId: string; text: string }[],
        ) {
            transcriptLengths.push(transcript.length);
            speakerIds.push(playerId);
            return {
                message: { playerId, text: `Statement from ${playerId}` },
                voteFor: null,
            };
        },
        async vote(
            _state: typeof game,
            playerId: string,
            transcript: { playerId: string; text: string }[],
        ) {
            voteTranscriptLengths.push(transcript.length);
            return playerId === "player-0" ? "player-1" : "player-0";
        },
    };
    const runtime = new GameRuntime(game, agents, 10, 100, 50, 1, 1);
    runtime.start();
    try {
        await Bun.sleep(100);
        expect(speakerIds[0]).toBe(reporter.id);
        expect(transcriptLengths).toEqual([0]);
        expect(voteTranscriptLengths).toEqual([1, 1, 1, 1]);
        expect(runtime.state.phase).toBe("ejection");
        expect(runtime.state.ejection?.ejectedId).toBe("player-0");
    } finally {
        runtime.stop();
    }
});

test("a quiet Jev round still gets ten distinct discussion turns before voting", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 0 }, 34);
    game.phase = "meeting";
    game.meeting = {
        reason: "Body reported",
        reporterId: "player-0",
        bodyId: null,
        stage: "discussion",
        transcript: [],
        votes: {},
        endsAtTick: 100,
    };
    const agents = {
        async decide(state: typeof game, playerId: string) {
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async shouldSpeak() {
            return { speak: false, confidence: 0, source: "jev" as const };
        },
        async discuss(
            _state: typeof game,
            playerId: string,
            transcript: { playerId: string; text: string }[],
        ) {
            return {
                message: { playerId, text: `Reply ${transcript.length + 1}` },
                voteFor: null,
            };
        },
        async vote() {
            return "player-1";
        },
    };
    const runtime = new GameRuntime(game, agents, 10, 100, 250, 1, 1, 10);
    runtime.start();
    try {
        await Bun.sleep(50);
        const meeting = runtime.state.meeting;
        expect(meeting?.stage).toBe("discussion");
        expect(meeting?.transcript).toHaveLength(10);
        expect(meeting?.transcript[0]?.playerId).toBe("player-0");
        expect(
            new Set(meeting?.transcript.map((message) => message.playerId)).size,
        ).toBeGreaterThanOrEqual(3);
        expect(meeting?.votes).toEqual({});
        await Bun.sleep(250);
        expect(runtime.state.phase).toBe("ejection");
    } finally {
        runtime.stop();
    }
});

test("Jev can select a later reply from an agent who already spoke", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 0 }, 33);
    game.phase = "meeting";
    game.meeting = {
        reason: "Body reported",
        reporterId: "player-0",
        bodyId: null,
        stage: "discussion",
        transcript: [],
        votes: {},
        endsAtTick: 100,
    };
    const turns = ["player-0", "player-1", "player-0"];
    const seenTranscriptLengths: number[] = [];
    let classifiedBeforeReporter = false;
    const agents = {
        async decide(state: typeof game, playerId: string) {
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async shouldSpeak(
            _state: typeof game,
            playerId: string,
            transcript: { playerId: string; text: string }[],
        ) {
            if (transcript.length === 0) classifiedBeforeReporter = true;
            return {
                speak: turns[transcript.length] === playerId,
                confidence: 0.9,
                source: "jev" as const,
            };
        },
        async discuss(
            _state: typeof game,
            playerId: string,
            transcript: { playerId: string; text: string }[],
        ) {
            seenTranscriptLengths.push(transcript.length);
            return {
                message: { playerId, text: `Turn ${transcript.length + 1}` },
                voteFor: null,
            };
        },
        async vote() {
            return "player-1";
        },
    };
    const runtime = new GameRuntime(game, agents, 10, 100, 50, 1, 1);
    runtime.start();
    try {
        await Bun.sleep(100);
        expect(
            runtime.state.meeting?.transcript.map((message) => message.playerId),
        ).toEqual(turns);
        expect(seenTranscriptLengths).toEqual([0, 1, 2]);
        expect(classifiedBeforeReporter).toBe(false);
        expect(runtime.state.phase).toBe("ejection");
    } finally {
        runtime.stop();
    }
});

test("a slow discussion reaches voting when its time window expires", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 0 }, 33);
    game.phase = "meeting";
    game.meeting = {
        reason: "Body reported",
        reporterId: "player-0",
        bodyId: null,
        stage: "discussion",
        transcript: [],
        votes: {},
        endsAtTick: 100,
    };
    const agents = {
        async decide(state: typeof game, playerId: string) {
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async shouldSpeak(_state: typeof game, playerId: string) {
            return {
                speak: playerId === "player-0",
                confidence: 0.9,
                source: "jev" as const,
            };
        },
        async discuss(_state: typeof game, playerId: string) {
            await Bun.sleep(70);
            return {
                message: { playerId, text: "One useful statement." },
                voteFor: null,
            };
        },
        async vote() {
            return "player-1";
        },
    };
    const runtime = new GameRuntime(game, agents, 10, 50, 50, 1, 1);
    runtime.start();
    try {
        await Bun.sleep(150);
        expect(runtime.state.phase).toBe("ejection");
        expect(runtime.state.meeting?.transcript).toHaveLength(0);
    } finally {
        runtime.stop();
    }
});

test("meeting statements stream before voting opens", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 1 }, 33);
    const human = game.players[0];
    if (!human) throw new Error("Expected human");
    game.phase = "meeting";
    game.meeting = {
        reason: "Body reported",
        reporterId: human.id,
        bodyId: null,
        stage: "discussion",
        transcript: [],
        votes: {},
        endsAtTick: 100,
    };
    const agents = {
        async decide(state: typeof game, playerId: string) {
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async discuss(_state: typeof game, playerId: string) {
            await Bun.sleep(playerId === "player-1" ? 20 : 150);
            return { message: { playerId, text: "I saw nothing." }, voteFor: null };
        },
        async shouldSpeak(
            _state: typeof game,
            playerId: string,
            transcript: { playerId: string; text: string }[],
        ) {
            return {
                speak: !transcript.some((message) => message.playerId === playerId),
                confidence: playerId === "player-1" ? 1 : 0.5,
                source: "jev" as const,
            };
        },
        async vote() {
            await Bun.sleep(20);
            return "player-1";
        },
    };
    const runtime = new GameRuntime(game, agents, 10, 100, 450, 1, 1);
    runtime.start();
    try {
        for (
            let attempt = 0;
            attempt < 10 && (runtime.state.meeting?.transcript.length ?? 0) < 2;
            attempt += 1
        ) {
            await Bun.sleep(20);
        }
        expect(runtime.state.meeting?.transcript.length).toBeGreaterThanOrEqual(2);
        expect(runtime.state.meeting?.transcript[0]?.playerId).toBe(human.id);
        expect(runtime.state.meeting?.stage).toBe("discussion");
        expect(runtime.voteHuman(human.id, "player-1")).toBe(false);
        for (
            let attempt = 0;
            attempt < 40 &&
            (runtime.state.meeting?.stage !== "voting" ||
                Object.keys(runtime.state.meeting?.votes ?? {}).length < 3);
            attempt += 1
        ) {
            await Bun.sleep(20);
        }
        expect(runtime.state.meeting?.transcript).toHaveLength(4);
        expect(runtime.state.meeting?.stage).toBe("voting");
        expect(runtime.voteHuman(human.id, "player-1")).toBe(true);
        for (
            let attempt = 0;
            attempt < 20 && runtime.state.phase !== "ejection";
            attempt += 1
        )
            await Bun.sleep(5);
        expect(runtime.state.phase).toBe("ejection");
    } finally {
        runtime.stop();
    }
});

test("agent votes appear one at a time and human voting waits for the final ballot", async () => {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers: 1 }, 49);
    const human = game.players[0];
    if (!human) throw new Error("Expected human");
    game.phase = "meeting";
    game.meeting = {
        reason: "Emergency meeting",
        reporterId: human.id,
        bodyId: null,
        stage: "discussion",
        transcript: [],
        votes: {},
        endsAtTick: 100,
        discussionEndsAtMs: Date.now() + 80,
    };
    let voteCalls = 0;
    const agents = {
        async decide(state: typeof game, playerId: string) {
            return {
                playerId,
                observation: observeGame(state, playerId),
                decision: {
                    actionId: ACTION.NOOP,
                    confidence: 1,
                    source: "fallback" as const,
                    probabilities: {},
                },
            };
        },
        async shouldSpeak() {
            return { speak: false, confidence: 0, source: "fallback" as const };
        },
        async discuss(_state: typeof game, playerId: string) {
            return { message: { playerId, text: "No new evidence." }, voteFor: null };
        },
        async vote() {
            voteCalls += 1;
            return "player-1";
        },
    };
    const runtime = new GameRuntime(game, agents, 5, 100, 60_000, 80, 80);
    runtime.start();
    try {
        await Bun.sleep(35);
        expect(runtime.state.meeting?.stage).toBe("discussion");
        expect(runtime.state.meeting?.votes).toEqual({});
        expect(voteCalls).toBe(0);
        expect(runtime.voteHuman(human.id, "player-1")).toBe(false);
        for (
            let attempt = 0;
            attempt < 20 && runtime.state.meeting?.stage !== "voting";
            attempt += 1
        )
            await Bun.sleep(5);
        expect(runtime.state.meeting?.stage).toBe("voting");
        expect(runtime.state.meeting?.votes).toEqual({});
        expect(runtime.voteHuman(human.id, "player-1")).toBe(true);
        expect(runtime.state.phase).toBe("meeting");
        for (
            let attempt = 0;
            attempt < 30 && Object.keys(runtime.state.meeting?.votes ?? {}).length < 2;
            attempt += 1
        )
            await Bun.sleep(5);
        expect(Object.keys(runtime.state.meeting?.votes ?? {})).toHaveLength(2);
        expect(runtime.state.phase).toBe("meeting");
        for (
            let attempt = 0;
            attempt < 60 && Object.keys(runtime.state.meeting?.votes ?? {}).length < 4;
            attempt += 1
        )
            await Bun.sleep(5);
        expect(Object.keys(runtime.state.meeting?.votes ?? {})).toHaveLength(4);
        expect(runtime.state.phase).toBe("meeting");
        await Bun.sleep(100);
        expect(runtime.state.phase).toBe("ejection");
        expect(runtime.state.ejection?.votes).toEqual({
            "player-0": "player-1",
            "player-1": "player-1",
            "player-2": "player-1",
            "player-3": "player-1",
        });
    } finally {
        runtime.stop();
    }
});
