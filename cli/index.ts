#!/usr/bin/env bun
/**
 * abcc：用命令行发布 / 更新 AstroBox 表盘资源，产出与 ABCC GUI 发布页一致。
 *
 * 命令层只做参数解析与交互；发布与更新流程在 packages/publish-core（@abcc/publish-core）。
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { PACKAGE_SPEC_TEXT } from "@abcc/publish-core";
import { runAuth } from "./commands/auth";
import { runKeys } from "./commands/keys";
import { runPublish } from "./commands/publish";
import { runStatus } from "./commands/status";
import { runUpdate } from "./commands/update";
import { runValidate } from "./commands/validate";
import { log } from "./lib/prompt";
import { installRuntime } from "./lib/runtime";

const USAGE = `用法：
  abcc auth login github                 GitHub 设备码登录（与 ABCC 同一个 OAuth App）
  abcc auth login astrobox [--password]  AstroBox 登录（默认浏览器登录，回调 localhost:6767）
  abcc auth status                       查看当前登录身份
  abcc auth logout <github|astrobox>     退出登录
  abcc spec                              打印提交包规范（abcc.json）
  abcc validate <目录...>                本地校验，不做任何远端写入
  abcc publish <目录...> [选项]          发布新资源（每个目录一个 PR）
  abcc update <目录...> [选项]           更新已上架资源（新版本）
      --env testenv|official             目标环境，默认 testenv
      --dry-run                          只预演，打印 manifest，不做远端写入
      --yes                              跳过身份确认
      --reset-ratings                    （update）新版本上线后清空资源评分
      --fold-comments                    （update）新版本上线后折叠既往评论
                                         （两项选过后重跑不带也会沿用，直到这次更新合并）
      --clear-version-options            （update）撤销已选的清空评分 / 折叠评论
      --allow-remove                     （update）允许移除 abcc.json 没写到的线上设备
  abcc status <目录...>                  查看各资源的 PR 审核状态
  abcc keys prune [资源ID...] [--yes]    清理已被替换的加密密钥记录（默认只列出；--env 同上）
`;

async function main() {
    installRuntime();
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            env: { type: "string" },
            "dry-run": { type: "boolean" },
            yes: { type: "boolean" },
            password: { type: "boolean" },
            "reset-ratings": { type: "boolean" },
            "fold-comments": { type: "boolean" },
            "clear-version-options": { type: "boolean" },
            "allow-remove": { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [command, ...rest] = positionals;
    if (!command || values.help) {
        log(USAGE);
        return 0;
    }
    const dirs = rest.map((dir) => resolve(dir));
    const requireDirs = () => {
        if (dirs.length === 0) throw new Error(USAGE);
    };
    switch (command) {
        case "auth":
            await runAuth(rest, values);
            return 0;
        case "spec":
            log(PACKAGE_SPEC_TEXT);
            return 0;
        case "validate":
            requireDirs();
            return (await runValidate(dirs)) > 0 ? 1 : 0;
        case "publish":
            requireDirs();
            return (await runPublish(dirs, values)) > 0 ? 1 : 0;
        case "update":
            requireDirs();
            return (await runUpdate(dirs, values)) > 0 ? 1 : 0;
        case "keys":
            return runKeys(rest, values);
        case "status":
            requireDirs();
            await runStatus(dirs);
            return 0;
        default:
            throw new Error(USAGE);
    }
}

main().then(
    (code) => process.exit(code),
    (error) => {
        console.error((error as Error).message || String(error));
        process.exit(1);
    },
);
