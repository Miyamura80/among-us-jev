import { describe, expect, test } from "bun:test";

import { JevClient } from "@/agents/jev-client";
import { OpenRouterClient } from "@/agents/openrouter-client";
import { AgentOrchestrator, movementFallback, spreadMove } from "@/agents/orchestrator";
import { ACTION, ACTION_COUNT } from "@/game/action-space";
import {
    FIRST_KILL_DELAY_MS,
    advanceGame,
    createGame,
    resolveVotes,
    stepGame,
} from "@/game/engine";
import { ROOMS, centerOf } from "@/game/map";
import { trimMemoryEvents } from "@/game/memory";
import { observeGame } from "@/game/observation";
import { serializeGameState } from "@/server";

function planReply(
    goal: string,
    targetRoom: string,
    rationale: string,
    horizonTicks: number | string,
) {
    return {
        planA: { goal, targetRoom, rationale },
        planB: {
            goal: "Use public route",
            targetRoom: targetRoom === "admin" ? "cafeteria" : "admin",
            rationale: "Safer alternative",
            trigger: "A visible threat blocks plan A",
        },
        horizonTicks,
    };
}

function gameMeetingAfterSpentCooldown(meetingKind: "emergency" | "body") {
    const game = createGame({ playerCount: 6, impostorCount: 2, humanPlayers: 1 }, 23);
    const reporter = game.players[0];
    const victim = game.players.find(
        (player) => player.role === "crewmate" && player.id !== reporter?.id,
    );
    if (!reporter || !victim) throw new Error("Expected crewmates");
    reporter.position = centerOf("cafeteria");
    reporter.roomId = "cafeteria";
    game.tick = 60;
    for (const player of game.players) {
        if (player.role === "impostor") player.killCooldown = 0;
    }
    if (meetingKind === "body") {
        victim.alive = false;
        game.bodies.push({
            playerId: victim.id,
            position: { ...reporter.position },
            roomId: "cafeteria",
            reported: false,
            createdAtTick: game.tick,
        });
    }
    return stepGame(
        game,
        reporter.id,
        meetingKind === "body" ? ACTION.REPORT_BODY : ACTION.CALL_MEETING,
    );
}

function meetingWithHumanCount(humanPlayers: number) {
    const game = createGame({ playerCount: 4, impostorCount: 1, humanPlayers }, 23);
    const reporter = game.players[0];
    if (!reporter) throw new Error("Expected reporter");
    reporter.position = centerOf("cafeteria");
    reporter.roomId = "cafeteria";
    if (!humanPlayers) {
        const victim = game.players.find(
            (player) => player.role === "crewmate" && player.id !== reporter.id,
        );
        if (!victim) throw new Error("Expected victim");
        victim.alive = false;
        game.bodies.push({
            playerId: victim.id,
            position: { ...reporter.position },
            roomId: "cafeteria",
            reported: false,
            createdAtTick: game.tick,
        });
    }
    game.firstKillAtMs = 0;
    const called = stepGame(
        game,
        reporter.id,
        humanPlayers ? ACTION.CALL_MEETING : ACTION.REPORT_BODY,
    );
    return { called, reporterId: reporter.id };
}

