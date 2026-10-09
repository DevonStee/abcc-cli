import { loadSpec, publishResource, SpecError } from "@abcc/publish-core";
import { log } from "../lib/prompt";
import { parseEnv, prepareSession } from "../lib/session";

export async function runPublish(
    dirs: string[],
    flags: { env?: string; "dry-run"?: boolean; yes?: boolean },
) {
    const env = parseEnv(flags.env);
    const dryRun = Boolean(flags["dry-run"]);
    const ok = await prepareSession({ env, dryRun, yes: Boolean(flags.yes), action: "发布", count: dirs.length });
    if (!ok) return 0;

    let failed = 0;
    // 串行：fork 同步与建分支不能并发，也避免触发 GitHub 二级限流
    for (const dir of dirs) {
        try {
            await publishResource(loadSpec(dir), { env, dryRun, log });
        } catch (error) {
            failed += 1;
            log(`✗ ${dir}`);
            log(error instanceof SpecError ? error.message : `  ${(error as Error).message}`);
            log("  修正后重新运行同一命令即可从中断处继续。");
        }
    }
    return failed;
}
