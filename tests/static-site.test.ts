import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticSite } from "@/static-site";

test("serves the built site and its assets from one origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-site-"));
    try {
        mkdirSync(join(root, "assets"));
        writeFileSync(join(root, "index.html"), "<h1>Jev Among Us</h1>");
        writeFileSync(join(root, "assets", "app.js"), "console.log('ready')");

        const page = await serveStaticSite(new Request("https://game.test/"), root);
        expect(page.status).toBe(200);
        expect(page.headers.get("Content-Type")).toContain("text/html");
        expect(await page.text()).toContain("Jev Among Us");

        const asset = await serveStaticSite(
            new Request("https://game.test/assets/app.js"),
            root,
        );
        expect(asset.status).toBe(200);
        expect(asset.headers.get("Cache-Control")).toContain("immutable");

        const traversal = await serveStaticSite(
            new Request("https://game.test/%2Fetc/passwd"),
            root,
        );
        expect(traversal.status).toBe(404);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
