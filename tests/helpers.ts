import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 只含签名与 IHDR 的 PNG 头，足够读出宽高。 */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** 小米表盘 bin：magic + offset4 版本（patch, minor, major）+ offset40 的 12 位 ID。 */
export function watchfaceBin(options: { id?: string; version?: [number, number, number]; seed?: number } = {}) {
  const bytes = new Uint8Array(256);
  bytes.set([0x5a, 0xa5, 0x34, 0x12], 0);
  const [major, minor, patch] = options.version ?? [1, 0, 0];
  bytes.set([patch, minor, major], 4);
  bytes.set(new TextEncoder().encode(options.id ?? "000000000000"), 40);
  for (let i = 64; i < bytes.length; i += 1) bytes[i] = (i * 7 + (options.seed ?? 0)) % 256;
  return bytes;
}

/** 在临时目录里按 { 相对路径: 内容 } 建一个资源目录。 */
export function makeResourceDir(files: Record<string, Uint8Array | string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), "abcc-cli-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    if (content instanceof Uint8Array || typeof content === "string") {
      writeFileSync(full, content);
    } else {
      writeFileSync(full, JSON.stringify(content, null, 2));
    }
  }
  return dir;
}

export function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    id: null,
    name: "Test Face",
    description: "测试表盘",
    tags: ["小米", "像素", "LED"],
    icon: "media/icon.png",
    cover: "media/cover.png",
    preview: ["media/preview.png"],
    downloads: [{ devices: ["xmb10", "xmb10nfc"], file: "band.bin", encrypt: false }],
    ...overrides,
  };
}

export function baseFiles(spec: object = baseSpec()): Record<string, Uint8Array | string | object> {
  return {
    "abcc.json": spec,
    "band.bin": watchfaceBin(),
    "media/icon.png": pngHeader(200, 200),
    "media/cover.png": pngHeader(300, 200),
    "media/preview.png": pngHeader(336, 480),
  };
}
