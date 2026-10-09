/**
 * 包体版本：以包体内部为准，manifest 里的 version / versionCode 只是它的转写。
 *
 * 更新已上架资源时，客户端靠 versionCode 判断有没有新版本，所以新包的
 * versionCode 必须大于线上同设备的上一版（GUI 的 rowsWithNonIncrementedVersionCode
 * 会直接拦下）。GUI 让创作者在 VersionEditorDialog 里改版本，改的是包体本身
 * （writePackageVersion），再从改写后的包体重新读出版本；CLI 做同样的事：
 *
 * - abcc.json 指定了 version（大版本由创作者决定，如 2.0.0）→ 写进包体；
 * - 没指定、包体版本已经大于线上 → 原样使用；
 * - 没指定、包体版本不大于线上 → 在线上版本的末位 +1（1.0.1 → 1.0.2）写进包体。
 *
 * 小米表盘版本是三个 0–255 的字节，versionCode = major<<16 | minor<<8 | patch。
 */
import {
    readPackageVersion,
    writePackageVersion,
    xiaomiVersionCodeFromVersion,
    type PackageVersionInfo,
} from "~/logic/publish/package-version";

export interface PublishedVersion {
    version?: string;
    versionCode?: number;
}

export interface VersionTarget {
    version: string;
    versionCode: number;
}

export type VersionDecision =
    /** 包体版本可直接使用。 */
    | { kind: "keep"; target: VersionTarget }
    /** 需要把 target 写进包体。 */
    | { kind: "rewrite"; from: VersionTarget; target: VersionTarget; reason: "requested" | "auto-increment" }
    | { kind: "error"; message: string };

const MAX_PART = 255;

export function versionFromCode(code: number): string {
    return `${(code >>> 16) & 0xff}.${(code >>> 8) & 0xff}.${code & 0xff}`;
}

/** 线上一版的 versionCode；旧 manifest 缺 versionCode 时按 version 推算。 */
export function publishedVersionCode(previous: PublishedVersion | undefined): number | undefined {
    if (!previous) return undefined;
    if (typeof previous.versionCode === "number" && Number.isFinite(previous.versionCode)) {
        return Math.trunc(previous.versionCode);
    }
    return previous.version ? xiaomiVersionCodeFromVersion(previous.version) : undefined;
}

/**
 * 决定一个包体最终使用的版本。
 *
 * @param current   从包体读出的版本
 * @param previous  共用这个包体的各设备在线上的上一版（新增设备没有）
 * @param requested abcc.json 中显式指定的版本
 */
export function decidePackageVersion(input: {
    current: VersionTarget;
    previous: PublishedVersion[];
    requested?: string;
}): VersionDecision {
    const { current, requested } = input;
    const codes = input.previous
        .map(publishedVersionCode)
        .filter((code): code is number => code !== undefined);
    const floor = codes.length > 0 ? Math.max(...codes) : undefined;
    const floorLabel = floor !== undefined ? `${versionFromCode(floor)}（versionCode ${floor}）` : "";

    if (requested !== undefined) {
        const code = xiaomiVersionCodeFromVersion(requested);
        const parts = requested.trim().split(".").map(Number);
        if (code === undefined || parts.some((part) => part > MAX_PART)) {
            return { kind: "error", message: `version「${requested}」不是合法的小米表盘版本（a.b.c，每段 0–255）` };
        }
        if (floor !== undefined && code <= floor) {
            return {
                kind: "error",
                message: `指定的 version ${requested}（versionCode ${code}）必须大于线上的 ${floorLabel}`,
            };
        }
        const target = { version: versionFromCode(code), versionCode: code };
        return code === current.versionCode
            ? { kind: "keep", target }
            : { kind: "rewrite", from: current, target, reason: "requested" };
    }

    if (floor === undefined || current.versionCode > floor) {
        return { kind: "keep", target: current };
    }

    if ((floor & 0xff) >= MAX_PART) {
        return {
            kind: "error",
            message: `线上已是 ${floorLabel}，末位到顶无法自动 +1，请在 abcc.json 该组写明更大的 version（如 ${
                ((floor >>> 16) & 0xff) + 1
            }.0.0）`,
        };
    }
    const next = floor + 1;
    return {
        kind: "rewrite",
        from: current,
        target: { version: versionFromCode(next), versionCode: next },
        reason: "auto-increment",
    };
}

/**
 * 把版本写进包体，并从改写后的包体重新读出来核对（与 VersionEditorDialog 相同）。
 * 返回改写后的文件与读回的版本信息，原文件不动。
 */
export async function rewritePackageVersion(
    file: File,
    target: VersionTarget,
): Promise<{ file: File; info: PackageVersionInfo }> {
    const updated = await writePackageVersion(file, target);
    const info = await readPackageVersion(updated);
    if (!info.readable || info.versionCode !== target.versionCode || info.version !== target.version) {
        throw new Error(
            `${file.name} 写入版本 ${target.version} 后读回 ${info.version ?? "-"}（versionCode ${
                info.versionCode ?? "-"
            }），与目标不一致${info.reason ? `：${info.reason}` : ""}`,
        );
    }
    return { file: updated, info };
}
