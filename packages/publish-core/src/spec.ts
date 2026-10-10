/**
 * 提交包规范：每个表盘一个目录，目录下一个 abcc.json 描述发布内容。
 *
 * 这里只做结构解析与本地文件存在性检查；业务规则（ID 格式、图片规格、
 * 加密与 creator features 的约束等）统一交给 app/logic/publish/validation.ts，
 * 与 GUI 保持同一套判定。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";

export const SPEC_FILE_NAME = "abcc.json";

/** CLI 只发布小米表盘的 .bin / .face。 */
export const SUPPORTED_PACKAGE_EXTENSIONS = [".bin", ".face"] as const;

export const PAID_TYPES = ["", "free", "paid", "force_paid"] as const;
export type PaidType = (typeof PAID_TYPES)[number];

/** 付费表盘未明确付费类型时的提示，含 GUI「付费类型」的官方说明。 */
export const PAID_TYPE_CHOICE_HINT =
    '付费表盘请在 paidType 中明确选择："paid"（付费：可先体验部分功能，购买后解锁完整功能）' +
    '或 "force_paid"（强制付费：不购买则无法使用）。由创作者决定，不要代选';

export function isPaidType(value: string | undefined): boolean {
    return value === "paid" || value === "force_paid";
}

export interface SpecLink {
    title: string;
    url: string;
    icon: string;
}

export interface SpecDownloadGroup {
    devices: string[];
    /** keep 为 true 时为空：沿用线上已发布的包体。 */
    file: string;
    /** 默认 true；只有 abcc.json 明确写 false 才不加密。 */
    encrypt: boolean;
    /** 仅更新时可用：这组设备沿用线上包体，不上传新包，也不改版本。 */
    keep: boolean;
    /** 显式指定写进包体的版本（a.b.c），用于大版本升级；不填则读包体，更新时不够大会自动末位 +1。 */
    version?: string;
    /** 本次版本的更新日志，追加到这组设备的 updatelogs。 */
    changelog?: string;
}

export interface SpecPricing {
    /** 爱发电购买链接，顺序即 sortOrder，第一条是客户端里的购买入口。 */
    afdian: string[];
    /** 应用到哪些设备；"all" 表示所有下载设备。 */
    devices: "all" | string[];
}

export interface ResourceSpec {
    /** null 表示首次发布时自动生成并回写。 */
    id: string | null;
    name: string;
    description: string;
    tags: string[];
    icon: string;
    cover: string;
    preview: string[];
    links: SpecLink[];
    downloads: SpecDownloadGroup[];
    pricing: SpecPricing | null;
    paidType: PaidType;
    /** 显式声明「加密但免费」：不配付费映射，服务端会向所有用户免费发放密钥。 */
    allowFreeEncryption: boolean;
    prBody: string;
    /** abcc.json 是否写了 links / paidType；更新时没写就沿用线上的值。 */
    specified: { links: boolean; paidType: boolean };
}

export interface LoadedSpec {
    dir: string;
    specPath: string;
    spec: ResourceSpec;
    /** 原始 JSON，回写 id 时保留用户的其它字段与顺序。 */
    raw: Record<string, unknown>;
}

