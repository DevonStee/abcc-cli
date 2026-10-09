/**
 * abcc CLI 写进 request.json 的 client 信息，让审核方知道这是 CLI 提交的。
 * 字段含义与 GUI 对齐：version 为客户端版本，git_commit_hash / build_time 为
 * 所用代码的提交与提交时间（CLI 直接从源码运行，没有单独的构建），
 * 工作区有未提交改动时 hash 带 -dirty。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubmissionClientInfo } from "~/logic/publish/submission-protocol";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args: string[]): string {
    try {
        return execFileSync("git", args, { cwd: PACKAGE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return "";
    }
}

export function cliClientInfo(): SubmissionClientInfo {
    const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
    const hash = git(["rev-parse", "--short", "HEAD"]);
    const dirty = git(["status", "--porcelain"]) !== "";
    return {
        version: `abcc-cli@${version}`,
        git_commit_hash: hash ? `${hash}${dirty ? "-dirty" : ""}` : "unknown",
        build_time: git(["log", "-1", "--format=%cI"]) || "unknown",
        build_user: "abcc-cli",
    };
}
