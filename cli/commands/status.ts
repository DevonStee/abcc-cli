import { resourceStatus } from "@abcc/publish-core";
import { log } from "../lib/prompt";

export async function runStatus(dirs: string[]) {
    for (const dir of dirs) {
        const status = await resourceStatus(dir);
        log(`${status.stage.padEnd(10)} ${status.id ?? "-"}  ${dir}${status.prUrl ? `  ${status.prUrl}` : ""}`);
        for (const item of status.needFix) log(`    需修改：${item}`);
    }
}
