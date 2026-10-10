/**
 * 更新已上架资源：与 GUI 从「已发布资源」进入编辑、再「更新仓库 → 提交 PR」相同的产出。
 *
 * - 基准是目录（index_v2.csv）里已上线的那一版 manifest；换包的设备 versionCode
 *   必须大于线上，不够大时把新版本写进包体（见 version.ts），而不是只改 manifest。
 * - 资源仓库沿用原仓库，commit message 为 `update: <名称>`（upsertManifestAndAssets）。
 * - 该资源已有自己开着的 PR 时，在原 PR 分支上更新提交明细（GUI 的 in_progress 模式）；
 *   否则新建 `[ABCC] Update resource: <名称>`，request.json 为 mode=edit。
 * - 新版本选项（清空评分 / 折叠评论）记在进度文件里，重跑时没带参数也沿用上次的选择，
 *   每次推送新 commit 都按这份选择重新登记；要撤销用 clearVersionOptions。
 * - abcc.json 没写到的线上设备会从 manifest 移除，必须用 allowRemove 明确同意。
 */
import type { RepoEnvId } from "~/config/repoEnv";
import { registerVersionResetIntent } from "~/api/astrobox/resource";
import { listSellerResourceFileKeys } from "~/api/astrobox/order";
import { loadDeviceOptions } from "~/logic/devices/catalog";
import { MAIN_RESOURCE_BRANCH, toMainResourceRepo } from "~/logic/publish/branch";
import { fetchCatalogEntries, type CatalogEntry } from "~/logic/publish/catalog";
import { syncBranchWithUpstream } from "~/logic/publish/fork";
import {
    ensureMainResourceBranch,
    getBranchHead,
    setRepoHomepage,
    setRepoTopics,
} from "~/logic/publish/github-actions";
import { fetchManifestForCatalogEntry } from "~/logic/publish/manifest-loader";
import { getRepoTopicsForResourceType } from "~/logic/publish/resource-type";
import { buildInProgressEditContextFromPr } from "~/logic/publish/resources";
import {
    createSubmissionBranch,
    createSubmissionPullRequest,
    findOpenSubmissionForResourceId,
    updateSubmissionEntryOnBranch,
} from "~/logic/publish/staging-submission";
import { encryptedDownloadDevices } from "~/logic/publish/validation";
import { buildPlanManifest, effectivePaidType, selectedDevices, type PublishedBaseline } from "./plan";
import {
    applyWatchfaceId,
    commitUploads,
    contentFingerprint,
    describePackages,
    encryptAssets,
    assertPaidMappings,
    ensurePaidProtection,
    preparePlan,
    prepareUploads,
    reportCryptoInfo,
    requireAccounts,
    type Logger,
} from "./pipeline";
import { pricingDevices, type LoadedSpec } from "./spec";
import {
    loadPendingKeys,
    loadUpdateState,
    savePendingKeys,
    saveUpdateState,
    type UpdateState,
} from "./state";

export interface UpdateOptions {
    env: RepoEnvId;
    dryRun: boolean;
    log: Logger;
    /** 新版本上线后清空资源评分。不传则沿用本次更新上一次运行的选择。 */
    resetRatings?: boolean;
    /** 新版本上线后折叠既往的全部评论。不传则沿用本次更新上一次运行的选择。 */
    foldComments?: boolean;
    /** 撤销已选的清空评分 / 折叠评论。 */
    clearVersionOptions?: boolean;
    /** 允许把 abcc.json 没写到的线上设备从 manifest 移除。 */
    allowRemove?: boolean;
}

interface VersionOptions {
    resetRatings: boolean;
    foldComments: boolean;
}

/** 本次运行要登记的新版本选项：命令行指定的优先，否则沿用进度文件里的。 */
function resolveVersionOptions(options: UpdateOptions, saved: UpdateState | null): VersionOptions {
    if (options.clearVersionOptions) return { resetRatings: false, foldComments: false };
    return {
        resetRatings: options.resetRatings ?? saved?.versionOptions?.resetRatings ?? false,
        foldComments: options.foldComments ?? saved?.versionOptions?.foldComments ?? false,
    };
}

export interface UpdateResult {
    id: string;
    prUrl?: string;
    dryRun: boolean;
}

/** 正在进行中的、属于当前用户的提交 PR（GUI 的 in_progress 编辑上下文）。 */
interface OpenSubmission {
    prNumber: number;
    prUrl: string;
    head: { owner: string; repo: string; ref: string };
    submission: NonNullable<Awaited<ReturnType<typeof buildInProgressEditContextFromPr>>["submission"]>;
}

