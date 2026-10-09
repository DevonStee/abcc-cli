/**
 * 查询已提交 PR 的审核状态，判定规则复用 GUI 的 review-status.ts
 * （按 [ABCC_NEEDFIX] / [ABCC_FIXED] 等评论推导）。
 */
import { PUBLISH_CONFIG } from "~/config/publish";
import { loadAccountState } from "~/logic/account/store";
import { githubFetch } from "~/logic/publish/github-actions";
import { deriveReviewStatus } from "~/logic/publish/review-status";
import { loadState, loadUpdateState } from "./state";

export interface ResourceStatus {
    dir: string;
    id?: string;
    stage: string;
    prUrl?: string;
    needFix: string[];
}

const REVIEW_LABELS: Record<string, string> = {
    waiting_review: "等待审核",
    changes_requested: "需要修改",
    fixed_waiting: "已修复，等待审核",
};

export async function resourceStatus(dir: string): Promise<ResourceStatus> {
    // 有更新进度时优先看更新 PR：新建的 PR 早已合并，更新才是当前在审的。
    const update = loadUpdateState(dir);
    if (update?.pr) return prStatus(dir, update.id, update.pr, "更新");
    const state = loadState(dir);
    if (!state) {
        return update
            ? { dir, id: update.id, stage: "更新未完成：PR 未提交", needFix: [] }
            : { dir, stage: "未发布", needFix: [] };
    }
    if (!state.pr) {
        const stage = !state.repoCommit
            ? "未完成：仓库未提交"
            : !state.submission
              ? "未完成：PR 未创建"
              : "未完成：PR 未创建（分支已建）";
        return { dir, id: state.id, stage, needFix: [] };
    }
    return prStatus(dir, state.id, state.pr, "");
}

async function prStatus(
    dir: string,
    id: string,
    prRef: { number: number; url: string },
    label: string,
): Promise<ResourceStatus> {
    const token = loadAccountState().github?.token;
    if (!token) throw new Error("未登录 GitHub，无法查询 PR 状态");
    const headers = { Authorization: `Bearer ${token}` };
    const base = `https://api.github.com/repos/${PUBLISH_CONFIG.targetPrRepoOwner}/${PUBLISH_CONFIG.targetPrRepoName}`;
    const pr = await githubFetch<{ state: string; merged_at?: string | null }>(
        `${base}/pulls/${prRef.number}`,
        { headers },
    );
    if (pr.merged_at) {
        return { dir, id, stage: `${label ? `${label}：` : ""}已合并（已上架）`, prUrl: prRef.url, needFix: [] };
    }
    const comments = await githubFetch<
        Array<{ id?: number; body?: string; created_at?: string; user?: { login: string } }>
    >(`${base}/issues/${prRef.number}/comments?per_page=100`, { headers });
    const review = deriveReviewStatus(comments);
    const refused = comments.some((comment) => /^\s*\[ABCC_REFUSE\]/i.test(comment.body || ""));
    const stage =
        pr.state === "closed"
            ? refused
                ? "已拒绝"
                : "已关闭"
            : (REVIEW_LABELS[review.state] ?? review.state);
    const prefix = label ? `${label}：` : "";
    return {
        dir,
        id,
        stage: `${prefix}${stage}`,
        prUrl: prRef.url,
        needFix: review.items.filter((item) => !item.fixed).map((item) => item.message),
    };
}
