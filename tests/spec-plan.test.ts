import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan, buildPlanManifest, checkDevices } from "@abcc/publish-core/plan";
import { loadSpec, SpecError, writeBackId } from "@abcc/publish-core/spec";
import { baseFiles, baseSpec, makeResourceDir, pngHeader, watchfaceBin } from "./helpers";

function specProblems(spec: object, extraFiles: Record<string, Uint8Array> = {}): string[] {
  const dir = makeResourceDir({ ...baseFiles(spec), ...extraFiles });
  try {
    loadSpec(dir);
    return [];
  } catch (error) {
    if (error instanceof SpecError) return error.problems;
    throw error;
  }
}

describe("abcc.json 解析", () => {
  test("合法规范不报错", () => {
    expect(specProblems(baseSpec())).toEqual([]);
  });

  test("不允许手填作者", () => {
    expect(specProblems(baseSpec({ author: [{ name: "x" }] })).join()).toContain("author");
  });

  test("只接受 .bin / .face", () => {
    const problems = specProblems(
      baseSpec({ downloads: [{ devices: ["xmb10"], file: "band.mwz" }] }),
      { "band.mwz": watchfaceBin() },
    );
    expect(problems.join()).toContain(".bin / .face");
  });

  test("同一台设备不能出现在两组里", () => {
    const problems = specProblems(
      baseSpec({
        downloads: [
          { devices: ["xmb10"], file: "band.bin" },
          { devices: ["xmb10"], file: "band.bin" },
        ],
      }),
    );
    expect(problems.join()).toContain("每台设备只能对应一个包");
  });

  test("路径不能指向资源目录之外", () => {
    expect(specProblems(baseSpec({ icon: "../icon.png" })).join()).toContain("资源目录之外");
  });

  test("pricing.devices 必须是下载里的设备", () => {
    const problems = specProblems(
      baseSpec({ pricing: { afdian: ["https://afdian.com/item/x"], devices: ["xmws4"] } }),
    );
    expect(problems.join()).toContain("xmws4");
  });

  test("回写 id 时保留其它字段", () => {
    const dir = makeResourceDir(baseFiles(baseSpec({ prBody: "keep me" })));
    const loaded = loadSpec(dir);
    writeBackId(loaded, "979812345678");
    const saved = JSON.parse(readFileSync(join(dir, "abcc.json"), "utf8"));
    expect(saved.id).toBe("979812345678");
    expect(saved.prBody).toBe("keep me");
    expect(loaded.spec.id).toBe("979812345678");
  });
});

describe("发布计划与 manifest", () => {
  test("多设备共用一个包时共用仓库路径，作者来自登录账号", async () => {
    const plan = await buildPlan(loadSpec(makeResourceDir(baseFiles())));
    expect(plan.problems).toEqual([]);
    const manifest = JSON.parse(buildPlanManifest(plan, "979812345678", "brin").manifestJson);
    expect(manifest.item).toMatchObject({
      id: "979812345678",
      restype: "watchface",
      icon: "media/icon.png",
      cover: "media/cover.png",
      preview: ["media/preview.png"],
      author: [{ name: "brin", bindABAccount: true }],
    });
    expect(manifest.downloads).toEqual({
      xmb10: { version: "1.0.0", file_name: "downloads/band.bin", versionCode: 65536 },
      xmb10nfc: { version: "1.0.0", file_name: "downloads/band.bin", versionCode: 65536 },
    });
    expect(manifest.ext).toEqual({});
  });

  test("不同包同名时追加设备 ID 后缀", async () => {
    const spec = baseSpec({
      downloads: [
        { devices: ["xmb10"], file: "band/face.bin" },
        { devices: ["xmws4"], file: "watch/face.bin" },
      ],
    });
    const dir = makeResourceDir({
      ...baseFiles(spec),
      "band/face.bin": watchfaceBin({ seed: 1 }),
      "watch/face.bin": watchfaceBin({ seed: 2 }),
    });
    const plan = await buildPlan(loadSpec(dir));
    const manifest = JSON.parse(buildPlanManifest(plan, "979812345678", "brin").manifestJson);
    expect(manifest.downloads.xmb10.file_name).toBe("downloads/face.bin");
    expect(manifest.downloads.xmws4.file_name).toBe("downloads/face-xmws4.bin");
  });

  test("加密但没有付费映射时拦截", async () => {
    const spec = baseSpec({
      downloads: [{ devices: ["xmb10"], file: "band.bin", encrypt: true }],
    });
    const plan = await buildPlan(loadSpec(makeResourceDir(baseFiles(spec))));
    expect(plan.problems.join()).toContain("没有配置 pricing");
  });

  test("加密 + 付费映射时开启 creator features", async () => {
    const spec = baseSpec({
      downloads: [{ devices: ["xmb10"], file: "band.bin", encrypt: true }],
      pricing: { afdian: ["https://afdian.com/order/create?plan_id=p1&sku=%5B%5D"], devices: "all" },
    });
    const plan = await buildPlan(loadSpec(makeResourceDir(baseFiles(spec))));
    expect(plan.problems).toEqual([]);
    const manifest = JSON.parse(buildPlanManifest(plan, "979812345678", "brin").manifestJson);
    expect(manifest.ext).toEqual({ enableAstroBoxCreatorFeatures: true });
  });

  test("图片规格沿用 GUI 校验：图标必须是正方形", async () => {
    const dir = makeResourceDir({ ...baseFiles(), "media/icon.png": pngHeader(200, 100) });
    const plan = await buildPlan(loadSpec(dir));
    expect(plan.problems.some((problem) => problem.includes("图标"))).toBe(true);
  });

  test("不同图片同名会互相覆盖，提前拦截", async () => {
    const spec = baseSpec({ preview: ["media/preview.png", "other/preview.png"] });
    const dir = makeResourceDir({ ...baseFiles(spec), "other/preview.png": pngHeader(336, 480) });
    const plan = await buildPlan(loadSpec(dir));
    expect(plan.problems.join()).toContain("文件名相同");
  });

  test("设备 ID 校验：未知设备与非小米设备", async () => {
    const plan = await buildPlan(loadSpec(makeResourceDir(baseFiles())));
    const problems = checkDevices(plan, [
      { id: "xmb10", name: "Xiaomi Smart Band 10", vendor: "xiaomi" },
      { id: "xmb10nfc", name: "vivo Test", vendor: "vivo" },
    ]);
    expect(problems.join()).toContain("不是小米设备");
    expect(checkDevices(plan, []).join()).toContain("未知设备 ID");
  });
});

describe("加密但免费", () => {
  test("显式 allowFreeEncryption 时放行", async () => {
    const spec = baseSpec({
      downloads: [{ devices: ["xmb10"], file: "band.bin", encrypt: true }],
      allowFreeEncryption: true,
    });
    const plan = await buildPlan(loadSpec(makeResourceDir(baseFiles(spec))));
    expect(plan.problems).toEqual([]);
    const manifest = JSON.parse(buildPlanManifest(plan, "979812345678", "brin").manifestJson);
    expect(manifest.ext).toEqual({ enableAstroBoxCreatorFeatures: true });
  });

  test("与 pricing 同时出现时报错", async () => {
    const spec = baseSpec({
      downloads: [{ devices: ["xmb10"], file: "band.bin", encrypt: true }],
      pricing: { afdian: ["https://afdian.com/x?plan_id=p&sku=%5B%5D"], devices: "all" },
      allowFreeEncryption: true,
    });
    const plan = await buildPlan(loadSpec(makeResourceDir(baseFiles(spec))));
    expect(plan.problems.join()).toContain("不需要 allowFreeEncryption");
  });
});
