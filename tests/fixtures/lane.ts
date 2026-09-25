import type { ActionAdapter } from '../../src/core/types.ts';

/**
 * 脚本化 Agent 车道：驱动真实任务图的测试用它们代替真实模型。
 *
 * 三个自己踩过才知道的坑：
 * 1. `user.begin` 需要**已知项目**（`projects: [{ id, root }]`），否则报
 *    `A known project and nonempty request are required`。
 * 2. worker 车道必须产出符合 `result_handoff@1` 的结果，否则节点以
 *    `result_noncompliant` 被 block，**下游车道永远不会派发**。
 * 3. 节点完成是**异步结算**的：一次 `host.runReady()` 不够，后继节点要等前驱
 *    结算完才 ready。用 `settle(...)` 轮询派发。
 */

export const laneUsage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 };

/** `result_handoff@1` 的完整形状：顶层字段一个都不能少，空列表也要保留。 */
export const laneResult = (workSummary = 'lane done') => ({
  schemaVersion: 1,
  objective: 'run one lane',
  outcome: 'completed',
  workSummary,
  changes: [],
  decisions: [],
  verification: [],
  knownLimits: [],
  openQuestions: [],
  nextActions: [],
});

export interface ScriptedLane {
  action: ActionAdapter;
  /** 每条已派发车道实际收到的 briefing，按派发顺序；它包含该定义的能力清单。 */
  briefings: string[];
  /** 每条已派发车道的工作副本路径。 */
  workspaces: string[];
}

/** 一条立即成功、并把 briefing 与工作副本记下来的车道。 */
export function scriptedLane(workSummary?: string): ScriptedLane {
  const briefings: string[] = [];
  const workspaces: string[] = [];
  return {
    briefings,
    workspaces,
    action: {
      kind: 'agent',
      reserveTokens: 100,
      prepare: async operation => async () => {
        briefings.push(JSON.stringify(operation.context.briefing ?? {}));
        if (operation.workspace) workspaces.push(operation.workspace);
        return { outcome: 'completed', output: laneResult(workSummary), usage: laneUsage };
      },
    },
  };
}

/**
 * 反复派发直到 `ready()` 成立。节点结算异步，所以要在循环里调
 * `host.runReady()`，不能只调一次。
 */
export async function settle(
  ready: () => boolean,
  tick: () => Promise<unknown>,
  attempts = 200,
  delayMs = 20,
): Promise<void> {
  for (let attempt = 0; attempt < attempts && !ready(); attempt += 1) {
    await tick();
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}
