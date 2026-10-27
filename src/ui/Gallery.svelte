<script>
  /* Gallery.svelte —— 基础组件库与动效模块的自查页（?ui=1，阶段 3）
   * 默认形态不挂载（零像素变化）；这里是组件库的视觉 / 动效检视台：
   * 图标 · 按钮 · 表单 · 折叠 · 弹窗 · 动效三档 · 循环预算 · 子树暂停。 */
  import Icon from './Icon.svelte';
  import Button from './Button.svelte';
  import IconButton from './IconButton.svelte';
  import Field from './Field.svelte';
  import TextInput from './TextInput.svelte';
  import Select from './Select.svelte';
  import Checkbox from './Checkbox.svelte';
  import Modal from './Modal.svelte';
  import Collapse from './Collapse.svelte';
  import { applyMotion, registerLoop, suspendLoops, Motion } from './motion.js';
  import { onMount } from 'svelte';

  const ICON_NAMES = [
    'x', 'gear', 'back', 'up', 'down', 'chev', 'chev-l', 'minus', 'redo', 'plus', 'more',
    'history', 'bulb', 'mail', 'clock', 'cart', 'palette', 'pencil', 'expand', 'film',
    'play', 'bolt', 'warn', 'check', 'book', 'chat', 'mask', 'spark',
  ];

  let level = $state('rich');
  let showModal = $state(false);
  let advanced = $state(true);
  let demoText = $state('一段示例文字');
  let demoModel = $state('gpt-example');
  let demoOn = $state(true);
  let suspended = $state(false);
  let suspendEl = null;
  let resume = null;

  function setLevel(pref) {
    level = applyMotion(document.documentElement, pref);
  }

  function toggleSuspend() {
    if (suspended) {
      if (resume) resume();
      resume = null;
      suspended = false;
    } else if (suspendEl) {
      resume = suspendLoops(suspendEl);
      suspended = true;
    }
  }

  onMount(() => {
    // 循环预算演示：5 个循环点登记，超过 Motion.LOOP_BUDGET（3）的挂 data-loop="wait" 暂停
    const dots = Array.from(document.querySelectorAll('.loop-dot'));
    const offs = dots.map((el) => registerLoop(el));
    return () => offs.forEach((off) => off());
  });
</script>

<div class="gallery">
  <header class="g-head">
    <h1>无限阅读 · 组件库与动效模块</h1>
    <div class="g-levels">
      {#each ['off', 'standard', 'rich'] as lv (lv)}
        <Button size="slim" variant={level === lv ? 'primary' : 'default'} onclick={() => setLevel(lv)}>
          {lv}
        </Button>
      {/each}
      <Button size="slim" variant="ghost" onclick={() => setLevel('auto')}>auto</Button>
      <span class="g-note">当前档位：{level} · 循环上限 {Motion.LOOP_BUDGET} 组</span>
    </div>
  </header>

  <section>
    <h2>图标（28 个，与 0.12.1 sprite 逐字一致）</h2>
    <div class="g-icons">
      {#each ICON_NAMES as n (n)}
        <span class="g-icon"><Icon name={n} /><code>{n}</code></span>
      {/each}
    </div>
  </section>

  <section>
    <h2>按钮</h2>
    <div class="g-row">
      <Button>默认</Button>
      <Button variant="primary" icon="check">主操作（黑底）</Button>
      <Button variant="ghost">次级</Button>
      <Button variant="danger" icon="warn" iconSide="left">危险</Button>
      <Button size="slim" icon="plus">小号</Button>
      <Button disabled>禁用</Button>
      <IconButton icon="gear" label="设置" />
      <IconButton icon="trash-none" label="不存在的名字不渲染图形" />
      <IconButton icon="more" label="更多" variant="bordered" />
    </div>
  </section>

  <section>
    <h2>表单</h2>
    <Field label="模型" hint="填模型名，例如 gpt-example。" for="g-model">
      <TextInput id="g-model" bind:value={demoText} placeholder="填你的模型名" />
    </Field>
    <Field label="档位示例" for="g-select">
      <Select id="g-select" bind:value={demoModel} options={[
        { value: 'gpt-example', label: 'gpt-example' },
        { value: 'demo-local', label: 'demo-local' },
      ]} />
    </Field>
    <Checkbox bind:checked={demoOn} label="启用某个开关" />
  </section>

  <section>
    <h2>折叠（高级参数 · 状态标签）</h2>
    <Collapse summary="高级参数" status={advanced ? '已单独配置' : '沿用剧情模型'} bind:open={advanced}>
      <Field label="温度" for="g-temp">
        <TextInput id="g-temp" type="number" value="0.8" />
      </Field>
    </Collapse>
    <Collapse summary="邮件与定时" status="未启用">
      <p class="g-note">折叠块里的内容：单次淡入位移，高度不参与过渡。</p>
    </Collapse>
  </section>

  <section>
    <h2>弹窗</h2>
    <Button onclick={() => (showModal = true)}>打开弹窗</Button>
    {#if showModal}
      {#snippet foot()}
        <Button onclick={() => (showModal = false)}>取消</Button>
        <Button variant="primary" onclick={() => (showModal = false)}>保存</Button>
      {/snippet}
      <Modal title="示例弹窗" narrow onclose={() => (showModal = false)} footer={foot}>
        <p class="g-note">Esc 或右上关闭。遮罩点击不关（防误触）。</p>
      </Modal>
    {/if}
  </section>

  <section>
    <h2>循环动画预算（≤ {Motion.LOOP_BUDGET} 组，超出者暂停）</h2>
    <div class="g-row">
      {#each [0, 1, 2, 3, 4] as i (i)}
        <span class="loop-dot"></span>
      {/each}
    </div>
    <p class="g-note">5 个循环点全部登记：前 {Motion.LOOP_BUDGET} 个在动，其余挂 data-loop="wait" 暂停。仅 rich 档循环。</p>

    <h2>子树暂停（分支页压阅读页的通用机制）</h2>
    <div class="g-suspend" bind:this={suspendEl}>
      <span class="loop-solo"></span>
      <span class="g-note">这颗循环点在子树里</span>
    </div>
    <Button onclick={toggleSuspend}>{suspended ? '恢复子树循环' : '暂停子树循环'}</Button>
  </section>
</div>

<style>
  .gallery {
    position: fixed;
    inset: 0;
    z-index: 100;
    overflow-y: auto;
    padding: 28px clamp(16px, 5vw, 56px) 64px;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-ui);
  }
  .g-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 20px;
  }
  h1 { font-family: var(--font-note); font-size: 20px; font-weight: 400; letter-spacing: .12em; }
  h2 { font-size: 13px; color: var(--accent); letter-spacing: .08em; margin: 22px 0 10px; }
  section {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 4px 18px 18px;
    margin-bottom: 16px;
  }
  .g-levels { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .g-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .g-note { font-size: 12px; color: var(--ink-faint); line-height: 1.9; }
  .g-icons { display: flex; flex-wrap: wrap; gap: 10px; }
  .g-icon {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 72px;
    padding: 8px 0;
    border: 1px solid var(--line-soft);
    border-radius: var(--radius);
    font-size: 18px;
  }
  .g-icon code { font-family: var(--font-mono); font-size: 10px; color: var(--ink-faint); }

  /* 循环演示点：breathe 是 rich 专档循环（ANIMATIONS.breathe），其余档静止 */
  .loop-dot, .loop-solo {
    display: inline-block;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    background: var(--accent);
    animation: var(--an-breathe) var(--loop-busy) var(--ease-out) var(--m-iter) alternate;
  }
  .g-suspend {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius);
  }
</style>
