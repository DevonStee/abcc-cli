/**
 * 新建发布与更新共用的步骤：付费映射、写入表盘 ID、加密、单次提交、上报密钥。
 *
 * GUI 的 uploadManifestAndAssets / upsertManifestAndAssets 把这些步骤和 Tauri 加密
 * 合在一个函数里，CLI 无法调用 Tauri，也需要在中间保存密钥以便续跑，所以这里用
 * app 导出的同一批底层函数按同样的顺序重新编排；提交内容（路径、manifest、
 * commit message）与 GUI 保持一致。
 */
import { PUBLISH_CONFIG } from "~/config/publish";
import type { RepoEnvId } from "~/config/repoEnv";
import { submitResourceCryptoInfo } from "~/api/astrobox/resource";
import {
    listSellerPlatformConfigs,
    upsertResourceProduct,
    upsertResourceSku,
} from "~/api/astrobox/order";
import { loadAccountState } from "~/logic/account/store";
import { loadDeviceOptions } from "~/logic/devices/catalog";
import { parseAfdUrl } from "~/logic/publish/afdian-url";
import { MAIN_RESOURCE_BRANCH } from "~/logic/publish/branch";
import {
    createBlob,
    createCommit,
    createTree,
    ensureBase64,
    getBranchHead,
    getRepoFile,
    isGithubStatus,
    updateRef,
    type GitBlobRef,
    type RepoInfo,
} from "~/logic/publish/github-actions";
import type { AssetDescriptor, ManifestBuildResult } from "~/logic/publish/manifest";
import { readPackageVersion } from "~/logic/publish/package-version";
import { checkUnpaidEncryption } from "~/logic/publish/unpaid-encryption";
import { replaceWatchfaceIdInPackage } from "~/logic/publish/watchface-id";
import { encryptAes256Ecb, generateKeyBase64, sha256Hex } from "./crypto";
import { buildPlan, checkDevices, type PublishedBaseline, type ResourcePlan } from "./plan";
import { pricingDevices, type LoadedSpec } from "./spec";
import { clearPendingKeys, loadPendingKeys, type PendingKey } from "./state";

export type Logger = (line: string) => void;

export function requireAccounts() {
    const state = loadAccountState();
    const github = state.github;
    const astrobox = state.astrobox;
    if (!github?.token || !github.username) {
        throw new Error("未登录 GitHub，请先运行 abcc auth login github");
    }
    if (!astrobox?.token || !astrobox.username) {
        throw new Error("未登录 AstroBox，请先运行 abcc auth login astrobox");
    }
    return { github, astrobox };
}

// ---- 校验 ----

export async function preparePlan(
    loaded: LoadedSpec,
    baseline?: PublishedBaseline,
): Promise<ResourcePlan> {
    const plan = await buildPlan(loaded, baseline);
    const options = await loadDeviceOptions();
    plan.problems.push(...checkDevices(plan, options));
    if (plan.loaded.spec.pricing) {
        plan.loaded.spec.pricing.afdian.forEach((url, index) => {
            const parsed = parseAfdUrl(url);
            if (!parsed.productId || parsed.skuIds.length === 0) {
                plan.problems.push(
                    `pricing.afdian[${index}] 解析不出商品 ID（plan_id）和 SKU（sku_id），请复制爱发电的完整购买链接`,
                );
            }
        });
    }
    return plan;
}

// ---- 付费映射 ----

export async function savePricing(plan: ResourcePlan, id: string, log: Logger) {
    const pricing = plan.loaded.spec.pricing;
    if (!pricing) return;

    const platforms = await listSellerPlatformConfigs();
    if (!platforms.some((platform) => platform.platform === "afd" && platform.enabled)) {
        throw new Error(
            "账号还没有启用爱发电平台。请先在 ABCC「资源加解密与激活」页面完成一次性配置。",
        );
    }

    const rows = pricing.afdian.flatMap((url) => {
        const parsed = parseAfdUrl(url);
        return parsed.skuIds.map((skuId) => ({
            productId: parsed.productId!,
            skuId,
            buyUrl: url,
        }));
    });

    const products = new Map<string, string>();
    for (const row of rows) {
        if (!products.has(row.productId)) products.set(row.productId, row.buyUrl);
    }
    for (const [externalProductId, buyUrl] of products) {
        await upsertResourceProduct({
            resourceId: id,
            platform: "afd",
            externalProductId,
            buyUrl,
            enabled: true,
        });
    }

    // 与 EncryptConfigDialog 的 saveRowsForDevice 相同：每台设备逐条 upsert，
    // sortOrder 即顺序，第一条启用的映射是客户端里唯一的购买入口。
    for (const deviceId of pricingDevices(plan.loaded.spec)) {
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            await upsertResourceSku({
                resourceId: id,
                platform: "afd",
                externalProductId: row.productId,
                externalSkuId: row.skuId,
                deviceId,
                buyUrl: row.buyUrl,
                isPaid: true,
                enabled: true,
                sortOrder: index,
            });
        }
        log(`  已保存爱发电映射：${deviceId}（${rows.length} 条）`);
    }
}

