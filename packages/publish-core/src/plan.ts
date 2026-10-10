/**
 * 把 abcc.json 转换成 GUI 发布页同样的数据结构，再交给 app 里的
 * validatePublish / buildManifest。这里不自己拼 manifest，保证产出与 GUI 一致。
 *
 * 更新已上架资源时，以线上 manifest 为基准（对应 GUI 从目录进入编辑时
 * buildDownloadInputsFromManifest 还原出来的下载行）：沿用的设备保留旧路径与
 * 版本，换包的设备按 version.ts 的规则保证 versionCode 递增。
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseTagText } from "~/logic/publish/composer-utils";
import {
    buildManifest,
    normalizeBundledResources,
    type BasicAuthor,
    type DownloadUploadInput,
    type ManifestBuildResult,
    type ManifestDownloadInfo,
    type ManifestExtObject,
    type ManifestUpdateLogEntry,
    type UploadAssetInput,
} from "~/logic/publish/manifest";
import { computePackageHash, readPackageVersion } from "~/logic/publish/package-version";
import {
    validatePublish,
    validatePushQuality,
    type ValidationUploadItem,
} from "~/logic/publish/validation";
import { validateWatchfaceIdFormat } from "~/logic/publish/watchface-id";
import type { DeviceOption } from "~/logic/devices/catalog";
import { readImageSize } from "./images";
import {
    hasEncryption,
    isPaidType,
    PAID_TYPE_CHOICE_HINT,
    pricingDevices,
    type LoadedSpec,
    type ResourceSpec,
    type SpecDownloadGroup,
} from "./spec";
import {
    decidePackageVersion,
    rewritePackageVersion,
    type PublishedVersion,
    type VersionTarget,
} from "./version";

export interface PlannedImage {
    /** 资源目录内的相对路径（abcc.json 里写的）。 */
    source: string;
    upload: UploadAssetInput;
    validation: ValidationUploadItem;
}

export interface PlannedPackage {
    source: string;
    file: File;
    devices: string[];
    encrypt: boolean;
    version: string;
    versionCode?: number;
    identity?: string;
    hash: string;
    /** 版本被写进了包体（自动末位 +1 或 abcc.json 指定）。 */
    versionChange?: { from: VersionTarget; to: VersionTarget; reason: "requested" | "auto-increment" };
    /** 共用此包的设备在线上的上一版，用于展示。 */
    previous: Record<string, PublishedVersion>;
}

/** 沿用线上包体的设备（abcc.json 中 keep: true 的组）。 */
export interface KeptDownload {
    platformId: string;
    info: ManifestDownloadInfo;
    encrypted: boolean;
}

/** 更新时的线上基准：已合并进目录的那一版 manifest。 */
export interface PublishedBaseline {
    downloads: Record<string, Partial<ManifestDownloadInfo>>;
    ext: ManifestExtObject;
    authors: BasicAuthor[];
    links: Array<{ title?: string; url?: string; icon?: string }>;
    /** 服务端登记过密钥的设备（GUI 同样以此判定旧行是否加密）。 */
    encryptedDevices: Set<string>;
    /** 目录里登记的付费类型（index_v2.csv 的 paid_type）。 */
    paidType?: string;
}

/** 最终提交的付费类型：abcc.json 写了用它，更新时没写就沿用线上（与提交 PR 时一致）。 */
export function effectivePaidType(spec: ResourceSpec, baseline: PublishedBaseline | undefined): string {
    if (spec.specified.paidType || !baseline) return spec.paidType;
    return baseline.paidType?.trim() ?? "";
}

export interface ResourcePlan {
    loaded: LoadedSpec;
    tags: string[];
    icon: PlannedImage;
    cover: PlannedImage;
    previews: PlannedImage[];
    packages: PlannedPackage[];
    kept: KeptDownload[];
    downloadRows: DownloadUploadInput[];
    baseline?: PublishedBaseline;
    enableCreatorFeatures: boolean;
    /** 本地即可判定的问题（不需要网络）。 */
    problems: string[];
}

function mimeFromName(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    return "application/octet-stream";
}

function loadFile(dir: string, relativePath: string): File {
    const bytes = readFileSync(join(dir, relativePath));
    const name = basename(relativePath);
    return new File([bytes], name, { type: mimeFromName(name) });
}

function planImage(dir: string, source: string, problems: string[], label: string): PlannedImage {
    const file = loadFile(dir, source);
    const size = readImageSize(new Uint8Array(readFileSync(join(dir, source))));
    if (!size) problems.push(`${label} 不是可识别的 PNG / JPEG / WebP / GIF 图片：${source}`);
    const upload: UploadAssetInput = { id: source, name: file.name, file };
    return {
        source,
        upload,
        validation: {
            id: source,
            name: file.name,
            file,
            width: size?.width,
            height: size?.height,
        },
    };
}

