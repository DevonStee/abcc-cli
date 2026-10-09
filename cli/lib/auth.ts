/**
 * 登录：与 GUI 同一套账号体系。
 *
 * - GitHub：复用 app/logic/account/github.ts 的 Device Flow（同一个 OAuth App）。
 * - AstroBox：复用 GUI 浏览器版本的 Casdoor 流程——回调到
 *   http://localhost:6767/callback（已在 Casdoor 允许列表中），用同一个
 *   /auth/login 接口换 token。CLI 临时监听 6767 端口接收回调。
 *   也支持 GUI 的账号密码登录（/auth/native/password/login）。
 *
 * logic/account/astrobox.ts 在模块顶层创建 Casdoor SDK（依赖浏览器），不能直接
 * import，所以这里按 SDK 的 getSigninUrl / signin 做了等价实现。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CASDOOR_CONFIG } from "~/config/casdoor";
import { ASTROBOX_SERVER_CONFIG } from "~/config/abserver";
import { GITHUB_OAUTH_CONFIG } from "~/config/github";
import { getSelfUserInfo, nativePasswordLogin } from "~/api/astrobox/auth";
import {
    finalizeGithubLogin,
    pollGithubDeviceSession,
    startGithubDeviceSession,
} from "~/logic/account/github";
import {
    loadAccountState,
    logoutAccount,
    setAstroboxAccount,
    type AccountProvider,
    type AstroboxAccount,
} from "~/logic/account/store";

export const ASTROBOX_CALLBACK_PORT = 6767;
export const ASTROBOX_CALLBACK_PATH = "/callback";
const ASTROBOX_REDIRECT_URI = `http://localhost:${ASTROBOX_CALLBACK_PORT}${ASTROBOX_CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function openInBrowser(url: string) {
    const command =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        spawn(command, args, { stdio: "ignore", detached: true }).unref();
    } catch {
        // 打不开浏览器时用户可以手动复制链接
    }
}

// ---- GitHub ----

export async function loginGithub(log: (line: string) => void) {
    const session = await startGithubDeviceSession();
    log(`在浏览器中打开 ${session.verificationUri}`);
    log(`输入验证码：${session.userCode}`);
    openInBrowser(session.verificationUriComplete || session.verificationUri);
    const payload = await pollGithubDeviceSession(session);
    const missing = GITHUB_OAUTH_CONFIG.scopes.filter(
        (scope) => !payload.scopes.includes(scope),
    );
    if (missing.includes("repo")) {
        throw new Error(`GitHub 授权缺少 repo 权限，无法创建仓库和提交 PR。`);
    }
    const account = await finalizeGithubLogin(payload);
    return account;
}

// ---- AstroBox ----

/** 与 logic/account/astrobox.ts 的 persistAstroboxAccount 保持一致。 */
function toAstroboxAccount(
    profile: Record<string, unknown> | null | undefined,
    token: string,
    refreshToken: string | undefined,
): AstroboxAccount {
    const pick = (...keys: string[]) => {
        for (const key of keys) {
            const value = profile?.[key];
            if (typeof value === "string" && value) return value;
        }
        return "";
    };
    const roles = Array.isArray(profile?.roles)
        ? (profile.roles as unknown[]).filter((role): role is string => typeof role === "string")
        : [];
    return {
        avatar: pick("avatar"),
        name: pick("displayName", "preferred_username", "name"),
        username: pick("username", "preferred_username"),
        plan: pick("vip", "tag"),
        email: pick("email"),
        token,
        refreshToken: refreshToken || "",
        roles,
        activeSocialBan:
            (profile?.activeSocialBan as AstroboxAccount["activeSocialBan"]) ?? null,
    };
}

async function persistAstrobox(token: string, refreshToken: string | undefined) {
    const profile = (await getSelfUserInfo(token)) as Record<string, unknown>;
    const account = toAstroboxAccount(profile, token, refreshToken);
    if (!account.username) {
        throw new Error("登录成功，但读不到 AstroBox 用户名，无法关联作者。");
    }
    setAstroboxAccount(account);
    return account;
}

export function buildCasdoorSigninUrl(state: string): string {
    const scope = (CASDOOR_CONFIG as { scope?: string }).scope ?? "profile";
    return (
        `${CASDOOR_CONFIG.serverUrl.trim()}/login/oauth/authorize` +
        `?client_id=${CASDOOR_CONFIG.clientId}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(ASTROBOX_REDIRECT_URI)}` +
        `&scope=${scope}` +
        `&state=${state}`
    );
}