// ---- 仓库上传 ----

export interface PreparedUpload {
    path: string;
    base64: string;
    size: number;
}

export async function findOwnResourceManifest(token: string, owner: string, repoName: string) {
    for (const file of [PUBLISH_CONFIG.manifestFileName, "manifest.json"]) {
        try {
            await getRepoFile({
                repo: { owner, name: repoName, branch: MAIN_RESOURCE_BRANCH },
                path: file,
                tokenOverride: token,
                ref: MAIN_RESOURCE_BRANCH,
            });
            return file;
        } catch (error) {
            if (isGithubStatus(error, 404, 409)) continue;
            throw error;
        }
    }
    return null;
}

/** 与 GUI applyWatchfaceId 相同：按路径改写一次，包内 ID 已一致则原样上传。 */
export async function applyWatchfaceId(assets: AssetDescriptor[], id: string, log: Logger) {
    const byPath = new Map<string, File>();
    for (const asset of assets) {
        if (asset.skipUpload) continue;
        let updated = byPath.get(asset.path);
        if (!updated) {
            const info = await readPackageVersion(asset.file);
            if (info.identity === id) {
                updated = asset.file;
            } else {
                log(`  写入表盘 ID ${id}：${asset.path}`);
                updated = await replaceWatchfaceIdInPackage(asset.file, id);
            }
            byPath.set(asset.path, updated);
        }
        asset.file = updated;
    }
}

/**
 * 加密：同一路径只加密一次，所有共用该路径的设备共用密文与密钥。
 * 密钥沿用上次未上报完的那份（同一明文 + 同一密钥 = 同一密文），否则新生成。
 */
export async function encryptAssets(
    manifest: ManifestBuildResult,
    previousKeys: PendingKey[],
    log: Logger,
): Promise<PendingKey[]> {
    const byPath = new Map<string, { key: PendingKey; file: File }>();
    for (const asset of manifest.downloadAssets) {
        if (asset.skipUpload || !asset.encryptOnUpload) continue;
        const existing = byPath.get(asset.path);
        if (existing) {
            // 共用路径的设备共用同一份密文与密钥
            existing.key.devices.push(asset.platformId);
            asset.file = existing.file;
            continue;
        }
        const plain = new Uint8Array(await asset.file.arrayBuffer());
        const keyBase64 =
            previousKeys.find((key) => key.path === asset.path)?.keyBase64 ?? generateKeyBase64();
        const cipher = encryptAes256Ecb(plain, keyBase64);
        if (cipher.byteLength === 0) {
            throw new Error(`${asset.path} 加密失败：输出为空，原始文件不会上传。`);
        }
        const file = new File([cipher as BlobPart], asset.file.name, { type: "application/octet-stream" });
        byPath.set(asset.path, {
            key: { path: asset.path, keyBase64, hash: sha256Hex(cipher), devices: [asset.platformId] },
            file,
        });
        asset.file = file;
        log(`  已加密 ${asset.path}：${plain.byteLength} → ${cipher.byteLength} 字节`);
    }
    return Array.from(byPath.values(), (entry) => entry.key);
}

export async function prepareUploads(manifest: ManifestBuildResult): Promise<PreparedUpload[]> {
    const uploads: PreparedUpload[] = [];
    const taken = new Set<string>();
    const add = async (asset: AssetDescriptor | undefined) => {
        if (!asset || asset.skipUpload || taken.has(asset.path)) return;
        const buffer = await asset.file.arrayBuffer();
        if (buffer.byteLength === 0) {
            throw new Error(`文件 ${asset.path} 内容为空，拒绝上传空文件。`);
        }
        taken.add(asset.path);
        uploads.push({ path: asset.path, base64: ensureBase64(buffer), size: buffer.byteLength });
    };
    // 顺序与 GUI 相同：预览图、图标、封面、manifest、包体
    for (const asset of manifest.previewAssets) await add(asset);
    await add(manifest.iconAsset);
    await add(manifest.coverAsset);
    uploads.push({
        path: PUBLISH_CONFIG.manifestFileName,
        base64: ensureBase64(manifest.manifestJson),
        size: new TextEncoder().encode(manifest.manifestJson).byteLength,
    });
    for (const asset of manifest.downloadAssets) await add(asset);
    return uploads;
}

