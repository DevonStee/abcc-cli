import { loadSpec, preparePlan, SpecError } from "@abcc/publish-core";
import { log } from "../lib/prompt";

/** 本地校验（按新建规则）：只读 devices_v2.json，不做远端写入。更新需对照线上版本，请用 abcc update --dry-run。 */
export async function runValidate(dirs: string[]) {
    let failed = 0;
    for (const dir of dirs) {
        try {
            const plan = await preparePlan(loadSpec(dir));
            if (plan.problems.length === 0) {
                log(`✓ ${dir}`);
            } else {
                failed += 1;
                log(`✗ ${dir}`);
                for (const problem of plan.problems) log(`  - ${problem}`);
            }
        } catch (error) {
            failed += 1;
            log(`✗ ${dir}`);
            log(error instanceof SpecError ? error.message : `  - ${(error as Error).message}`);
        }
    }
    return failed;
}
