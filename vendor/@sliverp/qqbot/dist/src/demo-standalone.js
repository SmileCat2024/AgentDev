import { createInterface } from "node:readline";
import { createQQBotAgentAdapter } from "../standalone.js";
import { startGateway } from "../standalone.js";
import { sendText } from "../standalone.js";
function createAccountFromEnv() {
    const appId = process.env.QQBOT_APP_ID || "";
    const clientSecret = process.env.QQBOT_CLIENT_SECRET || "";
    if (!appId || !clientSecret) {
        throw new Error("Missing QQBOT_APP_ID or QQBOT_CLIENT_SECRET");
    }
    return {
        accountId: "default",
        enabled: true,
        appId,
        clientSecret,
        secretSource: "env",
        markdownSupport: process.env.QQBOT_MARKDOWN_SUPPORT !== "false",
        imageServerBaseUrl: process.env.QQBOT_IMAGE_SERVER_BASE_URL,
        config: {
            allowFrom: ["*"],
            markdownSupport: process.env.QQBOT_MARKDOWN_SUPPORT !== "false",
        },
    };
}
async function main() {
    const account = createAccountFromEnv();
    const abortController = new AbortController();
    const agentAdapter = createQQBotAgentAdapter(async (request) => {
        const stamp = new Date(request.timestamp).toLocaleString("zh-CN", { hour12: false });
        console.log("");
        console.log("[inbound]", JSON.stringify({
            when: stamp,
            chatType: request.chatType,
            senderId: request.senderId,
            senderName: request.senderName,
            text: request.text,
            from: request.from,
            attachments: request.attachments,
        }, null, 2));
        if (request.text.trim() === "/help") {
            return [
                "这是一个独立 TS demo，当前机器人已收到你的消息。",
                "电脑控制台支持命令: send <target> <message>",
            ];
        }
        return `回声: ${request.text}`;
    });
    const gatewayPromise = startGateway({
        account,
        cfg: {},
        abortSignal: abortController.signal,
        agentAdapter,
        log: console,
    });
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
    });
    console.log("QQBot standalone demo started.");
    console.log("Commands:");
    console.log("  send <target> <message>");
    console.log("  help");
    console.log("  quit");
    console.log("Target examples:");
    console.log("  32位私聊 openid");
    console.log("  group:<group_openid>");
    console.log("  channel:<channel_id>");
    rl.on("line", async (line) => {
        const input = line.trim();
        if (!input)
            return;
        if (input === "quit" || input === "exit") {
            abortController.abort();
            rl.close();
            return;
        }
        if (input === "help") {
            console.log("send <target> <message>");
            console.log("quit");
            return;
        }
        if (input.startsWith("send ")) {
            const rest = input.slice(5).trim();
            const firstSpace = rest.indexOf(" ");
            if (firstSpace <= 0) {
                console.log("Usage: send <target> <message>");
                return;
            }
            const target = rest.slice(0, firstSpace).trim();
            const message = rest.slice(firstSpace + 1).trim();
            if (!message) {
                console.log("Message cannot be empty.");
                return;
            }
            try {
                const result = await sendText({
                    to: target,
                    text: message,
                    account,
                });
                console.log("[outbound]", JSON.stringify(result, null, 2));
            }
            catch (error) {
                console.error("[outbound-error]", error);
            }
            return;
        }
        console.log("Unknown command. Type help.");
    });
    process.on("SIGINT", () => {
        abortController.abort();
        rl.close();
    });
    try {
        await gatewayPromise;
    }
    finally {
        rl.close();
    }
}
main().catch((error) => {
    console.error("[demo-startup-error]", error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
