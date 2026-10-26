<script>
  /* Node.svelte —— 字段配置节点渲染器（settingsForm.js 的 k 分支）
   * 只产标记、不带行为：控件 id 与 0.12.1 逐字一致，读写仍由 js/app/* 按 id 完成
   *（syncSettingsToForm / applyFormToSettings / syncAdvPanels / renderModelProfiles …）。
   * 静态渲染、不建响应式绑定——legacy 界面层直接改 value / classList，两边不打架。 */
  import Icon from '../../ui/Icon.svelte';
  import Inline from './Inline.svelte';
  import Self from './Node.svelte';

  let { node } = $props();
</script>

{#if node.k === 'grid2'}
  <div class="grid2" id={node.id || null}>
    {#each node.items as item}<Self node={item} />{/each}
  </div>
{:else if node.k === 'row'}
  <div class={node.cls ? node.cls : 'row-inline'}>
    {#each node.items as item}<Self node={item} />{/each}
  </div>
{:else if node.k === 'field'}
  {#if node.wrapId}
    <label id={node.wrapId} class={node.wrapCls || (node.wrapHidden ? 'hidden' : null)}>
      {#if node.label}{node.label}{/if}
      {#if node.type === 'textarea'}
        <textarea id={node.id} {...node.attrs} placeholder={node.placeholder || null}></textarea>
      {:else}
        <input id={node.id} type={node.type || 'text'} {...node.attrs} list={node.list || null} placeholder={node.placeholder || null} spellcheck={node.spellcheck === false ? 'false' : null} class={node.cls || null} />
      {/if}
    </label>
  {:else if node.label}
    <label>
      {node.label}
      {#if node.type === 'textarea'}
        <textarea id={node.id} {...node.attrs} placeholder={node.placeholder || null}></textarea>
      {:else}
        <input id={node.id} type={node.type || 'text'} {...node.attrs} list={node.list || null} placeholder={node.placeholder || null} spellcheck={node.spellcheck === false ? 'false' : null} class={node.cls || null} />
      {/if}
    </label>
  {:else if node.type === 'textarea'}
    <textarea id={node.id} {...node.attrs} placeholder={node.placeholder || null}></textarea>
  {:else}
    <input id={node.id} type={node.type || 'text'} {...node.attrs} list={node.list || null} placeholder={node.placeholder || null} spellcheck={node.spellcheck === false ? 'false' : null} class={node.cls || null} />
  {/if}
{:else if node.k === 'select'}
  <label id={node.wrapId || null} class={node.wrapCls || (node.wrapHidden ? 'hidden' : null)}>
    {#if node.label}{node.label}{/if}
    <select id={node.id}>
      {#each node.options || [] as opt}<option value={opt[0]}>{opt[1]}</option>{/each}
    </select>
  </label>
{:else if node.k === 'check'}
  <label class={node.wrapCls ? 'check ' + node.wrapCls : 'check'} id={node.wrapId || null}>
    <input id={node.id} type="checkbox" checked={node.checked ? true : null} /> {node.text}{#if node.sub}<span class="check-sub">{node.sub}</span>{/if}
  </label>
{:else if node.k === 'text'}
  <p class={node.cls || null} id={node.id || null}><Inline html={node.text || ''} /></p>
{:else if node.k === 'box'}
  <div class={node.cls || null} id={node.id || null}>
    {#each node.nodes || [] as item}<Self node={item} />{/each}
  </div>
{:else if node.k === 'btn'}
  <button id={node.id} class={node.cls || 'btn'} type="button" title={node.title || null}>{#if node.icon}<Icon name={node.icon} class="ic-l" />{/if}{node.text}</button>
{:else if node.k === 'test'}
  <div class="test-row">
    <button id={node.id} class="mini-btn" type="button"><Icon name={node.icon || 'bolt'} class="ic-l" />{node.text}</button>
    <span class="hint test-state" id={node.stateId}>{node.hint}</span>
  </div>
{:else if node.k === 'adv'}
  <details class="adv" data-auto={node.auto || null} data-tag-off={node.tagOff || null} data-tag-on={node.tagOn || null}>
    <summary><span class="adv-t">{node.title}</span>{#if node.tagOn}<span class="adv-tag"></span>{/if}</summary>
    <div class="adv-body">
      {#each node.nodes as item}<Self node={item} />{/each}
    </div>
  </details>
{:else if node.k === 'help'}
  <details class="help">
    <summary>{node.title}</summary>
    <div class="help-body">
      {#each node.nodes as item}<Self node={item} />{/each}
    </div>
  </details>
{:else if node.k === 'details'}
  <details class={node.cls || null} id={node.id || null}>
    <summary>{node.summary}</summary>
    {#each node.nodes || [] as item}<Self node={item} />{/each}
  </details>
{:else if node.k === 'datalist'}
  <datalist id={node.id}>
    {#each node.options || [] as opt}<option value={opt[0]}>{opt[1]}</option>{/each}
  </datalist>
{:else if node.k === 'inline-num'}
  <label class="inline-field">{node.before} <input id={node.id} class="inline-num" {...node.attrs} /> {node.after}</label>
{/if}
