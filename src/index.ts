import { createGameServer } from "@/server";

const server = createGameServer();

console.log(`Among Us Jev server listening on http://localhost:${server.port}`);
console.log(
    `Providers: Jev=${process.env.TYPESAFE_API_KEY ? "configured" : "local fallback"}, OpenRouter=${process.env.OPENROUTER_API_KEY ? "configured" : "local fallback"}`,
);
