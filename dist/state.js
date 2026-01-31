"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadState = loadState;
exports.saveState = saveState;
const fs_1 = require("fs");
const DEFAULT_STATE = {
    lastSeenJobId: null,
};
async function fileExists(path) {
    try {
        await fs_1.promises.access(path);
        return true;
    }
    catch {
        return false;
    }
}
async function loadState(path) {
    if (!(await fileExists(path))) {
        await saveState(path, DEFAULT_STATE);
        return { ...DEFAULT_STATE };
    }
    try {
        const raw = await fs_1.promises.readFile(path, "utf-8");
        const parsed = JSON.parse(raw);
        return {
            lastSeenJobId: typeof parsed.lastSeenJobId === "string" ? parsed.lastSeenJobId : null,
        };
    }
    catch {
        await saveState(path, DEFAULT_STATE);
        return { ...DEFAULT_STATE };
    }
}
async function saveState(path, state) {
    const payload = JSON.stringify(state, null, 2);
    await fs_1.promises.writeFile(path, `${payload}\n`, "utf-8");
}