async function loadBaseline(entry: CatalogEntry, token: string, log: Logger) {
    const { manifest, repo } = await fetchManifestForCatalogEntry({
        entry,
        token,
        ref: entry.repo_commit_hash || MAIN_RESOURCE_BRANCH,
    });
    // 与 GUI 编辑页一致：旧行是否加密以服务端登记的密钥设备为准。
    const fileKeys = await listSellerResourceFileKeys({ resourceId: entry.id, limit: 500 }).catch(
        (error: unknown) => {
            log(`  （读取已登记的加密设备失败：${(error as Error).message}，沿用的设备按未加密处理）`);
            return [];
        },
    );
    const baseline: PublishedBaseline = {
        downloads: manifest.downloads ?? {},
        ext: manifest.ext ?? {},
        authors: (manifest.item.author ?? []).map((author) => ({
            name: author.name || "",
            bindABAccount: Boolean(author.bindABAccount),
        })),
        links: manifest.links ?? [],
        encryptedDevices: new Set(fileKeys.map((item) => item.deviceId)),
        paidType: entry.paid_type,
    };
    return { baseline, manifest, repo };
}

async function findOwnOpenSubmission(
    token: string,
    id: string,
    login: string,
): Promise<OpenSubmission | null> {
    const open = await findOpenSubmissionForResourceId(token, id);
    if (!open) return null;
    const context = await buildInProgressEditContextFromPr({ prNumber: open.prNumber, token });
    if ((context.authorLogin ?? "").toLowerCase() !== login.toLowerCase()) {
        throw new Error(
            `资源 ${id} 已有他人发起的进行中 PR #${open.prNumber}《${open.prTitle}》，请等其处理完成后再更新。`,
        );
    }
    if (!context.prHead || !context.submission) {
        throw new Error(`PR #${open.prNumber} 缺少分支或提交明细，无法在原 PR 上更新。`);
    }
    if (context.submission.request.mode !== "edit") {
        throw new Error(`PR #${open.prNumber} 不是更新请求（mode=${context.submission.request.mode}），无法在其上更新。`);
    }
    return {
        prNumber: open.prNumber,
        prUrl: context.prUrl || "",
        head: context.prHead,
        submission: context.submission,
    };
}

