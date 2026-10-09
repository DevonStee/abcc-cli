/**
 * CLI 运行时：让 app/ 下的发布逻辑在 Bun 里原样运行。
 *
 * app 代码里只有两处依赖浏览器存储：账号（logic/account/store.ts）与发布环境
 * （config/repoEnv.ts），二者都在「调用时」检查 window + localStorage。这里提供
 * 一个落盘到配置目录的 localStorage，让它们读写同一份 CLI 凭证。
 *
 * 必须在所有 app 模块加载完成之后再安装：github-actions.ts / account/github.ts
 * 在「加载时」用 window 判断是否走浏览器代理（/github-api/）。加载时 window 不存在，
 * 它们就会直连 api.github.com，这正是 CLI 需要的。入口文件在 main() 里调用
 * installRuntime()，此时静态 import 已全部求值完毕。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliClientInfo, configDir } from "@abcc/publish-core";
import { setClientInfoProvider } from "~/logic/publish/submission-protocol";

/** 落盘的 Storage 实现：整个对象存成一个 JSON 文件，权限 600。 */
export class FileStorage implements Storage {
    private data: Record<string, string>;

    constructor(private readonly file: string) {
        this.data = FileStorage.read(file);
    }

    private static read(file: string): Record<string, string> {
        if (!existsSync(file)) return {};
        try {
            const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
            if (!parsed || typeof parsed !== "object") return {};
            const result: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === "string") result[key] = value;
            }
            return result;
        } catch {
            return {};
        }
    }

    private flush() {
        const dir = this.file.slice(0, this.file.lastIndexOf("/"));
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        // 先写临时文件再改名，避免中途退出留下半个 JSON 把凭证弄坏。
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        renameSync(tmp, this.file);
        chmodSync(this.file, 0o600);
    }

    get length() {
        return Object.keys(this.data).length;
    }

    clear() {
        this.data = {};
        this.flush();
    }

    getItem(key: string): string | null {
        return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    }

    key(index: number): string | null {
        return Object.keys(this.data)[index] ?? null;
    }

    removeItem(key: string) {
        if (!(key in this.data)) return;
        delete this.data[key];
        this.flush();
    }

    setItem(key: string, value: string) {
        this.data[key] = String(value);
        this.flush();
    }
}

let installed = false;

export function installRuntime() {
    if (installed) return;
    installed = true;
    const storage = new FileStorage(join(configDir(), "storage.json"));
    const g = globalThis as Record<string, unknown>;
    // 只提供 app 代码实际用到的最小 window：addEventListener 供 store/repoEnv
    // 订阅 storage 事件（CLI 里不会触发）。
    g.window = {
        addEventListener() {},
        removeEventListener() {},
        location: { origin: "http://localhost:6767" },
    };
    g.localStorage = storage;
    g.sessionStorage = new FileStorage(join(configDir(), "session.json"));
    // request.json 的 client 写 CLI 自己的信息，审核方能区分 CLI 与 GUI 提交
    setClientInfoProvider(cliClientInfo);
}
