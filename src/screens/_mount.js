/*
 * src/screens/_mount.js —— 7 个屏幕挂载点的共用外壳
 *
 * 每个屏幕目录下的 index.js 只做一件事：把 index.html 里的容器内容换成组件输出。
 * 这段「取容器 → 清空 → 打标记 → mount」在 7 处逐字相同，因此收在这里维护一份，
 * 各屏只留「哪个容器配哪个组件」的声明。三条约定（阶段 4 逐屏验收依赖它们）：
 *
 *   1. **外层容器不动**：#screen-* / #modal-* / #story-prefs / #branch-page 本身
 *      不替换、不加删 class —— hidden 开关、弹窗栈 / 遮罩、焦点陷阱仍归
 *      src/ui/navigation.js 与 src/ui/modalHost.js；
 *   2. **data-impl="svelte"** 打在容器上：acceptance/tools/*.mjs 用它判断
 *      「这一屏已经由组件接管」，不要挪到组件内部；
 *   3. 只替换**内容**：replaceChildren() 之后 mount，组件产出的元素按既有 id 契约
 *      被 src/app/* 绑定（src/app/main.js 的 bind() 晚于挂载执行）。
 *
 * 容器不在（index.html 与挂载表不同步）时静默跳过：少一屏是可见的布局问题，
 * 比整页在 import 期抛错白屏更好定位。
 */
import { mount } from 'svelte';

/**
 * 把 Component 挂进 id 对应的容器。
 * @param {string} id 容器 id（不带 #）
 * @param {import('svelte').Component} Component 屏幕组件
 * @returns {ReturnType<typeof mount>|null} 组件实例；容器不存在时 null
 */
export function mountScreen(id, Component) {
  const host = document.getElementById(id);
  if (!host) return null;
  host.replaceChildren();
  host.dataset.impl = 'svelte';
  return mount(Component, { target: host });
}