function normalizeLogs(value: unknown): ManifestUpdateLogEntry[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((log) => ({
            version: String((log as ManifestUpdateLogEntry)?.version ?? "").trim(),
            content: String((log as ManifestUpdateLogEntry)?.content ?? "").trim(),
        }))
        .filter((log) => log.version || log.content);
}

/** 线上日志 + 本次日志；同版本只保留一条（GUI 不允许重复版本）。 */
function mergeUpdateLogs(
    previous: unknown,
    version: string,
    changelog: string | undefined,
): ManifestUpdateLogEntry[] | undefined {
    const logs = normalizeLogs(previous);
    if (changelog) {
        const index = logs.findIndex((log) => log.version === version);
        if (index >= 0) logs[index] = { version, content: changelog };
        else logs.push({ version, content: changelog });
    }
    return logs.length > 0 ? logs : undefined;
}

async function planPackage(
    dir: string,
    group: SpecDownloadGroup,
    baseline: PublishedBaseline | undefined,
    problems: string[],
): Promise<PlannedPackage> {
    let file = loadFile(dir, group.file);
    const info = await readPackageVersion(file);
    const previous: Record<string, PublishedVersion> = {};
    for (const device of group.devices) {
        const entry = baseline?.downloads[device];
        if (entry) previous[device] = { version: entry.version, versionCode: entry.versionCode };
    }
    const planned: PlannedPackage = {
        source: group.file,
        file,
        devices: group.devices,
        encrypt: group.encrypt,
        version: info.version ?? "",
        versionCode: info.versionCode,
        identity: info.identity,
        hash: "",
        previous,
    };
    if (!info.readable || info.versionCode === undefined || !info.version) {
        problems.push(`无法从 ${group.file} 读取版本号${info.reason ? `：${info.reason}` : ""}`);
        planned.hash = await computePackageHash(file);
        return planned;
    }

    const decision = decidePackageVersion({
        current: { version: info.version, versionCode: info.versionCode },
        previous: Object.values(previous),
        requested: group.version,
    });
    if (decision.kind === "error") {
        problems.push(`${group.file}：${decision.message}`);
    } else if (decision.kind === "rewrite") {
        const rewritten = await rewritePackageVersion(file, decision.target);
        file = rewritten.file;
        planned.file = file;
        planned.versionChange = { from: decision.from, to: decision.target, reason: decision.reason };
        planned.version = decision.target.version;
        planned.versionCode = decision.target.versionCode;
        planned.identity = rewritten.info.identity;
    }
    planned.hash = await computePackageHash(file);
    return planned;
}