export async function updateResource(
    loaded: LoadedSpec,
    options: UpdateOptions,
): Promise<UpdateResult> {
    const { env, dryRun, log } = options;
    const { github, astrobox } = requireAccounts();
    const token = github.token;
    const spec = loaded.spec;
    const id = spec.id?.trim();
    if (!id) throw new Error("更新需要 abcc.json 里填写已上架资源的 id。");

    log(`[${spec.name}] ${loaded.dir}`);
    log(`  身份：GitHub ${github.username} / AstroBox ${astrobox.username} / 环境 ${env}`);

    // 1. 线上基准：以远端为准
    const catalog = await fetchCatalogEntries({ token });
    const entry = catalog.entries.find((item) => item.id.trim() === id);
    if (!entry) {
        throw new Error(`目录中没有资源 ${id}。新资源请使用 abcc publish；还在审核中的新资源请等合并后再更新。`);
    }
    if (entry.repo_owner.toLowerCase() !== github.username.toLowerCase()) {
        throw new Error(`资源 ${id} 的仓库属于 ${entry.repo_owner}，不是当前 GitHub 账号 ${github.username}。`);
    }
    const { baseline, repo: baseRepo } = await loadBaseline(entry, token, log);
    log(`  线上版本：${entry.repo_owner}/${entry.repo_name}@${entry.repo_commit_hash}`);

    const plan = await preparePlan(loaded, baseline);
    if (plan.problems.length > 0) {
        throw new Error(`校验未通过：\n${plan.problems.map((p) => `  - ${p}`).join("\n")}`);
    }
    const removed = Object.keys(baseline.downloads).filter(
        (device) => !plan.downloadRows.some((row) => row.platformId === device),
    );
    if (removed.length > 0 && !options.allowRemove) {
        throw new Error(
            `abcc.json 没有写线上已有的设备：${removed.join(", ")}，继续会把它们从线上移除。\n` +
                '  要保留：在 downloads 里加一组 { "devices": [...], "keep": true }（沿用线上包体）或给新包；\n' +
                "  确实要移除：加 --allow-remove 重新运行。",
        );
    }

    const openPr = await findOwnOpenSubmission(token, id, github.username);
    const manifest = buildPlanManifest(plan, id, astrobox.username);
    const devices = selectedDevices(plan, await loadDeviceOptions());
    const encryptedDevices = encryptedDownloadDevices(
        plan.downloadRows.map((row) => ({
            platformId: row.platformId,
            version: row.version,
            file: null,
            encryptOnUpload: row.encryptOnUpload,
        })),
    );
    const title = `[ABCC] Update resource: ${spec.name}`;
    const keyScope = `${id}-update`;
    const saved = loadUpdateState(loaded.dir);
    const sameCycle =
        saved && saved.env === env && saved.id === id && saved.baseCommit === entry.repo_commit_hash ? saved : null;
    const versionOptions = resolveVersionOptions(options, sameCycle);

    if (dryRun) {
        log(`  仓库：${baseRepo.owner}/${baseRepo.name}（沿用）`);
        describePackages(plan, log);
        if (removed.length > 0) log(`  将从 manifest 移除的设备（--allow-remove）：${removed.join(", ")}`);
        if (spec.pricing) {
            log(`  爱发电映射：${spec.pricing.afdian.length} 条链接 → ${pricingDevices(spec).join(", ")}`);
        } else if (encryptedDevices.length > 0 && !spec.allowFreeEncryption) {
            // abcc.json 没写购买链接时，加密设备靠服务端已有的付费映射保护；只读查询，预演就能发现缺失。
            await assertPaidMappings(id, encryptedDevices);
            log(`  付费映射：服务端已配置（${encryptedDevices.join(", ")}）`);
        }
        log(
            openPr
                ? `  PR：在进行中的 PR #${openPr.prNumber} 上更新提交明细（${openPr.prUrl}）`
                : `  PR 标题：${title}`,
        );
        log(
            `  新版本选项：清空评分 ${versionOptions.resetRatings ? "是" : "否"}，折叠评论 ${versionOptions.foldComments ? "是" : "否"}` +
                (options.resetRatings === undefined && options.foldComments === undefined && sameCycle?.versionOptions
                    ? "（沿用上次运行的选择）"
                    : ""),
        );
        log("  manifest_v2.json：");
        log(manifest.manifestJson.split("\n").map((line) => `    ${line}`).join("\n"));
        log("  （dry-run：未做任何远端写入）");
        return { id, dryRun: true };
    }

    // 2. 本地进度：基准变了（上一版已合并）或环境不同就作废
    const current: UpdateState = sameCycle ?? { version: 1, env, id, baseCommit: entry.repo_commit_hash };
    // 先记下本次的新版本选项，中途失败后重跑不带参数也不会丢
    current.versionOptions = { ...versionOptions, registeredCommit: current.versionOptions?.registeredCommit };
    const repo = toMainResourceRepo({
        owner: baseRepo.owner,
        name: baseRepo.name,
        branch: MAIN_RESOURCE_BRANCH,
    });
    await ensureMainResourceBranch(repo, token);
    if (current.repoCommit) {
        // 资源仓库被别处（GUI）推过新提交，本地记录的 commit 不再是 HEAD，重新提交。
        const head = await getBranchHead(repo, token);
        if (head.commitSha !== current.repoCommit) {
            log("  资源仓库 HEAD 与本地记录不一致（可能在 GUI 中改过），重新提交");
            current.repoCommit = undefined;
            current.contentFingerprint = undefined;
            current.cryptoReported = [];
        }
    }
    saveUpdateState(loaded.dir, current);

    // 3. 付费保护：先于更新仓库（与 GUI 在「更新仓库」前的检查一致）
    const fingerprint = contentFingerprint(manifest, plan);
    const needsCommit = !current.repoCommit || current.contentFingerprint !== fingerprint;
    if (needsCommit) {
        await ensurePaidProtection({
            plan,
            id,
            encryptedDevices,
            pricingSaved: Boolean(current.pricingSaved),
            onPricingSaved: () => {
                current.pricingSaved = true;
                saveUpdateState(loaded.dir, current);
            },
            log,
        });
    }

    // 4. 更新资源仓库（单次提交）
    if (needsCommit) {
        try {
            await setRepoTopics(repo, getRepoTopicsForResourceType("watchface"), token);
        } catch {
            log("  （设置仓库 topics 失败，不影响更新）");
        }
        try {
            const homepage = `https://abox.run/open?source=resv2&id=${encodeURIComponent(id)}&provider=OfficialV2`;
            await setRepoHomepage(repo, homepage, token);
        } catch {
            log("  （设置仓库 homepage 失败，不影响更新）");
        }
        await applyWatchfaceId(manifest.downloadAssets, id, log);
        const keys = await encryptAssets(manifest, loadPendingKeys(env, keyScope), log);
        if (keys.length > 0) savePendingKeys(env, keyScope, keys);

        const uploads = await prepareUploads(manifest);
        const commitSha = await commitUploads(repo, uploads, `update: ${spec.name}`, token, log);
        current.repoCommit = commitSha;
        current.contentFingerprint = fingerprint;
        current.cryptoReported = [];
        saveUpdateState(loaded.dir, current);
        log(`  已提交 ${commitSha.slice(0, 7)}`);
    } else {
        log(`  沿用已提交的 ${current.repoCommit!.slice(0, 7)}`);
    }
    const commitSha = current.repoCommit!;

    // 5. 上报新包体的加密信息
    await reportCryptoInfo({
        env,
        keyScope,
        id,
        repo,
        commitSha,
        reported: new Set(current.cryptoReported ?? []),
        onReported: (reported) => {
            current.cryptoReported = reported;
            saveUpdateState(loaded.dir, current);
        },
        log,
    });

    // 6. PR
    const paidType = effectivePaidType(spec, baseline);
    if (current.submittedCommit !== commitSha) {
        if (openPr) {
            log(`  同步 PR #${openPr.prNumber} 分支并更新提交明细...`);
            await syncBranchWithUpstream({
                token,
                forkOwner: openPr.head.owner,
                forkRepo: openPr.head.repo,
                targetBranch: openPr.head.ref,
            });
            const catalogEntry: CatalogEntry = {
                id,
                name: spec.name,
                restype: "watchface",
                repo_owner: repo.owner,
                repo_name: repo.name,
                repo_commit_hash: commitSha.slice(0, 7),
                icon: manifest.iconPath,
                cover: manifest.coverPath,
                tags: plan.tags.join(";"),
                device_vendors: Array.from(
                    new Set(devices.map((device) => device.vendor).filter(Boolean)),
                ).join(";"),
                devices: Array.from(new Set(devices.map((device) => device.id))).join(";"),
                paid_type: paidType.trim(),
            };
            await updateSubmissionEntryOnBranch({
                token,
                owner: openPr.head.owner,
                repo: openPr.head.repo,
                branch: openPr.head.ref,
                entry: catalogEntry,
                request: openPr.submission.request,
                submissionPath: openPr.submission.path,
            });
            current.pr = { number: openPr.prNumber, url: openPr.prUrl };
        } else {
            log("  创建提交分支（fork + 同步 + 建分支）...");
            const branch = await createSubmissionBranch({
                repoInfo: { ...repo, commitSha },
                iconPath: manifest.iconPath,
                coverPath: manifest.coverPath,
                tags: plan.tags,
                devices,
                itemId: id,
                itemName: spec.name,
                restype: "watchface",
                paidType,
                intent: { mode: "edit", originalId: entry.id },
            });
            const pr = await createSubmissionPullRequest({
                forkOwner: branch.forkOwner,
                forkRepo: branch.forkRepo,
                branch: branch.branch,
                token,
                title,
                body: spec.prBody.trim() || undefined,
            });
            current.pr = { number: pr.number, url: pr.html_url };
        }
        current.submittedCommit = commitSha;
        saveUpdateState(loaded.dir, current);
    }

    // 7. 新版本选项：绑定这次会上线的 commit；commit 或选择变了才重新登记，失败不影响已提交的 PR
    const optionsGiven =
        options.clearVersionOptions || options.resetRatings !== undefined || options.foldComments !== undefined;
    if (current.versionOptions.registeredCommit !== commitSha || optionsGiven) {
        try {
            await registerVersionResetIntent({ id, commitSha, ...versionOptions });
            current.versionOptions = { ...versionOptions, registeredCommit: commitSha };
            saveUpdateState(loaded.dir, current);
            log(
                `  新版本选项：清空评分 ${versionOptions.resetRatings ? "是" : "否"}，折叠评论 ${versionOptions.foldComments ? "是" : "否"}`,
            );
        } catch (error) {
            log(`  （登记新版本选项失败：${(error as Error).message}。PR 已提交，重新运行即可重试）`);
        }
    }

    log(`  PR：${current.pr?.url ?? "-"}`);
    return { id, prUrl: current.pr?.url, dryRun: false };
}
