<script>
  /* Modal.svelte —— 弹窗（阶段 3 组件库 / 阶段 4 屏 6a 起兼任「弹窗外壳」）
   * 结构对齐 css/style.css 的 .modal（遮罩 + 卡片 + 头 / 体 / 脚），但样式全部作用域限定，
   * 不复用 legacy 的全站类名（§8：组件库样式必须按作用域限定）。
   * 关闭途径：右上关闭按钮 / Esc。遮罩点击不关（表单弹窗防误触）。
   *
   * shell 模式（屏 6a）：只渲染一个 display:contents 的层容器，不画任何像素。
   * 11 个 legacy 弹窗由 src/ui/modalHost.js 整块搬进这个容器（节点本身不动，内部 DOM 一行不改），
   * 于是「弹窗有哪几块、外壳在哪」有了唯一落点——第 7 步的开合过渡与第 6b/6c 的重写都在这里接。
   * display:contents 不生成盒子：不产生包含块 / 层叠上下文 / 布局盒，搬前搬后逐字节一致。 */
  import Icon from './Icon.svelte';
  import { onMount } from 'svelte';

  let {
    title = '',
    narrow = false,
    onclose = undefined,
    children,
    footer = null,
    class: cls = '',
    shell = false,
  } = $props();

  onMount(() => {
    if (shell) return;   // 外壳不接键盘：Esc 的唯一入口仍是 src/app/main.js 的 closeTopModal
    const onKey = (e) => {
      if (e.key === 'Escape' && onclose) onclose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
</script>

{#if shell}
  <div id="modal-shell-host" class="ui-modal-shell"></div>
{:else}
  <div class={['ui-modal', cls].filter(Boolean).join(' ')}>
    <div class="ui-modal-card" class:narrow role="dialog" aria-modal="true" aria-label={title}>
      <div class="ui-modal-head">
        <h2>{title}</h2>
        <button type="button" class="ui-modal-close" aria-label="关闭" onclick={onclose}>
          <Icon name="x" />
        </button>
      </div>
      <div class="ui-modal-body">
        {@render children?.()}
      </div>
      {#if footer}
        <div class="ui-modal-foot">{@render footer()}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* 外壳：只做「层」这件事，不生成盒子（见文件头 shell 模式说明） */
  .ui-modal-shell { display: contents; }

  .ui-modal {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow-y: auto;
    padding: 24px 12px;
  }
  .ui-modal-card {
    width: min(680px, 96vw);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    animation: var(--an-leafIn) var(--m-dur-base) var(--ease-spring) both;
  }
  .ui-modal-card.narrow { width: min(520px, 94vw); }

  .ui-modal-head {
    position: relative;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 22px;
    border-bottom: 1px solid var(--line);
  }
  .ui-modal-head h2 {
    font-family: var(--font-note);
    font-size: 19px;
    font-weight: 400;
    letter-spacing: .12em;
    color: var(--ink);
  }
  .ui-modal-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    margin: -8px -10px -8px 0;
    color: var(--ink-dim);
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
    transition:
      color var(--m-t-color-fast) var(--ease-out),
      background-color var(--m-t-color-fast) var(--ease-out);
  }
  .ui-modal-close:hover { color: var(--ink); background: var(--hover-tint); }

  .ui-modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px 22px;
  }
  .ui-modal-foot {
    padding: 13px 22px;
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
</style>