export class SpecError extends Error {
    constructor(
        readonly specPath: string,
        readonly problems: string[],
    ) {
        super(`${specPath}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
        this.name = "SpecError";
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    if (!value.every((item) => typeof item === "string")) return undefined;
    return value.map((item) => item.trim()).filter(Boolean);
}

/** 资源内的相对路径：禁止绝对路径与 ..，避免把目录外的文件传上去。 */
function checkRelativePath(dir: string, path: string, label: string, problems: string[]) {
    if (!path) {
        problems.push(`${label} 不能为空`);
        return;
    }
    if (isAbsolute(path)) {
        problems.push(`${label} 必须是相对于资源目录的路径：${path}`);
        return;
    }
    const rel = relative(dir, join(dir, normalize(path)));
    if (rel.startsWith("..")) {
        problems.push(`${label} 不能指向资源目录之外：${path}`);
        return;
    }
    const full = join(dir, path);
    if (!existsSync(full) || !statSync(full).isFile()) {
        problems.push(`${label} 文件不存在：${path}`);
    }
}

export function parseSpec(dir: string, raw: Record<string, unknown>, specPath: string): ResourceSpec {
    const problems: string[] = [];

    const rawId = raw.id;
    let id: string | null = null;
    if (rawId === null || rawId === undefined || rawId === "") {
        id = null;
    } else if (typeof rawId === "string") {
        id = rawId.trim();
    } else {
        problems.push("id 必须是字符串或 null");
    }

    if ("author" in raw || "authors" in raw) {
        problems.push("不要填写 author：作者由登录的 AstroBox 账号决定");
    }

    const name = asString(raw.name)?.trim() ?? "";
    const description = asString(raw.description) ?? "";
    const tags = asStringArray(raw.tags);
    if (!tags) problems.push("tags 必须是字符串数组");

    const icon = asString(raw.icon)?.trim() ?? "";
    checkRelativePath(dir, icon, "icon", problems);
    const cover = asString(raw.cover)?.trim() ?? "";
    checkRelativePath(dir, cover, "cover", problems);
    const preview = asStringArray(raw.preview);
    if (!preview) {
        problems.push("preview 必须是字符串数组");
    } else {
        preview.forEach((path, index) => checkRelativePath(dir, path, `preview[${index}]`, problems));
    }

    const links: SpecLink[] = [];
    if (raw.links !== undefined) {
        if (!Array.isArray(raw.links)) {
            problems.push("links 必须是数组");
        } else {
            raw.links.forEach((item, index) => {
                const link = (item ?? {}) as Record<string, unknown>;
                links.push({
                    title: asString(link.title)?.trim() ?? "",
                    url: asString(link.url)?.trim() ?? "",
                    icon: asString(link.icon)?.trim() ?? "",
                });
                if (typeof item !== "object" || item === null) {
                    problems.push(`links[${index}] 必须是对象`);
                }
            });
        }
    }

    const downloads: SpecDownloadGroup[] = [];
    if (!Array.isArray(raw.downloads) || raw.downloads.length === 0) {
        problems.push("downloads 至少需要一组 { devices, file }");
    } else {
        const seenDevices = new Map<string, number>();
        raw.downloads.forEach((item, index) => {
            const group = (item ?? {}) as Record<string, unknown>;
            const devices = asStringArray(group.devices) ?? [];
            const file = asString(group.file)?.trim() ?? "";
            // 默认加密：只有明确写 false 才上传明文包。
            const encrypt = group.encrypt !== false;
            const keep = group.keep === true;
            if (group.encrypt !== undefined && typeof group.encrypt !== "boolean") {
                problems.push(`downloads[${index}].encrypt 必须是 true 或 false`);
            }
            if (group.keep !== undefined && typeof group.keep !== "boolean") {
                problems.push(`downloads[${index}].keep 必须是 true 或 false`);
            }
            const version = group.version === undefined ? undefined : asString(group.version)?.trim();
            if (group.version !== undefined && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version ?? "")) {
                problems.push(`downloads[${index}].version 必须是 a.b.c 形式的版本号`);
            }
            const changelog = group.changelog === undefined ? undefined : asString(group.changelog)?.trim();
            if (group.changelog !== undefined && changelog === undefined) {
                problems.push(`downloads[${index}].changelog 必须是字符串`);
            }
            if (devices.length === 0) problems.push(`downloads[${index}].devices 不能为空`);
            for (const device of devices) {
                const previous = seenDevices.get(device);
                if (previous !== undefined) {
                    problems.push(
                        `设备 ${device} 同时出现在 downloads[${previous}] 和 downloads[${index}]，每台设备只能对应一个包`,
                    );
                }
                seenDevices.set(device, index);
            }
            if (keep) {
                if (file || version !== undefined || changelog !== undefined) {
                    problems.push(`downloads[${index}] 设置了 keep，不能再填写 file / version / changelog`);
                }
            } else {
                checkRelativePath(dir, file, `downloads[${index}].file`, problems);
                const lower = file.toLowerCase();
                if (file && !SUPPORTED_PACKAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
                    problems.push(
                        `downloads[${index}].file 只支持 ${SUPPORTED_PACKAGE_EXTENSIONS.join(" / ")}：${file}`,
                    );
                }
            }
            downloads.push({
                devices,
                file,
                encrypt,
                keep,
                ...(version !== undefined ? { version } : {}),
                ...(changelog ? { changelog } : {}),
            });
        });
    }

    let pricing: SpecPricing | null = null;
    if (raw.pricing !== undefined && raw.pricing !== null) {
        const value = raw.pricing as Record<string, unknown>;
        const afdian = asStringArray(value.afdian);
        if (!afdian || afdian.length === 0) {
            problems.push("pricing.afdian 至少需要一条爱发电购买链接");
        }
        let devices: "all" | string[] = "all";
        if (value.devices === undefined || value.devices === "all") {
            devices = "all";
        } else {
            const list = asStringArray(value.devices);
            if (!list || list.length === 0) {
                problems.push('pricing.devices 必须是 "all" 或设备 ID 数组');
            } else {
                const known = new Set(downloads.flatMap((group) => group.devices));
                for (const device of list) {
                    if (!known.has(device)) {
                        problems.push(`pricing.devices 中的 ${device} 不在 downloads 里`);
                    }
                }
                devices = list;
            }
        }
        pricing = { afdian: afdian ?? [], devices };
    }

    const paidTypeRaw = asString(raw.paidType)?.trim() ?? "";
    if (!(PAID_TYPES as readonly string[]).includes(paidTypeRaw)) {
        problems.push(`paidType 只能是 ${PAID_TYPES.filter(Boolean).join(" / ")} 或留空`);
    }

    // 付费类型由创作者决定：配置了付费映射就必须明确选 paid 或 force_paid，不替创作者默认。
    if (pricing && paidTypeRaw !== "paid" && paidTypeRaw !== "force_paid") {
        problems.push(PAID_TYPE_CHOICE_HINT);
    }

    if (raw.allowFreeEncryption !== undefined && typeof raw.allowFreeEncryption !== "boolean") {
        problems.push("allowFreeEncryption 必须是 true 或 false");
    }

    if (problems.length > 0) throw new SpecError(specPath, problems);

    return {
        id,
        name,
        description,
        tags: tags ?? [],
        icon,
        cover,
        preview: preview ?? [],
        links,
        downloads,
        pricing,
        paidType: paidTypeRaw as PaidType,
        allowFreeEncryption: raw.allowFreeEncryption === true,
        prBody: asString(raw.prBody) ?? "",
        specified: { links: raw.links !== undefined, paidType: raw.paidType !== undefined },
    };
}

export function loadSpec(dir: string): LoadedSpec {
    const specPath = join(dir, SPEC_FILE_NAME);
    if (!existsSync(specPath)) {
        throw new SpecError(specPath, [`找不到 ${SPEC_FILE_NAME}`]);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(specPath, "utf8"));
    } catch (error) {
        throw new SpecError(specPath, [`JSON 解析失败：${(error as Error).message}`]);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new SpecError(specPath, ["顶层必须是一个对象"]);
    }
    const record = raw as Record<string, unknown>;
    return { dir, specPath, spec: parseSpec(dir, record, specPath), raw: record };
}

/** 把生成的 id 写回 abcc.json，保证重跑幂等；其余字段原样保留。 */
export function writeBackId(loaded: LoadedSpec, id: string) {
    const next = { ...loaded.raw, id };
    writeFileSync(loaded.specPath, `${JSON.stringify(next, null, 2)}\n`);
    loaded.raw = next;
    loaded.spec = { ...loaded.spec, id };
}

/** 所有下载组展开后的设备列表（去重，保持出现顺序）。 */
export function allDevices(spec: ResourceSpec): string[] {
    return Array.from(new Set(spec.downloads.flatMap((group) => group.devices)));
}

/** pricing 实际作用的设备。 */
export function pricingDevices(spec: ResourceSpec): string[] {
    if (!spec.pricing) return [];
    return spec.pricing.devices === "all" ? allDevices(spec) : spec.pricing.devices;
}

export function hasEncryption(spec: ResourceSpec): boolean {
    return spec.downloads.some((group) => group.encrypt);
}

/** 需要上传新包体的下载组（排除 keep）。 */
export function uploadGroups(spec: ResourceSpec): SpecDownloadGroup[] {
    return spec.downloads.filter((group) => !group.keep);
}
