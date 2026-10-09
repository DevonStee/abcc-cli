import { describe, expect, test } from "bun:test";
import { buildPlan, buildPlanManifest, type PublishedBaseline } from "@abcc/publish-core/plan";
import { loadSpec, SpecError } from "@abcc/publish-core/spec";
import { decidePackageVersion } from "@abcc/publish-core/version";
import { readPackageVersion } from "~/logic/publish/package-version";
import { baseFiles, baseSpec, makeResourceDir, watchfaceBin } from "./helpers";

const ID = "979812217215";
const v = (version: string, versionCode: number) => ({ version, versionCode });

describe("decidePackageVersion", () => {
  test("新上架（无线上版本）原样使用包体版本", () => {
    expect(decidePackageVersion({ current: v("0.0.0", 0), previous: [] })).toEqual({
      kind: "keep",
      target: v("0.0.0", 0),
    });
  });

  test("包体 0.0.0、线上 1.0.1 → 线上末位 +1 = 1.0.2", () => {
    expect(decidePackageVersion({ current: v("0.0.0", 0), previous: [v("1.0.1", 65537)] })).toEqual({
      kind: "rewrite",
      from: v("0.0.0", 0),
      target: v("1.0.2", 65538),
      reason: "auto-increment",
    });
  });

  test("包体与线上相同版本也要 +1", () => {
    const decision = decidePackageVersion({ current: v("0.0.1", 1), previous: [v("0.0.1", 1)] });
    expect(decision.kind === "rewrite" && decision.target).toEqual(v("0.0.2", 2));
  });

  test("共用包体的设备线上版本不一致时，以最高的为基准", () => {
    const decision = decidePackageVersion({
      current: v("0.0.0", 0),
      previous: [v("0.0.0", 0), v("1.0.1", 65537)],
    });
    expect(decision.kind === "rewrite" && decision.target).toEqual(v("1.0.2", 65538));
  });

  test("包体版本已大于线上（创作者自己升过）则不改", () => {
    expect(decidePackageVersion({ current: v("2.0.0", 131072), previous: [v("1.0.1", 65537)] }).kind).toBe(
      "keep",
    );
  });

  test("abcc.json 指定大版本，写进包体", () => {
    expect(
      decidePackageVersion({ current: v("0.0.0", 0), previous: [v("1.0.1", 65537)], requested: "2.0.0" }),
    ).toEqual({ kind: "rewrite", from: v("0.0.0", 0), target: v("2.0.0", 131072), reason: "requested" });
  });

  test("指定的版本不大于线上时报错", () => {
    const decision = decidePackageVersion({
      current: v("0.0.0", 0),
      previous: [v("1.0.1", 65537)],
      requested: "1.0.1",
    });
    expect(decision.kind).toBe("error");
  });

  test("末位已到 255 不自动进位，要求手动指定", () => {
    const decision = decidePackageVersion({ current: v("0.0.0", 0), previous: [v("1.0.255", 65791)] });
    expect(decision.kind === "error" && decision.message).toContain("2.0.0");
  });

  test("旧 manifest 缺 versionCode 时按 version 推算", () => {
    const decision = decidePackageVersion({ current: v("0.0.0", 0), previous: [{ version: "1.0.1" }] });
    expect(decision.kind === "rewrite" && decision.target).toEqual(v("1.0.2", 65538));
  });
});

