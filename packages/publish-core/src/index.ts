/**
 * @abcc/publish-core：ABCC 资源发布 / 更新流程（无界面）。
 *
 * 业务规则（manifest、校验、版本、表盘 ID、提交明细、PR）全部来自 app/logic/publish，
 * 与 GUI 同一份代码；这里只负责把它们按 GUI 的顺序编排成可续跑的流程。
 * 调用方需要先提供 localStorage（账号与环境），见 cli/lib/runtime.ts。
 */
export { configDir } from "./paths";
export { cliClientInfo } from "./client-info";
export { AES_KEY_BYTES, decryptAes256Ecb, encryptAes256Ecb, generateKeyBase64, sha256Hex } from "./crypto";
export { readImageSize, type ImageSize } from "./images";
export {
    allDevices,
    hasEncryption,
    loadSpec,
    parseSpec,
    pricingDevices,
    SPEC_FILE_NAME,
    SpecError,
    SUPPORTED_PACKAGE_EXTENSIONS,
    writeBackId,
    type LoadedSpec,
    type ResourceSpec,
    type SpecDownloadGroup,
} from "./spec";
export { PACKAGE_SPEC_TEXT } from "./spec-doc";
export {
    buildPlan,
    buildPlanManifest,
    checkDevices,
    type PlannedPackage,
    type PublishedBaseline,
    type ResourcePlan,
} from "./plan";
export {
    decidePackageVersion,
    publishedVersionCode,
    rewritePackageVersion,
    versionFromCode,
    type PublishedVersion,
    type VersionDecision,
    type VersionTarget,
} from "./version";
export { preparePlan, requireAccounts, type Logger } from "./pipeline";
export { publishResource, type PublishOptions, type PublishResult } from "./publish";
export { updateResource, type UpdateOptions, type UpdateResult } from "./update";
export { resourceStatus, type ResourceStatus } from "./status";
export { planKeyPrune, pruneKeys, type ResourceKeyPlan, type StaleKey } from "./keys";
export { loadState, loadUpdateState, STATE_FILE_NAME, UPDATE_STATE_FILE_NAME } from "./state";