export async function buildPlan(
    loaded: LoadedSpec,
    baseline?: PublishedBaseline,
): Promise<ResourcePlan> {
    const { dir, spec } = loaded;
    const problems: string[] = [];

    const tags = parseTagText(spec.tags.join(";"));
    const icon = planImage(dir, spec.icon, problems, "icon");
    const cover = planImage(dir, spec.cover, problems, "cover");
    const previews = spec.preview.map((source, index) =>
        planImage(dir, source, problems, `preview[${index}]`),
    );

    // 仓库里图片放在 media/<文件名>：不同文件同名会互相覆盖。
    const mediaNames = new Map<string, string>();
    for (const image of [icon, cover, ...previews]) {
        const existing = mediaNames.get(image.upload.name);
        if (existing && existing !== image.source) {
            problems.push(
                `图片 ${existing} 和 ${image.source} 文件名相同，上传后会互相覆盖，请重命名其中一个`,
            );
        }
        mediaNames.set(image.upload.name, image.source);
    }

    const packages: PlannedPackage[] = [];
    const kept: KeptDownload[] = [];
    for (const [index, group] of spec.downloads.entries()) {
        if (group.keep) {
            if (!baseline) {
                problems.push(`downloads[${index}] 的 keep 只能用于更新已上架的资源`);
                continue;
            }
            for (const device of group.devices) {
                const info = baseline.downloads[device];
                if (!info?.file_name) {
                    problems.push(`downloads[${index}] 设置了 keep，但线上没有 ${device} 的包体`);
                    continue;
                }
                kept.push({
                    platformId: device,
                    info: {
                        version: info.version ?? "",
                        file_name: info.file_name,
                        versionCode: info.versionCode,
                        updatelogs: info.updatelogs,
                    },
                    encrypted: baseline.encryptedDevices.has(device),
                });
            }
            continue;
        }
        packages.push(await planPackage(dir, group, baseline, problems));
    }

    // 同一个包文件被多组引用时，加密设置必须一致：同一路径只会有一份密文。
    const encryptByHash = new Map<string, boolean>();
    for (const pkg of packages) {
        const previous = encryptByHash.get(pkg.hash);
        if (previous !== undefined && previous !== pkg.encrypt) {
            problems.push(`${pkg.source} 被多组引用，但 encrypt 设置不一致`);
        }
        encryptByHash.set(pkg.hash, pkg.encrypt);
    }

    // 每台设备一行，与 GUI 的 DownloadInput 一致；同一文件的行共用 packageHash，
    // buildManifest 据此让它们共用仓库里的同一条路径。
    const changelogBySource = new Map(
        spec.downloads.filter((group) => !group.keep).map((group) => [group.file, group.changelog]),
    );
    const downloadRows: DownloadUploadInput[] = [
        ...packages.flatMap((pkg) =>
            pkg.devices.map((platformId) => ({
                platformId,
                version: pkg.version,
                file: { name: pkg.file.name, file: pkg.file },
                encryptOnUpload: pkg.encrypt,
                versionCode: pkg.versionCode,
                packageHash: pkg.hash,
                updatelogs: mergeUpdateLogs(
                    baseline?.downloads[platformId]?.updatelogs,
                    pkg.version,
                    changelogBySource.get(pkg.source),
                ),
            })),
        ),
        // 与 GUI 编辑页的旧行相同：沿用仓库路径，不重新上传、不重新加密。
        ...kept.map((row) => ({
            platformId: row.platformId,
            version: row.info.version,
            file: {
                name: row.info.file_name.split("/").pop() || row.info.file_name,
                file: new File([], row.info.file_name.split("/").pop() || row.info.file_name),
                pathOverride: row.info.file_name,
                skipUpload: true,
            },
            encryptOnUpload: row.encrypted,
            versionCode: row.info.versionCode,
            updatelogs: mergeUpdateLogs(row.info.updatelogs, row.info.version, undefined),
        })),
    ];

    const enableCreatorFeatures =
        hasEncryption(spec) ||
        spec.pricing !== null ||
        kept.some((row) => row.encrypted) ||
        Boolean(baseline?.ext.enableAstroBoxCreatorFeatures);

    const result = validatePublish({
        // 首次发布时 id 尚未生成，用合法占位值跳过 ID 校验，真实 ID 生成后再校验。
        itemId: spec.id ?? "979800000000",
        itemName: spec.name,
        description: spec.description,
        tags,
        resourceType: "watchface",
        previews: previews.map((image) => image.validation),
        icon: icon.validation,
        cover: cover.validation,
        usePreviewAsCover: false,
        coverPreviewId: null,
        downloads: downloadRows.map((row) => ({
            platformId: row.platformId,
            version: row.version,
            file: row.file ? { name: row.file.name, file: row.file.file } : null,
            encryptOnUpload: row.encryptOnUpload,
        })),
        trialDownloads: [],
        links: plannedLinks(loaded, baseline),
        enableAstroBoxCreatorFeatures: enableCreatorFeatures,
        hasPaidPlatformMapping: spec.pricing ? true : undefined,
    });
    problems.push(...result.errors);
    // GUI 提交 PR 前的推流质量检查（简介、标签数）
    for (const issue of validatePushQuality(spec.description, tags)) {
        if (!problems.includes(issue.message)) problems.push(issue.message);
    }
    if (spec.id) {
        const idError = validateWatchfaceIdFormat(spec.id);
        if (idError && !problems.includes(idError)) problems.push(idError);
    }

    const paidType = effectivePaidType(spec, baseline);
    const paid = isPaidType(paidType);
    // 付费类型（paid / force_paid）由创作者决定：更新付费表盘时也要在 abcc.json 里明确写出。
    if (paid && !spec.specified.paidType) {
        problems.push(`线上是付费表盘（${paidType}）。${PAID_TYPE_CHOICE_HINT}`);
    }
    if (paid && !spec.pricing && !baseline) {
        problems.push(`paidType 为 ${paidType}，但没有配置 pricing（爱发电购买链接）`);
    }
    if (hasEncryption(spec) && !spec.pricing && !spec.allowFreeEncryption && !paid && !baseline) {
        problems.push(
            "有设备开启了加密，但没有配置 pricing。没有付费映射时服务端会把密钥当作免费资源发放，任何人都能下载。" +
                "如果这正是你要的「加密但免费」，请在 abcc.json 中写明 \"allowFreeEncryption\": true",
        );
    }
    // 付费表盘必须加密，否则包体在仓库里是明文，谁都能直接下载安装。
    const encryptedRowDevices = new Set(
        downloadRows.filter((row) => row.encryptOnUpload).map((row) => row.platformId),
    );
    const paidDevices = paid ? downloadRows.map((row) => row.platformId) : pricingDevices(spec);
    const plainPaid = paidDevices.filter((device) => !encryptedRowDevices.has(device));
    if (plainPaid.length > 0) {
        problems.push(`付费表盘必须加密，以下设备未开启 encrypt：${plainPaid.join(", ")}`);
    }
    // 线上已加密的设备，换包后也必须加密，不退回明文。
    const downgraded = packages
        .filter((pkg) => !pkg.encrypt)
        .flatMap((pkg) => pkg.devices)
        .filter((device) => baseline?.encryptedDevices.has(device));
    if (downgraded.length > 0) {
        problems.push(`以下设备线上是加密的，新包也必须加密（不要写 encrypt: false）：${downgraded.join(", ")}`);
    }
    if (spec.pricing && spec.allowFreeEncryption) {
        problems.push("配置了 pricing 时不需要 allowFreeEncryption，请删除其中一个");
    }

    return {
        loaded,
        tags,
        icon,
        cover,
        previews,
        packages,
        kept,
        downloadRows,
        baseline,
        enableCreatorFeatures,
        problems,
    };
}

