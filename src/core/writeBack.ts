/*
 * src/core/writeBack.ts —— 异步写回契约
 *
 * 问题：回合 / 书记员 / 压缩 / 画师 / 导入整理都是「发起时认准目标 → await 网络 → 写回目标」
 * 的续体。等待期间用户可能换故事、关弹窗、开新任务——快捷键 / 深链 / 桌面壳等任何绕过 UI
 * S.busy 拦截的新入口都可能让回包落地时目标已经不是发起时那个：旧档丢一轮数据、新档被串写。
 *
 * 契约：发起异步工作时快照目标（故事 id / 任务对象），写回前必须过闸。三种形态：
 *   ① 断言式 assertStory(current, sid, where)
 *        —— 大块写回（回合续体）前核 id；false = 目标已换，整段写回放弃（不留警告以外的痕迹）。
 *   ② 闸门式 writeBackIfSameStory(current, sid, apply) / writeBackIfSameJob(current, job, apply)
 *        —— 把「回包写回」收敛进回调；目标已换则回调整段不执行。
 *   ③ 归位式 resolveWriteBackStory(current, origin) / writeBackToStory(current, origin, apply)
 *        —— 写回「发起时那本」故事（画师线程语义）：换档也照写原故事，切走再切回时按 id
 *          认回当前对象（避免旧副本覆盖存盘）；返回值告知调用方是否仍是当前故事，
 *          不是则由调用方负责离线落盘（Store.saveStory）。
 *
 * 纯逻辑、无 DOM / 网络 / 存储依赖：单测见 eval/writeback-test.js。
 */

interface StoryLike {
  id?: string | null;
}

/** 目标是否仍是「发起时的那本故事」（按 id 认；空 id 不算同一本） */
function isSameStory(current: any, sid: any): boolean {
  return !!(current && sid != null && sid !== '' && current.id === sid);
}

/**
 * 断言式写回闸：仍是同一本 → true；已换档 / 已关档 → console 留警告并返回 false，
 * 调用方立即放弃其后的所有写回。where 用于定位是哪条续体（'回合回包' / '书记员校对' …）。
 */
function assertStory(current: any, sid: any, where?: string): boolean {
  if (isSameStory(current, sid)) return true;
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[writeback] ' + (where || '续体') + '：故事已切换或已关闭，丢弃这次写回（发起于 ' + String(sid) + '）');
  }
  return false;
}

/** 闸门式写回闸：目标未换才执行 apply(current)；返回是否执行了写回 */
function writeBackIfSameStory(current: any, sid: any, apply: (story: any) => void): boolean {
  if (!isSameStory(current, sid)) return false;
  apply(current);
  return true;
}

/** 任务对象是否仍是「发起时那个」（按引用认：S.importJob / S.pw 一类） */
function isSameJob(current: any, job: any): boolean {
  return !!job && current === job;
}

/** 任务对象的写回闸：已被置空 / 换成新任务则整段不执行（导入整理续体） */
function writeBackIfSameJob(current: any, job: any, apply: (job: any) => void): boolean {
  if (!isSameJob(current, job)) return false;
  apply(job);
  return true;
}

/**
 * 归位式写回目标：当前对象仍是同一本（按 id 认，切走再切回是新对象也算）→ 用当前对象；
 * 否则写回发起时持有的那个对象本身（离线归位，由调用方落盘）。
 */
function resolveWriteBackStory(current: any, origin: any): any {
  if (current && origin && isSameStory(current, origin.id)) return current;
  return origin;
}

/**
 * 归位式写回闸：apply 收到归位后的目标故事；返回 true = 目标仍是当前故事（可顺手刷新界面），
 * false = 已切走（写回落在原故事对象上，调用方决定是否 Store.saveStory 离线落盘）。
 */
function writeBackToStory(current: any, origin: any, apply: (story: any) => void): boolean {
  const target = resolveWriteBackStory(current, origin);
  apply(target);
  return isSameStory(current, origin && origin.id) && target === current;
}

const WriteBack = {
  isSameStory,
  assertStory,
  writeBackIfSameStory,
  isSameJob,
  writeBackIfSameJob,
  resolveWriteBackStory,
  writeBackToStory,
};

// 调用方（turn / round / painter / importer）一律用 WriteBack.xxx；不再逐个二次导出
export { WriteBack };
