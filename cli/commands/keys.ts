import { planKeyPrune, pruneKeys, requireAccounts } from "@abcc/publish-core";
import { confirm, log } from "../lib/prompt";
import { parseEnv, prepareSession } from "../lib/session";

/** abcc keys prune [资源ID...]：清理已被替换的加密密钥记录，默认只列出。 */
export async function runKeys(args: string[], flags: { env?: string; yes?: boolean }) {
    const [action, ...ids] = args;
    if (action !== "prune") throw new Error("用法：abcc keys prune [资源ID...] [--env official] [--yes]");
    const env = parseEnv(flags.env);
    // 先只读列出，删除另行确认，所以这里不需要身份确认
    await prepareSession({ env, dryRun: true, yes: true, action: "清理密钥", count: ids.length });
    const { github } = requireAccounts();

    log(`环境 ${env}，按此刻的线上版本核对${ids.length > 0 ? ` ${ids.join(", ")}` : "全部资源"}...`);
    const plans = await planKeyPrune({ token: github.token, login: github.username, ids });
    let total = 0;
    for (const plan of plans) {
        if (plan.skipped) {
            log(`  ${plan.name.padEnd(18)} 跳过：${plan.skipped}`);
        } else if (plan.stale.length > 0) {
            const devices = new Map<string, number>();
            for (const key of plan.stale) devices.set(key.deviceId, (devices.get(key.deviceId) ?? 0) + 1);
            log(
                `  ${plan.name.padEnd(18)} 可删 ${plan.stale.length} 条，保留 ${plan.kept} 条（` +
                    Array.from(devices, ([device, count]) => `${device} ${count}`).join("、") +
                    "）",
            );
            total += plan.stale.length;
        }
    }
    if (total === 0) {
        log("没有需要清理的旧记录。");
        return 0;
    }
    log(`合计可删 ${total} 条。只删与线上密文不一致的记录，每台设备当前在用的那条一定保留；删除后不能恢复。`);
    if (!flags.yes) {
        const ok = process.stdin.isTTY ? await confirm("现在删除？") : false;
        if (!ok) {
            log("未删除。确认后加 --yes 重新运行。");
            return 0;
        }
    }
    const targets = plans.filter((plan) => plan.stale.length > 0).map((plan) => plan.id);
    const deleted = await pruneKeys({ token: github.token, login: github.username, ids: targets, log });
    log(`已删除 ${deleted} 条。`);
    return 0;
}