/** abcc.json 没写 links 时，更新沿用线上的链接（GUI 编辑页同样从旧 manifest 还原）。 */
function plannedLinks(loaded: LoadedSpec, baseline: PublishedBaseline | undefined) {
    if (loaded.spec.specified.links || !baseline) return loaded.spec.links;
    return baseline.links.map((link) => ({
        title: link.title ?? "",
        url: link.url ?? "",
        icon: link.icon ?? "",
    }));
}

/** 设备 ID 校验，需要正式仓库的 devices_v2.json。 */
export function checkDevices(plan: ResourcePlan, options: DeviceOption[]): string[] {
    const known = new Map(options.map((option) => [option.id, option]));
    const problems: string[] = [];
    for (const row of plan.downloadRows) {
        const option = known.get(row.platformId);
        if (!option) {
            problems.push(`未知设备 ID：${row.platformId}`);
        } else if (option.vendor !== "xiaomi") {
            problems.push(`${row.platformId}（${option.name}）不是小米设备，CLI 只发布小米表盘`);
        }
    }
    return problems;
}

export function selectedDevices(plan: ResourcePlan, options: DeviceOption[]) {
    const known = new Map(options.map((option) => [option.id, option]));
    return plan.downloadRows.map((row) => ({
        id: row.platformId,
        vendor: known.get(row.platformId)?.vendor,
    }));
}

export function buildPlanManifest(
    plan: ResourcePlan,
    itemId: string,
    authorName: string,
): ManifestBuildResult {
    const { spec } = plan.loaded;
    const baseline = plan.baseline;
    // 更新时保留线上 ext 里 CLI 不管理的字段（捆绑资源、试用包等），与 GUI 编辑页一致。
    // 结构化字段（开关、试用包、捆绑资源）与 GUI 一样单独传给 buildManifest，否则会被它清掉。
    const ext: ManifestExtObject = baseline ? { ...baseline.ext } : {};
    delete ext.enableAstroBoxCreatorFeatures;
    const bundledResources = normalizeBundledResources(ext.bundledResources);
    delete ext.bundledResources;
    const trialDownloads = ext.trialDownloads ?? {};
    delete ext.trialDownloads;
    const trialRows: DownloadUploadInput[] = Object.entries(trialDownloads)
        .filter(([, info]) => info?.file_name)
        .map(([platformId, info]) => {
            const name = info.file_name.split("/").pop() || info.file_name;
            return {
                platformId,
                version: info.version ?? "",
                file: { name, file: new File([], name), pathOverride: info.file_name, skipUpload: true },
                versionCode: info.versionCode,
                updatelogs: info.updatelogs,
            };
        });
    const authors =
        baseline && baseline.authors.length > 0
            ? baseline.authors
            : [{ name: authorName, bindABAccount: true }];
    return buildManifest({
        itemId,
        itemName: spec.name,
        description: spec.description,
        resourceType: "watchface",
        previews: plan.previews.map((image) => image.upload),
        icon: plan.icon.upload,
        cover: plan.cover.upload,
        usePreviewAsCover: false,
        coverPreviewId: null,
        authors,
        links: plannedLinks(plan.loaded, baseline),
        downloads: plan.downloadRows,
        trialDownloads: trialRows,
        bundledResources,
        ext,
        enableAstroBoxCreatorFeatures: plan.enableCreatorFeatures,
    });
}
