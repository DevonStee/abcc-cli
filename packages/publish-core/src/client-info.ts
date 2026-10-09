/**
 * abcc CLI 写进 request.json 的 client 信息，让审核方知道这是 CLI 提交的，
 * 以及它用的是哪一版 ABCC 的发布规则（CLI 直接复用 ABCC 的代码）。
 *
 * - version：`abcc-cli@<CLI 版本> (ABCC <版本>)`，ABCC 版本取自子模块的
 *   tauri.conf.json，与 GUI 写入 client.version 的来源相同。
 * - git_commit_hash / build_time：CLI 代码的提交与提交时间（CLI 从源码运行，没有单独的构建）。
 * - build_user：`abcc-cli, ABCC <子模块提交>`，精确到所用的那份 ABCC 代码。
 * 工作区有未提交改动时 hash 带 -dirty。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubmissionClientInfo } from "~/logic/publish/submission-protocol";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ABCC_DIR = join(PACKAGE_DIR, "..", "..", "vendor", "AstroBoxCreatorConsole");

function git(cwd: string, args: string[]): string {
    try {
        return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return "";
    }
}

function readVersion(file: string): string | undefined {
    try {
        const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
        return typeof version === "string" && version.trim() ? version.trim() : undefined;
    } catch {
        return undefined;
    }
}

/** 短提交哈希，工作区有未提交改动时带 -dirty；不在 git 仓库里返回 undefined。 */
function commitOf(dir: string): string | undefined {
    const hash = git(dir, ["rev-parse", "--short", "HEAD"]);
    if (!hash) return undefined;
    return git(dir, ["status", "--porcelain"]) ? `${hash}-dirty` : hash;
}

export function cliClientInfo(): SubmissionClientInfo {
    const cliVersion = readVersion(join(PACKAGE_DIR, "package.json")) ?? "unknown";
    const abccVersion = readVersion(join(ABCC_DIR, "src-tauri", "tauri.conf.json"));
    const abccCommit = commitOf(ABCC_DIR);
    return {
        version: `abcc-cli@${cliVersion}${abccVersion ? ` (ABCC ${abccVersion})` : ""}`,
        git_commit_hash: commitOf(PACKAGE_DIR) ?? "unknown",
        build_time: git(PACKAGE_DIR, ["log", "-1", "--format=%cI"]) || "unknown",
        build_user: abccCommit ? `abcc-cli, ABCC ${abccCommit}` : "abcc-cli",
    };
}
