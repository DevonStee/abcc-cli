import { loadSpec, SpecError, updateResource } from "@abcc/publish-core";
import { log } from "../lib/prompt";
import { parseEnv, prepareSession } from "../lib/session";

export async function runUpdate(
    dirs: string[],
    flags: {
        env?: string;
        "dry-run"?: boolean;
        yes?: boolean;
        "reset-ratings"?: boolean;
        "fold-comments"?: boolean;
        "clear-version-options"?: boolean;
        "allow-remove"?: boolean;
    },
) {
    const env = parseEnv(flags.env);
    const dryRun = Boolean(flags["dry-run"]);
    const ok = await prepareSession({ env, dryRun, yes: Boolean(flags.yes), action: "更新", count: dirs.length });
    if (!ok) return 0;

    let failed = 0;
    for (const dir of dirs) {
        try {
            await updateResource(loadSpec(dir), {
                env,
                dryRun,
                log,
                // 没带参数时传 undefined，沿用本次更新上一次运行的选择
                resetRatings: flags["reset-ratings"] ? true : undefined,
                foldComments: flags["fold-comments"] ? true : undefined,
                clearVersionOptions: Boolean(flags["clear-version-options"]),
                allowRemove: Boolean(flags["allow-remove"]),
            });
        } catch (error) {
            failed += 1;
            log(`✗ ${dir}`);
            log(error instanceof SpecError ? error.message : `  ${(error as Error).message}`);
            log("  修正后重新运行同一命令即可从中断处继续。");
        }
    }
    return failed;
}