const CALLBACK_PAGE = (message: string) =>
    `<!doctype html><meta charset="utf-8"><title>ABCC CLI</title>` +
    `<body style="font-family:system-ui;padding:40px">${message}</body>`;

export async function loginAstroboxWithBrowser(log: (line: string) => void) {
    const state = randomBytes(12).toString("hex");

    const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
        let server: ReturnType<typeof Bun.serve> | undefined;
        const timer = setTimeout(() => {
            server?.stop(true);
            reject(new Error("等待 AstroBox 登录回调超时（5 分钟）。"));
        }, LOGIN_TIMEOUT_MS);
        try {
            server = Bun.serve({
                hostname: "localhost",
                port: ASTROBOX_CALLBACK_PORT,
                fetch(request) {
                    const url = new URL(request.url);
                    if (url.pathname !== ASTROBOX_CALLBACK_PATH) {
                        return new Response("Not found", { status: 404 });
                    }
                    const code = url.searchParams.get("code");
                    const returnedState = url.searchParams.get("state");
                    clearTimeout(timer);
                    setTimeout(() => server?.stop(true), 100);
                    if (!code || !returnedState) {
                        reject(new Error("回调缺少 code 或 state 参数。"));
                        return new Response(CALLBACK_PAGE("登录失败：回调缺少参数。"), {
                            headers: { "content-type": "text/html; charset=utf-8" },
                        });
                    }
                    resolve({ code, state: returnedState });
                    return new Response(
                        CALLBACK_PAGE("AstroBox 登录完成，可以关闭此页面回到终端。"),
                        { headers: { "content-type": "text/html; charset=utf-8" } },
                    );
                },
            });
        } catch (error) {
            clearTimeout(timer);
            reject(
                new Error(
                    `无法监听 ${ASTROBOX_CALLBACK_PORT} 端口（可能被 bun run dev 等进程占用），` +
                        `请关闭占用进程后重试：${(error as Error).message}`,
                ),
            );
        }
    });

    const url = buildCasdoorSigninUrl(state);
    log("在浏览器中完成 AstroBox 登录：");
    log(url);
    openInBrowser(url);

    const result = await callback;
    if (result.state !== state) {
        throw new Error("回调的 state 不匹配，已中止登录。");
    }

    // 与 casdoor-js-sdk 的 signin() 相同：POST {server}/auth/login?code=&state=
    const signinPath = CASDOOR_CONFIG.signinPath || "/api/signin";
    const response = await fetch(
        `${ASTROBOX_SERVER_CONFIG.serverUrl}${signinPath}?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(result.state)}`,
        { method: "POST" },
    );
    const data = (await response.json().catch(() => ({}))) as {
        token?: string;
        refreshToken?: string;
        error?: string;
        msg?: string;
    };
    if (!data.token) {
        throw new Error(data.error || data.msg || `换取 token 失败（HTTP ${response.status}）。`);
    }
    return persistAstrobox(data.token, data.refreshToken);
}

export async function loginAstroboxWithPassword(username: string, password: string) {
    const pair = await nativePasswordLogin(username.trim(), password);
    return persistAstrobox(pair.token, pair.refreshToken);
}

/** 用当前 token 拉一次资料，确认登录仍然有效（会触发 app 的自动刷新）。 */
export async function refreshAstroboxProfile() {
    const state = loadAccountState();
    const token = state.astrobox?.token;
    if (!token) return null;
    const profile = (await getSelfUserInfo()) as Record<string, unknown>;
    // getSelfUserInfo 可能刷新了 token，取最新值
    const latest = loadAccountState().astrobox;
    const account = toAstroboxAccount(
        profile,
        latest?.token || token,
        latest?.refreshToken || state.astrobox?.refreshToken,
    );
    setAstroboxAccount(account);
    return account;
}

export function logout(provider: AccountProvider) {
    logoutAccount(provider);
}

export interface IdentitySummary {
    github?: string;
    astrobox?: string;
}

export function currentIdentity(): IdentitySummary {
    const state = loadAccountState();
    return {
        github: state.github?.username || undefined,
        astrobox: state.astrobox?.username || undefined,
    };
}
