function normalizeSimpleResult(result) {
    if (result === null || result === undefined) {
        return [];
    }
    if (typeof result === "string") {
        return [{ text: result }];
    }
    if (Array.isArray(result)) {
        return result.flatMap((item) => normalizeSimpleResult(item));
    }
    return [result];
}
export function createQQBotAgentAdapter(handler) {
    return {
        name: "custom",
        async handleMessage(ctx) {
            const result = await handler(ctx.request, {
                account: ctx.account,
                cfg: ctx.cfg,
                abortSignal: ctx.abortSignal,
                log: ctx.log,
            });
            const outputs = normalizeSimpleResult(result);
            for (const output of outputs) {
                await ctx.deliver(output, { kind: "message" });
            }
        },
    };
}
let currentAgentAdapter = null;
export function setQQBotAgentAdapter(adapter) {
    currentAgentAdapter = adapter;
}
export function getQQBotAgentAdapter() {
    return currentAgentAdapter;
}
