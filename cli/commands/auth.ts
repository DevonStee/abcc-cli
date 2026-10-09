import {
    currentIdentity,
    loginAstroboxWithBrowser,
    loginAstroboxWithPassword,
    loginGithub,
    logout,
    refreshAstroboxProfile,
} from "../lib/auth";
import { log, readHidden } from "../lib/prompt";

export async function runAuth(args: string[], flags: { password?: boolean }) {
    const [action, provider] = args;
    if (action === "login" && provider === "github") {
        const account = await loginGithub(log);
        log(`GitHub 已登录：${account.username}`);
        return;
    }
    if (action === "login" && provider === "astrobox") {
        log("提示：若同一账号只允许一个有效会话，这次登录可能会让 ABCC 应用里的 AstroBox 登录失效。");
        const account = flags.password
            ? await loginAstroboxWithPassword(
                  (await readHidden("用户名：")).trim(),
                  await readHidden("密码："),
              )
            : await loginAstroboxWithBrowser(log);
        log(`AstroBox 已登录：${account.username}`);
        return;
    }
    if (action === "status") {
        const identity = currentIdentity();
        log(`GitHub：${identity.github ?? "未登录"}`);
        if (identity.astrobox) {
            try {
                const account = await refreshAstroboxProfile();
                log(`AstroBox：${account?.username ?? identity.astrobox}`);
            } catch (error) {
                log(`AstroBox：${identity.astrobox}（登录可能已失效：${(error as Error).message}）`);
            }
        } else {
            log("AstroBox：未登录");
        }
        return;
    }
    if (action === "logout" && (provider === "github" || provider === "astrobox")) {
        logout(provider);
        log(`${provider} 已退出`);
        return;
    }
    throw new Error("用法：abcc auth login github|astrobox [--password] | status | logout <github|astrobox>");
}
