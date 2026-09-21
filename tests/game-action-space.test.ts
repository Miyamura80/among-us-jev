import { describe, expect, test } from "bun:test";

import {
    ACTION,
    ACTION_COUNT,
    DEFAULT_CONFIG,
    actionLabel,
    buildActionMask,
    createGame,
} from "../frontend/src/game";

describe("fixed action space", () => {
    test("always exposes exactly 255 action slots", () => {
        const game = createGame({
            ...DEFAULT_CONFIG,
            playerCount: 6,
            impostorCount: 1,
        });

        expect(buildActionMask(game, 0)).toHaveLength(ACTION_COUNT);
        expect(ACTION_COUNT).toBe(255);
        expect(actionLabel(163)).toBe("TASK_CLICK_63");
        expect(actionLabel(172)).toBe("RESERVED_172");
        expect(actionLabel(254)).toBe("RESERVED_254");
    });

    test("gates kill slots by role, range, and cooldown", () => {
        const game = createGame({
            ...DEFAULT_CONFIG,
            playerCount: 4,
            impostorCount: 1,
        });
        const impostor = game.players[3];
        const crewmate = game.players[0];
        if (!impostor || !crewmate) throw new Error("Expected seeded players");

        impostor.position = { ...crewmate.position };

        expect(
            buildActionMask(game, crewmate.id)[ACTION.KILL_START + impostor.id],
        ).toBe(false);
        expect(
            buildActionMask(game, impostor.id)[ACTION.KILL_START + crewmate.id],
        ).toBe(true);

        impostor.cooldown = 5;
        expect(
            buildActionMask(game, impostor.id)[ACTION.KILL_START + crewmate.id],
        ).toBe(false);
    });

    test("limits dead players to NOOP", () => {
        const game = createGame(DEFAULT_CONFIG);
        const player = game.players[0];
        if (!player) throw new Error("Expected seeded player");
        player.alive = false;

        const enabled = buildActionMask(game, player.id)
            .map((allowed, id) => (allowed ? id : -1))
            .filter((id) => id >= 0);

        expect(enabled).toEqual([ACTION.NOOP]);
    });
});