/** DOT MATRIX 事故时的线上状态：xmb10/10nfc/11 为 1.0.1，xmb11nfc 为 0.0.0。 */
function dotMatrixBaseline(): PublishedBaseline {
  return {
    downloads: {
      xmb10: { version: "1.0.1", file_name: "downloads/Dot Matrix.bin", versionCode: 65537 },
      xmb10nfc: { version: "1.0.1", file_name: "downloads/Dot Matrix.bin", versionCode: 65537 },
      xmb11: { version: "1.0.1", file_name: "downloads/Dot Matrix.bin", versionCode: 65537 },
      xmb11nfc: {
        version: "0.0.0",
        file_name: "downloads/Dot Matrix.bin",
        versionCode: 0,
        updatelogs: [{ version: "0.0.0", content: "首发" }],
      },
    },
    ext: {
      enableAstroBoxCreatorFeatures: true,
      bundledResources: { recommended: [{ type: "resource", id: "979800000001" }] },
      trialDownloads: { xmb10: { version: "1.0.0", file_name: "downloads/trial/t.bin", versionCode: 65536 } },
    },
    authors: [{ name: "DevonStee", bindABAccount: true }],
    links: [{ title: "小红书", url: "https://example.com", icon: "Link" }],
    encryptedDevices: new Set(["xmb10", "xmb10nfc", "xmb11", "xmb11nfc"]),
  };
}

async function updatePlan(spec: Record<string, unknown>, files: Record<string, Uint8Array> = {}) {
  const dir = makeResourceDir({
    ...baseFiles(spec),
    "band.bin": watchfaceBin({ id: ID, version: [0, 0, 0] }),
    "band9.bin": watchfaceBin({ id: ID, version: [0, 0, 0], seed: 9 }),
    ...files,
  });
  return buildPlan(loadSpec(dir), dotMatrixBaseline());
}

describe("更新：版本写进包体", () => {
  const spec = baseSpec({
    id: ID,
    downloads: [
      { devices: ["xmb10", "xmb10nfc", "xmb11", "xmb11nfc"], file: "band.bin", encrypt: false, changelog: "适配手环 9" },
      { devices: ["xmb9"], file: "band9.bin", encrypt: false },
    ],
  });

  test("包体 0.0.0 被改写成 1.0.2，manifest 由改写后的包体读出", async () => {
    const plan = await updatePlan(spec);
    expect(plan.problems).toEqual([]);

    const band = plan.packages.find((pkg) => pkg.source === "band.bin")!;
    expect(band.versionChange?.reason).toBe("auto-increment");
    // 真实读取改写后的包体字节，而不是只看 manifest 字段
    const bytes = new Uint8Array(await band.file.arrayBuffer());
    expect(Array.from(bytes.subarray(4, 7))).toEqual([2, 0, 1]); // patch, minor, major
    expect(await readPackageVersion(band.file)).toMatchObject({ version: "1.0.2", versionCode: 65538 });

    const manifest = JSON.parse(buildPlanManifest(plan, ID, "someone").manifestJson);
    for (const device of ["xmb10", "xmb10nfc", "xmb11", "xmb11nfc"]) {
      expect(manifest.downloads[device]).toMatchObject({ version: "1.0.2", versionCode: 65538 });
    }
  });

  test("新增设备没有线上版本，按包体版本走", async () => {
    const plan = await updatePlan(spec);
    const band9 = plan.packages.find((pkg) => pkg.source === "band9.bin")!;
    expect(band9.versionChange).toBeUndefined();
    const manifest = JSON.parse(buildPlanManifest(plan, ID, "someone").manifestJson);
    expect(manifest.downloads.xmb9).toMatchObject({ version: "0.0.0", versionCode: 0 });
  });

  test("保留线上更新日志并追加本次日志", async () => {
    const plan = await updatePlan(spec);
    const manifest = JSON.parse(buildPlanManifest(plan, ID, "someone").manifestJson);
    expect(manifest.downloads.xmb11nfc.updatelogs).toEqual([
      { version: "0.0.0", content: "首发" },
      { version: "1.0.2", content: "适配手环 9" },
    ]);
    expect(manifest.downloads.xmb10.updatelogs).toEqual([{ version: "1.0.2", content: "适配手环 9" }]);
  });

  test("指定 version 时写入指定的大版本", async () => {
    const plan = await updatePlan(
      baseSpec({ id: ID, downloads: [{ devices: ["xmb10"], file: "band.bin", version: "2.0.0" }] }),
    );
    expect(await readPackageVersion(plan.packages[0].file)).toMatchObject({ version: "2.0.0", versionCode: 131072 });
  });

  test("指定的版本不大于线上时校验不通过", async () => {
    const plan = await updatePlan(
      baseSpec({ id: ID, downloads: [{ devices: ["xmb10"], file: "band.bin", version: "1.0.1" }] }),
    );
    expect(plan.problems.join()).toContain("必须大于线上");
  });

  test("沿用作者、链接、ext 与试用包", async () => {
    const plan = await updatePlan(spec);
    const manifest = JSON.parse(buildPlanManifest(plan, ID, "someone").manifestJson);
    expect(manifest.item.author).toEqual([{ name: "DevonStee", bindABAccount: true }]);
    expect(manifest.links).toEqual([{ title: "小红书", url: "https://example.com", icon: "Link" }]);
    expect(manifest.ext.bundledResources).toBeDefined();
    expect(manifest.ext.trialDownloads.xmb10.file_name).toBe("downloads/trial/t.bin");
    expect(manifest.ext.enableAstroBoxCreatorFeatures).toBe(true);
  });
});

