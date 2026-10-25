/*
 * 无限阅读 · 离线演示模式（?demo=1，开源路线图 W2「零安装」）
 *
 * 目的：把「下载 → 配置 Key → 才能看到东西」三道门槛压成一道——
 *       打开 `index.html?demo=1` 就直接开演：内置剧本 + 本地占位图，不联网、不花钱、不用配置。
 *
 * 做法：往适配器层注册两个「假适配器」，其余流程（上下文组装 / 画师子代理 / 出水 / 存档）与真实模式完全同一条路：
 *   IR.ChatProviders['demo']       —— 按提示词特征分派：AI1 走内置剧本，画师走内置画师脚本，其余（书记员等）返回空串交由本地规则兜底
 *   IR.ImageProviders['demo-image']—— canvas 现场画一张占位图（dataURL），让出图链路与背景淡入都能跑通
 *
 * 三条纪律：
 *   1. 只在 ?demo=1 时生效；enabled() 之外的一切都由 app.js 判定，本文件不主动改任何状态。
 *   2. applyTo(settings) 只改内存副本，绝不写回 localStorage（真实配置不会被污染）。
 *   3. 剧本与画师脚本都是常量数据，不含任何外部请求；断网、file:// 下同样可用。
 */
import { IR, registerIR } from './ir.ts';

/* ↑ 阶段 2 搬迁自 js/demo.js（IIFE → ES module，函数体逐字未动）。
 * 模块间现存的 global.IR 惰性互访按铁律保留（可选依赖语义，见 src/core/ir.ts 头注）；
 * 导出即真实 API，IR 只是给未迁移界面层的镜像。 */
