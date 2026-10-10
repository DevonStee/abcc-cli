/**
 * `abcc spec` 输出的提交包规范，给创作者和 AI 工具按规范整理素材用。
 * 数值与 app/logic/publish/pre-publish-checks.ts、validation.ts 保持一致。
 */
import {
    COVER_MAX_BYTES,
    COVER_RATIO,
    COVER_RATIO_TOLERANCE,
    ICON_MAX_DIMENSION,
} from "~/logic/publish/pre-publish-checks";
import { PUBLISH_TAGS_MIN } from "~/logic/publish/validation";
import { SPEC_FILE_NAME, SUPPORTED_PACKAGE_EXTENSIONS } from "./spec";

export const PACKAGE_SPEC_TEXT = `提交包规范（每个表盘一个目录）

目录结构示例：
  led-wall/
    ${SPEC_FILE_NAME}
    band.bin
    media/icon.png
    media/cover.png
    media/preview-1.png

${SPEC_FILE_NAME} 字段：
  id           表盘 ID。首次发布填 null，发布时自动生成 12 位 9798 开头的 ID 并写回；
               abcc update 必须填已上架的 ID。
  name         资源名称，必填。
  description  简介，必填。
  tags         标签数组，至少 ${PUBLISH_TAGS_MIN} 个。
  icon         图标路径：正方形，边长不超过 ${ICON_MAX_DIMENSION}px。
  cover        封面路径：宽高比 ${COVER_RATIO}（3:2，允许 ±${COVER_RATIO_TOLERANCE}），不超过 ${Math.round(COVER_MAX_BYTES / 1024)}KB。
  preview      预览图路径数组，至少 1 张。
  links        可选，[{ "title", "url"(https), "icon" }]。更新时不写则沿用线上。
  downloads    按包分组：[{ "devices": ["xmb10", ...], "file": "band.bin", "encrypt": true }]
               - encrypt 不写默认加密；只有明确写 false 才上传明文包。
               - 更新时，线上已加密的设备换包后必须继续加密。
               - 只支持 ${SUPPORTED_PACKAGE_EXTENSIONS.join(" / ")}（小米表盘）。
               - 设备 ID 以正式仓库 devices_v2.json 为准；每台设备只能出现在一组里。
               - 哪个包配哪些设备由创作者决定，CLI 不判断包与设备是否匹配。
               - 版本号与 versionCode 从包体读取（小米表盘偏移 4 的三个字节），不需要填写。
               - version   可选，"a.b.c"，写进包体，用于大版本升级（如 2.0.0）。
               - changelog 可选，本次版本的更新日志，追加到这组设备的 updatelogs。
               - keep      可选，仅 abcc update：true 表示这组设备沿用线上包体（不写 file）。
               更新已上架资源时，换包设备的 versionCode 必须大于线上：包体版本不够大且没写
               version 时，CLI 把「线上版本末位 +1」写进包体（1.0.1 → 1.0.2），再从包体读回。
  pricing      可选，爱发电付费映射：{ "afdian": ["<爱发电购买链接>"], "devices": "all" }
               - 链接需包含 plan_id 与 sku 参数；顺序即购买入口顺序，第一条是客户端里的购买按钮。
               - 新建时有加密的组必须配置 pricing 或 allowFreeEncryption，否则密钥会被当作免费资源发放。
               - 配置了 pricing 必须明确写 paidType（paid 或 force_paid）。
               - 付费表盘必须加密：pricing 覆盖的设备（付费类型为 paid / force_paid 时为全部设备）
                 都要加密。免费表盘可以加密（配 allowFreeEncryption），也可以写 encrypt: false 不加密。
  allowFreeEncryption  可选，true 表示「加密但免费」：包体在仓库里是密文，只能通过 AstroBox
               安装，密钥向所有用户免费发放。与 pricing 二选一。
  paidType     "free" / "paid" / "force_paid" 或留空（免费）：
               - free       免费：可直接使用。
               - paid       付费：可先体验部分功能，购买后解锁完整功能。
               - force_paid 强制付费：不购买则无法使用。
               付费表盘（新建或更新）必须明确写 paid 或 force_paid，由创作者选择，CLI 不默认；
               免费表盘更新时不写则沿用线上。
  prBody       可选，PR 描述。

不需要填写：author（由登录的 AstroBox 账号决定）、仓库名（astrobox-resource-<id>）。
文件名不能包含 # ? %；所有路径必须是资源目录内的相对路径。
`;
