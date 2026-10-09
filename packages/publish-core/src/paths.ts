import { homedir } from "node:os";
import { join } from "node:path";

/** 凭证与待上报密钥所在目录，可用 ABCC_CONFIG_DIR 覆盖。 */
export function configDir(): string {
    const override = process.env.ABCC_CONFIG_DIR?.trim();
    return override || join(homedir(), ".config", "abcc");
}
