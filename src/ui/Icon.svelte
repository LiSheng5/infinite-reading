<script>
  /* Icon.svelte —— 0.12.1 手绘图标 sprite 的组件化（阶段 3）
   * 图标本身保持不变：24 网格、1.6 描边、圆头圆角、currentColor；
   * 实心圆点保留元素上的 fill="currentColor"（历史坑：<use> 内部元素吃不到外部 CSS 选择器）。
   * 每个分支的图形与 index.html 的 <symbol id="i-名字"> 逐字一致，由 eval/ui-lib-test.js 对账。
   * 用法：<Icon name="gear" />；有文字语义时传 label（渲染 role="img" + aria-label），否则 aria-hidden。 */
  let { name, label = null, class: cls = '' } = $props();
</script>

<svg
  class={cls ? 'ic ' + cls : 'ic'}
  viewBox="0 0 24 24"
  role={label ? 'img' : null}
  aria-label={label || null}
  aria-hidden={label ? null : 'true'}
  focusable="false"
  xmlns="http://www.w3.org/2000/svg"
>
{#if name === 'x'}<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>
{:else if name === 'gear'}<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.4"/><path d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9"/>
{:else if name === 'back'}<path d="M19.5 12h-15M10.5 6l-6 6 6 6"/>
{:else if name === 'up'}<path d="M12 19.5v-15M6 10.5l6-6 6 6"/>
{:else if name === 'down'}<path d="M12 4.5v15M6 13.5l6 6 6-6"/>
{:else if name === 'chev'}<path d="M9.5 5.5l6.5 6.5-6.5 6.5"/>
{:else if name === 'chev-l'}<path d="M14.5 5.5L8 12l6.5 6.5"/>
{:else if name === 'minus'}<path d="M5 12h14"/>
{:else if name === 'redo'}<path d="M4.2 12a7.8 7.8 0 107.8-7.8 7.8 7.8 0 00-5.6 2.4L4.2 8.8"/><path d="M4.2 4.2v4.6h4.6"/>
{:else if name === 'plus'}<path d="M12 5v14M5 12h14"/>
{:else if name === 'more'}<circle fill="currentColor" stroke="none" cx="5.5" cy="12" r="1.5"/><circle fill="currentColor" stroke="none" cx="12" cy="12" r="1.5"/><circle fill="currentColor" stroke="none" cx="18.5" cy="12" r="1.5"/>
{:else if name === 'history'}<path d="M4.2 12a7.8 7.8 0 107.8-7.8 7.8 7.8 0 00-5.6 2.4L4.2 8.8"/><path d="M4.2 4.2v4.6h4.6M12 8v4.2l2.8 1.8"/>
{:else if name === 'bulb'}<path d="M12 3.2a6 6 0 00-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0012 3.2z"/><path d="M9.7 19h4.6M10.6 21.2h2.8"/>
{:else if name === 'mail'}<rect x="3.5" y="5.5" width="17" height="13" rx="2.2"/><path d="M4.4 7.6L12 13.4l7.6-5.8"/>
{:else if name === 'clock'}<circle cx="12" cy="12.5" r="8"/><path d="M12 8v4.6l3 1.8M5 4.2L3.4 5.8M19 4.2l1.6 1.6"/>
{:else if name === 'cart'}<path d="M3 4.5h2.6l1.9 10.2h10.2l1.8-7.4H6.4"/><circle cx="9.6" cy="19" r="1.4"/><circle cx="16.8" cy="19" r="1.4"/>
{:else if name === 'palette'}<path d="M12 3.6a8.4 8.4 0 100 16.8c1.3 0 1.9-.8 1.9-1.7 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.7 1.8-1.7h2.1a3.7 3.7 0 003.7-3.7C20.5 7.1 16.7 3.6 12 3.6z"/><circle fill="currentColor" stroke="none" cx="7.6" cy="11.2" r="1.1"/><circle fill="currentColor" stroke="none" cx="10.4" cy="7.4" r="1.1"/><circle fill="currentColor" stroke="none" cx="15.2" cy="7.8" r="1.1"/>
{:else if name === 'pencil'}<path d="M4.2 19.8l.9-4L16.6 4.3a2 2 0 012.8 0l.3.3a2 2 0 010 2.8L8.2 18.9z"/><path d="M14.4 6.5l3.1 3.1"/>
{:else if name === 'expand'}<path d="M4 9.2V4h5.2M14.8 4H20v5.2M20 14.8V20h-5.2M9.2 20H4v-5.2"/>
{:else if name === 'film'}<rect x="3.5" y="4.8" width="17" height="14.4" rx="2"/><path d="M8 4.8v14.4M16 4.8v14.4M3.5 9.6H8M3.5 14.4H8M16 9.6h4.5M16 14.4h4.5"/>
{:else if name === 'play'}<path d="M8 5.6v12.8a.8.8 0 001.2.7l10-6.4a.8.8 0 000-1.4L9.2 4.9A.8.8 0 008 5.6z"/>
{:else if name === 'bolt'}<path d="M13.4 3L5.6 13.4h5.4l-.9 7.6 8.3-10.9h-5.4z"/>
{:else if name === 'warn'}<path d="M12 4.2L3 19.4h18z"/><path d="M12 10v4.4M12 17.2h.01"/>
{:else if name === 'check'}<path d="M5 12.6l4.6 4.5L19 7.6"/>
{:else if name === 'book'}<path d="M3.8 5.6c2.7-1 5.6-.8 8.2.8 2.6-1.6 5.5-1.8 8.2-.8v12.8c-2.7-1-5.6-.8-8.2.8-2.6-1.6-5.5-1.8-8.2-.8z"/><path d="M12 6.4v12.8"/>
{:else if name === 'chat'}<path d="M5.2 4.8h13.6a1.7 1.7 0 011.7 1.7v8.2a1.7 1.7 0 01-1.7 1.7h-6.4l-4.6 3.5v-3.5H5.2a1.7 1.7 0 01-1.7-1.7V6.5a1.7 1.7 0 011.7-1.7z"/><path d="M8 10h8M8 13h4.6"/>
{:else if name === 'mask'}<path d="M4.6 5.4c4.6-1.4 10.2-1.4 14.8 0v6.2c0 4.3-3.2 7.6-7.4 7.6s-7.4-3.3-7.4-7.6z"/><path d="M8 10.4c.9-.7 2-.7 2.9 0M13.1 10.4c.9-.7 2-.7 2.9 0M9.2 14.6c1.6 1.5 4 1.5 5.6 0"/>
{:else if name === 'spark'}<path d="M12 3.2l2.3 6.5 6.5 2.3-6.5 2.3L12 20.8l-2.3-6.5L3.2 12l6.5-2.3z"/>
{/if}
</svg>

<style>
  /* 与 css/icons.css 的 .ic 同参数：描边随文字色（currentColor），尺寸由使用方用 class / style 调 */
  svg {
    width: 1.15em;
    height: 1.15em;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
    vertical-align: -0.2em;
  }
</style>
