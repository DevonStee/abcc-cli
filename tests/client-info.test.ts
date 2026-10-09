import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cliClientInfo } from "@abcc/publish-core/client-info";

const ABCC_DIR = join(import.meta.dir, "..", "vendor", "AstroBoxCreatorConsole");

describe("cliClientInfo", () => {
  test("version 标明所用的 ABCC 版本，与 GUI 写入 client.version 的来源一致", () => {
    const { version: abccVersion } = JSON.parse(
      readFileSync(join(ABCC_DIR, "src-tauri", "tauri.conf.json"), "utf8"),
    ) as { version: string };
    const { version: cliVersion } = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "packages", "publish-core", "package.json"), "utf8"),
    ) as { version: string };
    expect(cliClientInfo().version).toBe(`abcc-cli@${cliVersion} (ABCC ${abccVersion})`);
  });

  test("build_user 带上子模块里 ABCC 代码的提交", () => {
    expect(cliClientInfo().build_user).toMatch(/^abcc-cli, ABCC [0-9a-f]{7,}(-dirty)?$/);
  });

  test("四个字段都是非空字符串（上游解析器要求）", () => {
    for (const value of Object.values(cliClientInfo())) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
