import { describe, expect, test } from "bun:test";

import { movementFallback } from "@/agents/orchestrator";
import { createGame, stepGame } from "@/game/engine";
import {
    type MapArea,
    ROOMS,
    VENTS,
    centerOf,
    hasLineOfSight,
    isWalkable,
    nextWaypoint,
    roomAt,
} from "@/game/map";
import { observeGame } from "@/game/observation";
import type { GameState, Point } from "@/game/types";

function insideRoom(point: Point, room: MapArea, inset = 10): boolean {
    return (
        point.x >= room.x + inset &&
        point.x <= room.x + room.width - inset &&
        point.y >= room.y + inset &&
        point.y <= room.y + room.height - inset
    );
}

function moveAgentOnce(game: GameState, playerId: string): GameState {
    const player = game.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("Expected agent");
    const action = movementFallback(observeGame(game, playerId), player);
    const result = stepGame(game, playerId, action);
    if (!result.accepted) throw new Error("Expected legal move");
    return result.state;
}

describe("The Skeld layout", () => {
    test("keeps named rooms separate", () => {
        for (const [index, room] of ROOMS.entries()) {
            for (const other of ROOMS.slice(index + 1)) {
                const overlapX =
                    Math.min(room.x + room.width, other.x + other.width) -
                    Math.max(room.x, other.x);
                const overlapY =
                    Math.min(room.y + room.height, other.y + other.height) -
                    Math.max(room.y, other.y);
                expect(overlapX <= 0 || overlapY <= 0).toBe(true);
            }
        }
    });
    test("places all fourteen rooms in their recognizable wings", () => {
        expect(ROOMS.map((room) => room.id)).toEqual([
            "cafeteria",
            "weapons",
            "o2",
            "navigation",
            "shields",
            "communications",
            "storage",
            "admin",
            "electrical",
            "lower-engine",
            "security",
            "reactor",
            "upper-engine",
            "medbay",
        ]);
        const x = (id: string) => centerOf(id).x;
        const y = (id: string) => centerOf(id).y;
        expect(x("reactor")).toBeLessThan(x("security"));
        expect(x("security")).toBeLessThan(x("medbay"));
        expect(x("cafeteria")).toBeLessThan(x("weapons"));
        expect(x("weapons")).toBeLessThan(x("navigation"));
        expect(y("upper-engine")).toBeLessThan(y("reactor"));
        expect(y("reactor")).toBeLessThan(y("lower-engine"));
        expect(y("weapons")).toBeLessThan(y("o2"));
        expect(y("o2")).toBeLessThan(y("shields"));
        expect(y("cafeteria")).toBeLessThan(y("storage"));
        expect(y("storage")).toBeLessThan(y("communications"));
    });

    test("keeps walls opaque while the real doorways stay open", () => {
        expect(isWalkable({ x: 590, y: 250 })).toBe(false);
        expect(hasLineOfSight({ x: 420, y: 215 }, { x: 385, y: 245 })).toBe(false);
        expect(hasLineOfSight(centerOf("cafeteria"), centerOf("weapons"))).toBe(true);
        expect(isWalkable({ x: 837, y: 445 })).toBe(true);
    });

    test("MedBay and Security have no connecting doorway", () => {
        expect(isWalkable({ x: 292, y: 342 })).toBe(false);
        expect(hasLineOfSight(centerOf("security"), centerOf("medbay"))).toBe(false);
        expect(hasLineOfSight({ x: 358, y: 225 }, { x: 358, y: 280 })).toBe(true);
    });

    test("Electrical is a dead end with one south entrance", () => {
        expect(hasLineOfSight({ x: 312, y: 505 }, { x: 312, y: 567 })).toBe(true);
        expect(hasLineOfSight({ x: 213, y: 567 }, { x: 415, y: 567 })).toBe(true);
        expect(hasLineOfSight(centerOf("electrical"), { x: 152, y: 480 })).toBe(false);
        expect(hasLineOfSight(centerOf("electrical"), centerOf("storage"))).toBe(false);
        for (const point of [
            { x: 232, y: 500 },
            { x: 382, y: 500 },
            { x: 260, y: 537 },
            { x: 360, y: 537 },
        ]) {
            expect(isWalkable(point)).toBe(false);
        }
    });

    test("Security does not swallow the Upper–Lower Engine hallway", () => {
        expect(roomAt({ x: 152, y: 355 })).not.toBe("security");
        expect(hasLineOfSight({ x: 152, y: 280 }, { x: 152, y: 460 })).toBe(true);
        expect(hasLineOfSight({ x: 152, y: 360 }, { x: 235, y: 360 })).toBe(true);
    });

    test("routes between every room without crossing walls", () => {
        for (const origin of ROOMS) {
            for (const destination of ROOMS) {
                let point = centerOf(origin.id);
                for (
                    let step = 0;
                    step < 300 && !insideRoom(point, destination, 7);
                    step += 1
                ) {
                    const next = nextWaypoint(point, destination.id);
                    expect(isWalkable(next)).toBe(true);
                    expect(hasLineOfSight(point, next)).toBe(true);
                    point = next;
                }
                expect(insideRoom(point, destination, 7)).toBe(true);
            }
        }
    });

    test("agents actually enter Navigation from every starting room", () => {
        const navigation = ROOMS.find((room) => room.id === "navigation");
        if (!navigation) throw new Error("Expected Navigation");
        for (const room of ROOMS) {
            let game = createGame(
                { playerCount: 4, impostorCount: 1, humanPlayers: 0 },
                42,
            );
            const player = game.players[0];
            if (!player) throw new Error("Expected player");
            const playerId = player.id;
            player.position = centerOf(room.id);
            player.roomId = room.id;
            player.memory.plan.targetRoom = "navigation";
            let steps = 0;
            while (
                steps < 200 &&
                !insideRoom(game.players[0]?.position ?? { x: 0, y: 0 }, navigation)
            ) {
                game = moveAgentOnce(game, playerId);
                steps += 1;
            }
            const destination = game.players[0]?.position;
            expect(destination && insideRoom(destination, navigation)).toBe(true);
        }
    });

    test("agents sharing a route spread out and still reach Navigation", () => {
        let game = createGame(
            { playerCount: 8, impostorCount: 1, humanPlayers: 0 },
            42,
        );
        const spawn = centerOf("cafeteria");
        const navigation = ROOMS.find((room) => room.id === "navigation");
        if (!navigation) throw new Error("Expected Navigation");
        for (const player of game.players) {
            player.position = { ...spawn };
            player.roomId = "cafeteria";
            player.memory.plan.targetRoom = "navigation";
        }
        let distinctAtForty = 0;
        for (let tick = 0; tick < 200; tick += 1) {
            for (const playerId of game.players.map((player) => player.id)) {
                game = moveAgentOnce(game, playerId);
            }
            if (tick === 40)
                distinctAtForty = new Set(
                    game.players.map(
                        (player) =>
                            `${Math.round(player.position.x)},${Math.round(player.position.y)}`,
                    ),
                ).size;
        }
        expect(distinctAtForty).toBeGreaterThanOrEqual(6);
        expect(
            game.players.every((player) => insideRoom(player.position, navigation, 7)),
        ).toBe(true);
    });

    test("uses the fourteen canonical vent positions and reciprocal links", () => {
        expect(VENTS).toHaveLength(14);
        const vents = new Map(VENTS.map((vent) => [vent.id, vent]));
        for (const vent of VENTS) {
            expect(isWalkable(vent.position)).toBe(true);
            expect(roomAt(vent.position)).toBe(vent.roomId);
            for (const link of vent.links) {
                expect(vents.get(link)?.links).toContain(vent.id);
            }
        }
        expect(vents.get("vent-reactor-north")?.links).toEqual(["vent-upper-engine"]);
        expect(vents.get("vent-reactor-south")?.links).toEqual(["vent-lower-engine"]);
        expect(vents.get("vent-security")?.links).toEqual([
            "vent-electrical",
            "vent-medbay",
        ]);
        expect(vents.get("vent-admin")?.links).toEqual([
            "vent-cafeteria",
            "vent-hallway",
        ]);
        expect(vents.get("vent-navigation-north")?.links).toEqual(["vent-weapons"]);
        expect(vents.get("vent-navigation-south")?.links).toEqual(["vent-shields"]);
    });
});
