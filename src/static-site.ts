import { resolve, sep } from "node:path";

const STATIC_ROOT = resolve(import.meta.dir, "../frontend/dist");

export async function serveStaticSite(
    request: Request,
    root = STATIC_ROOT,
): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD")
        return new Response("Not found", { status: 404 });

    let pathname: string;
    try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
        return new Response("Invalid path", { status: 400 });
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = resolve(root, relativePath);
    if (!filePath.startsWith(`${resolve(root)}${sep}`))
        return new Response("Not found", { status: 404 });

    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });

    return new Response(request.method === "HEAD" ? null : file, {
        headers: {
            "Content-Type": file.type,
            "Cache-Control": relativePath.startsWith("assets/")
                ? "public, max-age=31536000, immutable"
                : "no-cache",
        },
    });
}
