/**
 * abcc publish / update 端到端流程：GitHub 换成内存版（fake-github.ts），AstroBox 接口换成
 * 记录调用的桩。重点校验仓库里真正落下的东西——manifest、解密后的包体字节、
 * request.json——而不是只看函数返回值。
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realOrder from "../vendor/AstroBoxCreatorConsole/app/api/astrobox/order";
import * as realResource from "../vendor/AstroBoxCreatorConsole/app/api/astrobox/resource";
import { readFileSync } from "node:fs";
import { decryptAes256Ecb } from "@abcc/publish-core/crypto";
import { loadSpec } from "@abcc/publish-core/spec";
import { FakeGithub } from "./fake-github";
import { baseFiles, baseSpec, makeResourceDir, watchfaceBin } from "./helpers";

const LOGIN = "brin";
const ID = "979812217215";
const REPO = `astrobox-resource-${ID}`;
const UPSTREAM = { owner: "AstralSightStudios", name: "ABRepo-TestEnv" };
const SUBMISSION_DIR = `tmp/${LOGIN}/${REPO}`;

// ---- AstroBox 接口桩 ----

const cryptoReports: Array<{ deviceId: string; hash: string; key: string; commitSha: string }> = [];
const versionResets: Array<{ id: string; commitSha: string; resetRatings: boolean; foldComments: boolean }> = [];
let skus: Array<{ resourceId: string; deviceId: string; isPaid: boolean; validationStatus: string }> = [];

mock.module("../vendor/AstroBoxCreatorConsole/app/api/astrobox/resource", () => ({
  ...realResource,
  submitResourceCryptoInfo: async (body: (typeof cryptoReports)[number]) => {
    cryptoReports.push(body);
    return {};
  },
  registerVersionResetIntent: async (body: (typeof versionResets)[number]) => {
    versionResets.push(body);
    return { pending: true };
  },
}));
mock.module("../vendor/AstroBoxCreatorConsole/app/api/astrobox/order", () => ({
  ...realOrder,
  listSellerResourceFileKeys: async () => [],
  listSellerResourceConfigs: async () => ({ products: [], skus }),
  listExternalAuthorizations: async () => ({ configs: [] }),
}));

const { updateResource } = await import("@abcc/publish-core/update");
const { publishResource } = await import("@abcc/publish-core/publish");
const { setClientInfoProvider } = await import("../vendor/AstroBoxCreatorConsole/app/logic/publish/submission-protocol");
const { loadRepoEnvId, saveRepoEnvId } = await import("../vendor/AstroBoxCreatorConsole/app/config/repoEnv");
const { saveAccountState } = await import("../vendor/AstroBoxCreatorConsole/app/logic/account/store");
const { readPackageVersion } = await import("../vendor/AstroBoxCreatorConsole/app/logic/publish/package-version");

// ---- 线上状态：DOT MATRIX 事故前的样子 ----

const CSV_HEADER = "id,name,restype,repo_owner,repo_name,repo_commit_hash,icon,cover,tags,device_vendors,devices,paid_type";

function publishedManifest() {
  const download = (version: string, versionCode: number) => ({ version, file_name: "downloads/band.bin", versionCode });
  return {
    item: {
      id: ID,
      restype: "watchface",
      name: "Test Face",
      description: "旧简介",
      preview: ["media/preview.png"],
      icon: "media/icon.png",
      cover: "media/cover.png",
      author: [{ name: "brin", bindABAccount: true }],
    },
    links: [{ title: "小红书连接", url: "https://xhslink.cn/o/3V9Ehd5GIPQ", icon: "book" }],
    downloads: {
      xmb10: download("1.0.1", 65537),
      xmb10nfc: download("1.0.1", 65537),
      xmb11nfc: { ...download("0.0.0", 0), updatelogs: [{ version: "0.0.0", content: "首发" }] },
    },
  };
}

// 本文件会切换环境与 localStorage；结束后还原，避免影响同进程里的其他测试文件
const previousEnvId = loadRepoEnvId();
const previousLocalStorage = (globalThis as Record<string, unknown>).localStorage;

let github: FakeGithub;
let configDir: string;
const originalFetch = globalThis.fetch;
const storage = new Map<string, string>();

function seed() {
  github = new FakeGithub(LOGIN);
  github.devicesJson = {
    xiaomi: {
      M2401: { id: "xmb9", name: "小米手环 9" },
      M2501: { id: "xmb10", name: "小米手环 10" },
      M2502: { id: "xmb10nfc", name: "小米手环 10 NFC" },
      M2602: { id: "xmb11nfc", name: "小米手环 11 NFC" },
    },
  };
  const resourceCommit = github.seedRepo(LOGIN, REPO, {
    "manifest_v2.json": JSON.stringify(publishedManifest(), null, 2),
    "downloads/band.bin": watchfaceBin({ id: ID, version: [1, 0, 1] }),
  });
  const row = [ID, "Test Face", "watchface", LOGIN, REPO, resourceCommit.slice(0, 7), "media/icon.png", "media/cover.png", "小米;像素;LED", "xiaomi", "xmb10;xmb10nfc;xmb11nfc", ""].join(",");
  const catalog = { "index_v2.csv": `${CSV_HEADER}\n${row}\n` };
  github.seedRepo(UPSTREAM.owner, UPSTREAM.name, catalog);
  // 表盘 ID 去重固定对照正式环境目录
  github.seedRepo("AstralSightStudios", "AstroBox-Repo", { "index_v2.csv": `${CSV_HEADER}\n` });
  github.seedRepo(LOGIN, UPSTREAM.name, catalog, { fork: UPSTREAM });
  // fork 与上游 main 必须是同一个提交（createSubmissionBranch 会校验）
  github.repo(LOGIN, UPSTREAM.name)!.branches.set("main", github.head(UPSTREAM.owner, UPSTREAM.name)!);
  return resourceCommit;
}

/** 本地提交包：DOT MATRIX 那次的情形——包体自带 0.0.0，新增手环 9。 */
function localResource(overrides: Record<string, unknown> = {}) {
  const spec = baseSpec({
    id: ID,
    description: "新简介",
    downloads: [
      { devices: ["xmb10", "xmb10nfc", "xmb11nfc"], file: "band.bin", encrypt: true, changelog: "新增手环 9 支持" },
      { devices: ["xmb9"], file: "band9.bin", encrypt: true },
    ],
    allowFreeEncryption: true,
    ...overrides,
  });
  return makeResourceDir({
    ...baseFiles(spec),
    "band.bin": watchfaceBin({ id: "000000000000", version: [0, 0, 0] }),
    "band9.bin": watchfaceBin({ id: "000000000000", version: [0, 0, 0], seed: 9 }),
  });
}

