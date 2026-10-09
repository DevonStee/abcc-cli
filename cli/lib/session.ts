import { saveRepoEnvId, type RepoEnvId } from "~/config/repoEnv";
import { loadAccountState } from "~/logic/account/store";
import { refreshAstroboxProfile } from "./auth";
import { confirm, log } from "./prompt";

export function parseEnv(value: string | undefined): RepoEnvId {
    if (!value || value === "testenv") return "testenv";
    if (value === "official") return "official";
    throw new Error(`--env 只能是 testenv 或 official：${value}`);
}

/**
 * 切换目标环境、确认两个账号都已登录且 AstroBox 会话仍有效，
 * 非 dry-run 时再让用户确认身份。返回 false 表示用户取消。
 */
export async function prepareSession(params: {
    env: RepoEnvId;
    dryRun: boolean;
    yes: boolean;
    action: string;
    count: number;
}): Promise<boolean> {
    saveRepoEnvId(params.env);
    const state = loadAccountState();
    if (!state.github?.username) throw new Error("未登录 GitHub，请先运行 abcc auth login github");
    if (!state.astrobox?.username) throw new Error("未登录 AstroBox，请先运行 abcc auth login astrobox");
    // 用接口确认 AstroBox 登录仍有效，并拿到最新用户名
    const astrobox = await refreshAstroboxProfile();
    if (params.dryRun || params.yes) return true;
    const ok = await confirm(
        `将以 GitHub ${state.github.username} / AstroBox ${astrobox?.username} 的身份，` +
            `向 ${params.env} 环境${params.action} ${params.count} 个资源，确认？`,
    );
    if (!ok) log("已取消");
    return ok;
}
