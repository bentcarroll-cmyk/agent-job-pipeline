import { loadRuntimeConfig } from "./candidate";
import { parseInstanceConfig } from "./instance";
import type { InstanceConfig, RuntimeConfig } from "./types";
export type ConfigBindings = {
    CANDIDATE_CONFIG: string;
    INSTANCE_CONFIG: string;
};
export async function configureEnv<T extends ConfigBindings>(env: T): Promise<T & {
    runtime: RuntimeConfig;
    instance: InstanceConfig;
    SHADOW_MODE: string;
    LIFECYCLE_MODE: string;
    RADAR_MODE: string;
    AI_GATEWAY_ID: string;
    SLACK_ALLOWED_USER_ID: string;
}> {
    if (typeof env.CANDIDATE_CONFIG !== "string" || typeof env.INSTANCE_CONFIG !== "string")
        throw new Error("CANDIDATE_CONFIG and INSTANCE_CONFIG bindings are required");
    const instance = parseInstanceConfig(JSON.parse(env.INSTANCE_CONFIG));
    const runtime = await loadRuntimeConfig(await decodeCandidateBinding(env.CANDIDATE_CONFIG));
    const lifecycleMode = (env as T & {
        LIFECYCLE_MODE?: string;
    }).LIFECYCLE_MODE;
    return Object.assign({}, env, { runtime, instance,
        CLOUDFLARE_ACCOUNT_ID: instance.cloudflare.accountId,
        AI_GATEWAY_ID: instance.cloudflare.gatewayId,
        SLACK_CHANNEL_ID: instance.slack.channelId,
        SLACK_ALLOWED_USER_ID: instance.slack.allowedUserId,
        SCREENING_MODE: instance.screeningMode,
        MANUAL_SCREENING_MODE: instance.manualScreeningMode,
        SHADOW_MODE: String(instance.shadowMode),
        LIFECYCLE_MODE: !instance.lifecycle.enabled || lifecycleMode === "off" ? "off" : (instance.shadowMode || lifecycleMode !== "live" ? "test" : "live"),
        RADAR_MODE: instance.radar.enabled ? "on" : "off",
        RADAR_CHANNEL_ID: instance.radar.channelId ?? "",
        RADAR_MONTHLY_BUDGET_USD: String(instance.radar.monthlyBudgetUsd),
    });
}
/** Bounded lossless transport only. Schema and approval validation always run after decode. */
export async function decodeCandidateBinding(value: string): Promise<unknown> {
    try {
        if (new TextEncoder().encode(value).length > 5120)
            throw new Error();
        if (!value.startsWith("gzip:"))
            return JSON.parse(value);
        const encoded = value.slice(5);
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
            throw new Error();
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                length += next.value.byteLength;
                if (length > 256 * 1024)
                    throw new Error();
                chunks.push(next.value);
            }
        }
        finally {
            await reader.cancel();
        }
        const decoded = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            decoded.set(chunk, offset);
            offset += chunk.length;
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decoded));
    }
    catch {
        throw new Error("INVALID_CANDIDATE_BINDING");
    }
}
