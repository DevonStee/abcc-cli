# 需求：资源发布流程自动化（CLI / MCP）

- 状态：草案
- 日期：2026-10-06
- 相关 issue：[#5 feat(publish): 支持通过 CLI 与 MCP 发布资源的提案](https://github.com/AstralSightStudios/AstroBoxCreatorConsole/issues/5)
- 范围：小米表盘（`.bin` / `.face`）资源的新建发布与版本更新；`.mwz`、快应用 rpk、vivo、CRPack、canopus 不在范围内（见 5.2.1）

## 1. 背景与痛点

当前创作者上架一个表盘，需要在 ABCC 的发布页面（`app/routes/resource/publish/new.tsx`）里逐项填写表单、选择文件、勾选设备、配置加密，然后依次点击「创建发布仓库」「提交 Pull Request」。

对表盘数量多的创作者来说，每个表盘都要重复整套点击流程，耗时长、容易漏填。但这个流程的本质只是：

1. 在用户自己的 GitHub 账号下建一个资源仓库并提交文件；
2. （加密时）把密钥登记到 AstroBox 后端；
3. 向主仓库提一个只含两个小文件的 PR。

这些步骤全部是 API 调用，没有必须依赖图形界面的环节，因此可以做成命令行 / AI 可调用的自动化流程。

**核心思路：鉴权和审核环节不变，只去掉图形界面的手动操作。**

## 2. 现有流程梳理（基于代码）

### 2.1 涉及的账号

| 账号 | 用途 | 凭证形式 |
|---|---|---|
| GitHub | 建资源仓库、提交文件、fork 主仓库、提 PR | OAuth Device Flow 获取的 token（clientId `Ov23liBMqMb1utzPatgY`，scope `repo delete_repo workflow read:user user:email`），请求头 `Authorization: Bearer` |
| AstroBox | 新建资源的前置登录门槛；上报加密密钥；登记外部授权；付费映射 | Casdoor OAuth 或账号密码登录获得的 token，请求头 `X-ASTROBOX-TOKEN`，可用 `auth/refresh_token` 刷新 |

### 2.2 步骤

**① 生成表盘 ID**（`app/logic/publish/watchface-id.ts`）
- 12 位数字，前缀 `9798`，客户端随机生成。
- 读取主仓库 `index_v2.csv` 去重。

**② 创建资源仓库并提交文件**（`submission.ts` 中 `uploadManifestAndAssets`）
- 仓库名：`astrobox-resource-<表盘ID>`，在用户自己的账号下、公开、`auto_init`。
- 设置 topics `astrobox-resource, watchface`，以及 homepage `https://abox.run/open?source=resv2&id=<id>&provider=OfficialV2`。
- 改写表盘包：把 12 字节 ASCII 的 ID 写入 `.bin` 偏移 40 处（magic `5A A5 34 12`）；`.mwz` 会解包改写后再打包。
- 可选加密，见 2.3。
- 通过 Git Data API 一次性提交，commit message 为 `publish: <名称>`（更新时为 `update: <名称>`）。文件结构如下：
  ```
  README.md
  manifest_v2.json
  media/<图标、封面、预览图>
  downloads/<表盘包>.bin
  downloads/trial/<试用包>   （可选）
  ```
- 不创建 Release，也不打 tag。下载直接走仓库里的文件（GitHub 托管）。

**③ 提交 PR 到主仓库**（`staging-submission.ts`）
- 目标是 `AstralSightStudios/AstroBox-Repo`（测试环境为 `ABRepo-TestEnv`）的 `main` 分支。
- 提交前的检查：
  - 读 `index_v2.csv`，校验 ID 和仓库是否重复；
  - 扫描所有 open PR，确认没有冲突的提交目录和资源 ID。
- 分支操作：
  1. fork 主仓库并同步到上游 head；
  2. 建分支 `astrobox-submit-<时间戳>`；
  3. 提交两个文件（见下面的示例）。
- PR 标题：`[ABCC] Add new resource: <名称>` 或 `[ABCC] Update resource: <名称>`。

PR 中提交的两个文件：
```
tmp/<github用户名小写>/<仓库名小写>/resource.csv    # 表头 + 1 行
tmp/<github用户名小写>/<仓库名小写>/request.json    # mode / original_id / base_catalog_commit 等
```
`resource.csv` 的列：`id,name,restype,repo_owner,repo_name,repo_commit_hash,icon,cover,tags,device_vendors,devices,paid_type`

**④ 主仓库侧（不在本项目内）**
- `.github/workflows/resource-submissions.yml` 在 PR 上运行 `resource_submissions.py validate-pr`。规则如下：
  - **每个 PR 只能包含一个 submission 目录**；
  - 只允许改动 `tmp/**` 下的 `resource.csv` 和 `request.json`。
- 维护者人工审核并合并。
- 合并后，`apply-pending` 自动把条目写进 `index_v2.csv`，并删除 `tmp` 目录，资源即正式上架。

### 2.3 加密与明文的区别

| | 明文 | 加密 |
|---|---|---|
| 判定方式 | 下载行未勾选 `encryptOnUpload` | 任一正式下载行勾选了加密（试用包永不加密） |
| `manifest.ext` | 无特殊字段 | 必须有 `enableAstroBoxCreatorFeatures: true` |
| 仓库里的 `.bin` | 原始表盘包，可直接看到 `5aa5 3412` 头和 ID | AES-256-ECB（PKCS7）密文，全是随机字节 |
| 密钥 | — | **客户端随机生成 32 字节**，由 Rust 命令 `encrypt_aes_256_ecb` 加密 |
| 额外的后端调用 | 无 | 仓库提交成功后，每个设备调用一次 `POST /resource/submit_crypto_info {id, deviceId, hash(密文SHA-256), key, repoOwner, repoName, commitSha}`；如有外部授权草稿，再调用 `/order/seller/external-authorization/upsert` |
| `paid_type` | 通常为空（free） | 如 `force_paid` |
| 定价 / 爱发电 / CDK 映射 | — | 在表单编辑阶段的 `EncryptConfigDialog` 中单独配置（`resource-product/upsert`、`resource-sku/upsert` 等），不属于发布这一步 |

实例对照：
- `DevonStee/astrobox-resource-979842555965` 是加密的，`ext.enableAstroBoxCreatorFeatures: true`，`paid_type` 为 `force_paid`。
- `DevonStee/astrobox-resource-979888789385` 是明文的，`ext: {}`。

### 2.4 发布前的校验规则（自动化后必须原样保留）

**基本信息**
- 名称、描述必填，标签至少 3 个。
- 表盘 ID 为 12 位数字，以 `9798` 开头。

**图片**
- 图标：正方形，边长不超过 500px。
- 封面：3:2（误差 ±0.02），不超过 600KB。
- 预览图：至少 1 张。

**下载包**
- 至少 1 个正式下载。每一行都要有设备、版本和包。
- `versionCode` 从 bin 偏移 4 读取，计算方式为 `(major<<16)|(minor<<8)|patch`。更新时新的 `versionCode` 必须大于旧的。

**文件名与链接**
- 文件名不能包含 `#`、`?`、`%`。
- 链接必须是 https，并且要有标题和图标。

**加密**
- 开启加密时，必须开启 creator features。
- 开启了 creator features，却既没有加密也没有付费映射，视为错误。

## 3. 目标

1. 创作者把多个表盘按约定目录结构放好，**一条命令批量完成**：校验、建仓、提交、加密、登记密钥、提 PR。
2. 支持 `--dry-run`：只做校验和预览，不产生任何远端写入。
3. 支持**断点续跑**：批量中某个表盘失败后，重跑时跳过已完成的步骤，不会重复建仓或重复提 PR。
4. 提供 MCP 接口，让 AI（Claude Code 等）能读取提交包规范、校验用户准备好的目录、调用发布。AI 不替用户生成内容。
5. 与 GUI 发布结果**完全一致**：同样的仓库结构、manifest 和 PR 格式，主仓库那边无需任何改动。

### 不在本期范围

- 替维护者审核或合并 PR（主仓库的人工审核保留）。
- 修改主仓库的校验脚本。

## 4. 设计决策

| 问题 | 决策 |
|---|---|
| 登录方式 | **与现有应用流程保持一致**：GitHub 使用同一个 OAuth App 的 Device Flow；AstroBox 复用应用浏览器版本的 Casdoor 登录（见 5.3） |
| 作者身份 | **必须关联 AstroBox 作者**：CLI 强制登录 AstroBox，作者名从账号读取，不允许手填（见 5.5） |
| 代码放在哪里 | **单独写一块**（独立的 `cli/` 目录），不重构 GUI，但 **import 复用** `app/logic/publish/` 中的现有逻辑 |
| 加密 | **复用应用的 Rust 加密代码**：抽成 `abcc-crypto` crate，应用和 CLI（WASM）共用（见 5.4） |
| PR 粒度 | **一个表盘一个 PR**（这也是上游规则的要求） |
| AI 的边界 | **只定义规范和校验，不替用户生产内容**：我们明确规定「一个合格的提交包长什么样」（目录结构、`abcc.json` 字段、图片和包体的要求），并在不合格时给出准确的错误。描述、配图、表盘本身由用户提供；用户的 AI 工具调用其他 skill 来作图、写文案，不在本项目范围内 |
| 付费映射 | 每个表盘在爱发电上是**单独一个商品**，链接在提 PR 之前就已经创建好；`abcc.json` 中填写这个链接，由 CLI 自动解析和保存（见 10.1） |
| 形态 | CLI 和 MCP 都可以；按「先 CLI 核心，MCP 包一层」的顺序实施 |

## 5. 方案设计

### 5.1 整体架构

```
┌──────────────┐        ┌───────────────────────────────┐
│ ABCC GUI     │        │ cli/（新增，独立入口）           │
│ (React/Tauri)│        │  ├─ abcc 命令行 (Bun)            │
│   不改动     │        │  ├─ MCP Server（包装同一套命令）  │
└──────┬───────┘        │  └─ adapters/（替换 Tauri/浏览器依赖）│
       │                └──────────────┬────────────────┘
       │      import 复用               │
       └─────────────┐   ┌──────────────┘
              ┌──────▼───▼──────┐
              │ app/logic/publish/*  现有纯 TS 逻辑
              │ app/api/astrobox/*   现有 API 封装
              └────────┬────────┘
       ┌───────────────┼───────────────┐
   GitHub API     AstroBox API      本地文件
```

原则：**GUI 代码一行不动**。CLI 通过 import 直接调用现有模块；遇到依赖浏览器或 Tauri 的地方，由 `cli/adapters/` 提供替代实现。如果某个模块与 UI 耦合得太紧、无法直接 import，再在 `app/logic/publish/` 里做**最小限度的拆分**（例如把 toast 调用移到调用方），并保证 GUI 行为不变。

代码梳理的结论是，下列模块本身就是平台无关的纯 TS，可以直接 import：
- `manifest.ts`、`catalog.ts`、`staging-submission.ts`、`submission-protocol.ts`、`fork.ts`、`github-actions.ts`、`watchface-id.ts`、`package-version.ts`、`validation.ts`、`pre-publish-checks.ts` 等。

与 GUI 或 Tauri 耦合、需要由 adapter 替换的点：

| 耦合点 | CLI 中的替代 |
|---|---|
| `loadAccountState()` 读取 token | 注入一个凭证提供器（见 5.3） |
| `encrypt_aes_256_ecb`（Tauri invoke） | 见 5.4 |
| `app_build_info`（写入 `request.json.client`） | CLI 自己填写版本信息 |
| `sonner` 的 toast 和日志桥 | 注入 logger 接口 |
| localStorage 中的环境 / 模式配置 | 改为命令行参数 `--env official\|testenv` |
| 浏览器中的图片尺寸读取与压缩 | 改用 `sharp` 或同类库（需要评估依赖） |

### 5.2 输入格式：每个表盘一个目录

```
watchfaces/
  led-wall/
    abcc.json            # 发布描述文件
    LED Wall.bin
    media/
      icon.png
      cover.png
      preview-1.png
  sextant-m3/
    abcc.json
    ...
```

`abcc.json` 示例：
```json
{
  "id": null,
  "name": "LED Wall",
  "description": "黄色小方格拼成一面灯墙……",
  "tags": ["小米", "像素", "LED"],
  "links": [{ "title": "小红书介绍", "url": "https://xhslink.cn/o/xxx", "icon": "article" }],
  "icon": "media/icon.png",
  "cover": "media/cover.png",
  "preview": ["media/preview-1.png"],
  "downloads": [
    { "devices": ["xmb10", "xmb10nfc", "xmb11", "xmb11nfc"], "file": "LED Wall band.bin", "encrypt": true },
    { "devices": ["xmws4", "xmws5"], "file": "LED Wall watch.bin", "encrypt": true }
  ],
  "paidType": "",
  "prBody": ""
}
```

各字段的约定：
- `downloads` 是一个**分组数组**：同一个表盘包支持的多台设备写在同一组里；不同设备需要不同的包（例如手环和手表的屏幕不同），就分成多组。详见 5.2.1。
- 不包含 `author`：作者由登录的 AstroBox 账号决定，见 5.5。
- `id` 为 null 时自动生成，生成后**回写**到 `abcc.json`，保证重跑时幂等。
- `version` 和 `versionCode` 默认从 bin 文件读取，不需要手填。
- 内容（描述、标签、图片、表盘包）全部由用户提供，CLI 和 MCP 只做校验，不生成内容。用户的 AI 工具可以调用其他 skill 来准备内容，这不在本项目范围内。

### 5.2.1 多设备与表盘包

**范围**：本项目只做**小米表盘**。

| 格式 | 是否支持 | 说明 |
|---|---|---|
| `.bin` | ✅ 支持 | |
| `.face` | ✅ 支持 | 与 `.bin` 的文件头相同：版本号在偏移 4，ID 在偏移 40（`package-version.ts:13`、`watchface-id.ts:61`） |
| `.mwz` | ❌ 不支持 | zip 工程包，GUI 支持，CLI 暂不支持 |
| 快应用 / Vela `.rpk`、vivo 表盘、CRPack 资源包、canopus | ❌ 不在范围内 | GUI 的文件选择器也接受 `crpack,zip,rpk`（`new.tsx:2727`），CLI 不支持 |

**设备列表**（`app/logic/devices/catalog.ts`）：
- 固定读取**正式仓库**的 `devices_v2.json`，不随测试环境切换，因为测试环境的设备列表比较旧。
- 结构是「厂商 → 机型号 → `{ id, name, chip }`」。多个机型号可以对应同一个设备 ID，例如 `M2345B1` 和 `M2346B1` 都是 `xmb9`。
- 截至 2026-10-06，小米共有 25 个机型号，对应 16 个设备 ID：
  - 手环：`xmb9`、`xmb9p`、`xmb10`、`xmb10nfc`、`xmb10p`、`xmb11`、`xmb11nfc`
  - 手表：`xmws3`、`xmws4`、`xmws4xring`、`xmws441`、`xmws5`、`xmws541`
  - REDMI 手表：`xmrw5`、`xmrw5xring`、`xmrw6`
- CLI 也从同一个地址读取设备列表，并做校验：`devices` 里的每个值都必须是合法的设备 ID；也接受机型号，CLI 会自动转换成设备 ID，与 GUI 的 `loadDeviceTokenResolver` 一致。

**GUI 的模型**（`components/types.ts` 中的 `DownloadInput`）：
- **每台设备一行**，每一行有自己的包、版本、`versionCode`、是否加密、更新日志；
- 提供「批量添加设备行」和「把第一行复制到所有设备行」两个操作；
- 生成 manifest 时（`manifest.ts:296-342`）：多台设备用同一个文件，仓库里只存一份；不同的文件同名时，会自动加上 `-<设备ID>` 后缀；
- `resource.csv` 中的 `devices` 和 `device_vendors` 由这些行汇总生成。

**CLI 的映射**：`abcc.json` 中每一组 `{ devices: [...], file }` 展开成若干个 GUI 的「设备行」，再交给 `manifest.ts` 生成 manifest。组内的每台设备共用同一个文件、同样的加密设置和同样的版本号。
- 加密按**文件**进行：同一个文件只加密一次，对应的所有设备共用一份密文和一个密钥（与 `submission.ts:198-272` 一致）。但 `submit_crypto_info` 要**每台设备各调一次**。
- 爱发电映射要**每台设备各保存一份**，所以 `pricing.devices: "all"` 会把同一个链接应用到所有设备。

**包与设备是否匹配：由创作者负责，CLI 不检查**
- 哪个包对应哪些设备，由创作者在 `abcc.json` 中自己决定，CLI 不判断。这与 GUI 一致：GUI 也只校验能否读出版本号、表盘 ID 是否需要改写、`versionCode` 是否递增，以及包内名称与资源名是否一致（只警告）。
- CLI 只校验设备 ID 是否存在于 `devices_v2.json`，以及每台设备都对应一个文件。
- dry-run 的输出中会列出「文件 → 设备」的对应表，方便创作者在发布前人工核对。

### 5.3 鉴权：与现有应用流程一致

**GitHub：直接沿用应用的 Device Flow**

- 同一个 clientId `Ov23liBMqMb1utzPatgY`，同样的 scope，同样调用 `login/device/code` 和 `login/oauth/access_token`。
- CLI 打印验证码和网址，用户在浏览器中授权，体验和应用里一样。
- GUI 需要借 `github_request` 绕开 CORS，命令行没有 CORS 限制，可以直接请求，因此复用 `app/logic/account/github.ts` 中的流程即可。
- 不使用 `gh auth token`：它属于另一个 OAuth App，token 来源与应用不一致。
- **与 GUI 不冲突**：GitHub 允许同一个 OAuth App 给同一个用户同时发放多个有效 token，CLI 登录不会让 GUI 掉线。这一点和 AstroBox 不同。
- **注意上限**：同一个用户、同一个 App、同样的 scope，最多同时保留 10 个 token，超出后最早的会被自动吊销（GitHub 文档中的规则）。如果 CLI 每次运行都重新登录，次数多了就会把 GUI 的 token 挤掉。所以 CLI 必须把 token 保存下来复用，只有 token 失效时才重新登录。

**AstroBox：沿用同一套 Casdoor 登录（必须登录，见 5.5）**

应用里共有三种 AstroBox 登录方式，以及它们在命令行中能否使用：

| 应用中的方式 | 回调地址 | CLI 能否复用 |
|---|---|---|
| 系统浏览器登录（deeplink） | `astroboxcc://auth/callback` | ❌ 回调会被已安装的 ABCC 应用接走 |
| 内置网页登录（webview） | 应用窗口内部 | ❌ 只能在应用窗口里用 |
| **浏览器版本（非 Tauri 环境）** | `<当前网址>/callback`，本地开发时是 `http://localhost:6767/callback` | ✅ **CLI 可以直接复用** |
| 账号密码登录（`/auth/native/password/login`） | 无回调 | ✅ 可以直接复用（备选） |

方案（主路径）：完全复用应用的「浏览器版本」登录流程，见 `app/logic/account/astrobox.ts:170`。
1. CLI 临时在 `127.0.0.1:6767` 上启动一个只接收 `/callback` 的本地服务；
2. 打开系统浏览器，进入同一个 Casdoor 应用（`cas.astralsight.space`，clientId `0fada617eb3ba5e1c2a3`）的登录页；
3. 收到回调后，用与应用完全相同的 `SDK.signin` 换取 token，并拉取账号资料，然后关闭本地服务。

和应用相比，登录页、Casdoor 应用、换 token 的代码都一样，区别只有「谁来接收回调」。

**验证结果**
- 已验证：通过 `http://localhost:6767/callback` 可以完成 AstroBox 登录。这条方案不需要后端改动。
- CLI 固定使用 6767 端口，端口被占用时直接报错提示，不切换端口。

**会话限制（待后端确认）**

同一个 AstroBox 账号是否只允许一个有效会话，目前不确定：开发测试中观察到，在另一处登录后，已安装的应用提示登录过期，但没能稳定复现。

如果确实是单会话，CLI 登录会让 GUI 掉线，反之亦然。可能的做法：

| 做法 | 说明 |
|---|---|
| A. 接受限制 | CLI 和 GUI 不同时使用，切换时重新登录。实现最简单 |
| B. 后端支持多会话 | 按客户端（GUI / CLI）分别保留 refresh token。体验最好，需要后端改动 |
| C. GUI 授权给 CLI | 在已登录的 GUI 中把会话交给 CLI，不重新登录。需要设计安全传递凭证的方式 |

在后端答复之前，第一期按 A 实现，CLI 登录时提示「这可能会让 ABCC 应用中的 AstroBox 登录失效」。

无论结论如何，CLI 都要做到：
- 判断登录是否有效，只以接口返回的 401 或 403 为准，不看本地状态，也不把请求慢或超时当作掉线。GUI 只在页面加载、窗口重新获得焦点时才核对登录（`app/root.tsx:44-58`），本地显示的状态并不可靠。
- AstroBox 接口单次请求约 0.3–0.6 秒，偶尔会更慢。超时要设置得宽松一些，并在超时后重试。

登录之后的 token 刷新，复用应用的 `auth/refresh_token`。批量发布耗时较长，**每次调用 AstroBox 接口前都要检查 token 是否需要刷新**。

**凭证存储**：放在 `~/.config/abcc/credentials.json`，权限 600，日志中脱敏（复用 `logging/mask.ts` 的规则）。

### 5.4 加密：复用现有逻辑

`app/logic/publish/encryption.ts` 中的 `encryptFileWithAes256Ecb` 负责以下几件事：
1. 生成 32 字节随机密钥；
2. 加密；
3. 计算密文的 SHA-256；
4. 返回密文、哈希和 base64 格式的密钥。

`submission.ts` 中围绕它的逻辑也都可以原样复用：同一路径的文件共用一份密文和密钥、`submit_crypto_info` 的参数组装、外部授权登记。

**唯一不能在 CLI 中运行的，是第 2 步那一行 `invoke("encrypt_aes_256_ecb")`**，它会调用 Tauri 里的 Rust 实现（`src-tauri/src/lib.rs`，`aes` + `ecb` crate，`Pkcs7` 填充）。

CLI 无法调用正在运行的应用里的 Tauri 命令，所以要让 CLI 与应用使用**同一份 Rust 加密代码**，方案如下：

1. 把 `encrypt_aes_256_ecb` 的函数体（约 20 行）抽成一个独立的小 crate `abcc-crypto`。它只依赖 `aes`、`ecb`、`base64`，不依赖 Tauri。
2. `src-tauri` 改为依赖 `abcc-crypto`。Tauri 命令只是一层薄包装，GUI 的行为和接口不变。
3. `abcc-crypto` 再编译出一个 **WASM** 产物，供 CLI 通过顶层 import 加载。
   - 一份产物就能在 macOS、Windows、Linux 上运行，不需要按平台分发二进制。
   - 与应用是同一份 Rust 源码，从根上避免两边实现不一致。
4. `encryption.ts` 中，除了 invoke 那一行，其余逻辑（生成密钥、计算哈希、返回结构）由 CLI 原样复用；加密原语以依赖注入的方式传入。

| 运行环境 | 加密原语 |
|---|---|
| GUI | `invoke("encrypt_aes_256_ecb")`，内部调用 `abcc-crypto` |
| CLI | `abcc-crypto` 的 WASM 导出，同一份源码 |

**测试**：
- `cargo test` 中验证 `abcc-crypto` 的输出与标准 AES-256-ECB/PKCS7 的测试向量一致；
- `bun test` 中验证 WASM 产物与原生版本对同一组输入输出相同；
- 再用一个真实表盘做往返测试：加密后再解密，结果必须与原文件逐字节一致。

**代价**：需要改动 `src-tauri`（把函数挪进新 crate），并在构建流程中增加一步 `wasm-pack`（或 `cargo build --target wasm32-unknown-unknown` 加 `wasm-bindgen`）。

**备选**：CLI 直接使用 `node:crypto` 的 `aes-256-ecb`。这是同一个标准算法，实现成本最低，但不是同一份代码，必须靠对拍测试来保证一致。

### 5.5 作者身份关联

**现状：一个资源在哪些地方关联到作者**

| 位置 | 内容 | 关联到的身份 | 强度 |
|---|---|---|---|
| 资源仓库 `manifest_v2.json` | `item.author: [{ name, bindABAccount: true }]` | AstroBox 作者 | 弱：只是一个用户名字符串 |
| PR 中的 `resource.csv` | `repo_owner`、`repo_name` | GitHub 账号 | 中：仓库确实属于这个账号 |
| PR 中的 `request.json` | `mode`、`base_catalog_commit`、客户端信息 | 无 | — |
| PR 提交者和 fork | GitHub 账号 | GitHub 账号 | 中：合并后作为 Co-authored-by 写入主仓库 |
| `/resource/submit_crypto_info` 等加密和订单接口 | 携带 `X-ASTROBOX-TOKEN` | AstroBox 账号 | **强：服务端认证，密钥和收益归属于这个账号** |

**应用中的保护手段**
- 正式版新建资源前，必须先登录 AstroBox（`new.tsx:2495`）。
- 作者名从**已登录账号的资料**中自动读取并填入（`new.tsx:710`），不由用户手填。
- 审核时，`resreview/rule-checks.ts:1697` 按作者名查找 AstroBox 账号，找不到判定失败；后续的 Creator Pro 权益校验、免费与付费比例校验，也都按这个名字找人。

**已知缺口（现状，不是 CLI 引入的）**：GitHub 账号与 AstroBox 账号之间，在发布流程中**没有互相校验**。后台的用户资料中有一个 `github` 字段（`app/api/astrobox/admin.ts:54`），但发布流程没有用到。目前只靠人工审核把关。

**CLI 的要求**
1. **必须登录 AstroBox**，不提供跳过登录的选项。明文资源需要它来确定作者，加密资源需要它来上报密钥。
2. **作者名不允许手填**：`abcc.json` 中不出现 `author` 字段，CLI 从登录账号的资料中读取用户名，写入 `{ name, bindABAccount: true }`，与应用一致。（是否支持多作者、或带有不绑定账号的合作者，待定，见第 9 节。）
3. **发布前展示身份并要求确认**：例如「GitHub：DevonStee ／ AstroBox：brin，将发布 12 个表盘到 official 环境，确认？」。MCP 模式下，这段信息必须展示给用户本人确认，不能由 AI 代为确认。
4. **GitHub 与 AstroBox 账号的一致性校验**：如果能读到账号资料中的 `github` 字段，就和当前 GitHub 登录名比对，不一致时警告。
   - 普通用户能否读到自己的 `github` 字段，需要确认（admin 接口里有，`/auth/api/me` 里不一定有）。
   - 长期来看，可以建议后端在 `submit_crypto_info` 等接口中做这项校验，同时惠及 GUI，见第 9 节。

### 5.6 批量 PR 策略

主仓库的校验脚本规定**一个 PR 只能包含一个 submission 目录**，所以批量发布 = **N 个独立 PR**，不能合成一个。

- 每个表盘一个分支 `astrobox-submit-<时间戳>`。所有表盘共用一个 fork，同步一次即可。
- **串行**提交 PR，避免并发 fork 同步或分支创建互相踩踏，同时规避 GitHub 的二级速率限制。
- 资源仓库的创建和提交可以适度并发（例如 2 个）。

需要和主仓库维护者沟通：一次出现十几个 PR 是否可以接受，审核侧要不要给 `[ABCC]` 前缀的 PR 加批量审核便利，例如加标签。

### 5.7 幂等与断点续跑

每个表盘目录下写一个 `.abcc-state.json`，记录已完成的步骤：

```json
{
  "id": "979888789385",
  "repo": "DevonStee/astrobox-resource-979888789385",
  "repoCommit": "8e56eae…",
  "cryptoSubmitted": true,
  "pr": 1189
}
```

重跑时的行为：
- 已有 `repoCommit`，且本地文件哈希没变：跳过提交。
- 已有 `pr`：跳过建 PR，只查询 PR 状态。
- AstroBox 登录在中途被顶掉（单会话限制，见 5.3）：识别这类错误后**暂停整批**，提示重新登录，登录后从当前步骤继续，而不是把剩下的表盘都标记为失败。
- 资源仓库已存在且已有 manifest（GUI 现有逻辑会直接中止）：CLI 根据 state 判断是不是自己建的。是自己建的就继续，否则报错。

### 5.8 CLI 命令草案

```bash
abcc auth login                      # GitHub + AstroBox
abcc auth status
abcc validate ./watchfaces/*         # 纯本地校验，不联网
abcc publish ./watchfaces/* --dry-run
abcc publish ./watchfaces/* --env official
abcc update ./watchfaces/led-wall    # 新版本：复用原仓库，request.json mode=edit
abcc status ./watchfaces/*           # 汇总各表盘的 PR 审核与合并状态
```

### 5.9 MCP 接口草案

MCP 不重复实现发布逻辑，只是把 CLI 核心包装成工具：

| 工具 | 作用 |
|---|---|
| `list_local_watchfaces(dir)` | 列出目录中待发布的表盘及校验结果 |
| `get_package_spec()` | 返回提交包规范：目录结构、`abcc.json` 字段说明、图片尺寸和大小要求、设备 ID 列表、标签数量等。供 AI 按规范整理用户已有的素材 |
| `validate(dir)` | 运行本地校验 |
| `publish(dir, dryRun)` | 执行发布，默认 dry-run，正式发布需要显式传参 |
| `get_status(dir)` | 查询 PR 状态 |

**安全约束**：MCP 的 `publish` 是对外写操作（建公开仓库、提 PR、上报密钥）。必须先让用户看到 dry-run 结果，再由用户确认。

### 5.10 与 GUI 互通：CLI 发布的资源在 GUI 中可见、可编辑

**需求**：通过 CLI 发布的资源，要能在 GUI 的「发布中」和「已发布资源」页面中看到，也能继续用 GUI 编辑，反过来也一样。

**现状：GUI 的列表是怎么来的**

| 页面 | 数据来源 | 匹配条件 |
|---|---|---|
| 已发布资源（`routes/resource/manage.tsx`） | 主仓库 `index_v2.csv`（`loadOwnedCatalogResourcesForCurrentUser`） | `repo_owner` = 当前 GitHub 登录名 |
| 发布中（`routes/resource/publish.tsx`） | 主仓库中当前用户提的 PR，包括审核状态（`fetchMyReviewPullRequests`、`loadInProgressStagingResourcesForCurrentUser`） | PR 作者 = 当前 GitHub 登录名，未合并；按 `tmp/` 下的 `resource.csv` 和 `request.json` 解析；按 `[ABCC_*]` 评论判断「需要修改」「已修复」「已拒绝」 |
| 加密文件、CDK、外部授权等管理页 | 同上，按归属于当前用户的资源筛选 | 同上 |

两个页面都**只看 GitHub 账号和主仓库中的数据**，不关心资源是用什么工具发布的。

**结论**：只要 CLI 满足以下几点，CLI 发布的资源就会**自动出现在 GUI 中**，GUI 不需要任何改动：
1. 使用与 GUI **同一个 GitHub 账号**：资源仓库建在这个账号下，PR 也由这个账号提交；
2. 资源仓库、`manifest_v2.json`、`resource.csv`、`request.json`、PR 标题的格式**与 GUI 完全一致**。CLI 直接复用 GUI 的生成代码，天然满足这一点；
3. 审核往来使用同样的 `[ABCC_FIXED_<id>]` 等评论约定，GUI 才能正确显示「已修复，等待审核」等状态；
4. **环境要一致**：CLI 默认发布到 testenv，GUI 默认显示 official。在 testenv 中发布的资源，要把 GUI 切换到测试环境才能看到。

**CLI 与 GUI 交替编辑同一个资源时**
- CLI 的 `.abcc-state.json` 只是本地缓存。执行 `update` 或 `fix` 之前，**必须以远端为准**：重新读取目录、open PR、资源仓库的最新 commit。如果有人在 GUI 里改过，不能用本地的旧状态覆盖。
- 同一个资源同时只能有一个进行中的 PR（GUI 有 `findOpenSubmissionForResourceId` 检查，上游也会校验 `base_entry_digest`）。CLI 复用同样的检查。

**验收标准**：在 testenv 中用 CLI 发布 1 个明文表盘和 1 个加密表盘后，把 GUI 切换到测试环境：
- 「发布中」页面能看到这两个 PR，状态正确，点击后能进入编辑；
- 维护者合并后，「已发布资源」页面能看到这两个资源，并能从 GUI 发起更新。

**已知限制（GUI 现状）**：「发布中」列表通过 GitHub 搜索取当前用户**最近更新的 50 个 PR**（包括已合并的），再过滤掉已合并的（`resources.ts:343-410`），另外还会从 `pulls?state=all&per_page=100` 中补充。PR 总数很多时，较早的未合并 PR 有可能不在列表中。目前单个创作者的 PR 数量远低于这个上限，暂不处理。

## 6. 关键取舍汇总

| 取舍点 | 选项 | 建议 |
|---|---|---|
| 代码组织 | 重构出共享核心，或 CLI 单独写 | ✅ 已定：**CLI 单独写一块，import 复用现有逻辑**，GUI 不动。代价是 `app/logic/publish/` 以后改动时，要同时跑 CLI 的测试，防止 CLI 被改坏 |
| CLI 运行时 | Bun 或 Node | **Bun**，与项目现有工具链一致（`bun test`），并且能直接 import `app/` 下的 TS |
| 加密实现 | Node crypto，或共用 Rust 代码（WASM） | ✅ 已定：**共用 Rust 代码**，抽成 `abcc-crypto`，CLI 加载 WASM |
| 先做 CLI 还是先做 MCP | — | ✅ 都可以，**先 CLI，后 MCP**。CLI 人和 AI 都能用，MCP 只是一层薄包装 |
| 登录方式 | 与应用一致，或另找捷径（如 `gh` token） | ✅ 已定：**与应用一致**。GitHub 走同一个 Device Flow，AstroBox 复用浏览器版本的回调，账号密码登录作为备选 |
| 作者关联 | 允许手填作者名，或强制从账号读取 | ✅ 已定：**强制登录并从账号读取** |
| 批量 PR | 一个 PR 多个表盘，或一个表盘一个 PR | ✅ 已定：**一个表盘一个 PR** |
| 默认环境 | official 或 testenv | **CLI 默认 testenv**，正式发布必须显式传 `--env official`，防止误操作 |

## 7. 风险与注意事项

1. **加密结果不一致**：一旦出错，用户购买后无法解密，属于严重事故。共用 `abcc-crypto` 能从源头避免这个问题，但仍需要做加密、解密往返测试，以及 WASM 与原生版本的对拍测试。
2. **密钥只存在一次**：密钥是客户端生成后上报到服务端的。如果在 `submit_crypto_info` 失败前就已经提交了密文仓库，就会出现「仓库里有密文，但服务端没有密钥」。CLI 必须在 state 中记录未上报的密钥（本地加密保存），保证重试时能补报，而不是重新生成。（需要核实 GUI 现有逻辑在这种情况下的表现。）
3. **ID 改写**：表盘包里嵌的 ID 必须与 manifest 一致。批量时如果多个目录复用了同一个 bin，要逐个检查。
4. **速率限制**：批量时 GitHub API 调用量大，包括扫描 open PR 的文件列表，需要做缓存和退避。
5. **上游规则变化**：主仓库校验脚本一旦变更，CLI 也要跟着改。CLI 直接 import GUI 使用的同一份逻辑，GUI 跟着上游改了，CLI 也会自动跟上。
6. **复用带来的耦合**：CLI 依赖 `app/logic/publish/` 的内部函数签名，GUI 那边重构时可能把 CLI 改坏。需要在 CI 中加入 CLI 的类型检查和测试。
7. **公开仓库**：资源仓库都是 public 的。加密表盘依靠的是密文；明文表盘任何人都能直接下载，这一点与现状一致，要在文档中让用户知晓。

## 8. 分期计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| P0 | 抽出 `abcc-crypto` crate（`src-tauri` 改为依赖它）并产出 WASM；搭建 `cli/` 骨架和 `adapters/`（凭证、日志、加密原语、构建信息）；逐个验证 `app/logic/publish/*` 能否在 Bun 下直接 import，对 import 不了的模块做最小拆分 | GUI 行为不变；`cargo check`、`bun run typecheck`、`bun run build`、`bun test` 全部通过；加密往返测试通过 |
| P1 | CLI 的 `auth`（GitHub Device Flow；AstroBox 复用浏览器版本回调，账号密码作为备选）、身份展示（5.5）、`validate`、`publish --dry-run` | 能对真实的表盘目录给出与 GUI 相同的校验结论；dry-run 的输出中作者名来自登录账号 |
| P2 | CLI 的 `publish`（明文和加密）、断点续跑、`status` | 在 testenv 完成 3 个表盘的批量发布（含 1 个加密），PR 能通过上游 validate-pr |
| P3 | `update`（新版本发布） | `versionCode` 递增校验生效，PR 标题和 `request.json` 与 GUI 一致 |
| P4 | MCP Server | Claude Code 能读取规范，对用户准备好的目录完成校验和 dry-run，经用户确认后发布 |
| P5 | 定价、SKU 映射自动化（见 10.1，付费表盘要能被购买，这一步不可缺少） | 批量发布的付费表盘无需打开 GUI 即可购买 |

## 9. 待确认问题

**需要后端答复**（已在 [#5](https://github.com/AstralSightStudios/AstroBoxCreatorConsole/issues/5) 中提出）
1. **AstroBox 会话**：同一个账号是否只允许一个有效会话？如果是，能否按客户端分别保留会话？（见 5.3）
2. **测试服务器**：AstroBox 后端只有正式环境，testenv 只隔离了 GitHub 一侧。是否有测试服务器？测试数据该怎么清理？
3. **账号绑定校验**：普通用户能否通过接口读到自己账号绑定的 `github` 字段？能否请后端在 `submit_crypto_info` 等接口中校验「GitHub 仓库的所有者 = 当前 AstroBox 账号绑定的 GitHub」？（见 5.5）

**需要在 testenv 中验证**
4. 资源在哪一步进入 AstroBox 服务端，也就是爱发电映射能否在提 PR 之前保存？推测 `submit_crypto_info` 之后就可以。（见 10.1 第 1 条）

**实现时再定**
5. `cli/` 放在本仓库内，便于 import 复用；未来是否需要单独发布成 npm 包？
6. Windows 路径和中文文件名的处理。现有仓库中已有中文文件名，例如 `media/01-图标-1比1.png`。
7. 多作者和合作者：是否支持在登录账号之外再加入其他作者？如果支持，作者名怎样防止填错？

## 10. 尚未覆盖、需要补充的点

按重要程度排列。

### 10.1 必须补充（否则自动化不完整）

1. **付费映射（爱发电链接）**

   **现状（`EncryptConfigDialog.tsx`）**：价格不在 AstroBox 里设置，而是在爱发电上设置好商品。发布时，作者把**爱发电购买链接**粘贴进「配置付费平台映射」弹窗：
   - `parseAfdUrl`（`app/logic/publish/afdian-url.ts`）从链接中解析出 `plan_id`（商品 ID）、`product_type`（1 是普通商品，2 是捆绑包）、`sku` 参数里的所有 `sku_id`；
   - 每个 SKU 生成一条映射，然后依次调用：
     - `resource-product/upsert`：每个商品调一次，参数是 `resourceId`、`platform: "afd"`、`externalProductId`、`buyUrl`、`enabled`；
     - `resource-sku/upsert`：每个 SKU、每台设备调一次，参数在上面基础上加 `externalSkuId`、`deviceId`、`isPaid`、`sortOrder`。
   - 映射**按设备**分别保存，有「应用到全部设备」的批量操作。
   - 一台设备可以关联多个商品或捆绑包，**排在最前、且已启用的那条就是客户端里唯一的购买入口**（`sortOrder`）。
   - 前提：作者账号已经在「资源加解密与激活」页面启用了爱发电平台（`platform-config/list` 里 `afd` 为 enabled），这是一次性配置。
   - 「付费但不加密」和「加密但不售卖」都是合法配置，映射与加密是两件独立的事。

   **时序限制**：保存映射时如果服务端返回 `Resource not found`，GUI 会提示「资源暂未入库，请先完成发布后再保存平台配置」。也就是说，**映射必须在资源进入服务端之后才能保存**。
   - 在现有 GUI 流程中，爱发电商品在提 PR 之前就已创建好，链接也可以在提 PR 之前保存。由此推测，资源在 `submit_crypto_info`（「创建发布仓库」这一步）之后就已进入服务端，不需要等 PR 合并。
   - 需要在 testenv 跑一次确认：上传加密信息后、提 PR 之前，保存映射是否成功。
   - 常见用法是**一个表盘对应一个爱发电商品**，所以 `afdian` 数组通常只有一个链接。

   **CLI 方案**：在 `abcc.json` 中增加：
   ```json
   "pricing": {
     "afdian": [
       "https://afdian.com/item/xxx?plan_id=...&product_type=1&sku=[{\"sku_id\":\"...\"}]"
     ],
     "devices": "all"
   }
   ```
   - 直接复用 `parseAfdUrl` 解析链接；数组的顺序就是 `sortOrder`，第一个就是购买入口；
   - `devices: "all"` 表示应用到这个表盘的所有设备，等同于 GUI 里的「应用到全部设备」；
   - 发布流程的最后一步是保存映射。如果遇到 `Resource not found`，在 state 中标记为「映射待保存」，由 `abcc status` 或 `abcc sync-pricing` 在资源进入服务端之后补上；
   - 发布前检查爱发电平台是否已启用，没有启用就直接报错，提示去 GUI 中完成一次性配置。
2. **审核被打回后的修改流程**
   - 维护者在 PR 上留言要求修改，是常见情况。
   - GUI 有完整的处理流程（`new.tsx:1869-1961`）：
     1. 重新打开已关闭的 PR；
     2. 同步上游；
     3. 在原分支上更新 `resource.csv` 和 `request.json`；
     4. 回复 `[ABCC_FIXED_<id>]` 评论。
   - CLI 需要 `abcc status` 拉取审核意见，以及 `abcc fix <dir>` 走同样的流程，否则批量发布后的返工又得回到 GUI。
   - MCP 场景下，AI 可以读审核意见、修改文件，再调用 `fix`。
3. **免费与付费比例、Creator Pro 预检查**
   - 审核时会检查作者的「2 个免费配 1 个付费」比例，Creator Pro 不受限（`resreview/rule-checks.ts`）。发布页本身不检查。
   - 批量上传一堆付费表盘，很可能全部在审核阶段被打回。CLI 应在 dry-run 时提前计算并警告。
4. **批次内的冲突检查**
   - 现有的重复检查只对比主仓库的 `index_v2.csv` 和其他 open PR。
   - 批量时还要检查**同一批次内部**：ID 是否重复，以及多个目录是否使用了同一个 bin。同一个 bin 被写进不同 ID，后写的会覆盖先写的。

### 10.2 应该补充（影响体验或安全）

5. **图片处理**
   - GUI 会读取图片尺寸，并把图标压缩到约 100KB、预览图压缩到约 500KB（浏览器端的 `browser-image-compression`）。
   - CLI 有两种做法：只校验、不压缩，不合格就报错让用户自己处理；或者引入 `sharp` 自动压缩。
   - 建议第一期**只校验**，避免多一个原生依赖。
6. **从已发布资源反向生成本地目录**（`abcc pull <id>`）
   - 已有大量资源的创作者，要用 CLI 发新版本，需要先有本地目录。
   - 从主仓库目录和资源仓库读取 manifest，生成 `abcc.json`，并下载素材。
7. **设备列表与标签**
   - 设备 ID（`xmb10`、`xmb11nfc` 等）和厂商应以主仓库的 `devices_v2.json` 为准（`app/logic/devices/catalog.ts`），CLI 要做校验，并给出候选。
   - 标签至少 3 个，建议不超过 10 个（`validation.ts:34-36`）。
8. **MCP 的安全边界**
   - GitHub token、AstroBox token、AES 密钥**都不能出现在返回给模型的内容里**。
   - 对外写操作（建仓、提 PR、上报密钥）必须在用户本人确认后才能执行（见 5.5 第 3 条）。
9. **发布日志**
   - GUI 有 `resource_log` 会话日志，用于用户反馈问题。CLI 应把每次批量运行的日志落盘（脱敏），出问题时可以直接附给开发者。
10. **失败回滚**
    - 资源仓库已经创建，但后续步骤失败、用户决定放弃时，是否要提供 `abcc abandon <dir>` 删除这个仓库？
    - 应用申请的 scope 里有 `delete_repo`，技术上可行，但删除仓库属于高危操作，必须二次确认。

### 10.3 可以之后再看

11. **客户端标识**：`request.json.client` 中写入 CLI 自己的版本信息（例如 `version: "cli-0.1.0"`），让维护者能区分 PR 来自 GUI 还是 CLI，出问题时便于定位。
12. **其他资源类型**：试用包（`downloads/trial`）、壁纸生成器、`bundledResources`、quick_app 和 rpk 签名，第一期只做表盘的正式包，其余按需扩展。
13. **testenv 的局限**：ID 去重时，代码固定读取的是 official 仓库的 `index_v2.csv`（`watchface-id.ts:120-136`），即使环境是 testenv 也一样。在 testenv 测试时要注意这一点。
14. **更新日志**：发布新版本时，`downloads.<设备>.updatelogs` 的填写方式，可以从 `abcc.json` 读取，或者从 git 提交信息生成。

## 11. 探测记录（2026-10-06）

### 11.1 现有代码能否在 Bun 下直接 import

逐个在 Bun 中 import 测试（只验证能否加载，没有验证运行时行为）：

| 模块 | 结果 |
|---|---|
| `logic/publish/` 下的 `manifest`、`validation`、`watchface-id`、`package-version`、`catalog`、`submission-protocol`、`staging-submission`、`fork`、`github-actions`、`submission`、`encryption`、`pre-publish-checks` | ✅ 可以加载 |
| `api/astrobox/` 下的 `resource`、`order`、`auth` | ✅ 可以加载 |
| `logic/account/` 下的 `store`、`github` | ✅ 可以加载（`store` 运行时读的是 localStorage，需要由 adapter 替换） |
| `logic/account/astrobox` | ❌ 加载失败：模块顶层执行了 `new Sdk(CASDOOR_CONFIG)`，Casdoor JS SDK 依赖浏览器环境 |

结论：「单独写一块、import 复用」的方案可行。Casdoor 登录这部分需要 CLI 自己实现授权码换 token 的步骤：参数沿用 `CASDOOR_CONFIG`，流程与 SDK 的 `signin` 保持一致。

### 11.2 加密信息上报失败时，GUI 的现状

见 `submission.ts` 的 `uploadManifestAndAssets`：
1. 先把密文提交进资源仓库（commit 已经生成），**之后**才逐个设备调用 `submit_crypto_info`；
2. 上报失败时直接抛错，**密钥只保存在内存中**，日志里也是脱敏的，抛错之后密钥就丢了；
3. 用户在 GUI 中重试新建时，`new.tsx:1697` 检测到仓库里已经有 manifest，会提示「仓库已被占用，请更换仓库名」，**原来的仓库无法继续使用**。

也就是说，现状下一次上报失败会留下「仓库里有密文、服务端没有密钥」的孤儿仓库，用户只能换个仓库名重来。

CLI 的要求：
- 上报成功之前，把密钥临时保存在本地 state 中（权限 600，不写进日志）。重试时**用同一个密钥补报**，不重新加密、不重新提交。
- 全部上报成功后，再从 state 中删除密钥。
- GUI 也存在这个问题，不过属于偶发情况，本需求只在 CLI 中规避。

### 11.3 上游校验脚本的补充规则

`AstroBox-Repo/.github/scripts/resource_submissions.py`：
- 每个 PR 只能有一个 `tmp/<owner>/<repo>/` 目录，并且只能包含 `resource.csv` 和 `request.json`。
- create 模式：ID 不能重复，`repo_owner/repo_name` 也不能重复（不区分大小写）。
- edit 模式：
  - `base_entry_digest` 必须与当前目录中这一行的 digest 一致，否则提示「digest 已过期」。所以**同一个资源不能同时有两个更新 PR**，前一个合并后，后一个必须重新生成。
  - 合并时会比较新旧两次提交里的包体 blob：包体变了就追加新行，没变就原地替换。
- 资源仓库的 Git tree 不能被截断，否则校验失败。仓库里文件特别多的时候需要注意。
