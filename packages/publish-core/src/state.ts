/**
 * 发布进度，用于断点续跑。
 *
 * - 进度写在资源目录的 .abcc-state.json，不含任何密钥。
 * - 加密密钥在上报服务端成功之前，临时保存在配置目录（权限 600），
 *   上报全部成功后删除。这样上报失败时可以用同一个密钥补报，
 *   而不是留下「仓库里有密文、服务端没有密钥」的孤儿仓库。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoEnvId } from "~/config/repoEnv";
import { configDir } from "./paths";

export const STATE_FILE_NAME = ".abcc-state.json";

export interface PublishState {
    version: 1;
    env: RepoEnvId;
    id: string;
    githubLogin: string;
    astroboxUser: string;
    pricingSaved?: boolean;
    repo?: { owner: string; name: string; htmlUrl?: string };
    /** 资源仓库的完整 commit sha（上传完成后写入）。 */
    repoCommit?: string;
    /** 本次上传内容的指纹，本地文件变化后不能沿用旧 commit。 */
    contentFingerprint?: string;
    /** 已上报加密信息的设备。 */
    cryptoReported?: string[];
    submission?: { forkOwner: string; forkRepo: string; branch: string; path: string };
    pr?: { number: number; url: string };
    updatedAt?: string;
}

export function statePath(dir: string) {
    return join(dir, STATE_FILE_NAME);
}

export function loadState(dir: string): PublishState | null {
    const path = statePath(dir);
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as PublishState;
        return parsed?.version === 1 ? parsed : null;
    } catch {
        return null;
    }
}

export function saveState(dir: string, state: PublishState) {
    state.updatedAt = new Date().toISOString();
    writeFileSync(statePath(dir), `${JSON.stringify(state, null, 2)}\n`);
}

// ---- 更新进度 ----

export const UPDATE_STATE_FILE_NAME = ".abcc-update-state.json";

/**
 * 一次更新的进度。只是本地缓存：每次运行都先以远端为准（目录里的线上 commit、
 * 资源仓库 HEAD、open PR），对不上就丢弃，不会用旧状态覆盖 GUI 里做过的修改。
 */
export interface UpdateState {
    version: 1;
    env: RepoEnvId;
    id: string;
    /** 本次更新基于的线上 commit（目录 repo_commit_hash）。合并后变化，旧进度作废。 */
    baseCommit: string;
    pricingSaved?: boolean;
    repoCommit?: string;
    contentFingerprint?: string;
    cryptoReported?: string[];
    /** 已把哪个 repoCommit 写进 PR 分支。 */
    submittedCommit?: string;
    /** 新版本选项（清空评分 / 折叠评论）；registeredCommit 为已向服务端登记的 commit。 */
    versionOptions?: { resetRatings: boolean; foldComments: boolean; registeredCommit?: string };
    pr?: { number: number; url: string };
    updatedAt?: string;
}

export function loadUpdateState(dir: string): UpdateState | null {
    const path = join(dir, UPDATE_STATE_FILE_NAME);
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as UpdateState;
        return parsed?.version === 1 ? parsed : null;
    } catch {
        return null;
    }
}

export function saveUpdateState(dir: string, state: UpdateState) {
    state.updatedAt = new Date().toISOString();
    writeFileSync(join(dir, UPDATE_STATE_FILE_NAME), `${JSON.stringify(state, null, 2)}\n`);
}

// ---- 待上报的密钥 ----

export interface PendingKey {
    /** 仓库里的包体路径，同一路径共用一份密文与密钥。 */
    path: string;
    keyBase64: string;
    /** 密文 SHA-256（hex），上报给服务端。 */
    hash: string;
    devices: string[];
}

function keysDir() {
    return join(configDir(), "pending-keys");
}

/** scope：新建用资源 ID，更新用 `<ID>-update`，两者的密钥互不覆盖。 */
function keysFile(env: RepoEnvId, scope: string) {
    return join(keysDir(), `${env}-${scope}.json`);
}

export function loadPendingKeys(env: RepoEnvId, id: string): PendingKey[] {
    const file = keysFile(env, id);
    if (!existsSync(file)) return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as PendingKey[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function savePendingKeys(env: RepoEnvId, id: string, keys: PendingKey[]) {
    const dir = keysDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = keysFile(env, id);
    writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
}

export function clearPendingKeys(env: RepoEnvId, id: string) {
    rmSync(keysFile(env, id), { force: true });
}