describe("authoritative game engine", () => {
    test("builds a stable 255-action private observation", () => {
        const game = createGame({ playerCount: 6, impostorCount: 1 }, 42);
        const viewer = game.players[0];
        if (!viewer) throw new Error("Expected player");

        const observation = observeGame(game, viewer.id);

        expect(observation.actionMask).toHaveLength(ACTION_COUNT);
        expect(observation.players.every((player) => !("role" in player))).toBe(true);
        expect(observation.self.role).toBe(viewer.role);
        const nextTask = game.tasks.find(
            (task) => task.ownerId === viewer.id && !task.completed,
        );
        expect(observation.nextTask?.roomId ?? null).toBe(
            nextTask?.roomIds[nextTask.stage] ?? null,
        );
    });

    test("impostors know teammates but cannot kill them", () => {
        const game = createGame(
            { playerCount: 6, impostorCount: 2, humanPlayers: 0 },
            29,
        );
        const [impostor, teammate] = game.players.filter(
            (player) => player.role === "impostor",
        );
        const crewmate = game.players.find((player) => player.role === "crewmate");
        if (!impostor || !teammate || !crewmate)
            throw new Error("Expected impostors and crewmate");
        teammate.position = { ...impostor.position };
        crewmate.position = { ...impostor.position };
        impostor.killCooldown = 0;
        game.firstKillAtMs = Date.now() - 1;

        const observation = observeGame(game, impostor.id);
        const allySlot = observation.players.find(
            (player) => player.id === teammate.id,
        )?.slot;
        const crewSlot = observation.players.find(
            (player) => player.id === crewmate.id,
        )?.slot;
        expect(observation.knownImpostors).toEqual([
            { id: teammate.id, name: teammate.name, alive: true },
        ]);
        expect(observeGame(game, crewmate.id).knownImpostors).toEqual([]);
        expect(allySlot).toBeDefined();
        expect(crewSlot).toBeDefined();
        expect(observation.actionMask[ACTION.KILL_START + (allySlot ?? 0)]).toBe(false);
        expect(observation.actionMask[ACTION.KILL_START + (crewSlot ?? 0)]).toBe(true);
        const allyView = serializeGameState(game, impostor.id) as {
            players: { id: string; role: string | null }[];
        };
        expect(allyView.players.find((player) => player.id === teammate.id)?.role).toBe(
            "impostor",
        );
        const crewView = serializeGameState(game, crewmate.id) as {
            players: { id: string; role: string | null }[];
        };
        expect(
            crewView.players.find((player) => player.id === teammate.id)?.role,
        ).toBeNull();
    });

    test("impostors can enter, travel, and exit linked vents while hidden", async () => {
        const game = createGame(
            { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
            29,
        );
        const impostor = game.players.find((player) => player.role === "impostor");
        const crewmate = game.players.find((player) => player.role === "crewmate");
        if (!impostor || !crewmate) throw new Error("Expected both roles");
        impostor.position = { x: 260, y: 380 };
        impostor.roomId = "security";
        crewmate.position = centerOf("cafeteria");
        crewmate.roomId = "cafeteria";
        impostor.memory.plan.targetRoom = "electrical";
        impostor.memory.lastPlannedAtMs = Date.now();

        const entrance = observeGame(game, impostor.id);
        expect(entrance.ventSlots.map((vent) => vent.id)).toEqual(["vent-security"]);
        expect(entrance.actionMask[ACTION.VENT_START]).toBe(true);
        expect(observeGame(game, crewmate.id).actionMask[ACTION.VENT_START]).toBe(
            false,
        );
        const controller = new AgentOrchestrator(
            new JevClient(""),
            new OpenRouterClient(""),
        );
        expect((await controller.decide(game, impostor.id)).decision.actionId).toBe(
            ACTION.VENT_START,
        );

        const entered = stepGame(game, impostor.id, ACTION.VENT_START).state;
        const inside = observeGame(entered, impostor.id);
        expect(inside.self.ventId).toBe("vent-security");
        expect(inside.ventSlots.map((vent) => vent.id)).toEqual([
            "vent-security",
            "vent-electrical",
            "vent-medbay",
        ]);
        expect(inside.actionMask[ACTION.MOVE_E]).toBe(false);
        expect(inside.actionMask[ACTION.REPORT_BODY]).toBe(false);
        let jevInput: {
            state?: { observation?: { vents?: unknown[] } };
            questions?: { action?: { criteria?: Record<string, string> } };
        } = {};
        const jev = new JevClient("test-key", async (_input, init) => {
            jevInput = JSON.parse(String(init?.body)) as typeof jevInput;
            return Response.json({
                answers: {
                    action: {
                        type: "choice",
                        choice: String(ACTION.VENT_START + 1),
                        confidence: 0.9,
                        probabilities: {},
                    },
                },
            });
        });
        expect(
            (await jev.chooseAction(inside, "Travel to Electrical", ACTION.NOOP))
                .actionId,
        ).toBe(ACTION.VENT_START + 1);
        expect(jevInput.questions?.action?.criteria?.["51"]).toContain("VENT_SLOT_1");
        expect(jevInput.state?.observation?.vents).toHaveLength(3);
        expect(observeGame(entered, crewmate.id).players).not.toContainEqual(
            expect.objectContaining({ id: impostor.id }),
        );
        expect((await controller.decide(entered, impostor.id)).decision.actionId).toBe(
            ACTION.VENT_START + 1,
        );

        const traveled = stepGame(entered, impostor.id, ACTION.VENT_START + 1).state;
        expect(observeGame(traveled, impostor.id).self.ventId).toBe("vent-electrical");
        expect((await controller.decide(traveled, impostor.id)).decision.actionId).toBe(
            ACTION.VENT_START + 1,
        );
        const exited = stepGame(traveled, impostor.id, ACTION.VENT_START + 1).state;
        expect(observeGame(exited, impostor.id).self.ventId).toBeNull();
        expect(exited.players.find((player) => player.id === impostor.id)?.roomId).toBe(
            "electrical",
        );
    });

    test("a vent witness goes to Cafeteria before calling a meeting", async () => {
        let game = createGame(
            { playerCount: 6, impostorCount: 1, humanPlayers: 0 },
            54,
        );
        const impostor = game.players.find((player) => player.role === "impostor");
        const [witness, hidden] = game.players.filter(
            (player) => player.role === "crewmate",
        );
        if (!impostor || !witness || !hidden) throw new Error("Expected players");
        impostor.position = { x: 260, y: 380 };
        impostor.roomId = "security";
        witness.position = { x: 250, y: 370 };
        witness.roomId = "security";
        hidden.position = { x: 330, y: 480 };
        hidden.roomId = "electrical";
        impostor.memory.plan.targetRoom = "electrical";
        impostor.memory.lastPlannedAtMs = Date.now();
        const cautiousAgent = new AgentOrchestrator(
            new JevClient(""),
            new OpenRouterClient(""),
        );
        expect(
            (await cautiousAgent.decide(game, impostor.id)).decision.actionId,
        ).not.toBe(ACTION.VENT_START);
        const ventSlot = observeGame(game, impostor.id).ventSlots.find(
            (vent) => vent.id === "vent-security",
        )?.slot;
        if (ventSlot === undefined) throw new Error("Expected security vent");

        game = stepGame(game, impostor.id, ACTION.VENT_START + ventSlot).state;
        const witnessMemory = game.players.find(
            (player) => player.id === witness.id,
        )?.memory;
        expect(witnessMemory?.events).toContainEqual(
            expect.objectContaining({
                kind: "vent",
                ventUserId: impostor.id,
                reported: false,
            }),
        );
        expect(witnessMemory?.suspicions[impostor.id]).toBe(1);
        expect(
            game.players.find((player) => player.id === hidden.id)?.memory.events,
        ).not.toContainEqual(expect.objectContaining({ kind: "vent" }));
        const electricalSlot = observeGame(game, impostor.id).ventSlots.find(
            (vent) => vent.id === "vent-electrical",
        )?.slot;
        if (electricalSlot === undefined) throw new Error("Expected linked vent");
        game = stepGame(game, impostor.id, ACTION.VENT_START + electricalSlot).state;
        const exitSlot = observeGame(game, impostor.id).ventSlots.find(
            (vent) => vent.id === "vent-electrical",
        )?.slot;
        if (exitSlot === undefined) throw new Error("Expected exit vent");
        expect(
            (await cautiousAgent.decide(game, impostor.id)).decision.actionId,
        ).not.toBe(ACTION.VENT_START + exitSlot);
        game = stepGame(game, impostor.id, ACTION.VENT_START + exitSlot).state;
        expect(
            game.players.find((player) => player.id === hidden.id)?.memory.events,
        ).toContainEqual(
            expect.objectContaining({ kind: "vent", ventUserId: impostor.id }),
        );
        const agent = new AgentOrchestrator(
            new JevClient(""),
            new OpenRouterClient(""),
        );
        let called = false;
        for (let attempt = 0; attempt < 180; attempt += 1) {
            const action = (await agent.decide(game, witness.id)).decision.actionId;
            if (action === ACTION.CALL_MEETING) {
                expect(
                    game.players.find((player) => player.id === witness.id)?.roomId,
                ).toBe("cafeteria");
                game = stepGame(game, witness.id, action).state;
                called = true;
                break;
            }
            expect(action).toBeGreaterThanOrEqual(ACTION.MOVE_N);
            expect(action).toBeLessThanOrEqual(ACTION.MOVE_NW);
            game = stepGame(game, witness.id, action).state;
        }
        expect(called).toBe(true);
        expect(game.meeting?.reporterId).toBe(witness.id);
        expect(game.meeting?.bodyId).toBeNull();
        expect(
            game.players
                .find((player) => player.id === witness.id)
                ?.memory.events.find((event) => event.kind === "vent")?.reported,
        ).toBe(true);
        const statement = await agent.discuss(game, witness.id, []);
        expect(statement.message.text).toContain("Personally saw");
        expect(statement.message.text).toContain(impostor.id);
        expect(await agent.vote(game, witness.id, [statement.message])).toBe(
            impostor.id,
        );
    });

    test("unreported bodies disappear when any meeting concludes", () => {
        let game = createGame({ playerCount: 7, impostorCount: 1 }, 55);
        const [reporter, first, second] = game.players.filter(
            (player) => player.role === "crewmate",
        );
        if (!reporter || !first || !second) throw new Error("Expected crew");
        reporter.position = centerOf("cafeteria");
        reporter.roomId = "cafeteria";
        for (const victim of [first, second]) {
            victim.alive = false;
            victim.position = centerOf("cafeteria");
            victim.roomId = "cafeteria";
            game.bodies.push({
                playerId: victim.id,
                position: { ...victim.position },
                roomId: victim.roomId,
                reported: false,
                createdAtTick: game.tick,
            });
        }
        game = stepGame(game, reporter.id, ACTION.REPORT_BODY).state;
        expect(game.meeting?.bodyId).toBe(first.id);
        expect(game.bodies).toHaveLength(2);
        game = resolveVotes(game, {});
        expect(game.bodies).toHaveLength(0);
    });

    test("redacts unseen positions and other agents' memories", () => {
        const game = createGame({ playerCount: 6, impostorCount: 1 }, 42);
        const viewer = game.players[0];
        const hidden = game.players[5];
        if (!viewer || !hidden) throw new Error("Expected players");
        hidden.position = centerOf("navigation");
        hidden.roomId = "navigation";

        const payload = serializeGameState(game, viewer.id) as {
            players: {
                id: string;
                role: string | null;
                position: object | null;
                memory?: object;
            }[];
        };
        const redacted = payload.players.find((player) => player.id === hidden.id);

        expect(redacted?.position).toBeNull();
        expect(redacted?.role).toBeNull();
        expect(redacted?.memory).toBeUndefined();
    });

    test("gives observer mode a complete map without revealing roles by default", () => {
        const game = createGame({ playerCount: 6, impostorCount: 1 }, 42);
        const distantPlayer = game.players[5];
        if (!distantPlayer) throw new Error("Expected distant player");
        distantPlayer.position = centerOf("navigation");
        const payload = serializeGameState(game, null) as {
            players: { position: object | null; role: string | null }[];
        };

        expect(payload.players.every((player) => player.position !== null)).toBe(true);
        expect(payload.players.every((player) => player.role === null)).toBe(true);
    });

    test("keeps a selected agent's private context in overview mode", () => {
        const game = createGame({ playerCount: 6, impostorCount: 1 }, 42);
        const viewer = game.players[0];
        const distantPlayer = game.players[5];
        if (!viewer || !distantPlayer) throw new Error("Expected players");
        distantPlayer.position = centerOf("navigation");
        const payload = serializeGameState(game, viewer.id, false, true) as {
            players: {
                id: string;
                position: object | null;
                role: string | null;
                memory?: object;
            }[];
        };

        expect(payload.players.every((player) => player.position !== null)).toBe(true);
        expect(payload.players.find((player) => player.id === viewer.id)?.role).toBe(
            viewer.role,
        );
        expect(
            payload.players.find((player) => player.id === viewer.id)?.memory,
        ).toBeDefined();
    });

    test("walls hide nearby players and bodies from observations and state", () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 19);
        const viewer = game.players[0];
        const hidden = game.players[1];
        if (!viewer || !hidden) throw new Error("Expected players");
        viewer.position = { x: 420, y: 215 };
        viewer.roomId = "cafeteria";
        hidden.position = { x: 385, y: 245 };
        hidden.roomId = "medbay";
        expect(
            Math.hypot(
                viewer.position.x - hidden.position.x,
                viewer.position.y - hidden.position.y,
            ),
        ).toBeLessThan(190);
        expect(
            observeGame(game, viewer.id).players.some(
                (player) => player.id === hidden.id,
            ),
        ).toBe(false);
        const payload = serializeGameState(game, viewer.id) as {
            players: { id: string; position: object | null }[];
        };
        expect(
            payload.players.find((player) => player.id === hidden.id)?.position,
        ).toBeNull();
        hidden.alive = false;
        game.bodies.push({
            playerId: hidden.id,
            position: hidden.position,
            roomId: hidden.roomId,
            reported: false,
            createdAtTick: game.tick,
        });
        expect(observeGame(game, viewer.id).bodies).toHaveLength(0);
        hidden.alive = true;
        hidden.position = { x: 500, y: 180 };
        hidden.roomId = "cafeteria";
        expect(
            observeGame(game, viewer.id).players.some(
                (player) => player.id === hidden.id,
            ),
        ).toBe(true);
    });

    test("resolves KILL_PLAYER slots against the private observation", () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 7);
        const killer = game.players[0];
        const target = game.players[1];
        if (!killer || !target) throw new Error("Expected players");
        killer.role = "impostor";
        killer.killCooldown = 0;
        game.firstKillAtMs = Date.now() - 1;
        target.role = "crewmate";
        killer.position = centerOf("cafeteria");
        target.position = { ...killer.position };
        killer.roomId = "cafeteria";
        target.roomId = "cafeteria";

        const observation = observeGame(game, killer.id);
        const slot = observation.players.find(
            (player) => player.id === target.id,
        )?.slot;
        if (slot === undefined) throw new Error("Target should be visible");
        const result = stepGame(game, killer.id, ACTION.KILL_START + slot);

        expect(result.accepted).toBe(true);
        expect(
            result.state.players.find((player) => player.id === target.id)?.alive,
        ).toBe(false);
        expect(result.state.bodies[0]?.playerId).toBe(target.id);
    });

    test("an impostor immediately escapes the murder room instead of stopping or self-reporting", async () => {
        let game = createGame({ playerCount: 6, impostorCount: 1 }, 69);
        const impostor = game.players.find((player) => player.role === "impostor");
        const [victim, ...others] = game.players.filter(
            (player) => player.role === "crewmate",
        );
        if (!impostor || !victim) throw new Error("Expected players");
        game.firstKillAtMs = 0;
        game.sabotage = "lights";
        impostor.killCooldown = 0;
        impostor.position = centerOf("cafeteria");
        impostor.roomId = "cafeteria";
        impostor.memory.plan.targetRoom = "cafeteria";
        victim.position = { x: impostor.position.x + 8, y: impostor.position.y };
        victim.roomId = "cafeteria";
        for (const other of others) {
            other.position = centerOf("reactor");
            other.roomId = "reactor";
        }
        expect(observeGame(game, impostor.id).players[0]?.id).toBe(victim.id);
        game = stepGame(game, impostor.id, ACTION.KILL_START).state;
        const bodyPosition = game.bodies[0]?.position;
        if (!bodyPosition) throw new Error("Expected a body");
        let jevCalls = 0;
        const agent = new AgentOrchestrator(
            new JevClient("test-key", async () => {
                jevCalls += 1;
                return Response.json({
                    answers: {
                        action: {
                            type: "choice",
                            choice: String(ACTION.STOP),
                            confidence: 1,
                            probabilities: {},
                        },
                    },
                });
            }),
            new OpenRouterClient(""),
        );
        let leftScene = false;
        for (let attempt = 0; attempt < 130; attempt += 1) {
            const action = (await agent.decide(game, impostor.id)).decision.actionId;
            expect(action).not.toBe(ACTION.REPORT_BODY);
            expect(action).not.toBe(ACTION.STOP);
            expect(action).not.toBe(ACTION.NOOP);
            game = stepGame(game, impostor.id, action).state;
            const current = game.players.find((player) => player.id === impostor.id);
            if (
                current?.roomId !== "cafeteria" &&
                current &&
                Math.hypot(
                    current.position.x - bodyPosition.x,
                    current.position.y - bodyPosition.y,
                ) > 200
            ) {
                leftScene = true;
                break;
            }
        }
        expect(leftScene).toBe(true);
        expect(jevCalls).toBe(0);
        const escaped = game.players.find((player) => player.id === impostor.id);
        if (!escaped) throw new Error("Expected surviving impostor");
        expect(
            Math.hypot(
                escaped.position.x - bodyPosition.x,
                escaped.position.y - bodyPosition.y,
            ),
        ).toBeGreaterThan(200);
    });

    test("a line-of-sight crewmate remembers and reports a witnessed murder", async () => {
        const game = createGame({ playerCount: 5, impostorCount: 1 }, 43);
        const killer = game.players.find((player) => player.role === "impostor");
        const [victim, witness, hidden] = game.players.filter(
            (player) => player.role === "crewmate",
        );
        if (!killer || !victim || !witness || !hidden)
            throw new Error("Expected players");
        killer.position = { x: 420, y: 180 };
        victim.position = { x: 428, y: 180 };
        witness.position = { x: 440, y: 180 };
        hidden.position = { x: 385, y: 245 };
        for (const player of [killer, victim, witness]) player.roomId = "cafeteria";
        hidden.roomId = "medbay";
        killer.killCooldown = 0;
        game.firstKillAtMs = Date.now() - 1;
        const slot = observeGame(game, killer.id).players.find(
            (player) => player.id === victim.id,
        )?.slot;
        if (slot === undefined) throw new Error("Expected visible victim");

        const killed = stepGame(game, killer.id, ACTION.KILL_START + slot).state;
        const remembered = killed.players.find((player) => player.id === witness.id);
        const event = remembered?.memory.events.find(
            (candidate) => candidate.kind === "kill",
        );
        expect(event?.killerId).toBe(killer.id);
        expect(event?.victimId).toBe(victim.id);
        expect(remembered?.memory.suspicions[killer.id]).toBe(1);
        expect(
            killed.players.find((player) => player.id === hidden.id)?.memory.events,
        ).not.toContainEqual(expect.objectContaining({ kind: "kill" }));
        expect(
            trimMemoryEvents([
                ...(remembered?.memory.events ?? []),
                ...Array.from({ length: 100 }, (_, tick) => ({
                    tick,
                    kind: "sighting" as const,
                    summary: `Later sighting ${tick}`,
                })),
            ]).some((candidate) => candidate.kind === "kill"),
        ).toBe(true);

        const agent = new AgentOrchestrator(
            new JevClient(""),
            new OpenRouterClient(""),
        );
        const distant = structuredClone(killed);
        const distantWitness = distant.players.find(
            (player) => player.id === witness.id,
        );
        if (!distantWitness) throw new Error("Expected witness");
        distantWitness.position = { x: 500, y: 180 };
        const approach = (await agent.decide(distant, witness.id)).decision.actionId;
        expect(approach).toBeGreaterThanOrEqual(ACTION.MOVE_N);
        expect(approach).toBeLessThanOrEqual(ACTION.MOVE_NW);
        expect((await agent.decide(killed, witness.id)).decision.actionId).toBe(
            ACTION.REPORT_BODY,
        );
        killed.phase = "meeting";
        killed.meeting = {
            reason: "Witness report",
            reporterId: witness.id,
            bodyId: victim.id,
            stage: "discussion",
            transcript: [],
            votes: {},
            endsAtTick: killed.tick + 10,
        };
        expect((await agent.shouldSpeak(killed, witness.id, [])).confidence).toBe(1);
        const statement = await agent.discuss(killed, witness.id, []);
        expect(statement.message.text).toContain(`kill ${victim.name}`);
        expect(statement.message.text).toContain(killer.id);
        expect(await agent.vote(killed, witness.id, [])).toBe(killer.id);

        const mistakenModel = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async (_input, init) => {
                const request = JSON.parse(String(init?.body)) as {
                    messages: { content: string }[];
                };
                const answer = request.messages[0]?.content.startsWith("Cast one vote")
                    ? {
                          voteFor: hidden.id,
                          rationale: "Weak guess",
                          suspicionUpdates: { [killer.id]: 0 },
                      }
                    : {
                          message: "I saw nothing.",
                          voteFor: hidden.id,
                          suspicionUpdates: { [killer.id]: 0 },
                      };
                return Response.json({
                    choices: [{ message: { content: JSON.stringify(answer) } }],
                });
            },
        );
        const guardedAgent = new AgentOrchestrator(new JevClient(""), mistakenModel);
        expect(
            (await guardedAgent.discuss(killed, witness.id, [])).message.text,
        ).toContain(`kill ${victim.name}`);
        expect(
            killed.players.find((player) => player.id === witness.id)?.memory
                .suspicions[killer.id],
        ).toBe(1);
        expect(await guardedAgent.vote(killed, witness.id, [])).toBe(killer.id);
    });

    test("a packed crowd witnesses the death without identifying the killer", async () => {
        const game = createGame(
            { playerCount: 6, impostorCount: 1, humanPlayers: 0 },
            83,
        );
        const killer = game.players.find((player) => player.role === "impostor");
        const [victim, ...witnesses] = game.players.filter(
            (player) => player.role === "crewmate",
        );
        if (!killer || !victim || witnesses.length !== 4)
            throw new Error("Expected one impostor and five crewmates");
        killer.position = { x: 420, y: 180 };
        victim.position = { x: 428, y: 180 };
        witnesses.forEach((witness, index) => {
            witness.position =
                index < 3 ? { x: 420 + index * 6, y: 190 } : { x: 500, y: 180 };
            witness.roomId = "cafeteria";
        });
        killer.roomId = "cafeteria";
        victim.roomId = "cafeteria";
        killer.killCooldown = 0;
        game.firstKillAtMs = 0;

        const observation = observeGame(game, killer.id);
        const slot = observation.players.find(
            (player) => player.id === victim.id,
        )?.slot;
        if (slot === undefined) throw new Error("Expected visible victim");
        const action = ACTION.KILL_START + slot;
        expect(observation.actionMask[action]).toBe(true);
        const controller = new AgentOrchestrator(
            new JevClient(""),
            new OpenRouterClient(""),
        );
        // A clear observer outside the cluster still identifies the killer.
        expect((await controller.decide(game, killer.id)).decision.actionId).not.toBe(
            action,
        );
        const killed = stepGame(game, killer.id, action).state;
        for (const witness of witnesses.slice(0, 3)) {
            const memory = killed.players.find(
                (player) => player.id === witness.id,
            )?.memory;
            const event = memory?.events.find((candidate) => candidate.kind === "kill");
            expect(event?.victimId).toBe(victim.id);
            expect(event?.killerId).toBeUndefined();
            expect(event?.summary).toContain("could not identify the killer");
            expect(memory?.suspicions[killer.id]).toBeUndefined();
        }
        const outside = killed.players.find((player) => player.id === witnesses[3]?.id);
        expect(
            outside?.memory.events.find((event) => event.kind === "kill")?.killerId,
        ).toBe(killer.id);
        expect(outside?.memory.suspicions[killer.id]).toBe(1);

        const covered = structuredClone(game);
        const outsidePlayer = covered.players.find(
            (player) => player.id === witnesses[3]?.id,
        );
        if (!outsidePlayer) throw new Error("Expected outside witness");
        outsidePlayer.position = centerOf("reactor");
        outsidePlayer.roomId = "reactor";
        expect((await controller.decide(covered, killer.id)).decision.actionId).toBe(
            action,
        );
        const obscured = stepGame(covered, killer.id, action).state;
        const closeWitness = witnesses[0];
        if (!closeWitness) throw new Error("Expected close witness");
        expect(
            (await controller.decide(obscured, closeWitness.id)).decision.actionId,
        ).toBe(ACTION.REPORT_BODY);
        obscured.phase = "meeting";
        obscured.meeting = {
            reason: "Crowd report",
            reporterId: closeWitness.id,
            bodyId: victim.id,
            stage: "discussion",
            transcript: [],
            votes: {},
            endsAtTick: obscured.tick + 10,
        };
        expect(
            (await controller.shouldSpeak(obscured, closeWitness.id, [])).confidence,
        ).toBe(1);
        expect(
            (await controller.discuss(obscured, closeWitness.id, [])).message.text,
        ).toContain("could not identify the killer");
    });

    test("a fellow impostor is not a witness to an isolated crewmate kill", async () => {
        const game = createGame(
            { playerCount: 5, impostorCount: 2, humanPlayers: 0 },
            87,
        );
        const [killer, teammate] = game.players.filter(
            (player) => player.role === "impostor",
        );
        const [victim, ...others] = game.players.filter(
            (player) => player.role === "crewmate",
        );
        if (!killer || !teammate || !victim) throw new Error("Expected players");
        killer.position = { x: 420, y: 180 };
        teammate.position = { x: 430, y: 180 };
        victim.position = { x: 425, y: 180 };
        for (const player of [killer, teammate, victim]) player.roomId = "cafeteria";
        for (const other of others) {
            other.position = centerOf("reactor");
            other.roomId = "reactor";
        }
        killer.killCooldown = 0;
        game.firstKillAtMs = 0;
        const observation = observeGame(game, killer.id);
        const slot = observation.players.find(
            (player) => player.id === victim.id,
        )?.slot;
        if (slot === undefined) throw new Error("Expected visible victim");
        const controller = new AgentOrchestrator(
            new JevClient(""),
            new OpenRouterClient(""),
        );
        expect((await controller.decide(game, killer.id)).decision.actionId).toBe(
            ACTION.KILL_START + slot,
        );
    });

    test("impostor movement can close the last few steps on a visible crewmate", () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 89);
        const impostor = game.players.find((player) => player.role === "impostor");
        const crew = game.players.filter((player) => player.role === "crewmate");
        const target = crew[0];
        if (!impostor || !target) throw new Error("Expected players");
        impostor.position = { x: 420, y: 180 };
        impostor.roomId = "cafeteria";
        target.position = { x: 432, y: 180 };
        target.roomId = "cafeteria";
        for (const other of crew.slice(1)) {
            other.position = centerOf("reactor");
            other.roomId = "reactor";
        }
        const observation = observeGame(game, impostor.id);
        expect(spreadMove(observation, impostor, ACTION.MOVE_E, target.position)).toBe(
            ACTION.MOVE_E,
        );
    });

    test("keeps the first minute free of agent-called meetings and murder", () => {
        const game = createGame({ playerCount: 6, impostorCount: 1 }, 23);
        const impostor = game.players.find((player) => player.role === "impostor");
        const crewmate = game.players.find(
            (player) => player.role === "crewmate" && !player.human,
        );
        if (!impostor || !crewmate) throw new Error("Expected agents");
        expect(game.firstKillAtMs - Date.now()).toBeGreaterThanOrEqual(
            FIRST_KILL_DELAY_MS - 1_000,
        );
        expect(game.firstKillAtMs - Date.now()).toBeLessThanOrEqual(
            FIRST_KILL_DELAY_MS,
        );
        impostor.killCooldown = 0;
        crewmate.position = { ...impostor.position };
        crewmate.roomId = impostor.roomId;
        const mask = observeGame(game, impostor.id).actionMask;
        expect(mask.slice(ACTION.KILL_START, ACTION.KILL_END + 1).some(Boolean)).toBe(
            false,
        );
        expect(
            mask.slice(ACTION.SABOTAGE_START, ACTION.SABOTAGE_END + 1).some(Boolean),
        ).toBe(false);
        const crewObservation = observeGame(game, crewmate.id);
        expect(crewObservation.actionMask[ACTION.CALL_MEETING]).toBe(false);
        expect(
            crewObservation.interactionSlots.some((slot) => slot.kind === "emergency"),
        ).toBe(false);
    });

    test("gives human discussions ninety seconds and agent-only discussions thirty", () => {
        for (const humanPlayers of [0, 1]) {
            const startedAtMs = Date.now();
            const { called, reporterId } = meetingWithHumanCount(humanPlayers);
            const duration = humanPlayers ? 90_000 : 30_000;
            expect(called.accepted).toBe(true);
            expect(called.state.meeting?.stage).toBe("discussion");
            expect(called.state.meeting?.votes).toEqual({});
            expect(called.state.meeting?.discussionEndsAtMs).toBeGreaterThanOrEqual(
                startedAtMs + duration,
            );
            expect(called.state.meeting?.discussionEndsAtMs).toBeLessThanOrEqual(
                Date.now() + duration,
            );
            const publicMeeting = serializeGameState(called.state, reporterId) as {
                meeting: { discussionSecondsRemaining: number };
            };
            expect(publicMeeting.meeting.discussionSecondsRemaining).toBe(
                duration / 1_000,
            );
        }
    });

    test("resets living impostors' kill cooldown after either kind of meeting", () => {
        for (const meetingKind of ["emergency", "body"] as const) {
            const meeting = gameMeetingAfterSpentCooldown(meetingKind);
            expect(meeting.accepted).toBe(true);
            expect(meeting.state.meeting?.startedAtTick).toBe(60);
            const publicMeeting = serializeGameState(
                meeting.state,
                meeting.state.meeting?.reporterId ?? null,
            ) as {
                meeting: { startedAtTick: number };
            };
            expect(publicMeeting.meeting.startedAtTick).toBe(60);

            const ejection = resolveVotes(meeting.state, {});
            if (!ejection.ejection) throw new Error("Expected ejection phase");
            ejection.ejection.endsAtMs = Date.now() - 1;
            const resumed = advanceGame(ejection);
            expect(resumed.phase).toBe("action");
            for (const impostor of resumed.players.filter(
                (player) => player.alive && player.role === "impostor",
            )) {
                expect(impostor.killCooldown).toBe(resumed.settings.killCooldownTicks);
            }
        }
    });

    test("retains the complete ballot during the ejection phase", () => {
        const game = createGame({ playerCount: 6, impostorCount: 1 }, 29);
        const [voterOne, voterTwo, target] = game.players;
        if (!voterOne || !voterTwo || !target) throw new Error("Expected players");
        target.role = "crewmate";
        game.phase = "meeting";
        game.meeting = {
            reason: "Test vote",
            reporterId: voterOne.id,
            bodyId: null,
            stage: "voting",
            transcript: [],
            votes: {},
            endsAtTick: game.tick + 10,
        };
        expect(observeGame(game, voterOne.id).meetingReason).toBe("Test vote");
        const votes = { [voterOne.id]: target.id, [voterTwo.id]: target.id };

        const result = resolveVotes(game, votes);

        expect(result.phase).toBe("ejection");
        expect(result.ejection?.votes).toEqual(votes);
        expect(result.ejection?.ejectedId).toBe(target.id);
        expect(result.meeting).not.toBeNull();
        expect(result.players.find((player) => player.id === target.id)?.alive).toBe(
            false,
        );
        if (!result.ejection) throw new Error("Expected ejection state");
        result.ejection.endsAtMs = Date.now() - 1;
        const resumed = advanceGame(result);
        expect(resumed.phase).toBe("action");
        expect(resumed.meeting).toBeNull();
        expect(resumed.ejection).toBeNull();
    });

    test("reassigns unfinished tasks after a crewmate is killed or ejected", () => {
        const game = createGame({ playerCount: 5, impostorCount: 1 }, 29);
        const impostor = game.players.find((player) => player.role === "impostor");
        const [victim, recipient] = game.players.filter(
            (player) => player.role === "crewmate",
        );
        if (!impostor || !victim || !recipient) throw new Error("Expected players");
        const victimTasks = game.tasks.filter((task) => task.ownerId === victim.id);
        const completed = victimTasks[0];
        if (!completed) throw new Error("Expected victim task");
        completed.completed = true;
        impostor.position = { ...victim.position };
        impostor.roomId = victim.roomId;
        impostor.killCooldown = 0;
        game.firstKillAtMs = Date.now() - 1;
        const slot = observeGame(game, impostor.id).players.find(
            (player) => player.id === victim.id,
        )?.slot;
        if (slot === undefined) throw new Error("Expected visible victim");

        const killed = stepGame(game, impostor.id, ACTION.KILL_START + slot).state;
        expect(killed.players.find((player) => player.id === victim.id)?.alive).toBe(
            false,
        );
        expect(killed.tasks.find((task) => task.id === completed.id)?.ownerId).toBe(
            victim.id,
        );
        for (const task of victimTasks.filter((task) => !task.completed)) {
            const reassigned = killed.tasks.find(
                (candidate) => candidate.id === task.id,
            );
            const newOwner = killed.players.find(
                (player) => player.id === reassigned?.ownerId,
            );
            expect(newOwner?.alive).toBe(true);
            expect(newOwner?.role).toBe("crewmate");
            expect(newOwner?.taskIds).toContain(task.id);
        }
        expect(killed.tasks).toHaveLength(game.tasks.length);
        const completedGame = structuredClone(killed);
        for (const task of completedGame.tasks) task.completed = true;
        expect(advanceGame(completedGame).winner).toBe("crewmate");

        killed.phase = "meeting";
        killed.meeting = {
            reason: "Test vote",
            reporterId: impostor.id,
            bodyId: null,
            stage: "voting",
            transcript: [],
            votes: {},
            endsAtTick: killed.tick + 10,
        };
        const ejected = resolveVotes(killed, {
            [impostor.id]: recipient.id,
        });
        expect(
            ejected.players.find((player) => player.id === recipient.id)?.alive,
        ).toBe(false);
        expect(
            ejected.tasks.filter(
                (task) => !task.completed && task.ownerId === recipient.id,
            ),
        ).toHaveLength(0);
    });

    test("a body report names its victim while an emergency meeting does not", () => {
        const game = createGame({ playerCount: 4, humanPlayers: 1 }, 13);
        const reporter = game.players[0];
        const victim = game.players[1];
        if (!reporter || !victim) throw new Error("Expected reporter and victim");
        reporter.position = centerOf("cafeteria");
        reporter.roomId = "cafeteria";
        victim.alive = false;
        game.bodies.push({
            playerId: victim.id,
            position: { ...reporter.position },
            roomId: "cafeteria",
            reported: false,
            createdAtTick: game.tick,
        });

        const report = stepGame(game, reporter.id, ACTION.REPORT_BODY);
        expect(report.accepted).toBe(true);
        expect(report.state.meeting?.bodyId).toBe(victim.id);
        expect(report.state.meeting?.reason).toContain(`${victim.name}'s body`);
        expect(observeGame(report.state, reporter.id).meetingReason).toContain(
            `${victim.name}'s body`,
        );

        const emergencyGame = createGame({ playerCount: 4, humanPlayers: 1 }, 13);
        const caller = emergencyGame.players[0];
        if (!caller) throw new Error("Expected caller");
        caller.position = centerOf("cafeteria");
        caller.roomId = "cafeteria";
        const emergency = stepGame(emergencyGame, caller.id, ACTION.CALL_MEETING);
        expect(emergency.accepted).toBe(true);
        expect(emergency.state.meeting?.bodyId).toBeNull();
        expect(emergency.state.meeting?.reason).toContain("emergency meeting");
    });

    test("advances only the acting player's active task", () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 11);
        const owner = game.players.find((player) => player.role === "crewmate");
        const task = game.tasks.find((candidate) => candidate.ownerId === owner?.id);
        if (!owner || !task) throw new Error("Expected crewmate task");
        owner.roomId = task.roomIds[task.stage] ?? "cafeteria";
        owner.position = centerOf(owner.roomId);

        const result = stepGame(
            game,
            owner.id,
            ACTION.TASK_CLICK_START + task.targetCell,
        );

        expect(result.accepted).toBe(true);
        expect(
            result.state.tasks.find((candidate) => candidate.id === task.id)?.stage,
        ).toBe(1);
    });

    test("completes fuel tasks with the press and release gesture", () => {
        const game = createGame({ playerCount: 10, impostorCount: 1 }, 17);
        const task = game.tasks.find((candidate) => candidate.kind === "fuel");
        const player = game.players.find((candidate) => candidate.id === task?.ownerId);
        if (!task || !player) throw new Error("Expected fuel task");
        player.roomId = task.roomIds[task.stage] ?? "storage";
        player.position = centerOf(player.roomId);

        const pressed = stepGame(game, player.id, ACTION.TASK_PRESS);
        const released = stepGame(pressed.state, player.id, ACTION.TASK_RELEASE);

        expect(pressed.accepted).toBe(true);
        expect(released.accepted).toBe(true);
        expect(
            released.state.tasks.find((candidate) => candidate.id === task.id)?.stage,
        ).toBe(1);
    });

    test("patrols locally instead of stopping after reaching a planned room", () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 21);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        player.roomId = "cafeteria";
        player.position = centerOf("cafeteria");
        player.memory.plan.targetRoom = "cafeteria";
        const observation = observeGame(game, player.id);

        const actionId = movementFallback(observation, player);

        expect(actionId).toBeGreaterThanOrEqual(ACTION.MOVE_N);
        expect(actionId).toBeLessThanOrEqual(ACTION.MOVE_NW);
        expect(observation.actionMask[actionId]).toBe(true);
    });

    test("takes a legal detour instead of NOOP when its preferred step is blocked", () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 21);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        player.roomId = "cafeteria";
        player.position = centerOf("cafeteria");
        player.memory.plan.targetRoom = "cafeteria";
        const observation = observeGame(game, player.id);
        const preferred = movementFallback(observation, player);
        observation.actionMask[preferred] = false;

        const detour = movementFallback(observation, player);

        expect(detour).not.toBe(ACTION.NOOP);
        expect(detour).not.toBe(ACTION.STOP);
        expect(detour).not.toBe(preferred);
        expect(observation.actionMask[detour]).toBe(true);
    });

    test("can route a fallback agent from Cafeteria to every room", async () => {
        const agents = new AgentOrchestrator(
            new JevClient(""),
            new OpenRouterClient(""),
        );
        for (const room of ROOMS) {
            let game = createGame(
                { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
                7,
            );
            const player = game.players.find(
                (candidate) => candidate.role === "impostor",
            );
            if (!player) throw new Error("Expected impostor");
            player.position = centerOf("cafeteria");
            player.roomId = "cafeteria";
            player.memory.plan = {
                goal: "Navigate",
                targetRoom: room.id,
                rationale: "navigation test",
                validUntilTick: 10_000,
            };
            player.memory.lastPlannedAtMs = Date.now();
            for (let step = 0; step < 220; step += 1) {
                const current = game.players.find(
                    (candidate) => candidate.id === player.id,
                );
                if (current?.roomId === room.id) break;
                const turn = await agents.decide(game, player.id);
                game = stepGame(game, player.id, turn.decision.actionId).state;
            }
            expect(
                game.players.find((candidate) => candidate.id === player.id)?.roomId,
            ).toBe(room.id);
        }
    });
});

