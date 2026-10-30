/*
 * src/core/confirmQueue.ts —— 通用确认弹窗的排队
 *
 * 问题：确认弹窗（#modal-confirm）只有一个，但 irConfirm 会被多条异步流程同时调用
 * （「删除模型」的确认还没答完，自动备份的「导出？」又弹出来）。旧实现是单槽 resolve：
 * 后一次调用直接覆盖前一次的 resolve → 前一个 Promise 永不落地，调用方的 await 永久挂起，
 * 连 toast 都不会出，表现为「点了删除，什么都没发生，也不报错」。
 *
 * 契约：按调用顺序排队，只有**队头**显示在弹窗里；收尾只收队头，后面还有人问就
 * 就地换成下一条（弹窗不关、焦点不跳）；队列空了才算真正关窗。
 *
 * 纯逻辑、无 DOM / 存储依赖：显示与关窗由 src/app/core.js 负责，单测见 eval/ui-state-test.js。
 */

interface ConfirmJob {
  message: string;
  opts: any;
  resolve: (value: any) => void;
}

function createConfirmQueue() {
  const items: ConfirmJob[] = [];
  return {
    /** 入队；返回排到的位置（1 = 队头，调用方此刻应把它显示出来） */
    push(job: ConfirmJob): number {
      items.push(job);
      return items.length;
    },
    /** 队头（没人排队时为 null） */
    head(): ConfirmJob | null {
      return items.length ? items[0] : null;
    },
    /** 收掉队头并返回（空队列返回 null）；调用方负责 resolve 它 */
    shift(): ConfirmJob | null {
      return items.length ? items.shift() : null;
    },
    /** 排队人数（含正在显示的那条） */
    size(): number {
      return items.length;
    },
  };
}

export { createConfirmQueue };
export type { ConfirmJob };
