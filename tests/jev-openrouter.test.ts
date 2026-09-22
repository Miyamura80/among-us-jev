import { expect, test } from "bun:test";

import { JevClient } from "@/agents/jev-client";
import { createGame } from "@/game/engine";
import { observeGame } from "@/game/observation";

test("OpenRouter key routes Jev decisions through OpenRouter", async () => {
    const requests: { url: string; key: string; model: string }[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        requests.push({
            url: String(input),
            key: String(new Headers(init?.headers).get("Authorization")),
            model: body.model,
        });
        return Response.json({
            answers: { speak: { type: "choice", choice: "SILENT", confidence: 0.9 } },
        });
    };
    const game = createGame({ playerCount: 4 }, 7);
    const player = game.players[0];
    if (!player) throw new Error("Expected player");
    const jev = new JevClient("", fetcher, Math.random, "sk-or-test");

    const result = await jev.shouldSpeak(
        observeGame(game, player.id),
        player.memory,
        [],
        0,
    );

    expect(result.source).toBe("jev");
    expect(requests).toEqual([
        {
            url: "https://openrouter.ai/api/alpha/decisions",
            key: "Bearer sk-or-test",
            model: "~typesafe/jev-latest",
        },
    ]);
});

test("rejected TypeSafe key falls back to OpenRouter for the game", async () => {
    const urls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
        urls.push(String(input));
        if (urls.at(-1) === "https://api.typesafe.ai/v1/systemone")
            return Response.json({ error: "invalid key" }, { status: 401 });
        return Response.json({
            answers: { speak: { type: "choice", choice: "SILENT", confidence: 0.9 } },
        });
    };
    const game = createGame({ playerCount: 4 }, 7);
    const player = game.players[0];
    if (!player) throw new Error("Expected player");
    const jev = new JevClient("invalid", fetcher, Math.random, "sk-or-test");

    await jev.shouldSpeak(observeGame(game, player.id), player.memory, [], 0);
    await jev.shouldSpeak(observeGame(game, player.id), player.memory, [], 0);

    expect(urls).toEqual([
        "https://api.typesafe.ai/v1/systemone",
        "https://openrouter.ai/api/alpha/decisions",
        "https://openrouter.ai/api/alpha/decisions",
    ]);
});