const global = globalThis as any;

  /* ==================== 内置剧本（10 回合 + 收尾） ====================
   * 与真实 AI1 回包同构：narration / choices / scene_change / scene_summary / world（自报世界卡）。
   * 玩家可以自由输入，剧情按回合推进（不依赖玩家说了什么）。 */

  const SCRIPT = {
    title: '末班电车',
    premise: [
      '标题：末班电车',
      '世界：现代都市的深夜，开往郊外的末班电车，车厢里只剩零星乘客，窗外是忽明忽暗的隧道灯。',
      '你的角色：一位刚下夜班的乘客（你可以随时扮演成任何人、做任何事）。',
      'AI 扮演：旁白，以及车厢里的一切——广播、邻座的乘客、窗外的雨。',
      '风格：克制的悬疑，日常里藏着一丝奇异。剧情随玩家的行动自由生长。',
    ].join('\n'),
    turns: [
      {
        reply: {
          narration: '车门合拢，顶灯闪了一下。整节车厢只剩三个人：你、一个抱着蒙布鸟笼的老人，和一个靠在门边打盹的乘务员。广播报出下一站，声音比平时慢了半拍。',
          choices: ['和抱鸟笼的老人搭话', '走向车厢尽头的那扇门', '把玻璃上的水汽擦开'],
          scene_change: true,
          scene_summary: '深夜电车车厢内部，冷白灯管，靛蓝色绒布座椅，一位抱着蒙布鸟笼的老人，车窗上凝着水汽',
          world: {
            place: '末班电车（第三节车厢）',
            time: '深夜 23:47',
            scene: '冷白灯管下的空车厢，靛蓝座椅与抱着蒙布鸟笼的老人',
            characters: [{ name: '抱鸟笼的老人', presence: '在场', personality: '沉默、讲礼数', speech: '一句话不超过十个字' }],
            threads: ['车厢尽头那扇门后面是什么'],
          },
        },
      },
      {
        reply: {
          narration: '老人没抬头，手指在笼子上敲了三下。「前面那站，不要下车。」话音刚落，笼子里的鸟也啄了三下木头，节奏一模一样。',
          choices: ['问他为什么', '点头，把目光移回窗外', '把耳朵贴到笼子上'],
          scene_summary: '老人枯瘦的手指敲在蒙布鸟笼上，冷白灯管在他脸上切出阴影',
          world: { threads: ['车厢尽头那扇门后面是什么', '老人的警告：前面那站不要下车'] },
        },
      },
      {
        reply: {
          narration: '你抹开一块水汽。玻璃外并没有站台——是同一节车厢，同一盏灯，你看见自己坐在那个位置上，低着头的那个「你」正抬起脸来。',
          choices: ['回头确认自己的座位', '把这件事告诉老人', '去拉紧急制动阀'],
          scene_change: true,
          scene_summary: '凝着水汽的车窗玻璃，被抹开的一块映出另一节一模一样的车厢',
          world: { scene: '被抹开水汽的车窗，映出镜像般的同一节车厢', threads: ['车厢尽头那扇门后面是什么', '老人的警告：前面那站不要下车', '窗外映出另一节一模一样的车厢'] },
        },
      },
      {
        reply: {
          narration: '你走到车厢尽头。那扇门虚掩着，缝里透出暖黄的灯，还有关东煮的味道——像某条街的深夜，从很远的地方漏了一点进来。',
          choices: ['推门进去', '在门上敲三下', '先转身坐回座位'],
          scene_change: true,
          scene_summary: '车厢尽头一扇虚掩的木门，门缝里透出暖黄灯光与一点热气，与冷白车厢形成冷暖对比',
          world: { scene: '车厢尽头虚掩的门，门缝里漏出暖黄的光', threads: ['车厢尽头那扇门后面是什么', '老人的警告：前面那站不要下车', '窗外映出另一节一模一样的车厢', '门后是另一条街的气味'] },
        },
      },
      {
        reply: {
          narration: '乘务员醒了，走过来把一张硬纸车票放在你手心，没有解释。票面印着你的名字，下面一行小字：单程。',
          choices: ['把票收进口袋', '问乘务员这是什么', '把票还回去'],
          scene_summary: '昏暗车厢里递到手上的一张旧硬纸车票，票面印着名字与「单程」小字',
          world: { threads: ['车厢尽头那扇门后面是什么', '老人的警告：前面那站不要下车', '车票上印着你的名字：单程'] },
        },
      },
      {
        reply: {
          narration: '「我等这班车，等了四十年。」老人终于抬起眼，「每周三的深夜，它一次都没晚过点。」他说这话时，广播刚好又慢半拍地报了一次站。',
          choices: ['问他等的是谁', '问他为什么不下车', '什么也不问，陪他坐着'],
          scene_summary: '老人抬眼看过来，车厢顶灯在他眼里映成两个小点，窗外隧道灯一格格掠过',
          world: { threads: ['车厢尽头那扇门后面是什么', '老人的警告：前面那站不要下车', '车票上印着你的名字：单程', '老人在这班车上等了四十年'] },
        },
      },
      {
        reply: {
          narration: '灯灭了七秒。再亮起来时，车厢地板多了一排湿脚印，从门口一路通向尽头那扇门，脚尖朝里，没有回来的。',
          choices: ['顺着脚印走过去', '问老人刚才看见了什么', '按响车厢里的铃'],
          scene_change: true,
          scene_summary: '空车厢地板上的一排湿脚印，从门口延伸向车厢尽头，顶灯刚刚亮起，空气里还有水汽',
          world: { scene: '空车厢地板上的一排湿脚印，通向车厢尽头', threads: ['车厢尽头那扇门后面是什么', '车票上印着你的名字：单程', '老人在这班车上等了四十年', '灯灭七秒后，车厢里多了一排湿脚印'] },
        },
      },
      {
        reply: {
          narration: '门开了。不是车厢，是雨夜的街道：霓虹在积水里晃，一家便利店的灯亮着，旧收音机放着老歌，门牌上的字被雨糊得看不清。',
          choices: ['踏出去', '回头看一眼老人', '站在门口不动'],
          scene_change: true,
          scene_summary: '雨夜的街道，霓虹在积水里晃动，一家亮着灯的便利店，旧收音机放着老歌',
          world: {
            place: '电车外的雨夜街道（一家便利店门口）',
            time: '深夜 00:10',
            scene: '雨夜街道，霓虹在积水里晃，便利店暖光透出来',
            threads: ['车厢尽头那扇门后面是什么', '车票上印着你的名字：单程', '老人在这班车上等了四十年', '门后是雨夜里一家亮着灯的便利店'],
          },
        },
      },
      {
        reply: {
          narration: '蒙布滑落半寸。笼子里的鸟侧过头看你，清清楚楚地说：「你也是被等的人。」老人没有惊讶，只是把布重新盖好。',
          choices: ['问它这句话是什么意思', '问老人这到底是不是他的鸟', '什么都不问，走到门口去'],
          scene_summary: '蒙布半落的鸟笼，笼中鸟侧头直视镜头，背景是车厢门口透进来的雨夜冷光',
          world: { threads: ['车厢尽头那扇门后面是什么', '老人在这班车上等了四十年', '笼中的鸟说：你也是被等的人'] },
        },
      },
      {
        reply: {
          narration: '便利店的门「叮」了一声，自己开了。收银台旁的收音机咔地停住，一个很平静的声音报出你的名字，然后是三个字：末班车。',
          choices: ['走进便利店', '转身回到电车上', '站在原地把广播听完'],
          scene_change: true,
          scene_summary: '便利店自动门「叮」地打开，收银台旁一台红色旋钮的旧收音机，暖光货架，落地玻璃外是雨',
          world: { scene: '便利店自动门打开，收银台旁的旧收音机，暖光货架与雨夜玻璃', threads: ['车厢尽头那扇门后面是什么', '老人在这班车上等了四十年', '收音机里报出了你的名字：末班车'] },
        },
      },
    ],
  };

  // 剧本用尽后的收尾回合（循环三条，不至于每次都一模一样）
  const EPILOGUE = [
    {
      narration: '（演示剧本到这里就结束了。接上你自己的模型之后，同样这个开场，走向会完全不同——每一句旁白都由 AI 现场写。）',
      choices: ['把「接入模型」走一遍', '回到首页', '再坐一次这班车'],
      scene_summary: '末班电车驶出隧道，窗外城市灯火渐远，车厢里只剩一盏灯还亮着',
    },
    {
      narration: '（还在演示模式里。去「设置」里填上 Base URL 与 Key，再去掉地址栏的 ?demo=1 重新打开，这条街上的一切就归 AI 管了。）',
      choices: ['回到首页', '再要一段旁白', '继续看画面'],
      scene_summary: '深夜街道的远景，雨已经小了，便利店的灯还亮着',
    },
    {
      narration: '（演示模式：这里的旁白、选项、画面都来自内置脚本与本地占位图，不消耗任何额度。）',
      choices: ['回到首页', '继续玩下去', '看看画师工作台'],
      scene_summary: '雨夜街道的霓虹倒影，水面上的光被风吹皱',
    },
  ];

  /* ==================== 内置画师脚本 ==================== */

  const SCENE_PROMPTS = [
    'cinematic still, empty late-night tram interior, cold fluorescent light, deep indigo velvet seats, an old man holding a covered birdcage, rain-streaked windows, moody atmosphere, 35mm film',
    'cinematic still, rain-soaked neon street at midnight, glowing convenience store front, wet asphalt reflections, warm interior light spilling onto the pavement, film grain',
    'cinematic still, dark tunnel seen through a fogged train window, faint mirrored reflection of a passenger, blue-green color cast, soft bloom, 35mm film',
    'cinematic still, a single worn paper ticket held in a hand under dim carriage light, shallow depth of field, dust in the air, muted palette',
    'cinematic still, a closed wooden door at the end of a train carriage, warm light leaking through the seams, condensation on metal, quiet dread, 35mm',
    'cinematic still, wet footprints crossing an empty train carriage floor, cold overhead light, long shadows, unsettling stillness, 35mm film',
  ];

  const STYLE_SETS = [
    {
      keywords: ['chinese ink wash', 'negative space', 'monochrome with one accent', 'paper texture'],
      prompt_en: 'chinese ink wash painting of a late-night tram interior, generous negative space, monochrome with a single warm accent, paper texture, elegant and quiet',
      alt: '水墨：留白多，只用一点暖色点亮车厢',
    },
    {
      keywords: ['cinematic still', 'neon rain', '35mm film grain', 'teal and orange'],
      prompt_en: 'cinematic still of a rain-soaked neon street at midnight, 35mm film grain, teal shadows with warm neon highlights, wet reflections',
      alt: '电影感：雨夜霓虹，青橙对撞，颗粒明显',
    },
    {
      keywords: ['anime style', 'cel shading', 'soft glow', 'detailed background'],
      prompt_en: 'anime style illustration of an empty night tram, cel shading, soft glow, detailed background, gentle melancholy',
      alt: '动画赛璐璐：干净线条与柔和光晕',
    },
    {
      keywords: ['pixel art', '16-bit', 'limited palette', 'dithering'],
      prompt_en: 'pixel art background of a night tram carriage, 16-bit retro game style, limited palette, dithering, atmospheric',
      alt: '像素画：16 位复古游戏背景，色调克制',
    },
  ];

  const CARD = {
    styleKeywords: ['cinematic still', 'cold fluorescent vs warm interior', 'rain atmosphere', '35mm film grain'],
    medium: 'photographic, 35mm film',
    palette: 'deep indigo, cool grey-green, one warm amber accent',
    characters: [
      { name: '抱鸟笼的老人', appearanceEn: 'old man in a worn wool coat, thin grey hair, deep-set calm eyes', outfit: 'worn wool coat, dark trousers', features: 'a covered birdcage always in his lap' },
      { name: '乘务员', appearanceEn: 'tired young conductor in a navy uniform', outfit: 'navy uniform, white shirt', features: 'half asleep, holds a stack of paper tickets' },
    ],
    negative: 'text, watermark, signature, extra fingers, deformed hands',
    note: '始终深夜、始终下雨；冷暖光源各占一半。',
  };

  /* ==================== 小工具 ==================== */

  // sleep / clone 的唯一口径在 IR.sleep / IR.clone（tree.js，审查 可维护性 三·1 / 三·5），
  // demo 模拟器不再各留一份实现；tree.js 缺失直接报错
  const sleep = (global.IR && global.IR.sleep) || function () {
    throw new Error('IR.sleep 未加载：tree.js 必须先于 demo.js');
  };
  const clone = (global.IR && global.IR.clone) || function () {
    throw new Error('IR.clone 未加载：tree.js 必须先于 demo.js');
  };

  function hash(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // 流式抛出：把一段文本切成小块，逐块交给 onDelta，得到与真实模型一致的打字机观感
  async function streamOut(text, hooks, delay) {
    const s = String(text || '');
    if (hooks && hooks.onDelta) {
      const step = 5 + (hash(s) % 7);
      for (let i = 0; i < s.length; i += step) {
        await sleep(delay || 16);
        hooks.onDelta(s.slice(i, i + step));
      }
    } else {
      await sleep(320);
    }
    return s;
  }

  function replyOf(o, extra?) {
    return JSON.stringify(Object.assign({
      narration: o.narration,
      choices: o.choices || [],
      scene_change: !!o.scene_change,
      scene_summary: o.scene_summary || '',
      world: o.world || {},
    }, extra || {}));
  }

  /* ==================== 演示对话适配器 ==================== */

  let ai1CallNo = 0;                       // 第几轮 AI1（不依赖历史长度，压缩后也不会错位）

  const AI1_MARK = /^\[(设定|玩家行动)\]/;

  function isAI1(messages) {
    return messages.some(m => m.role === 'user' && AI1_MARK.test(String(m.content || '')));
  }

  // 画师：[画面参考] xxx（场景/工作台对话）或 [锚定任务]（试画 / 设定卡）
  function painterTask(messages) {
    const all = messages.map(m => String(m.content || ''));
    const sys = all.join('\n');
    if (sys.indexOf('[锚定任务]') !== -1) {
      if (/\[锚定任务\]\s*styles/.test(sys)) {
        return JSON.stringify({ styles: STYLE_SETS });
      }
      return JSON.stringify({ card: CARD, reply: '（演示模式）按选定的画风方向起草了一张设定卡：以后每张图都带着它，画风与人物的前后一致就有了锚。' });
    }
    if (sys.indexOf('[当前设定卡]') !== -1) {
      // 锚定流程里的「改设定卡」对话（mode: cardchat）
      return JSON.stringify({ card: CARD, reply: '（演示模式）已经按你说的改过设定卡了：画风关键词保持稳定，只动了你提到的那一处。' });
    }
    if (sys.indexOf('画师工作台') !== -1) {
      // 画师工作台：讨论「已经画好的这张图」怎么改（mode: chat）
      const userText = String((messages[messages.length - 1] || {}).content || '');
      const ref = currentAlt(messages) || sceneRef(messages) || '深夜电车的一幕';
      return JSON.stringify({
        reply: '（演示模式）按你说的「' + (userText.slice(0, 18) || '再改一版') + '」调整了画面：光线更暖，窗上的水汽更重。',
        prompt_en: SCENE_PROMPTS[hash(ref) % SCENE_PROMPTS.length] + ', warmer light, heavier condensation on the glass',
        alt: ref,
      });
    }
    const ref = sceneRef(messages) || '深夜电车的一幕';
    const styleHint = styleKeywords(messages);
    return JSON.stringify({
      prompt_en: SCENE_PROMPTS[hash(ref) % SCENE_PROMPTS.length] + (styleHint ? ', ' + styleHint : ''),
      subject: 'scene',
      alt: ref,
    });
  }

  function sceneRef(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = String(messages[i].content || '');
      const hit = m.match(/\[画面参考\]\s*([^\n]*)/);
      if (hit && hit[1].trim()) return hit[1].trim();
    }
    return '';
  }

  // 画师工作台：从「[当前这张图] … alt：xxx」里取回这张图的画面描述
  function currentAlt(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = String(messages[i].content || '');
      const hit = m.match(/\[当前这张图\][\s\S]*?alt：\s*([^\n]*)/);
      if (hit && hit[1].trim()) return hit[1].trim();
    }
    return '';
  }

  // 画风要求里带英文关键词（锚定后是视觉设定卡的 styleKeywords）→ 拼进 prompt
  function styleKeywords(messages) {
    const sys = messages.map(m => String(m.content || '')).join('\n');
    const hit = sys.match(/\[画风要求\]\s*([^\n]*)/);
    if (!hit) return '';
    return hit[1].replace(/[^A-Za-z0-9,\s-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
  }

  async function chat(cfg, messages, hooks) {
    hooks = hooks || {};
    const first = String(((messages[0] || {}).content) || '');
    await sleep(220);                       // 让「生成中…」看得见

    // —— 画师子代理 ——
    if (first.indexOf('AI 画师导演') !== -1) {
      return streamOut(painterTask(messages), hooks, 12);
    }

    // —— AI1 剧情对话：走内置剧本 ——
    if (isAI1(messages)) {
      if (hooks.onReasoning) {
        hooks.onReasoning('（演示模式）这一段「思考链」与下面的旁白都来自内置剧本，不是模型输出；接入真模型后这里会显示模型的真实推理过程。');
      }
      const t = SCRIPT.turns[ai1CallNo];
      const ep = EPILOGUE[Math.max(0, ai1CallNo - SCRIPT.turns.length) % EPILOGUE.length];
      ai1CallNo += 1;
      return streamOut(replyOf(t ? t.reply : ep), hooks, 18);
    }

    // —— 自动标题（UI-2 §3.3）：按最近的用户话给一个确定性标题（仍不联网） ——
    if (first.indexOf('起一个不超过 15 个字的标题') !== -1) {
      let tail = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === 'user') { tail = String(messages[i].content || ''); break; }
      }
      return streamOut(tail.trim().slice(0, 12) || '演示对话', hooks, 6);
    }

    // —— 书记员 / 压缩 / 滚动风格等后台任务：返回空串，一律由本地规则兜底 ——
    await sleep(120);
    return '';
  }

  /* ==================== 演示生图适配器（canvas 占位图） ==================== */

  function draw(prompt, cfg) {
    const cw = Math.max(640, Math.min(1280, +(cfg && cfg.width) || 1280));
    const ratio = ((+(cfg && cfg.height) || 720) / ((+(cfg && cfg.width) || 1280)) || 0.5625);
    const ch = Math.round(cw * ratio);
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    const seed = hash(prompt);

    // 天空 → 地面
    const hue = seed % 360;
    const sky = g.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, 'hsl(' + hue + ', 40%, 26%)');
    sky.addColorStop(0.58, 'hsl(' + ((hue + 26) % 360) + ', 34%, 15%)');
    sky.addColorStop(1, 'hsl(' + ((hue + 320) % 360) + ', 28%, 8%)');
    g.fillStyle = sky;
    g.fillRect(0, 0, cw, ch);

    // 远景剪影（一层楼、一层山，按 seed 决定起伏）
    for (let layer = 0; layer < 2; layer++) {
      g.fillStyle = 'hsla(' + ((hue + 300) % 360) + ', ' + (22 + layer * 8) + '%, ' + (7 + layer * 4) + '%, 0.85)';
      const base = ch * (0.58 + layer * 0.12);
      g.beginPath();
      g.moveTo(0, ch);
      const n = 9 + (seed % 5) + layer * 3;
      for (let i = 0; i <= n; i++) {
        const x = (cw / n) * i;
        const wave = Math.sin(i * (1.3 + layer * 0.4) + (seed % 17)) * ch * 0.045;
        g.lineTo(x, base - wave);
      }
      g.lineTo(cw, ch);
      g.closePath();
      g.fill();
    }

    // 光源
    const lx = cw * (0.18 + ((seed >>> 3) % 64) / 100);
    const ly = ch * 0.26;
    const glow = g.createRadialGradient(lx, ly, 2, lx, ly, cw * 0.24);
    glow.addColorStop(0, 'hsla(' + ((hue + 55) % 360) + ', 88%, 74%, 0.9)');
    glow.addColorStop(1, 'hsla(' + ((hue + 55) % 360) + ', 88%, 74%, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = 'hsla(' + ((hue + 55) % 360) + ', 95%, 88%, 0.95)';
    g.beginPath();
    g.arc(lx, ly, 3 + (seed % 3), 0, Math.PI * 2);
    g.fill();

    // 雨丝（演示剧本一直在下雨）
    g.strokeStyle = 'hsla(' + ((hue + 40) % 360) + ', 60%, 88%, 0.16)';
    g.lineWidth = 1;
    for (let i = 0; i < 90; i++) {
      const x = ((seed + i * 977) % cw) + (i % 3);
      const y = (seed + i * 613) % ch;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - 4, y + 16 + (i % 12));
      g.stroke();
    }

    // 底部信息条：把提示词与「这是占位图」写清楚，避免被误当成模型产出
    const barH = Math.round(ch * 0.2);
    g.fillStyle = 'rgba(8, 10, 14, 0.72)';
    g.fillRect(0, ch - barH, cw, barH);
    g.fillStyle = 'rgba(255, 255, 255, 0.92)';
    g.font = '600 ' + Math.round(ch / 34) + 'px "Noto Serif SC", system-ui, sans-serif';
    g.fillText('离线演示 · 本地占位图（未调用任何生图模型）', 16, ch - barH + Math.round(ch / 20));
    g.fillStyle = 'rgba(255, 255, 255, 0.62)';
    g.font = Math.round(ch / 46) + 'px "Noto Serif SC", system-ui, sans-serif';
    const text = String(prompt || '').slice(0, 220);
    const maxW = cw - 32;
    let line = '';
    let y = ch - barH + Math.round(ch / 9.5);
    for (const ch2 of text) {
      if (g.measureText(line + ch2).width > maxW) {
        g.fillText(line, 16, y);
        y += Math.round(ch / 34);
        line = '';
        if (y > ch - ch / 40) break;
      }
      line += ch2;
    }
    if (line) g.fillText(line, 16, y);

    return cv.toDataURL('image/jpeg', 0.82);
  }

  async function generate(cfg, prompt) {
    await sleep(900);                       // 让「AI 画师作画中…」看得见
    return draw(prompt, cfg);
  }

  /* ==================== 对外 API ==================== */

  // 是否处于演示模式：?demo=1 / ?demo / ?demo=true
  function enabled() {
    try {
      const q = String((global.location && global.location.search) || '').replace(/^\?/, '');
      for (const kv of q.split('&')) {
        const k = kv.split('=')[0];
        if (k !== 'demo') continue;
        const v = kv.split('=')[1];
        return v == null || /^(1|true|yes|on)$/i.test(v);
      }
    } catch (_) {}
    return false;
  }

  // 把真实设置拷一份，把对话 / 生图都换成演示适配器（调用方负责不写回 localStorage）
  function applyTo(settings) {
    const s = clone(settings || {});
    s.chat = Object.assign({}, s.chat, { provider: 'demo', baseUrl: '', apiKey: '', model: 'demo', temperature: 0.9 });
    s.image = Object.assign({}, s.image, { provider: 'demo-image', baseUrl: '', apiKey: '', model: 'demo', size: '', quality: '' });
    // 子模型（画师 / 书记员 / 起草）留空即沿用剧情模型 → 同样是演示适配器
    for (const k of ['painter', 'scribe', 'draft']) {
      if (s[k]) s[k] = Object.assign({}, s[k], { provider: '', baseUrl: '', apiKey: '', model: '' });
    }
    s.profiles = [];                        // UI-3：演示不带模型库（profileId 找不到 → 回退演示适配器，绝不外联）
    s.toolsEnabled = 'off';                 // 演示不走工具，行为完全确定
    return s;
  }

  function reset() {
    ai1CallNo = 0;
  }

  // 演示模式不出视频（§8）：🎬 与视频入口置灰；点击弹「演示模式不出视频」。
  // 按钮保持可点（点了才有说明），只改样式与 onclick，不动其它状态。
  function applyVideoGate() {
    const show = () => {
      try {
        const t = global.IR && global.IR.App && global.IR.App.toast;
        if (t) t('演示模式不出视频');
      } catch (_) {}
    };
    const ids = ['btn-stage-video', 'btn-manual-video', 'btn-video-i2v', 'btn-video-t2v', 'btn-pw-video', 'btn-video-cancel'];
    for (const id of ids) {
      const el = (global.document && global.document.getElementById) ? global.document.getElementById(id) : null;
      if (!el) continue;
      el.classList.add('is-disabled');
      el.setAttribute('aria-disabled', 'true');
      el.title = '演示模式不出视频';
      el.onclick = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        show();
      };
    }
  }

  const Demo: any = {
    enabled: enabled,
    applyTo: applyTo,
    reset: reset,
    applyVideoGate: applyVideoGate,
    title: SCRIPT.title,
    premise: SCRIPT.premise,
    turnCount: SCRIPT.turns.length,
  };

  /* ==================== 可选本地服务的「内存 mock」（仅演示模式） ====================
   * 演示模式要保持零外联，不连真实 sidecar；但三个功能的界面链路要能跑通。
   * 这里把 IR.Sidecar 换成一整套内存实现（同一批方法名），策略仍按保守默认走一遍。
   * 注意：只改内存，不落盘、不发任何请求。 */
  function installSidecarMock() {
    const S = global.IR && global.IR.Sidecar;
    if (!S) return false;

    const cfg = {
      port: 4319,
      email: { enabled: true, provider: 'mock', allowlist: ['buddy@example.com'], dailyLimit: 3, from: 'demo@example.com', hasResendApiKey: false },
      schedule: { enabled: true, paused: false, quietHours: [{ start: '23:00', end: '08:00' }], dailyCap: 5, missedPolicy: 'SKIP' },
      payment: {
        enabled: true, provider: 'mock', currency: 'CNY',
        perTx: 10000, daily: 20000, monthly: 50000, autoApprove: 500, cooldownMin: 0,
        merchantAllowlist: [], merchantBlocklist: [], categoryAllowlist: [], categoryBlocklist: [], budgets: {},
      },
    };
    const state = { seq: 0, triggers: [], drafts: [], audit: [], txs: [], mandates: [] };
    const nid = p => p + String(++state.seq).padStart(3, '0');
    // 与真实客户端同语义（审查 可维护性 #7）：业务失败 = reject 一个带 code 的 Error，
    // 就像 js/sidecar.js 的 api() 把 400 + {ok:false,code} 抛出来那样——调用方的 catch 路径两边一致。
    const sidecarFail = (code, message) => {
      const e: any = new Error(message || code);
      e.code = code;
      e.status = 400;
      return Promise.reject(e);
    };
    const committed = () => state.txs.filter(t => t.status === 'charged' || t.status === 'awaiting_payment')
      .reduce((a, t) => a + t.amountCents, 0);

    function auditPush(kind, to, subject, status, code) {
      state.audit.unshift({ id: nid('a'), at: Date.now(), kind: kind, to: to, subject: subject, status: status, code: code || '', actor: 'user' });
    }

    S.__mock = true;
    S.configure = () => ({ port: 4319, token: 'demo' });
    S.config = () => ({ port: 4319, token: 'demo' });
    S.isOnline = () => true;
    S.probe = () => Promise.resolve(true);
    S.start = () => {};
    S.stop = () => {};
    S.on = () => function () {};
    S.off = () => {};
    S.startSSE = () => {};
    S.status = () => ({
      state: 'online', online: true, port: 4319, hasToken: true,
      features: { email: cfg.email.enabled, schedule: cfg.schedule.enabled, payment: cfg.payment.enabled },
      version: 'demo', lastError: '', health: { ok: true },
    });

    S.getConfig = () => Promise.resolve({ ok: true, config: clone(cfg) });
    S.putConfig = patch => {
      for (const k of ['email', 'schedule', 'payment']) {
        if (patch && patch[k]) Object.assign(cfg[k], patch[k]);
      }
      return S.getConfig();
    };

    S.listTriggers = () => Promise.resolve(clone(state.triggers));
    S.upsertTrigger = t => {
      const src = t || {};
      // 业务校验与 sidecar 同码（NAME_REQUIRED / 规格码）：错误面一致，catch 路径不用写两套
      if (!String(src.name || '').trim()) return sidecarFail('NAME_REQUIRED', '触发器名字不能为空。');
      const spec = clone(src.spec || {});
      if (src.type === 'once' && !(Number(spec.at) > 0)) return sidecarFail('ONCE_NEEDS_AT', '一次性触发器需要一个触发时间。');
      if (src.type === 'interval' && !(Math.floor(Number(spec.everyMs)) >= 60000)) return sidecarFail('INTERVAL_NEEDS_EVERYMS_MIN_1_MINUTE', '心跳间隔至少 1 分钟。');
      if (src.type === 'cron' && !String(spec.expr || '').trim()) return sidecarFail('CRON_EMPTY', 'cron 表达式为空。');
      if (['once', 'interval', 'cron'].indexOf(src.type) < 0) return sidecarFail('BAD_TRIGGER_TYPE', '不支持的触发器类型。');
      const found = state.triggers.filter(x => x.name === src.name)[0];
      const rec = found || { id: nid('t'), name: src.name, createdAt: Date.now() };
      Object.assign(rec, {
        type: src.type, spec: spec, channel: src.channel || '', prompt: src.prompt || '', reason: src.reason || '',
        status: (src.source === 'user') ? 'active' : (found ? found.status : 'pending_confirm'),
        enabled: true,
        nextAt: src.type === 'once' ? spec.at : (Date.now() + 3600000),
      });
      if (!found) state.triggers.push(rec);
      return Promise.resolve(clone(rec));
    };
    S.confirmTrigger = id => {
      const t = state.triggers.filter(x => x.id === id)[0];
      if (!t) return sidecarFail('TRIGGER_NOT_FOUND', '找不到这个触发器。');
      t.status = 'active';
      t.nextAt = Date.now() + 3600000;
      return Promise.resolve(clone(t));
    };
    S.cancelTrigger = id => {
      state.triggers = state.triggers.filter(x => x.id !== id);
      return Promise.resolve({ ok: true, cancelled: true });
    };
    S.listPending = () => Promise.resolve([]);
    S.ackPending = () => Promise.resolve({ ok: true, acked: true });
    S.pauseAll = paused => { cfg.schedule.paused = paused !== false; return Promise.resolve({ ok: true, paused: cfg.schedule.paused }); };

    // 提案制（v0.6.0）：模型路径只用「存草稿 → 用户确认后发」（与真实侧车的 emailDraft / emailSendDraft 同名同形；
    // 返回值与 js/sidecar.js 的 emailDraft 一致——直接给草稿对象）。手写表单仍走下面的 emailSend。
    S.emailDraft = msg => {
      const m = msg || {};
      const d = { id: nid('d'), at: Date.now(), to: String(m.to || '').toLowerCase(), subject: m.subject || '', body: m.body || '', status: 'pending' };
      state.drafts.push(d);
      auditPush('draft', d.to, d.subject, 'ok', '');
      return Promise.resolve(clone(d));
    };
    S.emailSend = msg => {
      const m = msg || {};
      const to = String(m.to || '').toLowerCase();
      if (!cfg.email.enabled) return Promise.resolve({ ok: false, code: 'EMAIL_DISABLED', message: '邮件功能未开启。' });
      if (cfg.email.dailyLimit <= 0) return Promise.resolve({ ok: false, code: 'DAILY_LIMIT_EXCEEDED', message: '每日上限为 0（默认保守值）。' });
      if (cfg.email.allowlist.indexOf(to) < 0) {   // 与 sidecar 一致：请求体里的 confirm 不算数，确认只走草稿流
        const d = { id: nid('d'), at: Date.now(), to: to, subject: m.subject || '', body: m.body || '', status: 'pending' };
        state.drafts.push(d);
        auditPush('draft', to, d.subject, 'denied', 'NEED_CONFIRMATION');
        return Promise.resolve({ ok: false, code: 'NEED_CONFIRMATION', draftId: d.id, message: '不在白名单里，已存成草稿，需要你确认后才发。' });
      }
      auditPush('send', to, m.subject || '', 'ok', '');
      return Promise.resolve({ ok: true, id: nid('m'), provider: 'mock' });
    };
    S.emailSentDrafts = () => Promise.resolve(state.drafts.filter(d => d.status === 'pending').map(clone));
    S.emailSendDraft = id => {
      const d = state.drafts.filter(x => x.id === id)[0];
      if (!d) return Promise.resolve({ ok: false, code: 'DRAFT_NOT_FOUND', message: '找不到草稿。' });
      d.status = 'sent';
      auditPush('send', d.to, d.subject, 'ok', '');
      auditPush('confirm', d.to, d.subject, 'ok', '');
      return Promise.resolve({ ok: true, id: nid('m'), provider: 'mock' });
    };
    S.emailDiscardDraft = id => {
      const d = state.drafts.filter(x => x.id === id)[0];
      if (d) d.status = 'discarded';
      return Promise.resolve({ ok: true, discarded: !!d });
    };
    S.emailAudit = () => Promise.resolve({ ok: true, audit: clone(state.audit.slice(0, 20)) });
    S.emailInbox = () => Promise.resolve({ ok: true, messages: [] });

    // summary 金额字段一律 *Cents 后缀（与真实 sidecar 同口径，审查 可维护性 #12）
    S.paymentSummary = () => Promise.resolve({
      ok: true,
      summary: {
        enabled: cfg.payment.enabled, provider: cfg.payment.provider, currency: cfg.payment.currency,
        perTxCents: cfg.payment.perTx, dailyCents: cfg.payment.daily, monthlyCents: cfg.payment.monthly,
        autoApproveCents: cfg.payment.autoApprove, cooldownMin: cfg.payment.cooldownMin,
        spent: { dailyCents: committed(), monthlyCents: committed(), agentCents: committed() },
        remaining: {
          dailyCents: Math.max(0, cfg.payment.daily - committed()),
          monthlyCents: Math.max(0, cfg.payment.monthly - committed()),
          agentCents: 0,
        },
      },
    });
    S.paymentPurchase = payload => {
      const p = payload || {};
      const amount = Math.floor(Number(p.amountCents) || 0);
      const detail = { merchant: p.merchant, category: p.category, amountCents: amount, currency: cfg.payment.currency, items: p.items || [] };
      if (!cfg.payment.enabled) return Promise.resolve({ ok: false, code: 'GATEWAY_DISABLED', message: '支付功能未开启。' });
      if (amount <= 0) return Promise.resolve({ ok: false, code: 'BAD_AMOUNT', message: '金额必须大于 0。' });
      if (amount > cfg.payment.perTx) return Promise.resolve({ ok: false, code: 'AMOUNT_EXCEEDS_LIMIT', message: '超过单笔上限。' });
      if (committed() + amount > cfg.payment.daily) return Promise.resolve({ ok: false, code: 'DAILY_LIMIT_EXCEEDED', message: '超过每日上限。' });
      const tx: any = {
        intentId: nid('pi'), agent: p.agent || 'agent', amountCents: amount, currency: cfg.payment.currency,
        merchant: p.merchant || '', category: p.category || '', items: p.items || [],
        status: 'pending', code: '', providerRef: '', createdAt: Date.now(),
      };
      state.txs.unshift(tx);
      return S.paymentSummary().then(s => {
        if (amount <= cfg.payment.autoApprove) {
          tx.status = 'charged';
          tx.providerRef = nid('mockpay-');
          tx.chargedAt = Date.now();
          return { ok: true, status: 'charged', intentId: tx.intentId, transaction: clone(tx), summary: s.summary, cart: detail };
        }
        return { ok: true, status: 'pending', needsApproval: true, intentId: tx.intentId, message: '需要你确认。', cart: detail, summary: s.summary };
      });
    };
    S.paymentApprove = id => {
      const t = state.txs.filter(x => x.intentId === id)[0];
      if (!t || t.status !== 'pending') return Promise.resolve({ ok: false, code: 'INTENT_ALREADY_RESOLVED' });
      t.status = 'charged';
      t.providerRef = nid('mockpay-');
      t.chargedAt = Date.now();
      return Promise.resolve({ ok: true, status: 'charged', transaction: clone(t) });
    };
    S.paymentDeny = id => {
      const t = state.txs.filter(x => x.intentId === id)[0];
      if (!t || t.status !== 'pending') return Promise.resolve({ ok: false, code: 'INTENT_ALREADY_RESOLVED' });
      t.status = 'denied';
      t.code = 'USER_REJECTED';
      return Promise.resolve({ ok: true, status: 'denied', code: 'USER_REJECTED' });
    };
    S.paymentCharge = S.paymentApprove;
    S.paymentMarkPaid = id => {
      const t = state.txs.filter(x => x.intentId === id)[0];
      if (!t) return Promise.resolve({ ok: false, code: 'INTENT_NOT_FOUND' });
      t.status = 'charged';
      t.chargedAt = Date.now();
      return Promise.resolve({ ok: true, status: 'charged' });
    };
    S.paymentTransactions = () => Promise.resolve({ ok: true, transactions: clone(state.txs.slice(0, 20)) });
    S.paymentReceipt = id => {
      const t = state.txs.filter(x => x.intentId === id)[0];
      if (!t) return Promise.resolve(null);
      return Promise.resolve({
        ok: true,
        receipt: {
          transaction: clone(t),
          text: '无限阅读 · 交易收据（演示）\n单号：' + t.intentId + '\n金额：' + (t.amountCents / 100).toFixed(2) + ' ' + t.currency
            + '\n商户：' + t.merchant + '\n状态：' + t.status + '\n备注：演示模式下的模拟收据。',
        },
      });
    };
    // 授权范围语义与真实 sidecar 对齐：状态记在内存里，下单前应用层会来查 / 签发；
    // 业务失败 reject 带 code 的 Error（真实客户端 api() 遇 400 也是抛，不是 resolve）
    S.paymentMandates = () => Promise.resolve({ ok: true, mandates: clone(state.mandates) });
    S.paymentCreateMandate = m => {
      const md = Object.assign({ id: nid('md'), createdAt: Date.now() }, m || {});
      if (!md.agent) return sidecarFail('AGENT_REQUIRED', '授权范围必须指定发起方（agent）。');
      state.mandates.push(md);
      return Promise.resolve(clone(md));   // 与 js/sidecar.js 同形：成功直接给 mandate 对象
    };

    // app.js 有几处直接走 api()：给一个最小路由（只覆盖界面用到的那几个）
    S.api = (method, pathText) => {
      const p = String(pathText || '');
      if (p.indexOf('/api/triggers') === 0) {
        return S.listTriggers().then(list => ({
          ok: true,
          triggers: list,
          stats: { active: list.filter(t => t.status === 'active').length, pending: 0 },
        }));
      }
      if (p.indexOf('/api/payment/transactions') === 0) return S.paymentTransactions();
      if (p.indexOf('/api/payment/summary') === 0) return S.paymentSummary();
      if (p.indexOf('/api/payment/receipt/') === 0) return S.paymentReceipt(decodeURIComponent(p.split('/').pop()));
      if (p.indexOf('/api/email/audit') === 0) return S.emailAudit();
      if (p.indexOf('/api/config') === 0) return S.getConfig();
      return Promise.resolve({ ok: true });
    };

    return true;
  }

  const ChatProviders = (global.IR && global.IR.ChatProviders) || {};
  ChatProviders['demo'] = { label: '离线演示（内置剧本，无需 Key）', chat: chat };

  const ImageProviders = (global.IR && global.IR.ImageProviders) || {};
  ImageProviders['demo-image'] = { label: '离线演示（本地占位图）', generate: generate };

  Demo.installSidecarMock = installSidecarMock;

  const __irApi = {
    ChatProviders: ChatProviders,
    ImageProviders: ImageProviders,
    Demo: Demo,
  };
  registerIR(__irApi);
  export { ChatProviders, ImageProviders, Demo };