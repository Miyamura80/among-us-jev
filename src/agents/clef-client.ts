import type { JevResponse } from "@/agents/jev-client";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const CLEF_OMNI_MODEL = "@cf/cloudflare/clef-omni";

interface DecisionBody {
    state: object | string;
    questions: object;
}

interface WorkersAiEnvelope {
    success?: boolean;
    errors?: { code?: number; message?: string }[];
    result?: JevResponse;
}

/**
 * Cloudflare Workers AI decision client for the Clef family. Clef takes the same
 * state/questions request and returns the same answers shape as Jev, plus up to
 * four embedded images placed before the state.
 */
export class ClefClient {
    readonly model: string;
    private readonly accountId: string;
    private readonly apiToken: string;
    private readonly fetcher: Fetcher;

    constructor(
        accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        apiToken = process.env.CLOUDFLARE_API_KEY ?? "",
        model = CLEF_OMNI_MODEL,
        fetcher: Fetcher = fetch,
    ) {
        this.accountId = accountId;
        this.apiToken = apiToken;
        this.model = model;
        this.fetcher = fetcher;
    }

    get configured(): boolean {
        return this.accountId.length > 0 && this.apiToken.length > 0;
    }

    get endpoint(): string {
        return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
    }

    async decide(
        body: DecisionBody,
        images: Buffer[] = [],
        timeoutMs = 2_500,
    ): Promise<JevResponse> {
        if (!this.configured)
            throw new Error(
                "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY are required",
            );
        if (images.length > 4) throw new Error("Clef accepts at most 4 images");
        const response = await this.fetcher(this.endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                state:
                    typeof body.state === "string"
                        ? body.state
                        : JSON.stringify(body.state),
                questions: body.questions,
                ...(images.length > 0
                    ? {
                          images: images.map(
                              (image) =>
                                  `data:image/png;base64,${image.toString("base64")}`,
                          ),
                      }
                    : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const payload = (await response.json().catch(() => ({}))) as WorkersAiEnvelope &
            Partial<JevResponse>;
        if (!response.ok || payload.success === false) {
            const reason = payload.errors?.[0]?.message ?? "no error message";
            throw new Error(`Workers AI returned ${response.status}: ${reason}`);
        }
        const result = payload.result ?? (payload as JevResponse);
        if (!result.answers) throw new Error("Workers AI returned no answers");
        return result;
    }
}
