/**
 * 新建发布：与 GUI「创建发布仓库 → 提交 Pull Request」相同的产出。
 *
 * 顺序与 GUI 一致，并加了两点 CLI 需要的保证：
 * 1. 付费映射先于上传保存，并用 GUI 同一个 checkUnpaidEncryption 复核——
 *    加密设备没有付费 SKU 时，服务端会把密钥当免费资源发放。
 * 2. 每一步写入 .abcc-state.json，密钥在上报成功前落盘保存，失败后可原样续跑。
 */
import { buildRepoName } from "~/config/publish";
import type { RepoEnvId } from "~/config/repoEnv";
import { loadDeviceOptions } from "~/logic/devices/catalog";
import { MAIN_RESOURCE_BRANCH, toMainResourceRepo } from "~/logic/publish/branch";
import { fetchCatalogEntries } from "~/logic/publish/catalog";
import {
    createUserRepo,
    ensureMainResourceBranch,
    setRepoHomepage,
    setRepoTopics,
    type RepoInfo,
} from "~/logic/publish/github-actions";
import { getRepoTopicsForResourceType } from "~/logic/publish/resource-type";
import {
    createSubmissionBranch,
    createSubmissionPullRequest,
} from "~/logic/publish/staging-submission";
import { encryptedDownloadDevices } from "~/logic/publish/validation";
import { generateUniqueWatchfaceId } from "~/logic/publish/watchface-id";
import { buildPlanManifest, selectedDevices } from "./plan";
import {
    applyWatchfaceId,
    commitUploads,
    contentFingerprint,
    describePackages,
    encryptAssets,
    ensurePaidProtection,
    findOwnResourceManifest,
    preparePlan,
    prepareUploads,
    reportCryptoInfo,
    requireAccounts,
    type Logger,
} from "./pipeline";
import { pricingDevices, writeBackId, type LoadedSpec } from "./spec";
import { loadPendingKeys, loadState, saveState, savePendingKeys, type PublishState } from "./state";

export interface PublishOptions {
    env: RepoEnvId;
    dryRun: boolean;
    log: Logger;
}

export interface PublishResult {
    id: string;
    prUrl?: string;
    dryRun: boolean;
}

// ---- 主流程 ----

