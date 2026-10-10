# abcc-cli：命令行发布 AstroBox 表盘资源

用命令行完成 [AstroBox CreatorConsole](https://github.com/AstralSightStudios/AstroBoxCreatorConsole)（ABCC）发布页的「创建发布仓库 → 提交 Pull Request」，以及已上架资源的版本更新。生成的资源仓库、`manifest_v2.json`、`tmp/` 提交文件和 PR 与 GUI 完全一致，发布后可在 GUI 的「发布中」「已发布资源」页面查看与编辑。

支持小米表盘（`.bin` / `.face`）的**新建发布**与**更新**。审核打回后回复 `[ABCC_FIXED_*]` 评论仍需在 GUI 中进行。

## 安装

需要 [Bun](https://bun.sh) 1.3+。原项目 ABCC 以 git 子模块的形式放在 `vendor/AstroBoxCreatorConsole`，克隆时要带上：

```bash
git clone --recurse-submodules https://github.com/DevonStee/abcc-cli.git
cd abcc-cli
bun install
```

已经克隆过但没带子模块：`git submodule update --init`。

在任意目录使用，可在 shell 配置里加别名：

```bash
alias abcc='bun /path/to/abcc-cli/cli/index.ts'
```

## 快速开始

```bash
abcc auth login github      # 设备码登录，与 ABCC 同一个 OAuth App
abcc auth login astrobox    # 浏览器登录，回调 http://localhost:6767/callback
abcc spec                   # 查看提交包规范
abcc validate ./faces/*     # 本地校验
abcc publish ./faces/* --dry-run
abcc publish ./faces/*                    # 默认发布到 testenv
abcc publish ./faces/* --env official     # 正式环境
abcc update ./faces/led-wall --dry-run    # 更新已上架资源，先预演
abcc update ./faces/led-wall --env official
abcc status ./faces/*
```

没配别名时，在仓库目录里用 `bun run abcc <命令>`。

AstroBox 登录需要占用 6767 端口，请先关闭本机占用该端口的 ABCC 开发服务（`bun run dev`）。没有设置密码的账号可以用浏览器登录；有密码的账号也可以使用 `--password` 登录。

## 提交包

每个表盘一个目录，目录下放一个 `abcc.json`，完整字段说明见 `abcc spec`。

```json
{
  "id": null,
  "name": "LED Wall",
  "description": "黄色小方格拼成一面灯墙",
  "tags": ["小米", "像素", "LED"],
  "icon": "media/icon.png",
  "cover": "media/cover.png",
  "preview": ["media/preview-1.png"],
  "downloads": [
    { "devices": ["xmb10", "xmb10nfc", "xmb11", "xmb11nfc"], "file": "band.bin", "encrypt": true }
  ],
  "pricing": { "afdian": ["<爱发电购买链接>"], "devices": "all" },
  "paidType": "force_paid"
}
```

- `author` 不需要填写，取自登录的 AstroBox 账号。
- 哪个包对应哪些设备由创作者决定，CLI 只校验设备 ID 是否存在。
- `encrypt` 不写默认加密，只有明确写 `false` 才上传明文包。
- 新建时有加密的组，必须配置 `pricing` 或 `allowFreeEncryption`。CLI 会先保存爱发电映射，并用 GUI 同一套规则复核，确认后才上传、上报密钥。
- 付费表盘必须明确写 `paidType`：`"paid"`（付费：可先体验部分功能，购买后解锁）或 `"force_paid"`（强制付费：不购买无法使用），CLI 不替创作者默认。付费表盘的全部设备都必须加密。
- 「加密但免费」需要显式写 `"allowFreeEncryption": true`：包体在仓库里是密文、只能通过 AstroBox 安装，密钥向所有用户免费发放。

## 更新已上架资源（abcc update）

`abcc.json` 填已上架的 `id`，其余字段描述**更新后**的完整内容。流程与 GUI 从「已发布资源」进入编辑相同：

- **基准是线上版本**：读取目录 `index_v2.csv` 中该资源的 commit 对应的 `manifest_v2.json`。作者、未写的 `links` / `paidType`、ext 中的捆绑资源与试用包、各设备的更新日志都沿用线上。
- **versionCode 必须递增，版本写在包体里**：换包设备的版本一律从包体读取。包体版本不大于线上时：
  - 没写 `version` → 在线上版本末位 +1（`1.0.1 → 1.0.2`），写进包体（小米表盘偏移 4 的三个字节），再从改写后的包体读回核对，manifest 的 `version` / `versionCode` 由读回的值生成；
  - 写了 `"version": "2.0.0"` → 写进包体，必须大于线上；
  - 末位已到 255 时不自动进位，要求手动写 `version`。
  新增的设备没有线上版本，按包体版本走。原文件不会被修改。
- `"keep": true` 的组沿用线上包体（不写 `file`），不上传、不改版本。
- **不会悄悄删设备**：线上有、abcc.json 没写到的设备，默认中止（预演也会报错）。要保留就加 `"keep": true` 的组，确实要移除加 `--allow-remove`。
- **新版本选项会记住**：`--reset-ratings` / `--fold-comments` 选过后记在进度文件里，中断后重跑不带参数也沿用，直到这次更新合并；撤销用 `--clear-version-options`。
- **预演检查付费映射**：abcc.json 没写 `pricing` 时，预演会只读查询服务端，确认加密设备都有付费映射。
- **加密只进不退**：线上已加密的设备，换包后必须继续加密。付费表盘更新时必须重新写明 `paidType`；「付费必须加密」按最终提交的付费类型检查（没写 `pricing` 也算）。
- 资源仓库沿用原仓库，单次提交 `update: <名称>`；加密包体用新密钥加密并按新 commit 上报。
- 该资源已有**自己开着的 PR** 时，在原 PR 分支上更新 `resource.csv` / `request.json`（GUI 的「继续编辑」）；否则新建 `[ABCC] Update resource: <名称>`，`request.json` 为 `mode: edit`。别人开着的 PR 会直接拦下。
- 加密设备在更新仓库前用 `checkUnpaidEncryption` 复核付费映射，未配置时中止。
- `--reset-ratings` / `--fold-comments`：新版本上线后清空评分 / 折叠评论。选过后重跑会沿用，每次推送新提交都按这份选择重新登记；`--clear-version-options` 撤销。

## 清理旧密钥记录（abcc keys prune）

每次推送都会给每台设备新登记一条「密文哈希 + 密钥」，服务端不删旧的（GUI 也一样）。App 只用与线上密文一致的那条。

```sh
abcc keys prune --env official            # 只列出可删的旧记录
abcc keys prune --env official --yes      # 删除
abcc keys prune 979812217215 --env official   # 只处理指定资源
```

- 按运行当时的线上版本判断：只删哈希与线上密文不一致的记录，每台设备当前在用的那条一定保留；找不到在用那条的设备不动。
- 有进行中 PR 的资源整个跳过（未合并时新密钥还没上线，会被误判为旧记录）。
- 删除前对每个资源重新读取一次线上状态。删除不能恢复。

进度写在资源目录的 `.abcc-update-state.json`，只作缓存：线上 commit 变了（上一版已合并）或资源仓库 HEAD 被别处推过，就以远端为准重新执行。

## 中断与续跑

每个资源目录下会生成 `.abcc-state.json`，记录已完成的步骤。任一步失败后，修正问题再运行同一条命令，CLI 会从中断处继续，不会重复建仓或重复提 PR。

加密密钥在上报服务端成功之前，临时保存在 `~/.config/abcc/pending-keys/`（权限 600），全部上报成功后删除。

## 凭证

凭证保存在 `~/.config/abcc/storage.json`（权限 600），与 GUI 互不影响。可以用 `ABCC_CONFIG_DIR` 指定其它目录。

## 实现说明

结构参考 [AstroBoxCli](https://github.com/AstralSightStudios/AstroBoxCli)：命令层与流程分开；发布规则不复制，直接用 ABCC 的代码。

```
vendor/AstroBoxCreatorConsole/   ABCC（git 子模块，DevonStee/AstroBoxCreatorConsole 的 cli-support 分支）
packages/publish-core/           @abcc/publish-core：发布 / 更新流程，无界面
  src/spec.ts                    abcc.json 解析
  src/plan.ts                    abcc.json + 线上基准 → GUI 同构的下载行，交给 validatePublish / buildManifest
  src/version.ts                 包体版本决策与改写（writePackageVersion + 读回核对）
  src/pipeline.ts                新建与更新共用：付费保护、写表盘 ID、加密、单次提交、上报密钥
  src/publish.ts                 新建发布
  src/update.ts                  更新已上架资源
  src/client-info.ts             request.json 的 client 信息：abcc-cli@版本 (ABCC 版本)，及所用 ABCC 代码的提交
cli/
  index.ts                       参数解析与分发
  commands/                      auth / validate / publish / update / status
  lib/                           登录、落盘 localStorage、交互
tests/                           单元测试与端到端流程测试（内存版 GitHub：tests/fake-github.ts）
docs/requirements/               需求文档
```

- 业务规则全部来自 ABCC 的 `app/logic/publish/`（manifest、校验、版本读写、表盘 ID、提交明细、fork 同步、PR），与 GUI 同一份代码；`publish-core` 只按 GUI 的顺序编排，并加上续跑与密钥落盘。`tsconfig.json` 把 `~/*` 指向子模块的 `app/`。
- 子模块指向 fork 的 `cli-support` 分支，在 ABCC `main` 之上只有 CLI 需要的两处改动：`setClientInfoProvider`（非 Tauri 宿主写 request.json 的 client）与包体改写函数的返回类型修正。
- `cli/lib/runtime.ts` 提供一个落盘的 `localStorage`，让 ABCC 的 `app/logic/account/store.ts` 与 `app/config/repoEnv.ts` 原样运行。
- 加密使用 `node:crypto` 的 AES-256-ECB（PKCS7）。`tests/fixtures/aes-256-ecb-vectors.json` 由与 ABCC `src-tauri` 相同的 Rust 实现生成，测试保证两边输出逐字节一致。
- `bunfig.toml` 固定扁平 `node_modules`（ABCC 代码直接引用了传递依赖），并让 `bun test` 只跑本仓库的 `tests/`。

## 开发

```bash
bun run typecheck   # tsc，包含被引用到的 ABCC 代码
bun test            # 单元测试 + 流程测试，不访问网络、不需要 API key
```

## 许可证

AGPL-3.0，与 ABCC 相同。
