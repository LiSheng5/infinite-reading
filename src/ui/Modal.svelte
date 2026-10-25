<script>
  /* Modal.svelte —— 弹窗（阶段 3 组件库）
   * 结构对齐 css/style.css 的 .modal（遮罩 + 卡片 + 头 / 体 / 脚），但样式全部作用域限定，
   * 不复用 legacy 的全站类名（§8：组件库样式必须按作用域限定）。
   * 关闭途径：右上关闭按钮 / Esc。遮罩点击不关（表单弹窗防误触）。 */
  import Icon from './Icon.svelte';
  import { onMount } from 'svelte';

  let {
    title = '',
    narrow = false,
    onclose = undefined,
    children,
    footer = null,
    class: cls = '',
  } = $props();

  onMount(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && onclose) onclose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
</script>

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

<style>
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