export async function publishResource(
    loaded: LoadedSpec,
    options: PublishOptions,
): Promise<PublishResult> {
    const { env, dryRun, log } = options;
    const { github, astrobox } = requireAccounts();
    const token = github.token;
    const spec = loaded.spec;

    log(`[${spec.name}] ${loaded.dir}`);
    log(`  身份：GitHub ${github.username} / AstroBox ${astrobox.username} / 环境 ${env}`);

    const plan = await preparePlan(loaded);
    if (plan.problems.length > 0) {
        throw new Error(`校验未通过：\n${plan.problems.map((p) => `  - ${p}`).join("\n")}`);
    }

    // 1. 资源 ID
    let id = spec.id;
    const catalog = await fetchCatalogEntries({ token });
    const state = loadState(loaded.dir);
    if (state && (state.env !== env || (id && state.id !== id))) {
        throw new Error(
            `该目录已有发布记录（环境 ${state.env}，ID ${state.id}），与本次参数不一致。` +
                `如需重新发布，请先删除 ${loaded.dir}/.abcc-state.json`,
        );
    }
    if (!id) {
        id = state?.id ?? null;
    }
    if (!id) {
        // 与 GUI 一致：表盘 ID 去重固定对照正式环境目录
        const officialIds = new Map<string, string>();
        const official = await fetchCatalogEntries({
            token,
            owner: "AstralSightStudios",
            repo: "AstroBox-Repo",
            ref: "main",
        });
        for (const entry of official.entries) officialIds.set(entry.id.trim(), entry.name);
        for (const entry of catalog.entries) officialIds.set(entry.id.trim(), entry.name);
        id = generateUniqueWatchfaceId(officialIds);
        log(`  生成表盘 ID：${id}`);
        if (!dryRun) writeBackId(loaded, id);
    }
    if (!state?.pr) {
        const taken = catalog.entries.find((entry) => entry.id.trim() === id);
        if (taken) {
            throw new Error(`资源 ID ${id} 已在目录中（「${taken.name}」）。更新已上架资源请使用 abcc update。`);
        }
    }

    const manifest = buildPlanManifest(plan, id, astrobox.username);
    const repoName = state?.repo?.name ?? buildRepoName(id);
    const devices = selectedDevices(plan, await loadDeviceOptions());
    const encryptedDevices = encryptedDownloadDevices(
        plan.downloadRows.map((row) => ({
            platformId: row.platformId,
            version: row.version,
            file: null,
            encryptOnUpload: row.encryptOnUpload,
        })),
    );

    if (dryRun) {
        log(`  仓库：${github.username}/${repoName}`);
        describePackages(plan, log);
        if (spec.pricing) {
            log(`  爱发电映射：${spec.pricing.afdian.length} 条链接 → ${pricingDevices(spec).join(", ")}`);
        } else if (spec.allowFreeEncryption && encryptedDevices.length > 0) {
            log("  加密但免费：不配置付费映射，密钥将向所有 AstroBox 用户免费发放");
        }
        log(`  PR 标题：[ABCC] Add new resource: ${spec.name}`);
        log("  manifest_v2.json：");
        log(manifest.manifestJson.split("\n").map((line) => `    ${line}`).join("\n"));
        log("  （dry-run：未做任何远端写入）");
        return { id, dryRun: true };
    }

    const current: PublishState = state ?? {
        version: 1,
        env,
        id,
        githubLogin: github.username,
        astroboxUser: astrobox.username,
    };
    saveState(loaded.dir, current);

    // 2. 付费映射：先于上传，保证加密设备在密钥上报时已受保护
    if (!current.repoCommit) {
        await ensurePaidProtection({
            plan,
            id,
            encryptedDevices,
            pricingSaved: Boolean(current.pricingSaved),
            onPricingSaved: () => {
                current.pricingSaved = true;
                saveState(loaded.dir, current);
            },
            log,
        });
    }

    // 3. 资源仓库 + 单次提交
    const fingerprint = contentFingerprint(manifest, plan);
    let repo: RepoInfo;
    if (current.repoCommit && current.contentFingerprint !== fingerprint && current.pr) {
        throw new Error("本地文件在 PR 提交后发生了变化。修改已提交的资源请走更新流程。");
    }
    if (!current.repoCommit || current.contentFingerprint !== fingerprint) {
        if (!current.repo) {
            const existing = await findOwnResourceManifest(token, github.username, repoName);
            if (existing) {
                throw new Error(
                    `仓库 ${github.username}/${repoName} 已包含 ${existing}，不是本次发布创建的，已中止。`,
                );
            }
        }
        log(`  创建仓库 ${repoName}...`);
        const created = await createUserRepo(repoName, `AstroBox resource of ${spec.name}`, token);
        repo = toMainResourceRepo(created);
        await ensureMainResourceBranch(repo, token);
        current.repo = { owner: repo.owner, name: repo.name, htmlUrl: repo.htmlUrl };
        saveState(loaded.dir, current);

        try {
            await setRepoTopics(repo, getRepoTopicsForResourceType("watchface"), token);
        } catch {
            log("  （设置仓库 topics 失败，不影响发布）");
        }
        try {
            const homepage = `https://abox.run/open?source=resv2&id=${encodeURIComponent(id)}&provider=OfficialV2`;
            await setRepoHomepage(repo, homepage, token);
        } catch {
            log("  （设置仓库 homepage 失败，不影响发布）");
        }

        await applyWatchfaceId(manifest.downloadAssets, id, log);
        const keys = await encryptAssets(manifest, loadPendingKeys(env, id), log);
        if (keys.length > 0) savePendingKeys(env, id, keys);

        const uploads = await prepareUploads(manifest);
        const commitSha = await commitUploads(repo, uploads, `publish: ${spec.name}`, token, log);
        current.repoCommit = commitSha;
        current.contentFingerprint = fingerprint;
        current.cryptoReported = [];
        saveState(loaded.dir, current);
        log(`  已提交 ${commitSha.slice(0, 7)}`);
    } else {
        repo = toMainResourceRepo({
            owner: current.repo!.owner,
            name: current.repo!.name,
            branch: MAIN_RESOURCE_BRANCH,
            htmlUrl: current.repo!.htmlUrl,
        });
        log(`  沿用已提交的 ${current.repoCommit.slice(0, 7)}`);
    }

    // 4. 上报加密信息（逐设备，失败可续跑）
    await reportCryptoInfo({
        env,
        keyScope: id,
        id,
        repo,
        commitSha: current.repoCommit!,
        reported: new Set(current.cryptoReported ?? []),
        onReported: (reported) => {
            current.cryptoReported = reported;
            saveState(loaded.dir, current);
        },
        log,
    });

    // 5. 提交分支 + PR
    if (!current.pr) {
        if (!current.submission) {
            log("  创建提交分支（fork + 同步 + 建分支）...");
            const branch = await createSubmissionBranch({
                repoInfo: { ...repo, commitSha: current.repoCommit! },
                iconPath: manifest.iconPath,
                coverPath: manifest.coverPath,
                tags: plan.tags,
                devices,
                itemId: id,
                itemName: spec.name,
                restype: "watchface",
                paidType: spec.paidType,
                intent: { mode: "create" },
            });
            current.submission = {
                forkOwner: branch.forkOwner,
                forkRepo: branch.forkRepo,
                branch: branch.branch,
                path: branch.submissionPath,
            };
            saveState(loaded.dir, current);
        }
        const pr = await createSubmissionPullRequest({
            forkOwner: current.submission.forkOwner,
            forkRepo: current.submission.forkRepo,
            branch: current.submission.branch,
            token,
            title: `[ABCC] Add new resource: ${spec.name}`,
            body: spec.prBody.trim() || undefined,
        });
        current.pr = { number: pr.number, url: pr.html_url };
        saveState(loaded.dir, current);
    }
    log(`  PR：${current.pr.url}`);
    return { id, prUrl: current.pr.url, dryRun: false };
}