describe("更新：keep 沿用线上包体", () => {
  test("沿用旧路径与版本，不上传", async () => {
    const plan = await updatePlan(
      baseSpec({
        id: ID,
        downloads: [
          { devices: ["xmb10", "xmb10nfc", "xmb11", "xmb11nfc"], keep: true },
          { devices: ["xmb9"], file: "band9.bin" },
        ],
      }),
    );
    expect(plan.problems).toEqual([]);
    const manifest = buildPlanManifest(plan, ID, "someone");
    const kept = manifest.downloadAssets.find((asset) => asset.platformId === "xmb10")!;
    expect(kept).toMatchObject({ path: "downloads/Dot Matrix.bin", skipUpload: true, version: "1.0.1", versionCode: 65537 });
    expect(kept.encryptOnUpload).toBe(true);
  });

  test("keep 不能用于新资源", async () => {
    const dir = makeResourceDir(baseFiles(baseSpec({ downloads: [{ devices: ["xmb10"], keep: true }] })));
    const plan = await buildPlan(loadSpec(dir));
    expect(plan.problems.join()).toContain("keep 只能用于更新");
  });

  test("keep 组不能再写 file", () => {
    const dir = makeResourceDir(baseFiles(baseSpec({ downloads: [{ devices: ["xmb10"], keep: true, file: "band.bin" }] })));
    expect(() => loadSpec(dir)).toThrow(SpecError);
  });
});

describe("付费必须加密", () => {
  const files = (spec: object) => makeResourceDir(baseFiles(spec));

  test("配置了 pricing 的设备未加密时报错", async () => {
    const dir = files(
      baseSpec({
        downloads: [{ devices: ["xmb10"], file: "band.bin", encrypt: false }],
        pricing: { afdian: ["https://afdian.com/item/x?plan_id=p&sku=[{\"sku_id\":\"s\"}]"], devices: "all" },
      }),
    );
    expect((await buildPlan(loadSpec(dir))).problems.join()).toContain("付费表盘必须加密");
  });

  test("paidType 为 paid 时所有设备都要加密", async () => {
    const dir = files(baseSpec({ paidType: "paid", downloads: [{ devices: ["xmb10"], file: "band.bin" }] }));
    expect((await buildPlan(loadSpec(dir))).problems.join()).toContain("xmb10");
  });

  test("免费表盘加密（allowFreeEncryption）或不加密都可以", async () => {
    const encrypted = files(
      baseSpec({ allowFreeEncryption: true, downloads: [{ devices: ["xmb10"], file: "band.bin", encrypt: true }] }),
    );
    expect((await buildPlan(loadSpec(encrypted))).problems.join()).not.toContain("付费表盘必须加密");
    const plain = files(baseSpec());
    expect((await buildPlan(loadSpec(plain))).problems.join()).not.toContain("付费表盘必须加密");
  });
});