describe("agent provider boundaries", () => {
    test("a crewmate reports a nearby body before planning or Jev", async () => {
        const game = createGame(
            { playerCount: 5, impostorCount: 1, humanPlayers: 0 },
            47,
        );
        const reporter = game.players.find((player) => player.role === "crewmate");
        const victim = game.players.find(
            (player) => player.role === "crewmate" && player !== reporter,
        );
        if (!reporter || !victim) throw new Error("Expected crewmates");
        reporter.position = { x: 420, y: 180 };
        reporter.roomId = "cafeteria";
        victim.alive = false;
        game.bodies.push({
            playerId: victim.id,
            position: { x: 520, y: 180 },
            roomId: reporter.roomId,
            reported: false,
            createdAtTick: game.tick,
        });
        let providerCalls = 0;
        const failingProvider = async () => {
            providerCalls += 1;
            throw new Error("Provider should not be called before reporting");
        };
        const agents = new AgentOrchestrator(
            new JevClient("test-key", failingProvider),
            new OpenRouterClient("test-key", "unbiased/pareto", failingProvider),
        );

        expect(observeGame(game, reporter.id).actionMask[ACTION.REPORT_BODY]).toBe(
            false,
        );
        expect((await agents.decide(game, reporter.id)).decision.actionId).toBe(
            ACTION.MOVE_E,
        );
        const body = game.bodies[0];
        if (!body) throw new Error("Expected body");
        body.position = { ...reporter.position };
        expect((await agents.decide(game, reporter.id)).decision.actionId).toBe(
            ACTION.REPORT_BODY,
        );
        expect(providerCalls).toBe(0);
    });

    test("sends Jev only currently legal action choices", async () => {
        let requestBody: Record<string, unknown> = {};
        const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Response.json({
                model: "jev-test",
                answers: {
                    action: {
                        type: "choice",
                        choice: "0",
                        confidence: 0.9,
                        probabilities: { "0": 0.9 },
                    },
                },
            });
        };
        const game = createGame({ playerCount: 4 }, 5);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        const observation = observeGame(game, player.id);
        observation.actionMask.fill(false);
        observation.actionMask[ACTION.NOOP] = true;
        observation.actionMask[ACTION.STOP] = true;

        const decision = await new JevClient("test-key", fetcher).chooseAction(
            observation,
            "Wait safely",
            ACTION.NOOP,
        );

        expect(decision.actionId).toBe(ACTION.NOOP);
        expect(decision.source).toBe("jev");
        const questions = requestBody.questions as {
            action: { criteria: Record<string, string>; instructions: string };
        };
        expect(Object.keys(questions.action.criteria)).toEqual(["0", "9"]);
        expect(questions.action.criteria["172"]).toBeUndefined();
        expect(questions.action.instructions).toContain("IMPOSTOR ESCAPE PRIORITY");
        expect(questions.action.instructions).toContain("increases distance");
        expect(questions.action.instructions).toContain("kill immediately");
        expect(questions.action.instructions).toContain("Do not kill in clear view");
        expect(questions.action.instructions).toContain(
            "Continue escaping on every action",
        );
        expect(
            questions.action.instructions.indexOf("ISOLATED KILL IS THE DEFAULT"),
        ).toBeLessThan(
            questions.action.instructions.indexOf("If the selected goal names"),
        );
    });

    test("samples nearby legal moves without randomizing critical actions", async () => {
        const game = createGame({ playerCount: 4 }, 5);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        const observation = observeGame(game, player.id);
        observation.actionMask.fill(false);
        observation.actionMask[ACTION.NOOP] = true;
        observation.actionMask[ACTION.MOVE_N] = true;
        observation.actionMask[ACTION.MOVE_NE] = true;
        observation.actionMask[ACTION.MOVE_NW] = true;
        observation.actionMask[ACTION.REPORT_BODY] = true;
        let choice = String(ACTION.MOVE_N);
        const fetcher = async () =>
            Response.json({
                answers: {
                    action: {
                        type: "choice",
                        choice,
                        confidence: 0.9,
                        probabilities: { "1": 0.9, "2": 0.05, "8": 0.05 },
                    },
                },
            });
        const exploratory = new JevClient("test-key", fetcher, () => 0.99);
        const greedy = new JevClient("test-key", fetcher, () => 0);
        expect(
            (await exploratory.chooseAction(observation, "Go north", ACTION.MOVE_N))
                .actionId,
        ).toBe(ACTION.MOVE_NW);
        expect(
            (await greedy.chooseAction(observation, "Go north", ACTION.MOVE_N))
                .actionId,
        ).toBe(ACTION.MOVE_N);
        observation.actionMask[ACTION.MOVE_NW] = false;
        expect(
            (await exploratory.chooseAction(observation, "Go north", ACTION.MOVE_N))
                .actionId,
        ).toBe(ACTION.MOVE_NE);
        choice = String(ACTION.REPORT_BODY);
        expect(
            (await exploratory.chooseAction(observation, "Report", ACTION.REPORT_BODY))
                .actionId,
        ).toBe(ACTION.REPORT_BODY);
    });

    test("Jev receives isolated-kill, witness, and post-kill escape cues", async () => {
        const game = createGame(
            { playerCount: 6, impostorCount: 2, humanPlayers: 0 },
            2,
        );
        const impostor = game.players.find((player) => player.role === "impostor");
        const teammate = game.players.find(
            (player) => player.role === "impostor" && player !== impostor,
        );
        const crew = game.players.filter((player) => player.role === "crewmate");
        const victim = crew[0];
        const witness = crew[1];
        if (!impostor || !teammate || !victim || !witness)
            throw new Error("Expected players");
        for (const task of game.tasks.slice(0, -1)) task.completed = true;
        game.firstKillAtMs = 0;
        game.tick = 35;
        impostor.killCooldown = 0;
        impostor.position = { x: 420, y: 180 };
        impostor.roomId = "cafeteria";
        teammate.position = { x: 436, y: 180 };
        teammate.roomId = "cafeteria";
        victim.position = { x: 430, y: 180 };
        victim.roomId = "cafeteria";
        for (const other of crew.slice(1)) {
            other.position = centerOf("reactor");
            other.roomId = "reactor";
        }
        let criteria: Record<string, string> = {};
        let instructions = "";
        let globalProgress: { completed: number; total: number } | undefined;
        const jev = new JevClient("test-key", async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as {
                state: {
                    observation: {
                        crewTaskProgress: { completed: number; total: number };
                    };
                };
                questions: {
                    action: { criteria: Record<string, string>; instructions: string };
                };
            };
            criteria = body.questions.action.criteria;
            instructions = body.questions.action.instructions;
            globalProgress = body.state.observation.crewTaskProgress;
            return Response.json({
                answers: {
                    action: {
                        type: "choice",
                        choice: String(ACTION.MOVE_W),
                        confidence: 1,
                        probabilities: {},
                    },
                },
            });
        });
        const isolated = observeGame(game, impostor.id);
        const slot = isolated.players.find((player) => player.id === victim.id)?.slot;
        if (slot === undefined) throw new Error("Expected visible victim");
        const killId = ACTION.KILL_START + slot;
        await jev.chooseAction(isolated, "SABOTAGE_2", ACTION.MOVE_E);
        expect(criteria[String(killId)]).toContain("ISOLATED LEGAL KILL");
        expect(instructions).toContain(
            "beside the same isolated target for several seconds",
        );
        expect(instructions).toContain("two impostors and one isolated crewmate");
        expect(instructions).toContain("five or more living players");
        expect(instructions).toContain("shadow them from across the room");
        expect(instructions).toContain("On the very next action after a kill");
        expect(instructions).toContain(
            "crewTaskProgress is the GLOBAL crew win counter",
        );
        expect(instructions).toContain("90%");
        expect(globalProgress).toEqual({
            completed: game.tasks.length - 1,
            total: game.tasks.length,
        });
        expect(criteria[String(killId)]).toContain("CREW TASKS CRITICAL");

        witness.position = { x: 424, y: 192 };
        witness.roomId = "cafeteria";
        await jev.chooseAction(observeGame(game, impostor.id), "Kill", ACTION.MOVE_E);
        expect(criteria[String(killId)]).toContain("WITNESSED KILL RISK");

        witness.position = centerOf("reactor");
        witness.roomId = "reactor";
        const killed = stepGame(game, impostor.id, killId).state;
        await jev.chooseAction(
            observeGame(killed, impostor.id),
            "Kill old target",
            ACTION.REPORT_BODY,
        );
        expect(criteria[String(ACTION.MOVE_W)]).toContain("ESCAPE, increases");
        expect(criteria[String(ACTION.MOVE_E)]).toContain("AVOID, decreases");
        expect(criteria[String(ACTION.REPORT_BODY)]).toContain("AVOID; leave");

        const inVent = observeGame(killed, impostor.id);
        inVent.self.ventId = "current";
        inVent.ventSlots = [
            { slot: 0, id: "current", roomId: "cafeteria" },
            { slot: 1, id: "linked", roomId: "admin" },
        ];
        inVent.actionMask[ACTION.VENT_START] = true;
        inVent.actionMask[ACTION.VENT_START + 1] = true;
        await jev.chooseAction(inVent, "Escape", ACTION.VENT_START + 1);
        expect(criteria[String(ACTION.VENT_START)]).toContain("AVOID, exits vent");
        expect(criteria[String(ACTION.VENT_START + 1)]).toContain(
            "ESCAPE, travel to linked vent",
        );
    });

    test("Jev classifies whether an agent should speak", async () => {
        let sentTranscript: unknown = null;
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 5);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        const transcript = [{ playerId: "player-1", text: "I saw someone in Admin." }];
        const jev = new JevClient("test-key", async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as {
                state: { transcript: unknown };
                questions: {
                    speak: { criteria: Record<string, string>; instructions: string };
                };
            };
            sentTranscript = body.state.transcript;
            expect(Object.keys(body.questions.speak.criteria)).toEqual([
                "SPEAK",
                "SILENT",
            ]);
            expect(body.questions.speak.instructions).toContain(
                "Being unspoken is not a reason",
            );
            return Response.json({
                answers: {
                    speak: {
                        type: "choice",
                        choice: "SPEAK",
                        confidence: 0.82,
                        probabilities: { SPEAK: 0.82, SILENT: 0.18 },
                    },
                },
            });
        });
        const decision = await jev.shouldSpeak(
            observeGame(game, player.id),
            player.memory,
            transcript,
            0,
        );
        expect(decision).toEqual({
            speak: true,
            confidence: 0.82,
            source: "jev",
        });
        expect(sentTranscript).toEqual(transcript);
        const quiet = await new JevClient("").shouldSpeak(
            observeGame(game, player.id),
            player.memory,
            [],
            0,
        );
        expect(quiet.speak).toBe(false);
    });

    test("Jev selects a conditional plan B and can switch back to A", async () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 9);
        const player = game.players.find((candidate) => candidate.role === "crewmate");
        if (!player) throw new Error("Expected player");
        player.memory.plan = {
            goal: "Complete task in Navigation",
            targetRoom: "navigation",
            rationale: "Next task",
            alternative: {
                goal: "Avoid a visible suspect",
                targetRoom: "upper-engine",
                rationale: "Safer route",
                trigger: "A strong suspect appears near Navigation",
            },
            active: "A",
            validUntilTick: 500,
        };
        player.memory.lastPlannedAtMs = Date.now();
        let choice: "A" | "B" = "B";
        const jev = new JevClient("test-key", async (_input, init) => {
            const request = JSON.parse(String(init?.body)) as {
                state: { planA: { targetRoom: string }; planB: { trigger: string } };
                questions: { plan: { criteria: Record<string, string> } };
            };
            expect(request.state.planA.targetRoom).toBe("navigation");
            expect(request.state.planB.trigger).toContain("suspect");
            expect(Object.keys(request.questions.plan.criteria)).toEqual(["A", "B"]);
            return Response.json({
                answers: {
                    plan: {
                        type: "choice",
                        choice,
                        confidence: 0.9,
                        probabilities: {},
                    },
                    action: {
                        type: "choice",
                        choice: String(ACTION.NOOP),
                        confidence: 0.9,
                        probabilities: {},
                    },
                },
            });
        });
        const agent = new AgentOrchestrator(jev, new OpenRouterClient(""));
        await agent.decide(game, player.id);
        expect(player.memory.plan.active).toBe("B");
        choice = "A";
        await agent.decide(game, player.id);
        expect(player.memory.plan.active).toBe("A");
    });

    test("uses the requested OpenRouter model for planning", async () => {
        let model = "";
        let knownImpostors: unknown = null;
        const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
                model: string;
                messages: { content: string }[];
            };
            model = body.model;
            const input = JSON.parse(body.messages[1]?.content ?? "{}") as {
                observation?: { knownImpostors?: unknown };
            };
            knownImpostors = input.observation?.knownImpostors;
            return Response.json({
                choices: [
                    {
                        message: {
                            content: JSON.stringify(
                                planReply(
                                    "Finish wiring",
                                    "electrical",
                                    "It is my next private task",
                                    100,
                                ),
                            ),
                        },
                    },
                ],
            });
        };
        const game = createGame({ playerCount: 6, impostorCount: 2 }, 9);
        const player = game.players.find((candidate) => candidate.role === "impostor");
        if (!player) throw new Error("Expected player");

        const plan = await new OpenRouterClient(
            "test-key",
            "stealth/union-alpha",
            fetcher,
        ).plan(observeGame(game, player.id), player.memory);

        expect(model).toBe("stealth/union-alpha");
        expect(plan?.targetRoom).toBe("electrical");
        expect(plan?.alternative?.trigger).toBe("A visible threat blocks plan A");
        expect(knownImpostors).toEqual(observeGame(game, player.id).knownImpostors);
    });

    test("impostor System 2 is prompted to blend in across plans, speech, and votes", async () => {
        const game = createGame(
            { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
            9,
        );
        const impostor = game.players.find((player) => player.role === "impostor");
        const crewmate = game.players.find((player) => player.role === "crewmate");
        if (!impostor || !crewmate) throw new Error("Expected both roles");
        for (const task of game.tasks.slice(0, -1)) task.completed = true;
        const prompts: string[] = [];
        const inputs: string[] = [];
        const model = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async (_input, init) => {
                const request = JSON.parse(String(init?.body)) as {
                    messages: { content: string }[];
                };
                const prompt = request.messages[0]?.content ?? "";
                prompts.push(prompt);
                inputs.push(request.messages[1]?.content ?? "");
                const answer = prompt.includes("Cast one vote")
                    ? { voteFor: crewmate.id, rationale: "Plausible vote" }
                    : prompt.includes("Speak once")
                      ? { message: "I was in Admin.", voteFor: null }
                      : planReply("Move through Admin", "admin", "Credible route", 60);
                return Response.json({
                    choices: [{ message: { content: JSON.stringify(answer) } }],
                });
            },
        );
        const observation = observeGame(game, impostor.id);
        const aliveIds = [crewmate.id];
        await model.plan(observation, impostor.memory);
        await model.discuss(observation, impostor.memory, [], aliveIds);
        await model.vote(observation, impostor.memory, [], aliveIds);
        await model.plan(observeGame(game, crewmate.id), crewmate.memory);

        expect(prompts).toHaveLength(4);
        expect(
            prompts
                .slice(0, 3)
                .every((prompt) => prompt.includes("avoiding detection")),
        ).toBe(true);
        expect(prompts[3]).not.toContain("avoiding detection");
        expect(prompts[0]).toContain("taskProgress is your own tasks");
        expect(prompts[0]).toContain(
            "crewTaskProgress is the global crew win-condition counter",
        );
        expect(prompts[0]).toContain("above 90%");
        expect(inputs[0]).toContain('"crewTaskProgress"');
        expect(inputs[0]).toContain(`"completed":${game.tasks.length - 1}`);
        expect(prompts[0]).toContain("use SABOTAGE_2 (lights) only when");
        expect(prompts[0]).toContain("Leave body room now");
        expect(prompts[0]).toContain("visibly alone within kill range");
        expect(prompts[0]).toContain("choose ONE living crewmate by ID to shadow");
        expect(prompts[0]).toContain("shadow very closely at walking distance");
        expect(prompts[0]).toContain("Two impostors with one isolated crewmate");
        expect(prompts[0]).toContain("at least five living players");
        expect(prompts[0]).toContain(
            "Enter or exit a vent only when no living crewmate",
        );
        expect(prompts[0]).toContain("After one empty sweep");
        expect(prompts[0]).toContain("Each goal/trigger under 90 characters");
    });

    test("accepts fenced or length-marked complete JSON and retries truncated output", async () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 9);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        const response = planReply("Check Admin", "admin", "Nearby task", 60);
        const fenced = new OpenRouterClient("test-key", "unbiased/pareto", async () =>
            Response.json({
                choices: [
                    {
                        message: {
                            content: `\`\`\`json\n${JSON.stringify(response)}\n\`\`\``,
                        },
                    },
                ],
            }),
        );
        expect(
            (await fenced.plan(observeGame(game, player.id), player.memory))
                ?.targetRoom,
        ).toBe("admin");

        const lengthMarked = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async () =>
                Response.json({
                    choices: [
                        {
                            message: { content: JSON.stringify(response) },
                            finish_reason: "length",
                        },
                    ],
                }),
        );
        expect(
            (await lengthMarked.plan(observeGame(game, player.id), player.memory))
                ?.targetRoom,
        ).toBe("admin");

        let failure = "";
        let calls = 0;
        const truncated = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async () => {
                calls += 1;
                return Response.json({
                    choices: [
                        {
                            message: { content: '{"goal":' },
                            finish_reason: "length",
                        },
                    ],
                });
            },
        );
        expect(
            await truncated.plan(
                observeGame(game, player.id),
                player.memory,
                undefined,
                (reason) => {
                    failure = reason;
                },
            ),
        ).toBeNull();
        expect(failure).toBe("Model response was truncated");
        expect(calls).toBe(2);

        let emptyCalls = 0;
        const emptyReasoningOnly = new OpenRouterClient(
            "test-key",
            "deepseek/deepseek-v4.1-flash",
            async () => {
                emptyCalls += 1;
                return Response.json({
                    choices: [
                        emptyCalls === 1
                            ? { message: { content: "" }, finish_reason: "length" }
                            : { message: { content: JSON.stringify(response) } },
                    ],
                });
            },
        );
        expect(
            (await emptyReasoningOnly.plan(observeGame(game, player.id), player.memory))
                ?.targetRoom,
        ).toBe("admin");
        expect(emptyCalls).toBe(2);
    });

    test("retries invalid JSON and schema-invalid model replies", async () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 9);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        let calls = 0;
        const model = new OpenRouterClient("test-key", "unbiased/pareto", async () => {
            calls += 1;
            return Response.json({
                choices: [
                    {
                        message: {
                            content:
                                calls === 1
                                    ? '{"goal":"Check Admin"'
                                    : JSON.stringify(
                                          planReply("Check Admin", "admin", "Task", 60),
                                      ),
                        },
                    },
                ],
            });
        });
        expect(
            (await model.plan(observeGame(game, player.id), player.memory))?.targetRoom,
        ).toBe("admin");
        expect(calls).toBe(2);

        calls = 0;
        const schemaModel = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async () => {
                calls += 1;
                return Response.json({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify(
                                    planReply(
                                        "Check Admin",
                                        "admin",
                                        "Task",
                                        calls === 1 ? "sixty" : 60,
                                    ),
                                ),
                            },
                        },
                    ],
                });
            },
        );
        expect(
            (await schemaModel.plan(observeGame(game, player.id), player.memory))
                ?.targetRoom,
        ).toBe("admin");
        expect(calls).toBe(2);
    });

    test("System 2 refreshes its plan after twenty seconds", async () => {
        let planCalls = 0;
        const systemTwo = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async () => {
                planCalls += 1;
                return Response.json({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify(
                                    planReply(
                                        `Plan ${planCalls}`,
                                        "electrical",
                                        "Test route",
                                        100,
                                    ),
                                ),
                            },
                        },
                    ],
                });
            },
        );
        const jev = new JevClient("");
        const game = createGame(
            { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
            9,
        );
        const agent = game.players[0];
        if (!agent) throw new Error("Expected agent");
        const controller = new AgentOrchestrator(jev, systemTwo);

        await controller.decide(game, agent.id);
        await controller.decide(game, agent.id);
        expect(planCalls).toBe(1);
        agent.memory.lastPlannedAtMs = Date.now() - 20_001;
        await controller.decide(game, agent.id);
        expect(planCalls).toBe(2);
    });

    test("an impostor immediately takes a legal isolated kill but not a witnessed one", async () => {
        const game = createGame(
            { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
            33,
        );
        const impostor = game.players.find((player) => player.role === "impostor");
        const crew = game.players.filter((player) => player.role === "crewmate");
        const [victim, witness] = crew;
        if (!impostor || !victim || !witness)
            throw new Error("Expected impostor and crew");
        game.firstKillAtMs = 0;
        impostor.killCooldown = 0;
        impostor.position = centerOf("cafeteria");
        impostor.roomId = "cafeteria";
        victim.position = { ...impostor.position };
        victim.roomId = "cafeteria";
        for (const other of crew.slice(1)) {
            other.position = centerOf("reactor");
            other.roomId = "reactor";
        }
        let jevCalls = 0;
        const jev = new JevClient("test-key", async () => {
            jevCalls += 1;
            return Response.json({
                answers: {
                    action: {
                        type: "choice",
                        choice: String(ACTION.MOVE_E),
                        confidence: 1,
                        probabilities: {},
                    },
                },
            });
        });
        const controller = new AgentOrchestrator(jev, new OpenRouterClient(""));
        const isolated = observeGame(game, impostor.id);
        const victimSlot = isolated.players.find(
            (player) => player.id === victim.id,
        )?.slot;
        if (victimSlot === undefined) throw new Error("Expected visible victim");
        expect((await controller.decide(game, impostor.id)).decision.actionId).toBe(
            ACTION.KILL_START + victimSlot,
        );
        expect(jevCalls).toBe(0);

        witness.position = { x: impostor.position.x + 16, y: impostor.position.y };
        witness.roomId = "cafeteria";
        const witnessedAction = (await controller.decide(game, impostor.id)).decision
            .actionId;
        expect(witnessedAction).toBeGreaterThanOrEqual(ACTION.MOVE_N);
        expect(witnessedAction).toBeLessThanOrEqual(ACTION.MOVE_NW);
        expect(jevCalls).toBe(1);

        impostor.position = { x: 500, y: 135 };
        victim.position = { x: 450, y: 135 };
        witness.position = { x: 680, y: 135 };
        witness.roomId = "weapons";
        const peripheral = observeGame(game, impostor.id);
        expect(peripheral.players.some((player) => player.id === witness.id)).toBe(
            true,
        );
        const peripheralSlot = peripheral.players.find(
            (player) => player.id === victim.id,
        )?.slot;
        if (peripheralSlot === undefined) throw new Error("Expected visible victim");
        expect((await controller.decide(game, impostor.id)).decision.actionId).toBe(
            ACTION.KILL_START + peripheralSlot,
        );
        expect(jevCalls).toBe(1);
    });

    test("impostors replan after clearing a room and explore a new destination", async () => {
        const game = createGame(
            { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
            33,
        );
        const impostor = game.players.find((player) => player.role === "impostor");
        if (!impostor) throw new Error("Expected impostor");
        for (const crew of game.players.filter(
            (player) => player.role === "crewmate",
        )) {
            crew.position = centerOf("navigation");
            crew.roomId = "navigation";
        }
        const histories: string[][] = [];
        const systemTwo = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async (_input, init) => {
                const body = JSON.parse(String(init?.body)) as {
                    messages: { content: string }[];
                };
                const context = JSON.parse(body.messages[1]?.content ?? "{}") as {
                    recentRooms?: string[];
                };
                histories.push(context.recentRooms ?? []);
                return Response.json({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify(
                                    planReply(
                                        "Hunt in current room",
                                        impostor.roomId,
                                        "Search",
                                        60,
                                    ),
                                ),
                            },
                        },
                    ],
                });
            },
        );
        const controller = new AgentOrchestrator(new JevClient(""), systemTwo);
        await controller.decide(game, impostor.id);
        const firstDestination = impostor.memory.plan.targetRoom;
        expect(firstDestination).not.toBe(impostor.roomId);
        impostor.position = centerOf(firstDestination);
        impostor.roomId = firstDestination;
        impostor.memory.lastPlannedAtMs = Date.now() - 3_100;
        game.tick += 3;
        await controller.decide(game, impostor.id);
        expect(histories).toHaveLength(2);
        expect(histories[1]).toEqual(["cafeteria", firstDestination]);
        expect(impostor.memory.plan.targetRoom).not.toBe(firstDestination);
    });

    test("an impostor stuck in one room abandons a repeated unreachable target", async () => {
        const game = createGame(
            { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
            33,
        );
        const impostor = game.players.find((player) => player.role === "impostor");
        if (!impostor) throw new Error("Expected impostor");
        for (const crew of game.players.filter(
            (player) => player.role === "crewmate",
        )) {
            crew.position = centerOf("navigation");
            crew.roomId = "navigation";
        }
        impostor.memory.plan.targetRoom = "medbay";
        impostor.memory.lastPlannedAtMs = Date.now();
        let planCalls = 0;
        const model = new OpenRouterClient("test-key", "unbiased/pareto", async () => {
            planCalls += 1;
            return Response.json({
                choices: [
                    {
                        message: {
                            content: JSON.stringify(
                                planReply("Keep trying MedBay", "medbay", "Search", 60),
                            ),
                        },
                    },
                ],
            });
        });
        const controller = new AgentOrchestrator(new JevClient(""), model);
        await controller.decide(game, impostor.id);
        expect(planCalls).toBe(0);
        game.tick = 10;
        impostor.memory.lastPlannedAtMs = Date.now() - 3_100;
        await controller.decide(game, impostor.id);
        expect(planCalls).toBe(1);
        expect(impostor.memory.plan.targetRoom).not.toBe("medbay");
        expect(impostor.memory.plan.targetRoom).not.toBe(impostor.roomId);
    });

    test("a speaking agent saves its LLM-selected private memory", async () => {
        const game = createGame({ playerCount: 4, impostorCount: 1 }, 9);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        const transcript = [{ playerId: "player-1", text: "I saw red in Admin." }];
        let sentTranscript: unknown = null;
        const model = new OpenRouterClient(
            "test-key",
            "unbiased/pareto",
            async (_input, init) => {
                const body = JSON.parse(String(init?.body)) as {
                    messages: { content: string }[];
                };
                const input = JSON.parse(body.messages[1]?.content ?? "{}") as {
                    transcript: unknown;
                };
                sentTranscript = input.transcript;
                return Response.json({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    message: "Where did red go next?",
                                    voteFor: null,
                                    suspicionUpdates: { "player-2": 0.6 },
                                    memoryNote: `Red was last claimed in Admin. ${"x".repeat(200)}`,
                                }),
                            },
                        },
                    ],
                });
            },
        );
        const decision = await new AgentOrchestrator(new JevClient(""), model).discuss(
            game,
            player.id,
            transcript,
        );
        expect(decision.message.text).toBe("Where did red go next?");
        expect(sentTranscript).toEqual(transcript);
        expect(
            player.memory.events
                .at(-1)
                ?.summary.startsWith("Red was last claimed in Admin."),
        ).toBe(true);
        expect(player.memory.events.at(-1)?.summary).toHaveLength(180);
    });

    test("uses System 2 to cast a non-skip vote after reading the transcript", async () => {
        let completeTranscript: unknown = null;
        const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
                messages: { role: string; content: string }[];
            };
            const input = JSON.parse(body.messages[1]?.content ?? "{}") as {
                completeTranscript?: unknown;
            };
            completeTranscript = input.completeTranscript;
            return Response.json({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                voteFor: "player-1",
                                rationale: `Their route conflicts with the report. ${"x".repeat(250)}`,
                            }),
                        },
                    },
                ],
            });
        };
        const game = createGame({ playerCount: 4 }, 9);
        const player = game.players[0];
        if (!player) throw new Error("Expected player");
        const transcript = [{ playerId: "player-1", text: "I was in Admin." }];

        const vote = await new OpenRouterClient(
            "test-key",
            "stealth/union-alpha",
            fetcher,
        ).vote(observeGame(game, player.id), player.memory, transcript, [
            "player-1",
            "player-2",
        ]);

        expect(vote?.voteFor).toBe("player-1");
        expect(vote?.rationale).toHaveLength(240);
        expect(vote?.suspicionUpdates).toEqual({});
        expect(completeTranscript).toEqual(transcript);
    });
});