/** 单个 commit 提交全部文件（Git Data API），与 GUI batchUploadGitData 相同。 */
export async function commitUploads(
    repo: RepoInfo,
    uploads: PreparedUpload[],
    message: string,
    token: string,
    log: Logger,
): Promise<string> {
    const head = await getBranchHead(repo, token);
    // GitHub 要求写请求避免高并发，与 GUI 一样限制为 2
    const CONCURRENCY = 2;
    const refs: GitBlobRef[] = new Array(uploads.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (true) {
            const index = next++;
            if (index >= uploads.length) return;
            const sha = await createBlob(repo, uploads[index].base64, token);
            refs[index] = { sha, path: uploads[index].path, mode: "100644", type: "blob" };
            done += 1;
            log(`  上传 ${done}/${uploads.length}：${uploads[index].path}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uploads.length) }, worker));
    const tree = await createTree(repo, head.treeSha, refs, token);
    const commit = await createCommit(repo, message, tree, head.commitSha, token);
    await updateRef(repo, commit, token);
    return commit;
}

/** 本地内容指纹：manifest 与全部上传文件。文件变了就不能沿用旧 commit。 */
export function contentFingerprint(manifest: ManifestBuildResult, plan: ResourcePlan): string {
    const parts = [manifest.manifestJson, ...plan.packages.map((pkg) => pkg.hash)];
    return sha256Hex(new TextEncoder().encode(parts.join("\n")));
}

/**
 * 加密设备的付费保护：先保存 abcc.json 里的爱发电映射，再用 GUI 同一个
 * checkUnpaidEncryption 复核。没有付费 SKU 的加密设备，服务端会把密钥当免费资源发放。
 */
export async function ensurePaidProtection(params: {
    plan: ResourcePlan;
    id: string;
    encryptedDevices: string[];
    pricingSaved: boolean;
    onPricingSaved: () => void;
    log: Logger;
}) {
    const { plan, id, encryptedDevices, log } = params;
    const spec = plan.loaded.spec;
    if (spec.pricing && !params.pricingSaved) {
        log("  保存爱发电映射...");
        try {
            await savePricing(plan, id, log);
        } catch (error) {
            const message = (error as Error).message || String(error);
            if (/Resource not found/i.test(message) && encryptedDevices.length > 0) {
                throw new Error(
                    "服务端暂不接受该资源 ID 的付费映射（Resource not found）。加密资源在没有付费映射时上报密钥会被当作免费资源，已中止。",
                );
            }
            throw error;
        }
        params.onPricingSaved();
    }
    if (encryptedDevices.length === 0) return;
    if (spec.allowFreeEncryption) {
        log("  加密但免费（allowFreeEncryption）：密钥将向所有 AstroBox 用户免费发放");
        return;
    }
    await assertPaidMappings(id, encryptedDevices);
}

/**
 * 用 GUI 同一个 checkUnpaidEncryption 复核加密设备在服务端都有付费映射。
 * 只读查询，预演也可以调用。
 */
export async function assertPaidMappings(id: string, encryptedDevices: string[]) {
    const check = await checkUnpaidEncryption(id, encryptedDevices);
    if (check.status !== "ok") {
        throw new Error(
            check.status === "unknown"
                ? `无法确认付费配置（${check.error}），已中止，避免密钥被当作免费资源发放。`
                : `以下加密设备没有付费映射：${check.deviceIds.join(", ")}，已中止。` +
                      "请在 abcc.json 配置 pricing，或在 ABCC「资源加解密与激活」中配置；确属加密但免费请写 allowFreeEncryption。",
        );
    }
}

/** 逐设备上报加密信息，每成功一台就回调一次以便落盘；全部成功后删除本地密钥。 */
export async function reportCryptoInfo(params: {
    env: RepoEnvId;
    keyScope: string;
    id: string;
    repo: { owner: string; name: string };
    commitSha: string;
    reported: Set<string>;
    onReported: (reported: string[]) => void;
    log: Logger;
}) {
    const { env, keyScope, id, repo, commitSha, reported, log } = params;
    const pendingKeys = loadPendingKeys(env, keyScope);
    for (const key of pendingKeys) {
        for (const deviceId of key.devices) {
            if (reported.has(deviceId)) continue;
            await submitResourceCryptoInfo({
                id,
                deviceId,
                hash: key.hash,
                key: key.keyBase64,
                repoOwner: repo.owner,
                repoName: repo.name,
                commitSha,
            });
            reported.add(deviceId);
            params.onReported(Array.from(reported));
            log(`  已上报加密信息：${deviceId}`);
        }
    }
    if (pendingKeys.length > 0) clearPendingKeys(env, keyScope);
}

export function describePackages(plan: ResourcePlan, log: Logger) {
    for (const pkg of plan.packages) {
        const change = pkg.versionChange
            ? `，包体版本 ${pkg.versionChange.from.version} → ${pkg.versionChange.to.version}（${
                  pkg.versionChange.reason === "requested" ? "abcc.json 指定" : "线上末位 +1"
              }，已写入包体）`
            : "";
        const previous = Object.entries(pkg.previous)
            .map(([device, info]) => `${device} ${info.version ?? "-"}/${info.versionCode ?? "-"}`)
            .join("、");
        log(
            `  包体 ${pkg.source} → ${pkg.devices.join(", ")}` +
                `（版本 ${pkg.version}，versionCode ${pkg.versionCode}${pkg.encrypt ? "，加密" : ""}${change}）`,
        );
        if (previous) log(`    线上：${previous}`);
    }
    for (const row of plan.kept) {
        log(`  沿用线上包体 ${row.info.file_name} → ${row.platformId}（版本 ${row.info.version}）`);
    }
}
