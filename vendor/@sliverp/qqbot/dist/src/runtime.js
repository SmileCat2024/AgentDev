let runtime = null;
export function setQQBotRuntime(next) {
    runtime = next;
}
export function hasQQBotRuntime() {
    return runtime !== null;
}
export function tryGetQQBotRuntime() {
    return runtime;
}
export function getQQBotRuntime() {
    if (!runtime) {
        throw new Error("QQBot runtime not initialized");
    }
    return runtime;
}
