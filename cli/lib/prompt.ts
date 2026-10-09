import { createInterface } from "node:readline/promises";

export const log = (line: string) => console.log(line);

export async function confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
    } finally {
        rl.close();
    }
}

/** 隐藏输入的密码读取。 */
export async function readHidden(question: string): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
        const rl = createInterface({ input: stdin });
        const line = await rl[Symbol.asyncIterator]().next();
        rl.close();
        return String(line.value ?? "");
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    return new Promise((resolvePassword, reject) => {
        let value = "";
        const onData = (chunk: Buffer) => {
            for (const char of chunk.toString("utf8")) {
                if (char === "\r" || char === "\n") {
                    cleanup();
                    process.stdout.write("\n");
                    resolvePassword(value);
                    return;
                }
                if (char === "\u0003") {
                    cleanup();
                    reject(new Error("已取消"));
                    return;
                }
                if (char === "\u007f") {
                    value = value.slice(0, -1);
                } else {
                    value += char;
                }
            }
        };
        const cleanup = () => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
        };
        stdin.on("data", onData);
    });
}
