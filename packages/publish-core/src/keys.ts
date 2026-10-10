/**
 * 清理已被替换的加密密钥记录（abcc keys prune）。
 *
 * 每次推送都会给每台设备新登记一条「密文哈希 + 密钥」，服务端不删旧的。
 * App 只用与线上密文哈希一致的那条，其余都是已被覆盖的旧版本。
 *
 * 判定以运行当时的线上状态为准：
 * - 目录（index_v2.csv）里该资源的 commit → manifest → 各设备包体的 SHA-256；
 * - 只删哈希与线上不一致、且该设备当前在用的那条确实存在的记录；
 * - 有进行中 PR 的资源整个跳过：PR 未合并时新上报的密钥还没上线，会被误判为旧记录。
 * 删除前对每个资源重新读取一次线上状态，避免期间有更新合并后误删。
 */
import { deleteSellerResourceFileKey, listSellerResourceFileKeys } from "~/api/astrobox/order";
import { fetchCatalogEntries, type CatalogEntry } from "~/logic/publish/catalog";
import { fetchManifestForCatalogEntry } from "~/logic/publish/manifest-loader";
import { findOpenSubmissionForResourceId } from "~/logic/publish/staging-submission";
import { sha256Hex } from "./crypto";
import type { Logger } from "./pipeline";

export interface StaleKey {
    deviceId: string;
    encryptedFileHash: string;
    createdAt: string;
}

export interface ResourceKeyPlan {
    id: string;
    name: string;
    commit: string;
    /** 当前在用、保留的记录数。 */
    kept: number;
    stale: StaleKey[];
    /** 跳过的原因（有进行中的 PR 等）；有值时 stale 为空。 */
    skipped?: string;
}

/** 读取仓库文件原始字节（contents 接口超过 1MB 不返回内容，需要 raw）。 */
async function fetchRawFile(entry: CatalogEntry, path: string, token: string): Promise<Uint8Array> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.github.com/repos/${entry.repo_owner}/${entry.repo_name}/contents/${encoded}?ref=${encodeURIComponent(entry.repo_commit_hash)}`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw" },
    });
    if (!response.ok) throw new Error(`读取 ${entry.repo_name}/${path} 失败：HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

/** 线上各设备包体的密文哈希（hex）。 */
async function liveHashes(entry: CatalogEntry, token: string): Promise<Record<string, string>> {
    const { manifest } = await fetchManifestForCatalogEntry({ entry, token, ref: entry.repo_commit_hash });
    const byPath = new Map<string, string>();
    const result: Record<string, string> = {};
    for (const [device, info] of Object.entries(manifest.downloads ?? {})) {
        if (!info?.file_name) continue;
        let hash = byPath.get(info.file_name);
        if (!hash) {
            hash = sha256Hex(await fetchRawFile(entry, info.file_name, token));
            byPath.set(info.file_name, hash);
        }
        result[device] = hash;
    }
    return result;
}

async function planResource(entry: CatalogEntry, token: string): Promise<ResourceKeyPlan> {
    const base = { id: entry.id, name: entry.name, commit: entry.repo_commit_hash };
    const keys = await listSellerResourceFileKeys({ resourceId: entry.id, limit: 500 });
    if (keys.length === 0) return { ...base, kept: 0, stale: [] };
    const live = await liveHashes(entry, token);
    const liveKeyDevices = new Set(
        keys.filter((key) => key.encryptedFileHash.toLowerCase() === live[key.deviceId]).map((key) => key.deviceId),
    );
    const stale = keys
        .filter(
            (key) =>
                live[key.deviceId] &&
                liveKeyDevices.has(key.deviceId) &&
                key.encryptedFileHash.toLowerCase() !== live[key.deviceId],
        )
        .map((key) => ({ deviceId: key.deviceId, encryptedFileHash: key.encryptedFileHash, createdAt: key.createdAt }));
    if (stale.length === 0) return { ...base, kept: keys.length, stale };
    // 查进行中的 PR 要遍历上游全部 open PR，只对确有旧记录的资源查
    const open = await findOpenSubmissionForResourceId(token, entry.id);
    if (open) {
        return { ...base, kept: keys.length, stale: [], skipped: `有进行中的 PR #${open.prNumber}，合并后再清理` };
    }
    return { ...base, kept: keys.length - stale.length, stale };
}

/** 当前账号名下资源（或指定 ID）的目录行。 */
async function ownEntries(token: string, login: string, ids: string[]): Promise<CatalogEntry[]> {
    const catalog = await fetchCatalogEntries({ token });
    const own = catalog.entries.filter((entry) => entry.repo_owner.toLowerCase() === login.toLowerCase());
    if (ids.length === 0) return own;
    const missing = ids.filter((id) => !own.some((entry) => entry.id.trim() === id));
    if (missing.length > 0) throw new Error(`目录中没有属于 ${login} 的资源：${missing.join(", ")}`);
    return own.filter((entry) => ids.includes(entry.id.trim()));
}

/** 只读：列出可以删除的旧记录。 */
export async function planKeyPrune(params: { token: string; login: string; ids?: string[] }): Promise<ResourceKeyPlan[]> {
    const plans: ResourceKeyPlan[] = [];
    for (const entry of await ownEntries(params.token, params.login, params.ids ?? [])) {
        plans.push(await planResource(entry, params.token));
    }
    return plans;
}

/**
 * 删除旧记录。每个资源删之前重新读取目录与线上包体，只删此刻仍判定为旧的记录。
 * 返回实际删除的条数。
 */
export async function pruneKeys(params: { token: string; login: string; ids: string[]; log: Logger }): Promise<number> {
    let deleted = 0;
    for (const entry of await ownEntries(params.token, params.login, params.ids)) {
        const plan = await planResource(entry, params.token);
        if (plan.skipped) {
            params.log(`  跳过 ${plan.name}：${plan.skipped}`);
            continue;
        }
        for (const key of plan.stale) {
            await deleteSellerResourceFileKey({
                resourceId: entry.id,
                deviceId: key.deviceId,
                encryptedFileHash: key.encryptedFileHash,
            });
            deleted += 1;
        }
        if (plan.stale.length > 0) params.log(`  ${plan.name}：删除 ${plan.stale.length} 条，保留 ${plan.kept} 条`);
    }
    return deleted;
}