function run(dir: string, logs: string[] = []) {
  return updateResource(loadSpec(dir), { env: "testenv", dryRun: false, log: (line) => logs.push(line) });
}

function manifestAt(ref = "main") {
  return JSON.parse(github.text(LOGIN, REPO, ref, "manifest_v2.json")!);
}

beforeEach(() => {
  storage.clear();
  // account/store 只在有 window 时读 localStorage（与 CLI runtime 一致）
  (globalThis as Record<string, unknown>).window ??= globalThis;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  // 经由账号模块写入：它有内存缓存，只改 localStorage 不会生效
  saveAccountState({
    github: { token: "gh-token", username: LOGIN },
    astrobox: { token: "ab-token", refreshToken: "ab-refresh", username: LOGIN },
  } as Parameters<typeof saveAccountState>[0]);
  saveRepoEnvId("testenv");
  configDir = mkdtempSync(join(tmpdir(), "abcc-config-"));
  process.env.ABCC_CONFIG_DIR = configDir;
  cryptoReports.length = 0;
  versionResets.length = 0;
  skus = [];
  seed();
  globalThis.fetch = github.fetch as typeof fetch;
  setClientInfoProvider(() => ({
    version: "abcc-cli@test",
    git_commit_hash: "abc1234",
    build_time: "2026-10-09T00:00:00Z",
    build_user: "abcc-cli",
  }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(configDir, { recursive: true, force: true });
  delete process.env.ABCC_CONFIG_DIR;
});

afterAll(() => {
  setClientInfoProvider(null);
  saveRepoEnvId(previousEnvId);
  (globalThis as Record<string, unknown>).localStorage = previousLocalStorage;
});

describe("abcc update：新建更新 PR", () => {
  test("仓库里的 manifest 与包体都是递增后的版本", async () => {
    const result = await run(localResource());
    const head = github.head(LOGIN, REPO)!;

    const manifest = manifestAt();
    for (const device of ["xmb10", "xmb10nfc", "xmb11nfc"]) {
      expect(manifest.downloads[device]).toMatchObject({ version: "1.0.2", versionCode: 65538 });
    }
    expect(manifest.downloads.xmb9).toMatchObject({ version: "0.0.0", versionCode: 0 });
    expect(manifest.downloads.xmb11nfc.updatelogs).toEqual([
      { version: "0.0.0", content: "首发" },
      { version: "1.0.2", content: "新增手环 9 支持" },
    ]);
    // 没写 links：保留线上定制的链接，不换成别的
    expect(manifest.links).toEqual(publishedManifest().links);
    expect(manifest.ext.enableAstroBoxCreatorFeatures).toBe(true);
    expect(manifest.item.description).toBe("新简介");

    // 仓库里的包体是密文：用上报给服务端的密钥解开，确认版本与表盘 ID 写在包体里
    const report = cryptoReports.find((item) => item.deviceId === "xmb10")!;
    expect(report.commitSha).toBe(head);
    const plain = decryptAes256Ecb(github.file(LOGIN, REPO, "main", "downloads/band.bin")!, report.key);
    expect(Array.from(plain.subarray(4, 7))).toEqual([2, 0, 1]);
    expect(await readPackageVersion(new File([plain as BlobPart], "band.bin"))).toMatchObject({
      version: "1.0.2",
      versionCode: 65538,
      identity: ID,
    });
    expect(cryptoReports.map((item) => item.deviceId).sort()).toEqual(["xmb10", "xmb10nfc", "xmb11nfc", "xmb9"]);

    // 新建 PR：标题、request.json（mode=edit + CLI 客户端信息）、目录行指向新提交
    const pull = github.pulls.at(-1)!;
    expect(pull.title).toBe("[ABCC] Update resource: Test Face");
    expect(result.prUrl).toContain(`/pull/${pull.number}`);
    const request = JSON.parse(github.text(LOGIN, UPSTREAM.name, pull.head.ref, `${SUBMISSION_DIR}/request.json`)!);
    expect(request).toMatchObject({ mode: "edit", original_id: ID });
    expect(request.client).toMatchObject({ version: "abcc-cli@test", build_user: "abcc-cli" });
    const csv = github.text(LOGIN, UPSTREAM.name, pull.head.ref, `${SUBMISSION_DIR}/resource.csv`)!;
    expect(csv).toContain(head.slice(0, 7));
    expect(csv).toContain("xmb9");

    expect(versionResets).toEqual([{ id: ID, commitSha: head, resetRatings: false, foldComments: false }]);
  });

  test("重跑同一命令不再写 GitHub（续跑幂等）", async () => {
    const dir = localResource();
    await run(dir);
    const writes = github.writes().length;
    const pulls = github.pulls.length;
    await run(dir);
    expect(github.writes().length).toBe(writes);
    expect(github.pulls.length).toBe(pulls);
  });

  test("指定 version 时写入指定版本", async () => {
    await run(
      localResource({
        downloads: [{ devices: ["xmb10", "xmb10nfc", "xmb11nfc"], file: "band.bin", encrypt: true, version: "2.0.0" }],
      }),
    );
    expect(manifestAt().downloads.xmb10).toMatchObject({ version: "2.0.0", versionCode: 131072 });
  });
});

describe("abcc update：在进行中的 PR 上更新", () => {
  function seedOpenPull(user = LOGIN) {
    const request = {
      schema_version: 1,
      mode: "edit",
      original_id: ID,
      base_entry_digest: "digest-from-first-submit",
      base_catalog_commit: "base-commit",
      client: null,
    };
    const forkHead = github.head(LOGIN, UPSTREAM.name)!;
    const branch = "astrobox-submit-1";
    github.repo(LOGIN, UPSTREAM.name)!.branches.set(branch, forkHead);
    // 让 PR 分支带上提交明细
    const blobCsv = github.blob(`${CSV_HEADER}\n${ID},Test Face,watchface,${LOGIN},${REPO},0000000,,,,,xmb10,\n`);
    const blobRequest = github.blob(`${JSON.stringify(request, null, 2)}\n`);
    const baseTree = github.commits.get(forkHead)!.tree;
    const tree = new Map(github.trees.get(baseTree)!);
    tree.set(`${SUBMISSION_DIR}/resource.csv`, blobCsv);
    tree.set(`${SUBMISSION_DIR}/request.json`, blobRequest);
    const treeSha = `tree-open-pr`;
    github.trees.set(treeSha, tree);
    github.commits.set("commit-open-pr", { tree: treeSha, parents: [forkHead], message: "submit" });
    github.repo(LOGIN, UPSTREAM.name)!.branches.set(branch, "commit-open-pr");
    github.addPull(
      { number: 1264, title: "[ABCC] Update resource: Test Face", state: "open", user, head: { owner: LOGIN, repo: UPSTREAM.name, ref: branch } },
      UPSTREAM,
    );
    return branch;
  }

  test("更新原 PR 分支，不新开 PR，保留首次提交的 request 字段", async () => {
    const branch = seedOpenPull();
    const result = await run(localResource());
    const head = github.head(LOGIN, REPO)!;

    expect(github.pulls).toHaveLength(1);
    expect(result.prUrl).toContain("/pull/1264");
    const request = JSON.parse(github.text(LOGIN, UPSTREAM.name, branch, `${SUBMISSION_DIR}/request.json`)!);
    expect(request).toMatchObject({ mode: "edit", original_id: ID, base_entry_digest: "digest-from-first-submit" });
    expect(request.client.version).toBe("abcc-cli@test");
    expect(github.text(LOGIN, UPSTREAM.name, branch, `${SUBMISSION_DIR}/resource.csv`)).toContain(head.slice(0, 7));
    expect(manifestAt().downloads.xmb10.versionCode).toBe(65538);
  });

  test("别人开着的 PR：中止且不写任何东西", async () => {
    seedOpenPull("someone-else");
    await expect(run(localResource())).rejects.toThrow("他人发起");
    expect(github.writes()).toHaveLength(0);
  });
});

describe("abcc update：写入前的拦截", () => {
  test("加密设备没有付费映射且未声明 allowFreeEncryption：中止，资源仓库不变", async () => {
    const before = github.head(LOGIN, REPO);
    await expect(run(localResource({ allowFreeEncryption: false }))).rejects.toThrow("没有付费映射");
    expect(github.head(LOGIN, REPO)).toBe(before);
    expect(github.writes().filter((request) => request.url.includes("/git/"))).toHaveLength(0);
    expect(cryptoReports).toHaveLength(0);
  });

  test("有付费 SKU 时放行", async () => {
    skus = ["xmb9", "xmb10", "xmb10nfc", "xmb11nfc"].map((deviceId) => ({
      resourceId: ID,
      deviceId,
      isPaid: true,
      validationStatus: "active",
    }));
    await run(localResource({ allowFreeEncryption: false }));
    expect(manifestAt().downloads.xmb10.versionCode).toBe(65538);
  });

  test("指定的版本不大于线上：校验失败，不写任何东西", async () => {
    const dir = localResource({
      downloads: [{ devices: ["xmb10"], file: "band.bin", encrypt: true, version: "1.0.1" }],
    });
    await expect(run(dir)).rejects.toThrow("必须大于线上");
    expect(github.writes()).toHaveLength(0);
  });

  test("目录里没有该资源：提示用 publish", async () => {
    await expect(run(localResource({ id: "979800000009" }))).rejects.toThrow("abcc publish");
  });
});

describe("abcc publish：新建发布", () => {
  function newResource() {
    return makeResourceDir({
      ...baseFiles(baseSpec({ name: "New Face" })),
      "band.bin": watchfaceBin({ version: [0, 0, 0] }),
    });
  }

  test("生成 ID 并回写，建仓、提交、开 create PR；新资源不改包体版本", async () => {
    const dir = newResource();
    const result = await publishResource(loadSpec(dir), { env: "testenv", dryRun: false, log: () => {} });

    const id = result.id;
    expect(id).toMatch(/^9798\d{8}$/);
    expect(JSON.parse(readFileSync(join(dir, "abcc.json"), "utf8")).id).toBe(id);

    const repo = `astrobox-resource-${id}`;
    const manifest = JSON.parse(github.text(LOGIN, repo, "main", "manifest_v2.json")!);
    expect(manifest.downloads.xmb10).toMatchObject({ version: "0.0.0", versionCode: 0 });
    expect(manifest.item.author).toEqual([{ name: LOGIN, bindABAccount: true }]);
    const pkg = github.file(LOGIN, repo, "main", manifest.downloads.xmb10.file_name)!;
    expect(await readPackageVersion(new File([pkg as BlobPart], "band.bin"))).toMatchObject({ identity: id, versionCode: 0 });
    expect(github.repo(LOGIN, repo)!.topics.length).toBeGreaterThan(0);

    const pull = github.pulls.at(-1)!;
    expect(pull.title).toBe("[ABCC] Add new resource: New Face");
    const request = JSON.parse(github.text(LOGIN, UPSTREAM.name, pull.head.ref, `tmp/${LOGIN}/${repo}/request.json`)!);
    expect(request).toMatchObject({ mode: "create", original_id: null });
    expect(request.client.version).toBe("abcc-cli@test");
  });

  test("重跑不重复建仓、不重复开 PR", async () => {
    const dir = newResource();
    await publishResource(loadSpec(dir), { env: "testenv", dryRun: false, log: () => {} });
    const writes = github.writes().length;
    const pulls = github.pulls.length;
    await publishResource(loadSpec(dir), { env: "testenv", dryRun: false, log: () => {} });
    expect(github.writes().length).toBe(writes);
    expect(github.pulls.length).toBe(pulls);
  });
});
