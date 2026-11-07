/**
 * Replay identical action decisions through Jev and Cloudflare Clef-omni.
 *
 * Arms: jev (text state), clef-text (same request), clef-image (same request
 * plus a rendered PNG of the player's view). Reports legality, agreement with
 * Jev and with the rule-based fallback, latency, and token usage.
 *
 * Usage: bun run scripts/compare-clef.ts [scenarios=30] [seed=1]
 * Env: OPENROUTER_API_KEY or TYPESAFE_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_KEY
 */
import { mkdir, writeFile } from "node:fs/promises";

import { ClefClient } from "@/agents/clef-client";
import { JevClient, type JevResponse, buildActionRequest } from "@/agents/jev-client";
import { fallbackAction } from "@/agents/movement";
import { observationPng } from "@/agents/observation-image";
import { enabledActionIds } from "@/game/action-space";
import { advanceGame, createGame, stepGame } from "@/game/engine";
import { observeGame } from "@/game/observation";
import { activePlan } from "@/game/plan";
import type { GameState, Observation, PlayerState } from "@/game/types";

type Arm = "jev" | "clef-text" | "clef-image";
const ARMS: Arm[] = ["jev", "clef-text", "clef-image"];

interface Scenario {
    id: string;
    observation: Observation;
    player: PlayerState;
}

interface ArmResult {
    choice: string | null;
    confidence: number | null;
    legal: boolean;
    latencyMs: number;
    inputTokens: number | null;
    error: string | null;
}

function mulberry32(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
        value = (value + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function randomWalk(state: GameState, ticks: number, random: () => number): GameState {
    let current = state;
    for (let tick = 0; tick < ticks && current.phase === "action"; tick += 1) {
        for (const player of current.players.filter((candidate) => candidate.alive)) {
            // Walk only (directions 1-8); buttons and reports would end the action phase.
            const moves = enabledActionIds(
                observeGame(current, player.id).actionMask,
            ).filter((actionId) => actionId >= 1 && actionId <= 8);
            const actionId = moves[Math.floor(random() * moves.length)];
            if (actionId !== undefined)
                current = stepGame(current, player.id, actionId).state;
        }
        current = advanceGame(current);
    }
    return current;
}

function pickScenario(
    state: GameState,
    id: number,
    random: () => number,
): Scenario | null {
    if (state.phase !== "action") return null;
    const alive = state.players.filter((player) => player.alive);
    const player = alive[Math.floor(random() * alive.length)];
    if (!player) return null;
    const observation = observeGame(state, player.id);
    if (enabledActionIds(observation.actionMask).length <= 1) return null;
    return { id: `${id}:${player.id}`, observation, player };
}

/** Random-walk games so snapshots cover varied rooms, crowds, and roles. */
function buildScenarios(count: number, seed: number): Scenario[] {
    const random = mulberry32(seed);
    const scenarios: Scenario[] = [];
    for (let game = 0; scenarios.length < count && game < count * 4; game += 1) {
        const start = createGame({ playerCount: 8, impostorCount: 2 }, seed + game);
        const state = randomWalk(start, 10 + Math.floor(random() * 80), random);
        const scenario = pickScenario(state, seed + game, random);
        if (scenario) scenarios.push(scenario);
    }
    return scenarios;
}

async function timed(
    call: () => Promise<JevResponse>,
    legalActions: number[],
): Promise<ArmResult> {
    const startedAt = performance.now();
    try {
        const payload = await call();
        const answer = payload.answers.action;
        return {
            choice: answer?.choice ?? null,
            confidence: answer?.confidence ?? null,
            legal: legalActions.includes(Number(answer?.choice)),
            latencyMs: performance.now() - startedAt,
            inputTokens: payload.usage?.input_tokens ?? null,
            error: answer ? null : "no action answer",
        };
    } catch (error) {
        return {
            choice: null,
            confidence: null,
            legal: false,
            latencyMs: performance.now() - startedAt,
            inputTokens: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function percentile(values: number[], fraction: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return (
        sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ??
        null
    );
}

function rate(hits: number, total: number): string {
    return total === 0 ? "n/a" : `${((hits / total) * 100).toFixed(0)}%`;
}

const scenarioCount = Number(Bun.argv[2] ?? 30);
const seed = Number(Bun.argv[3] ?? 1);
const jev = new JevClient(
    process.env.TYPESAFE_API_KEY ?? "",
    fetch,
    Math.random,
    process.env.OPENROUTER_API_KEY ?? "",
);
const clef = new ClefClient();
if (!jev.configured)
    throw new Error("Set TYPESAFE_API_KEY or OPENROUTER_API_KEY for Jev");
if (!clef.configured)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY");

const scenarios = buildScenarios(scenarioCount, seed);
const rows: {
    scenario: string;
    role: string;
    legalCount: number;
    fallback: number;
    results: Record<Arm, ArmResult>;
}[] = [];

for (const [index, scenario] of scenarios.entries()) {
    const { observation, player } = scenario;
    const plan = player.memory.plan;
    const body = buildActionRequest(
        observation,
        activePlan(plan).goal,
        plan.alternative,
        plan,
    );
    const legalActions = enabledActionIds(observation.actionMask);
    const image = await observationPng(observation);
    // Sequential calls keep the latency numbers comparable across arms.
    const results = {
        jev: await timed(() => jev.decide(body, 10_000), legalActions),
        "clef-text": await timed(() => clef.decide(body, [], 10_000), legalActions),
        "clef-image": await timed(
            () => clef.decide(body, [image], 10_000),
            legalActions,
        ),
    };
    rows.push({
        scenario: scenario.id,
        role: observation.self.role,
        legalCount: legalActions.length,
        fallback: fallbackAction(observation, player),
        results,
    });
    const summary = ARMS.map((arm) => `${arm}=${results[arm].choice ?? "ERR"}`).join(
        " ",
    );
    console.info(`[${index + 1}/${scenarios.length}] ${scenario.id} ${summary}`);
}

const report = ARMS.map((arm) => {
    const ok = rows.filter((row) => row.results[arm].error === null);
    const latencies = ok.map((row) => row.results[arm].latencyMs);
    const tokens = ok
        .map((row) => row.results[arm].inputTokens)
        .filter((value): value is number => value !== null);
    const bothOk = ok.filter((row) => row.results.jev.error === null);
    return {
        arm,
        answered: `${ok.length}/${rows.length}`,
        legal: rate(ok.filter((row) => row.results[arm].legal).length, ok.length),
        agreesWithJev:
            arm === "jev"
                ? "-"
                : rate(
                      bothOk.filter(
                          (row) => row.results[arm].choice === row.results.jev.choice,
                      ).length,
                      bothOk.length,
                  ),
        agreesWithFallback: rate(
            ok.filter((row) => Number(row.results[arm].choice) === row.fallback).length,
            ok.length,
        ),
        p50Ms: percentile(latencies, 0.5)?.toFixed(0) ?? "n/a",
        p90Ms: percentile(latencies, 0.9)?.toFixed(0) ?? "n/a",
        meanInputTokens:
            tokens.length > 0
                ? (
                      tokens.reduce((sum, value) => sum + value, 0) / tokens.length
                  ).toFixed(0)
                : "n/a",
        firstError:
            rows.find((row) => row.results[arm].error)?.results[arm].error ?? null,
    };
});

console.table(report);
await mkdir("reports", { recursive: true });
const outPath = `reports/clef-comparison-${seed}.json`;
await writeFile(outPath, JSON.stringify({ seed, report, rows }, null, 2));
console.info(`Wrote ${outPath}`);
