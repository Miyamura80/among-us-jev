import { expect, test } from "bun:test";

import { ClefClient } from "@/agents/clef-client";
import { buildActionRequest } from "@/agents/jev-client";
import { observationPng, observationSvg } from "@/agents/observation-image";
import { createGame } from "@/game/engine";
import { observeGame } from "@/game/observation";

function firstObservation() {
    const game = createGame({ playerCount: 4 }, 7);
    const player = game.players[0];
    if (!player) throw new Error("Expected player");
    return observeGame(game, player.id);
}

test("Clef client sends the Jev request shape plus embedded images to Workers AI", async () => {
    const requests: {
        url: string;
        auth: string | null;
        body: Record<string, unknown>;
    }[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
            url: String(input),
            auth: new Headers(init?.headers).get("Authorization"),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
            success: true,
            result: {
                model: "@cf/cloudflare/clef-omni",
                answers: {
                    action: {
                        type: "choice",
                        choice: "3",
                        confidence: 0.8,
                        probabilities: {},
                    },
                },
            },
        });
    };
    const clef = new ClefClient("acct", "cf-token", undefined, fetcher);
    const observation = firstObservation();
    const body = buildActionRequest(observation, "Reach wires");
    const image = await observationPng(observation);

    const result = await clef.decide(body, [image]);

    expect(result.answers.action?.choice).toBe("3");
    expect(requests[0]?.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-omni",
    );
    expect(requests[0]?.auth).toBe("Bearer cf-token");
    expect(typeof requests[0]?.body.state).toBe("string");
    expect(requests[0]?.body.questions).toEqual(body.questions);
    const images = requests[0]?.body.images as string[];
    expect(images).toHaveLength(1);
    expect(images[0]?.startsWith("data:image/png;base64,")).toBe(true);
});

test("Clef client surfaces Workers AI errors", async () => {
    const fetcher = async () =>
        Response.json(
            {
                success: false,
                errors: [{ code: 10000, message: "Authentication error" }],
            },
            { status: 403 },
        );
    const clef = new ClefClient("acct", "bad", undefined, fetcher);

    await expect(
        clef.decide(buildActionRequest(firstObservation(), "Reach wires")),
    ).rejects.toThrow("Workers AI returned 403: Authentication error");
});

test("observation render marks the observing player", () => {
    expect(observationSvg(firstObservation())).toContain(">YOU<");
});
