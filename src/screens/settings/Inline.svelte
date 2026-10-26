<script>
  /* Inline.svelte —— 配置文案里的行内标记（<b> <code> <br>）解析器
   * 只服务 settingsForm.js 里的静态作者文案（帮助 / 副标题 / 提示）；
   * 用户与模型产出的内容一律走 textContent / Svelte 文本插值，不进这里。 */
  let { html = '' } = $props();

  function parseRuns(s) {
    const out = [];
    const tag = /<b>([\s\S]*?)<\/b>|<code>([\s\S]*?)<\/code>|<br\s*\/?>/g;
    let last = 0;
    let m;
    while ((m = tag.exec(s))) {
      if (m.index > last) out.push({ t: 'text', text: s.slice(last, m.index) });
      if (m[1] !== undefined) out.push({ t: 'b', text: m[1] });
      else if (m[2] !== undefined) out.push({ t: 'code', text: m[2] });
      else out.push({ t: 'br' });
      last = tag.lastIndex;
    }
    if (last < s.length) out.push({ t: 'text', text: s.slice(last) });
    return out;
  }

  const runs = $derived(parseRuns(html));
</script>

{#each runs as r}{#if r.t === 'br'}<br />{:else if r.t === 'b'}<b>{r.text}</b>{:else if r.t === 'code'}<code>{r.text}</code>{:else}{r.text}{/if}{/each}
