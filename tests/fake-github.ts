/**
 * 内存版 GitHub：覆盖发布 / 更新流程实际用到的 REST 接口（refs、blobs、trees、
 * commits、contents、pulls、fork 同步），供流程测试替换 globalThis.fetch。
 * 未覆盖的接口直接抛错，避免测试悄悄走到真实网络。
 */
import { createHash } from "node:crypto";

interface Commit {
  tree: string;
  parents: string[];
  message: string;
}

interface Repo {
  owner: string;
  name: string;
  branches: Map<string, string>;
  topics: string[];
  homepage?: string;
  fork?: { owner: string; name: string };
}

export interface FakePull {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  user: string;
  head: { owner: string; repo: string; ref: string };
  base: { owner: string; repo: string; ref: string };
}

export interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
}

function sha1(text: string) {
  return createHash("sha1").update(text).digest("hex");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(message = "Not Found") {
  return json({ message }, 404);
}

export class FakeGithub {
  repos = new Map<string, Repo>();
  blobs = new Map<string, string>(); // sha -> base64
  trees = new Map<string, Map<string, string>>(); // sha -> path -> blob sha
  commits = new Map<string, Commit>();
  pulls: FakePull[] = [];
  requests: RecordedRequest[] = [];
  devicesJson: unknown = {};
  private counter = 0;

  constructor(readonly login: string) {}

  // ---- 数据准备 ----

  blob(content: Uint8Array | string): string {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const base64 = Buffer.from(bytes).toString("base64");
    const sha = sha1(`blob:${base64}`);
    this.blobs.set(sha, base64);
    return sha;
  }

  private tree(entries: Map<string, string>): string {
    const sha = sha1(`tree:${JSON.stringify([...entries].sort())}:${this.counter++}`);
    this.trees.set(sha, entries);
    return sha;
  }

  private commit(tree: string, parents: string[], message: string): string {
    const sha = sha1(`commit:${tree}:${parents.join(",")}:${message}:${this.counter++}`);
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  /** 建仓库，并在 branch 上放一个包含 files 的提交。返回提交 sha。 */
  seedRepo(
    owner: string,
    name: string,
    files: Record<string, Uint8Array | string>,
    options: { branch?: string; fork?: { owner: string; name: string } } = {},
  ): string {
    const key = `${owner}/${name}`.toLowerCase();
    const repo = this.repos.get(key) ?? {
      owner,
      name,
      branches: new Map(),
      topics: [],
      fork: options.fork,
    };
    this.repos.set(key, repo);
    const entries = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) entries.set(path, this.blob(content));
    const commit = this.commit(this.tree(entries), [], "seed");
    repo.branches.set(options.branch ?? "main", commit);
    return commit;
  }

  addPull(pull: Omit<FakePull, "base"> & { base?: FakePull["base"] }, upstream: { owner: string; name: string }) {
    this.pulls.push({ base: { owner: upstream.owner, repo: upstream.name, ref: "main" }, ...pull });
  }

  // ---- 查询 ----

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`.toLowerCase());
  }

  /** 读取 owner/name 在 ref（分支或 commit 前缀）下的文件内容。 */
  file(owner: string, name: string, ref: string, path: string): Uint8Array | undefined {
    const sha = this.resolveRef(owner, name, ref);
    if (!sha) return undefined;
    const blobSha = this.trees.get(this.commits.get(sha)!.tree)?.get(path);
    return blobSha ? new Uint8Array(Buffer.from(this.blobs.get(blobSha)!, "base64")) : undefined;
  }

  text(owner: string, name: string, ref: string, path: string): string | undefined {
    const bytes = this.file(owner, name, ref, path);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  head(owner: string, name: string, branch = "main"): string | undefined {
    return this.repo(owner, name)?.branches.get(branch);
  }

  writes(): RecordedRequest[] {
    return this.requests.filter((request) => request.method !== "GET");
  }

  private resolveRef(owner: string, name: string, ref: string): string | undefined {
    const repo = this.repo(owner, name);
    if (!repo) return undefined;
    const branch = repo.branches.get(ref);
    if (branch) return branch;
    for (const sha of this.commits.keys()) if (sha.startsWith(ref)) return sha;
    return undefined;
  }

  // ---- fetch ----

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    // 浏览器形态下 github-actions 会把 api.github.com 改写成 /github-api/ 代理
    const href = raw.startsWith("/github-api/") ? `https://api.github.com/${raw.slice(12)}` : raw;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url: url.toString(), body });

    if (url.pathname.endsWith("devices_v2.json")) return json(this.devicesJson);
    if (url.hostname !== "api.github.com") throw new Error(`FakeGithub: 未模拟的地址 ${method} ${href}`);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (parts[0] === "orgs") return json([]);
    if (parts[0] === "search") return json({ items: [] });
    if (parts[0] === "user" && parts[1] === "repos" && method === "POST") {
      if (this.repo(this.login, body.name)) return json({ message: "name already exists on this account", errors: [{ message: "name already exists on this account" }] }, 422);
      this.seedRepo(this.login, body.name, { "README.md": `# ${body.name}\n` }); // auto_init
      return json({ name: body.name, owner: { login: this.login }, default_branch: "main", html_url: `https://github.com/${this.login}/${body.name}` }, 201);
    }
    if (parts[0] !== "repos") throw new Error(`FakeGithub: 未模拟的接口 ${method} ${href}`);

    const [, owner, name, ...rest] = parts;
    const repo = this.repo(owner, name);
    const route = rest.join("/");

    if (rest.length === 0) {
      if (!repo) return notFound();
      if (method === "PATCH") {
        repo.homepage = body?.homepage;
        return json({});
      }
      return json({
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        default_branch: "main",
        html_url: `https://github.com/${repo.owner}/${repo.name}`,
        fork: Boolean(repo.fork),
        parent: repo.fork ? { owner: { login: repo.fork.owner }, name: repo.fork.name } : undefined,
      });
    }
    if (!repo && route !== "forks") return notFound();

    if (route === "topics") {
      repo!.topics = body?.names ?? [];
      return json({ names: repo!.topics });
    }

    // refs
    const refMatch = /^git\/refs?\/(?:heads\/)?(.+)$/.exec(route);
    if (refMatch && route !== "git/refs") {
      const branch = refMatch[1];
      if (method === "PATCH") {
        repo!.branches.set(branch, body.sha);
        return json({ object: { sha: body.sha } });
      }
      const sha = repo!.branches.get(branch);
      return sha ? json({ ref: `refs/heads/${branch}`, object: { sha } }) : notFound();
    }
    if (route === "git/refs" && method === "POST") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (repo!.branches.has(branch)) return json({ message: "Reference already exists" }, 422);
      repo!.branches.set(branch, body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }

    // git 对象
    if (route === "git/blobs" && method === "POST") return json({ sha: this.blob(new Uint8Array(Buffer.from(body.content, "base64"))) }, 201);
    if (route.startsWith("git/blobs/")) {
      const content = this.blobs.get(rest[2]);
      return content ? json({ content, encoding: "base64" }) : notFound();
    }
    if (route === "git/trees" && method === "POST") {
      const entries = new Map(this.trees.get(body.base_tree) ?? []);
      for (const entry of body.tree as Array<{ path: string; sha: string | null }>) {
        if (entry.sha === null) entries.delete(entry.path);
        else entries.set(entry.path, entry.sha);
      }
      return json({ sha: this.tree(entries) }, 201);
    }
    if (route.startsWith("git/trees/")) {
      const tree = this.trees.get(rest[2]) ?? this.trees.get(this.commits.get(rest[2])?.tree ?? "");
      if (!tree) return notFound();
      return json({ sha: rest[2], truncated: false, tree: [...tree].map(([path, sha]) => ({ path, sha, type: "blob", mode: "100644" })) });
    }
    if (route === "git/commits" && method === "POST") {
      return json({ sha: this.commit(body.tree, body.parents ?? [], body.message) }, 201);
    }
    if (route.startsWith("git/commits/") || route.startsWith("commits/")) {
      const sha = this.resolveRef(owner, name, rest[rest.length - 1]);
      const commit = sha ? this.commits.get(sha) : undefined;
      if (!sha || !commit) return notFound();
      return json({ sha, tree: { sha: commit.tree }, parents: commit.parents.map((p) => ({ sha: p })), commit: { tree: { sha: commit.tree }, message: commit.message } });
    }

    // contents
    if (rest[0] === "contents") {
      const path = rest.slice(1).join("/");
      const ref = url.searchParams.get("ref") ?? "main";
      const bytes = this.file(owner, name, ref, path);
      if (!bytes) return notFound();
      const sha = this.resolveRef(owner, name, ref)!;
      return json({ path, sha: this.trees.get(this.commits.get(sha)!.tree)!.get(path), encoding: "base64", content: Buffer.from(bytes).toString("base64") });
    }

    // fork 与同步
    if (route === "forks" && method === "POST") {
      const fork = [...this.repos.values()].find(
        (item) => item.fork?.owner === owner && item.fork?.name === name && item.owner === this.login,
      );
      if (!fork) throw new Error("FakeGithub: 测试需预先 seed fork 仓库");
      return json({ name: fork.name, owner: { login: fork.owner }, default_branch: "main", full_name: `${fork.owner}/${fork.name}` }, 202);
    }
    if (route === "merge-upstream" && method === "POST") {
      const upstream = this.repo(repo!.fork!.owner, repo!.fork!.name)!;
      repo!.branches.set(body.branch, upstream.branches.get(body.branch)!);
      return json({ merge_type: "fast-forward" });
    }
    if (route === "merges" && method === "POST") {
      // 简化：上游没有与 PR 分支冲突的改动，合并结果保留 PR 分支的树
      const head = repo!.branches.get(body.base)!;
      const merged = this.commit(this.commits.get(head)!.tree, [head, body.head], "merge upstream");
      repo!.branches.set(body.base, merged);
      return json({ sha: merged }, 201);
    }
    if (rest[0] === "compare") return json({ status: "identical", ahead_by: 0, behind_by: 0 });

    // PR
    if (route === "pulls" && method === "POST") {
      const pull: FakePull = {
        number: 1000 + this.pulls.length + 1,
        title: body.title,
        body: body.body,
        state: "open",
        user: this.login,
        head: { owner: String(body.head).split(":")[0], repo: body.head_repo ?? this.forkNameFor(owner, name), ref: String(body.head).split(":")[1] },
        base: { owner, repo: name, ref: body.base },
      };
      this.pulls.push(pull);
      return json(this.pullJson(pull), 201);
    }
    if (route === "pulls") {
      const state = url.searchParams.get("state") ?? "open";
      return json(this.pulls.filter((pull) => state === "all" || pull.state === state).map((pull) => this.pullJson(pull)));
    }
    const pullMatch = /^pulls\/(\d+)(\/files)?$/.exec(route);
    if (pullMatch) {
      const pull = this.pulls.find((item) => item.number === Number(pullMatch[1]));
      if (!pull) return notFound();
      if (pullMatch[2]) return json(this.pullFiles(pull));
      if (method === "PATCH") Object.assign(pull, body);
      return json(this.pullJson(pull));
    }
    if (/^issues\/\d+\/comments$/.test(route)) return json(method === "POST" ? {} : []);
    if (/^pulls\/\d+\/reviews$/.test(route)) return json([]);

    throw new Error(`FakeGithub: 未模拟的接口 ${method} ${href}`);
  };

  private forkNameFor(owner: string, name: string) {
    return [...this.repos.values()].find((item) => item.fork?.owner === owner && item.fork?.name === name)?.name ?? name;
  }

  private pullJson(pull: FakePull) {
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged_at: null,
      html_url: `https://github.com/${pull.base.owner}/${pull.base.repo}/pull/${pull.number}`,
      user: { login: pull.user },
      head: { ref: pull.head.ref, sha: this.head(pull.head.owner, pull.head.repo, pull.head.ref), repo: { name: pull.head.repo, owner: { login: pull.head.owner } } },
      base: { ref: pull.base.ref },
    };
  }

  /** PR 改动的文件：PR 分支相对上游 main 新增 / 变化的路径。 */
  private pullFiles(pull: FakePull) {
    const headSha = this.head(pull.head.owner, pull.head.repo, pull.head.ref);
    const baseSha = this.head(pull.base.owner, pull.base.repo, pull.base.ref);
    const headTree = headSha ? this.trees.get(this.commits.get(headSha)!.tree)! : new Map<string, string>();
    const baseTree = baseSha ? this.trees.get(this.commits.get(baseSha)!.tree)! : new Map<string, string>();
    return [...headTree]
      .filter(([path, sha]) => baseTree.get(path) !== sha)
      .map(([filename, sha]) => ({ filename, sha, status: baseTree.has(filename) ? "modified" : "added" }));
  }
}
