/*
 * 无限阅读 · 上下文组装（AI1 剧情对话）v2
 *
 * 这里是「AI1 每轮发给模型的 messages 怎么拼、旧回合怎么压」的唯一实现：
 * 运行时（src/app/main.js）与离线评测（eval/run.js）共用同一份逻辑，避免评测测副本。
 *
 * 组装（§3.1 + §4.10 C-A/C-C，2026-10-14 评审后）：
 *   [system]  AI1 系统提示词（按 mode：choice / chat / rp；rp 无卡时用降级提示）
 *   [system]  [风格基调]（≤120 字）+ [故事设定（常驻）]（≤400 字）——此前 styleTone 只影响画面、
 *             premise 只在开局一回合在场，地基信息随摘要合并流失
 *   [system]  常驻摘要行：「{地点}｜{时间}｜在场：{names}｜伏笔：{最重要的2条}」
 *   [system]  场景摘要栈（压缩产物，越老越模糊）
 *   [最近保留的 messages]（已知容量时按 token 动态装，∈ [4, 40]；未知退回 8 条）
 *   [user]    召回 / 工具回传 / 启发式 / 强制注入作为前缀，后接 [玩家行动]
 *             （P2-12：注入层并入 user 前缀而非中段 system 块，规避兼容层吞中段 system）
 * 世界卡默认不常驻，靠 recall 工具按需召回、或「强制注入」（P5）。
 *
 * 压缩（§4.10 C-A/C-B）：以 scene_change 为边界做事件级摘要；占满时递归合并最旧两幕。
 * 提供纯函数 + 可注入的 summarize（真实用书记员模型，失败兜底用 localSummarize）。
 *
 * 纯函数、零依赖；UMD 兜底，浏览器挂 应用层注册表，Node 亦可加载。
 */

/* ↑ 阶段 2 搬迁自 src/core/context.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

  /* 上下文预算表（C-C，token 估算；中文 1 字 ≈ 1 token） */
  const BUDGET = {
    system: 150, summaryLine: 60, worldCard: 200,
    window: 800, expectation: 100, profile: 100,
    characterCard: 500, relationship: 80,   // R13：rp 角色卡常驻 + 关系记忆（chat / rp）
  };
  const COMPRESS_RATIO = 0.7;            // 超模型窗口 ~70% 触发压缩
  const DEFAULT_KEEP_MESSAGES = 8;       // §3.1：组装窗口 = 最近 8 条 messages（4 个回合）
  const DEFAULT_MAX_MESSAGES = 16;       // 积压超过即压缩（保留 8 + 消化积压）
  const DEFAULT_MAX_SUMMARIES = 6;        // 摘要栈上限，满了合并最旧两幕

  /* 2026-10-14 评审新增（P1-6 / P1-7 / P1-3）：常驻注入与动态窗口的预算参数 */
  const TONE_MAX_CHARS = 120;             // 风格基调注入上限（文本侧，此前只影响画面）
  const PREMISE_MAX_CHARS = 400;          // 常驻故事设定摘要上限（此前只在开局一回合在场）
  const WINDOW_MIN_MESSAGES = 4;          // 动态组装窗口下限
  const WINDOW_MAX_MESSAGES = 40;         // 动态组装窗口上限
  const WINDOW_TOKEN_RATIO = 0.5;         // 最近消息最多吃窗口的一半（另一半给系统块/注入/输出）

  /* P-1（§4）：画师 scene 模式的「最近剧情」窗口——只带最近 N 回合的「玩家行动 + 旁白」，
   * 单条截断 200 字；更早的对话 / 世界卡 / 摘要栈 / 画像一律不进画师上下文（用完即弃）。 */
  const PAINTER_RECENT_TURNS = 3;
  const PAINTER_RECENT_LINE_CHARS = 200;

  /* ---------------- 系统提示词（按模式，§3.1 / §4.8） ----------------
   * 剧情模式（choice）：中文字段 JSON 契约（v0.3）；
   * 对话 / 扮演（chat / rp）：极简提示词 + 纯文本输出（2026-10-07 定案，见下）。 */

  const COMMON_OPEN = '你是这部视觉小说的旁白，同时扮演故事世界里除玩家以外的所有角色。玩家的输入自由度极高，必须顺着玩家的任何行动把故事讲下去，不要拒绝、不要出戏、不要建议「该做什么」。玩家可能随时表达对后续发展的期望，顺着编织、保持合理，不必生硬照办。';

  // 做 / 说 / 导演：玩家输入前的内层标记（外层仍是 [玩家行动]，不要改）
  const KIND_MARK_HINT = '玩家输入里的（做）/（说）/（导演）是输入类型标记：（做）=玩家的行动，（说）=玩家说的话，（导演）=玩家设定的既成事实（当作世界里已经发生的事，顺着写）。标记只说明类型，不要复述标记本身，也不要把（导演）的内容当成玩家角色的行动。';

  const STORY_RULES = [
    COMMON_OPEN,
    '',
    '每次回复必须且只能输出一个 JSON 对象（禁止 markdown 代码块、禁止多余文字）：',
    '{"旁白":"旁白与对白，2~4 句中文，可包含角色对白（用「」）","人物":[{"名字":"角色名","在场":"在场或离场","性格":"性格","说话方式":"说话方式"}],"地点":"当前地点","时间":"当前时间","伏笔":["尚未回收的伏笔，一句话一条"],"画面":"当前画面内容，中文一句话","场景切换":false,"选项":["短选项1","短选项2","短选项3"]}',
    '',
    '规则：',
    KIND_MARK_HINT,
    '- 场景切换 只在地点、时间或画面主体明显变化时（含开局）为 true，否则 false；',
    '- 人物 只列当前在场或刚离场的角色，没有就给空数组；地点 / 时间 / 伏笔 / 画面 每轮自报当前最新值（合计约 50 字），解析失败时客户端会沿用上一轮；',
    '- 结尾必须给 2~3 个玩家可能采取的行动（每项不超过 12 个字）。选项只是辅助，玩家随时可以自己打字；',
    '- 保持前后剧情连贯，记住之前发生的事；只输出 JSON。',
  ].join('\n');

  /* 对话 / 扮演（chat / rp）：极简提示词 + 纯文本输出（2026-10-07 用户定案）。
   * 这两个模式不再走 JSON 契约——世界卡由 update_memory 工具 + 书记员定时校对维护，
   * 画面参考取旁白原文（app.js 的 parseAIReply / absorbReply 有对应兜底）；
   * 「工具怎么用」由 assembleAI1 自动追加的 [可用工具] 块交代，不写进这里。 */

  // 智能体模式（原「对话」，v0.6.0）：通用助手 + 更全的工具集（画图 / 记事 / 定时 / 邮件 / 下单）。
  // 发邮件与花钱只是「提案」：用户在界面上确认前不得声称已完成（红线在 src/core/proposals.ts 落地）。
  const CHAT_SYSTEM = '你是用户的智能助手。回答直接、简洁，用中文。需要时可以使用你拥有的能力（画图、记事、定时提醒、写邮件、下单），但不要在回复里提「工具」「函数」。发邮件和花钱只是向用户提出请求：先用一两句话说明你要做什么，由用户在界面上确认；在用户确认之前，不要说已经发出或已经付款。';

  // 扮演模式：同 CHAT_SYSTEM 的定位，多一句人设锚定与两条硬规则（不出戏 / 不替玩家行事）
  const RP_SYSTEM = '你是这部作品的伴读者 AI，现在在这里进行角色扮演：你就是角色卡里的那个人（名字、性格、说话方式都以角色卡为准）。保持角色不出戏，也不要替玩家说话或行动；每次回应 2~6 句中文。';

  // rp 无角色卡（导入 / 旧档可能产生）：指令不能指向不存在的卡，改为自拟并钉住
  const RP_SYSTEM_FALLBACK = '你是这部作品的伴读者 AI，现在在这里进行角色扮演：这部作品还没有角色卡，请按故事设定自拟你要扮演的角色，之后每一轮都保持这个角色不变，也不要替玩家说话或行动；每次回应 2~6 句中文。';

  // 对话 / 扮演的提示词保持极简：只补一句输入类型说明（与剧情模式同一条规则的短版）。
  // v0.6.0：chat（智能体）不再下发做 / 说 / 导演，因此 chat 的系统提示不附这条说明（防模型复述标记）。
  const KIND_MARK_HINT_SHORT = '输入前的（做）/（说）/（导演）是输入类型标记（分别是行动 / 说的话 / 世界里的既成事实），不要复述标记本身。';

  // 切换兼容：rp 存档切成 chat 后，历史用户消息里可能带着内层标记，而 chat 的系统提示
  // 不再解释它们（模型会照着复述）——组装 chat 历史时剥掉 [玩家行动] 之后紧跟的那一个标记。
  // 外层 [玩家行动] 前缀保持不变；正文中间出现的（导演）等不动。
  function stripKindMarker(content) {
    const s = String(content == null ? '' : content);
    return s.replace(/(\[玩家行动\] )（(?:做|说|导演)）/, '$1');
  }

  function systemForMode(mode, opts?) {
    if (mode === 'chat') return CHAT_SYSTEM;
    if (mode === 'rp') return ((opts && opts.noCharacterCard) ? RP_SYSTEM_FALLBACK : RP_SYSTEM) + KIND_MARK_HINT_SHORT;
    return STORY_RULES;
  }

  const AI1_SYSTEM = systemForMode('choice'); // 兼容旧引用

  /* ---------------- 画师子代理（§3.2：隔离上下文，用完即弃） ----------------
   *   [system]  PAINTER_SYSTEM（导演判断：画场景还是人物、构图、氛围）
   *   [system]  [画风锚]：设定卡全文（未锚定时带滚动风格摘要代替；都没有时「（未锚定，自由发挥）」）
   *   [context] [最近两张图]：最近 2 张图的 prompt + alt（防重复）
   *   [context] [基底 prompt]：上一次出图的完整 prompt（差分基底：风格部分原样保留，
   *             只改剧情变化的部分；没有上一张图时整块省略）。仅在 scene 模式下发。
   *   [context] [最近剧情]：scene 模式 = 最近 PAINTER_RECENT_TURNS 回合的「玩家行动 + 旁白」（§4，
   *             玩家行动带（做）/（说）/（导演）标记、每条截断 PAINTER_RECENT_LINE_CHARS 字）；
   *             chat（工作台）模式保持最近 3 条旁白不动
   *   [tools]   recall_recent_plot() —— 仅画师工作台对话时可用，返回最近 10 条完整记录
   *   [user]    [画面参考] world.scene ／ [画风要求] ／ 工作台对话时为用户的话
   * 子代理每次调用独立、用完即弃，不进 AI1 对话历史。scene 模式不得出现更早对话、世界卡全文、
   * 摘要栈、剧情规则提示词、用户画像、记忆条目（测试见 eval/painter-context-test.js）。
   */

  const PAINTER_SYSTEM = [
    '你是视觉小说的「AI 画师导演」。根据画面参考与最近剧情，决定当前这一幕画什么：可以是纯场景、人物、或两者结合，由你根据叙事需要自行判断。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"prompt_en":"English image prompt, composition/light/atmosphere/medium, under 40 words","subject":"scene|character|both","alt":"中文一句话，说明这张图画了什么"}',
    '',
    '规则：',
    '- prompt_en 用英文、具体、有画面感；不要出现任何文字、水印、签名的描述；alt 与 prompt 内容一致。',
    '- 若上下文给了「[基底 prompt]」（上一次出图的完整提示词）或「[当前这张图]」的提示词：以它为基底，'
      + '画风 / 媒介 / 色板 / 光线 / 镜头语言 / 画质词**原样保留**（措辞和顺序都别改），'
      + '只重写剧情（或用户要求）真正变化的部分：人物、动作、视角、道具、时间天气、地点。',
    '- 换了场景或视角时，替换与新画面冲突的主体描述，风格词照旧保留。',
    '- 输出必须是**完整**的 prompt（生图接口只吃完整句子）：不要输出差异说明、不要写「同上」、不要省略没变的部分。',
    '- 没有可参照的基底时（第一次出图），自己把风格写全。',
  ].join('\n');

  // 画师工作台对话：讨论「已经画好的这张图」怎么改
  const PAINTER_CHAT_SYSTEM = [
    PAINTER_SYSTEM,
    '',
    '现在用户在画师工作台里跟你讨论已经画好的这张图。用中文回应他的要求（一句话，说明你改了什么），并给出改后的 prompt_en 与 alt。',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"reply":"中文一句话，说明改动","prompt_en":"改后的英文提示词","alt":"改后的中文说明"}',
    '用户没要求改的地方尽量原样保留（尤其画风 / 媒介 / 色板 / 光线 / 镜头语言 / 画质词，措辞和顺序都别动）；不要输出与当前这张图无关的新场景。',
  ].join('\n');

  // 视频动态提示词（§6）：把这一幕写成「视频提示词」。输出沿用现有 JSON 键（prompt_en / alt）。
  // 图生（i2v）：只写「动起来的部分」（动作、运镜、氛围变化），可带 [pan] [zoom] [static] 镜头标记；
  //              不重复描述画面里已有的静态外观。
  // 文生（t2v）：完整画面 + 动作 + 运镜。
  const PAINTER_VIDEO_SYSTEM = [
    '你是视觉小说的「AI 画师导演」。现在要把这一幕做成一段短视频，由你写成「动态提示词」（video prompt）。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"prompt_en":"English video prompt: what moves, camera work, atmosphere changes (may include [pan] [zoom] [static] camera tags)","alt":"中文一句话，说明这段视频拍了什么"}',
    '',
    '规则：',
    '- prompt_en 用英文、具体，写「时间维度上的变化」：动作、运镜、氛围变化；可用 [pan] [zoom] [static] 这类镜头标记；',
    '- 若给了「源画面」（图生视频）：画面内容以它为准，不要重复描述已有的静态外观（人物长相、服饰、陈设、构图），只写动起来的部分；',
    '- 若没有源画面（文生视频）：写完整画面（主体、环境、光线）+ 动作与运镜；',
    '- 不要出现任何文字、水印、签名的描述；alt 与 prompt 内容一致。',
  ].join('\n');

  // P4 锚定：出 4 组画风关键词 + 试画提示词（风格基调为生成依据，§5）
  const PAINTER_STYLES_SYSTEM = [
    '你是视觉小说的「AI 画师导演」。现在为这部作品做开局画风锚定：给出 4 组风格明显不同的画风关键词，并为每组写一条试画提示词。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"styles":[{"keywords":["english style keywords"],"prompt_en":"English image prompt","alt":"中文一句话，说明这组画风的感觉"}]}',
    '',
    '规则：styles 必须 4 组；4 组之间差异明显（色调 / 媒介 / 笔触至少两项不同）；keywords 用英文短语；prompt_en 画的是这个故事世界的场景（建立镜头为主），不要出现任何文字、水印、签名的描述；不要与「已试过的方向」重复。',
  ].join('\n');

  // P4 锚定：写 / 改视觉设定卡（之后每张画都以它为锚，§5）
  const PAINTER_CARD_SYSTEM = [
    '你是视觉小说的「AI 画师导演」。按选定的画风方向与故事设定，写一张视觉设定卡——之后每一张画都以它为锚，保证画风与人物前后一致。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"card":{"styleKeywords":["english keywords"],"medium":"媒介（英文短语）","palette":"色板（英文短语）","characters":[{"name":"中文名","appearanceEn":"English appearance","outfit":"服饰","features":"特征"}],"negative":"negative prompt","note":"中文备注"},"reply":"中文一句话，说明这次写了/改了什么"}',
    '',
    '规则：',
    '- characters 覆盖给定人物，每人一条，appearanceEn 用英文且具体；',
    '- 用户要求修改时，未要求改的字段原样保留；画风关键词保持稳定，不要每轮换一套；',
    '- note 是**画风备注**，只写不随剧情变化的东西（笔触 / 光线质感 / 构图偏好 / 色调约束）。',
    '  不要写时间、天气、地点、季节、人物生死这类剧情事实——它们属于世界状态卡，由剧情随时改变；',
    '  例如写「冷暖光各占一半，颗粒明显」，而不要写「始终深夜、始终下雨」。',
  ].join('\n');

  // 画师可用工具（仅工作台对话下发；结构化定义，§4.5）
  const RECALL_RECENT_PLOT_TOOL = {
    type: 'function',
    function: {
      name: 'recall_recent_plot',
      description: '取回最近 10 条完整剧情记录（原文，不是摘要）。需要确认画面上该出现谁、有什么细节时调用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };

  /* ---------------- AI1 工具（P5-1 第一批：召回类，§4.5） ---------------- */

  const RECALL_WORLD_STATE_TOOL = {
    type: 'function',
    function: {
      name: 'recall_world_state',
      description: '取回世界状态卡全文（地点 / 时间 / 在场人物及其性格与说话方式 / 伏笔 / 关系）。不确定前情、地点、人名或时间时先调用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };

  const RECALL_STYLE_CARD_TOOL = {
    type: 'function',
    function: {
      name: 'recall_style_card',
      description: '取回画面基调（画风参数）。要写人物外貌、服饰或画面细节时先调用；结果里的英文是给绘图模型的参数，只用来把握氛围，不要在正文里复述。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };

  // 对话 / 扮演的直出变体（§3.E）：模型自己写生图提示词，不转画师子代理。
  // P-1（v0.11.0）：剧情模式不再下发 request_image（作画只能点按钮），画师变体 REQUEST_IMAGE_TOOL 已删除；
  // chat / rp 的直出变体保持不变（工具名仍是 request_image，frontend-smoke 对工具名集合的断言继续成立）。
  const REQUEST_IMAGE_DIRECT_TOOL = {
    type: 'function',
    function: {
      name: 'request_image',
      description: '生成一张图。玩家想看画面，或出现值得定格的一刻时调用。你自己写生图提示词（建议英文）：主体、外貌服饰、环境、光线、构图、画风写清楚；不要出现玩家真名。调用后不会等待结果，图会稍后自动出现在聊天里，别声称已经画好。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '英文生图提示词：主体、外貌服饰、环境、光线、构图、画风写清楚' },
          alt: { type: 'string', description: '一句话中文说明这张图画了什么（用于无障碍与留痕，可选）' },
        },
        required: ['prompt'],
      },
    },
  };

  const UPDATE_MEMORY_TOOL = {
    type: 'function',
    function: {
      name: 'update_memory',
      description: '把确凿的新事实写进记忆：玩家明确要求「记住……」，或本轮出现了需要长期记住的设定（新人物、新伏笔、关系变化）。不要每轮都调。',
      parameters: {
        type: 'object',
        properties: {
          world: { type: 'object', description: '世界卡增量：可含 place / time / scene / characters（{name,presence,personality,speech,note} 数组）/ threads（字符串数组）/ relationship（{stage,bonds,notes}）' },
          profile: {
            type: 'array',
            description: '用户画像条目（玩家明确说出的个人信息，如「记住我怕蜘蛛」）；kind 取 fact 事实 / preference 偏好 / taboo 忌讳。画像未开启时客户端不会记录。',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '一句话，如「怕蜘蛛」' },
                kind: { type: 'string', description: 'fact | preference | taboo' },
              },
            },
          },
          text: { type: 'string', description: '一句话说明这次记了什么（给玩家看的留痕）' },
        },
        required: [],
      },
    },
  };

  const TOOLS_RECALL = [RECALL_WORLD_STATE_TOOL, RECALL_STYLE_CARD_TOOL];
  const TOOL_NAMES_RECALL = TOOLS_RECALL.map(t => t.function.name);

  // AI1 全量工具（召回 + 写记忆），P5-1 一起下发。
  // P-1（v0.11.0）：剧情模式不再有 request_image——作画只能由用户点 🎨 触发（§3.3）；
  // 对话 / 扮演走直出变体（prompt），工具名不变（§3.E）
  const TOOLS_AI1 = TOOLS_RECALL.concat([UPDATE_MEMORY_TOOL]);
  const TOOLS_AI1_DIRECT = TOOLS_RECALL.concat([REQUEST_IMAGE_DIRECT_TOOL, UPDATE_MEMORY_TOOL]);
  const TOOL_NAMES_AI1 = TOOLS_AI1.map(t => t.function.name);
  const MAX_TOOL_CALLS_PER_TURN = 2;   // §4.5 每轮上限 2 次

  /* ---------------- 调度工具（模型主动行动） ----------------
   * 只在「对话 / 扮演」模式、且本地服务在线且后端已开启调度时才下发（见 toolsForMode）。
   * 调用后触发器进入「待确认」，必须由用户在界面上点确认才生效 ——
   * 模型可以「安排」，但不能让主动行为自己落地。 */

  const SCHEDULE_ONCE_TOOL = {
    type: 'function',
    function: {
      name: 'schedule_once',
      description: '安排一次「将来某个时刻主动联系用户」（只提一次，到点后自动结束）。提交后需要用户在界面上确认才会生效。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '这次安排的名字。同一个名字会覆盖旧安排，不会重复创建' },
          at: { type: 'string', description: '将来的时刻，ISO 8601 格式，例如 2026-10-11T09:00:00+08:00' },
          prompt: { type: 'string', description: '到点时要做什么（会作为一条消息交给你自己处理）' },
          reason: { type: 'string', description: '为什么在这个时刻联系用户（会展示给用户看）' },
        },
        required: ['name', 'at', 'prompt'],
      },
    },
  };

  const SCHEDULE_HEARTBEAT_TOOL = {
    type: 'function',
    function: {
      name: 'schedule_heartbeat',
      description: '安排「每隔固定时间主动联系用户」一次（最小 1 分钟）。提交后需要用户在界面上确认才会生效。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '这次安排的名字。同一个名字会覆盖旧安排' },
          everyMinutes: { type: 'number', description: '间隔分钟数，最小 1' },
          prompt: { type: 'string', description: '每次到点时要做什么' },
          reason: { type: 'string', description: '为什么要这样联系用户（会展示给用户看）' },
        },
        required: ['name', 'everyMinutes', 'prompt'],
      },
    },
  };

  const SCHEDULE_CRON_TOOL = {
    type: 'function',
    function: {
      name: 'schedule_cron',
      description: '用日历表达式安排主动联系（如每天 9 点、每周一）。5 字段：分 时 日 月 周；提交后需要用户在界面上确认才会生效。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '这次安排的名字。同一个名字会覆盖旧安排' },
          expr: { type: 'string', description: 'cron 表达式（5 字段），例如 0 9 * * * 表示每天 09:00' },
          tz: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai；不填按 UTC' },
          prompt: { type: 'string', description: '到点时要做什么' },
          reason: { type: 'string', description: '为什么要这样联系用户（会展示给用户看）' },
        },
        required: ['name', 'expr', 'prompt'],
      },
    },
  };

  const LIST_TRIGGERS_TOOL = {
    type: 'function',
    function: {
      name: 'list_triggers',
      description: '查看当前已有的主动联系安排（名字、状态、时间、原因）。',
      parameters: { type: 'object', properties: {} },
    },
  };

  const CANCEL_TRIGGER_TOOL = {
    type: 'function',
    function: {
      name: 'cancel_trigger',
      description: '取消一个已有的主动联系安排（按名字找）。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '要取消的安排名字' } },
        required: ['name'],
      },
    },
  };

  const SCHEDULE_TOOLS = [
    SCHEDULE_ONCE_TOOL, SCHEDULE_HEARTBEAT_TOOL, SCHEDULE_CRON_TOOL,
    LIST_TRIGGERS_TOOL, CANCEL_TRIGGER_TOOL,
  ];
  const TOOL_NAMES_SCHEDULE = SCHEDULE_TOOLS.map(t => t.function.name);
  const SCHEDULE_TOOL_SET = new Set(TOOL_NAMES_SCHEDULE);
  function isScheduleTool(name) { return SCHEDULE_TOOL_SET.has(String(name)); }

  const SCHEDULE_POLICY_TEXT = [
    '主动联系（只在对话 / 扮演模式可用）：',
    '用户说到「到点提醒我」「明天再来找我」「过几小时问问我在干嘛」这类将来才发生的事，就用 schedule_once / schedule_heartbeat / schedule_cron 安排；',
    'name 是这次安排的身份：同名会覆盖旧安排，不会重复；prompt 写到点时你要做什么，reason 写为什么这个时候找他（用户会看到）；',
    '这些只是「提案」，用户确认后才生效；用 list_triggers 看已有什么安排，用 cancel_trigger 取消。',
    '不要在回复里说「工具」「触发器」，用自然的话告诉他你已经安排好了、等他确认。',
  ].join('');

  /* ---------------- 邮件 / 下单工具（提案制，v0.6.0） ----------------
   * 模型发起的邮件 / 下单只能产生「提案」：执行必须由用户在界面上点确认触发
   * （状态机与执行在 src/core/proposals.ts，红线见该文件头注释）。 */

  const EMAIL_PROPOSE_TOOL = {
    type: 'function',
    function: {
      name: 'email_propose',
      description: '起草一封给用户的邮件（只是提案）：用户让你写信 / 发邮件时调用。填好收件人、主题与正文提交；用户在界面上确认后才会真正发出，确认前不要说已经发出。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人邮箱地址（单个地址，不要换行）' },
          subject: { type: 'string', description: '邮件主题（不要换行）' },
          body: { type: 'string', description: '邮件正文' },
          reason: { type: 'string', description: '一句话说明为什么要发这封信（会展示给用户，可选）' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  };

  const PAYMENT_PROPOSE_TOOL = {
    type: 'function',
    function: {
      name: 'payment_propose',
      description: '提交一个代下单提案（只是提案）：用户要买东西、或你建议购买时调用。金额用元（如 12.34）；用户在界面上确认后才会下单扣款，确认前不要说已经付款。',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: '金额（元），最多两位小数，必须大于 0' },
          merchant: { type: 'string', description: '商户名（可选）' },
          category: { type: 'string', description: '品类，例如 图书（可选）' },
          items: { type: 'array', items: { type: 'string' }, description: '商品名称列表（可选，最多 5 项）' },
          reason: { type: 'string', description: '一句话说明为什么要买（会展示给用户，可选）' },
        },
        required: ['amount'],
      },
    },
  };

  const EMAIL_TOOLS = [EMAIL_PROPOSE_TOOL];
  const PAYMENT_TOOLS = [PAYMENT_PROPOSE_TOOL];
  const TOOL_NAMES_PROPOSAL = EMAIL_TOOLS.concat(PAYMENT_TOOLS as any).map(t => t.function.name);
  const PROPOSAL_TOOL_SET = new Set(TOOL_NAMES_PROPOSAL);
  function isProposalTool(name) { return PROPOSAL_TOOL_SET.has(String(name)); }

  const EMAIL_POLICY_TEXT = [
    '写邮件（只是提案）：',
    '用户让你写信 / 发邮件时用 email_propose 起草，填收件人 / 主题 / 正文（可带一句 reason 说明为什么发）；',
    '这只是提案：用户在界面上确认后才会发送，确认前不要说「已经发出」「已经寄出」。',
  ].join('');

  const PAYMENT_POLICY_TEXT = [
    '代下单（只是提案）：',
    '用户要买东西、请你代买时用 payment_propose，金额用元（如 12.34），写清商户 / 品类 / 商品（可带一句 reason）；',
    '这只是提案：用户在界面上确认后才会下单扣款，确认前不要说「已经付款」「已经买好」。',
  ].join('');

  // 按模式 / 能力取工具清单：剧情模式恒定不变（不追加调度 / 邮件 / 下单 / 作画工具）。
  // P-1（v0.11.0）：choice 不含 request_image（剧情作画只能点按钮，§3.3）；
  // chat / rp 的 request_image 用直出变体（模型自己写提示词、不请画师，§3.E）。
  // 邮件 / 下单是高风险副作用动作：只在 chat（智能体）下发——rp / choice 即便传了 true 也不给。
  function toolsForMode(mode, opts) {
    opts = opts || {};
    const wantSchedule = !!opts.schedule && (mode === 'chat' || mode === 'rp');
    const wantEmail = !!opts.email && mode === 'chat';
    const wantPayment = !!opts.payment && mode === 'chat';
    const base = (mode === 'chat' || mode === 'rp') ? TOOLS_AI1_DIRECT : TOOLS_AI1;
    let out = base;
    if (wantSchedule) out = out.concat(SCHEDULE_TOOLS as any);
    if (wantEmail) out = out.concat(EMAIL_TOOLS);
    if (wantPayment) out = out.concat(PAYMENT_TOOLS);
    return out;
  }
  function toolNamesForMode(mode, opts) {
    return toolsForMode(mode, opts).map(t => t.function.name);
  }

  // 调用策略只留一两句，进系统提示词；不向玩家暴露「工具」概念（§4.5）。
  // P-1（§3.3）：request_image 的措辞按 tools 动态拼装——工具清单里没有它（剧情模式）就一个字不提，
  // 剧情模式的工具说明里不再出现「调 request_image / 请画师作画」字样。
  const TOOL_POLICY_IMAGE = '玩家想看画面或出现值得定格的一刻时调 request_image；';
  function toolPolicyText(tools) {
    const hasImage = Array.isArray(tools) && tools.indexOf('request_image') >= 0;
    return [
      '工具（只在必要时用，不要每轮都调，一轮最多 2 次）：',
      '不确定地点 / 时间 / 在场人物 / 前情 / 伏笔时先调 recall_world_state；要写人物外貌、服饰或画面细节时先调 recall_style_card；',
      hasImage ? TOOL_POLICY_IMAGE : '',
      '玩家明确要求记住某事、或出现需要长期记住的设定时调 update_memory（玩家自己的个人信息写 profile，世界与关系写 world）。',
      '拿到结果后直接继续剧情，不要在回复里提「工具」「召回」「函数」这类字眼。',
    ].filter(Boolean).join('');
  }
  const TOOL_POLICY_TEXT = toolPolicyText([]);   // 无作画工具的基础版（剧情模式口径）

  // 工具名 → 召回内容标识
  const RECALL_TOOL_SCOPE = { recall_world_state: 'world', recall_style_card: 'style' };

  function isRecallTool(name) { return !!RECALL_TOOL_SCOPE[name]; }

  // 视觉设定卡全文（P4 锁定后每次必带的锚）——**给画师**：外观与负面提示词都要，画师据此写 prompt
  function styleCardText(card) {
    if (!card) return '';
    const lines = [];
    const kw = (card.styleKeywords || []).filter(Boolean);
    if (kw.length) lines.push('画风：' + kw.join(', '));
    if (card.medium) lines.push('媒介：' + card.medium);
    if (card.palette) lines.push('色板：' + card.palette);
    const cs = (card.characters || []).filter(c => c && c.name).map(c =>
      '· ' + c.name + '：' + [c.appearanceEn, c.outfit, c.features].filter(Boolean).join('；'));
    if (cs.length) lines.push('人物设定：\n' + cs.join('\n'));
    if (card.negative) lines.push('负面：' + card.negative);
    if (card.note) lines.push('备注：' + card.note);
    return lines.join('\n') || '';
  }

  /* 视觉设定卡的「文本侧视图」——**给 AI1（旁白模型）**，和上面那套不是一回事：
   * 卡里的 人物外观 / 媒介 / 色板 是英文的生图参数，负面更是纯提示词参数，
   * 原样喂给旁白模型只会漏进思考链和正文（用户看到的就是「画师的提示词混进来了」）。
   * 文本侧只留：画风关键词（一句，注明是生图参数、别复述）+ 中文备注。 */
  function styleCardTextForText(card) {
    if (!card) return '';
    const lines = [];
    const kw = (card.styleKeywords || []).filter(Boolean);
    if (kw.length) {
      lines.push('画风参数（英文，仅供你把握氛围：不要在正文 / 对白 / 思考里复述、翻译或讨论这些词）：'
        + kw.join(', '));
    }
    if (card.note) {
      lines.push('画面偏好：' + card.note
        + '（只作画风参考：时间 / 天气 / 地点 / 在场者这些**剧情事实**以世界状态卡与最近剧情为准，冲突时听剧情）');
    }
    return lines.join('\n');
  }

  function rollingStyleText(rs) {
    rs = rs || {};
    const lines = [];
    if (rs.style) lines.push('风格倾向：' + rs.style);
    if (rs.scenes) lines.push('常见场景：' + rs.scenes);
    if (rs.wardrobe) lines.push('服饰元素：' + rs.wardrobe);
    return lines.join('\n');
  }

  // 画风锚的作用域说明：卡只定画风与气质，剧情事实（时间 / 天气 / 地点 / 在场者）永远听剧情的。
  // 起因：卡里的「备注」被写成了「始终深夜、始终下雨」，玩家要晴天时画师仍照雨画。
  const ANCHOR_SCOPE_HINT = '\n（画风锚只决定画风与气质：地点 / 时间 / 天气 / 在场者这类剧情事实以 [最近剧情] 为准，与备注冲突时听剧情。）';

  // 画风锚：设定卡优先 → 滚动风格摘要 → 未锚定（§6 降级）
  function painterAnchorText(story) {
    const card = story && story.styleCard;
    if (card && card.locked !== false) {
      const t = styleCardText(card);
      if (t) return t;
    }
    const t2 = rollingStyleText((story && story.rollingStyle) || {});
    return t2 || '（未锚定，自由发挥）';
  }

  // 文本侧画风锚（AI1 用）：设定卡走「文本侧视图」（不含英文外观 / 负面提示词），没卡退回滚动风格摘要
  function textAnchorText(story) {
    const card = story && story.styleCard;
    if (card && card.locked !== false) {
      const t = styleCardTextForText(card);
      if (t) return t;
    }
    return rollingStyleText((story && story.rollingStyle) || {});
  }

  // 召回块文本（§4.5）：world → 世界卡全文；style → 视觉设定卡（无卡退回滚动风格摘要 / 未锚定）
  function recallBlock(story, scope) {
    if (scope === 'world') {
      const t = worldCardText(story && story.world);
      return t
        ? ('[召回 · 世界状态卡]\n' + t)
        : '[召回 · 世界状态卡]\n（世界卡还是空的：按设定自由发挥，并在回复里用 world 字段自报地点 / 时间 / 人物。）';
    }
    if (scope === 'style') {
      const t = textAnchorText(story);
      return t
        ? ('[召回 · 视觉设定卡]\n' + t + '\n（以上只是画面基调参考：不要在旁白、对白或选项里复述这些参数。）')
        : '[召回 · 视觉设定卡]\n（还没有视觉设定卡：按故事设定自拟画面基调。）';
    }
    return '';
  }

  function recentImageLines(story, n) {
    const out = [];
    const log = (story && story.log) || [];
    for (let i = log.length - 1; i >= 0 && out.length < (n || 2); i--) {
      const e = log[i];
      if (e.type !== 'image') continue;
      out.push('· ' + (e.alt || '') + '｜prompt：' + (e.prompt || ''));
    }
    if (!out.length) {
      const sc = ((story && story.scenes) || []).filter(Boolean).slice(-(n || 2));
      for (const s of sc) out.push('· ' + (s.alt || '') + '｜prompt：' + (s.prompt || ''));
    }
    return out.reverse();
  }

  /* 上一次出图的完整 prompt（含画风后缀），给画师当「差分基底」。
   * 为什么需要：生图是纯文生图、每次从零开始，风格只能靠这段文字钉住；
   * 让画师在它上面只改剧情变化的部分，风格才不会一轮一个样。 */
  function lastImagePrompt(story) {
    const log = (story && story.log) || [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e && e.type === 'image' && e.prompt) return String(e.prompt).trim();
    }
    const scenes = ((story && story.scenes) || []).filter(s => s && s.prompt);
    return scenes.length ? String(scenes[scenes.length - 1].prompt).trim() : '';
  }

  function recentNarrationLines(story, n) {
    const out = [];
    const log = (story && story.log) || [];
    for (let i = log.length - 1; i >= 0 && out.length < (n || 3); i--) {
      const e = log[i];
      if (e.type !== 'narration' || !e.text) continue;
      out.push('· ' + String(e.text).slice(0, 120));
    }
    return out.reverse();
  }

  // P-1（§4）：画师 scene 模式的「最近剧情」——最近 N 回合的「玩家行动 + 旁白」，按时间顺序。
  // 玩家行动保留（做）/（说）/（导演）类型标记，每条截断 PAINTER_RECENT_LINE_CHARS 字；
  // N 回合之前的对话、世界卡、摘要栈、画像一律不带（画师上下文隔离规则，Node 可测）。
  const PAINTER_KIND_MARKS = { do: '（做）', say: '（说）', direct: '（导演）' };
  function recentTurnLines(story, n) {
    const keep = (n > 0) ? n : PAINTER_RECENT_TURNS;
    const log = (story && story.log) || [];
    const clip = (s) => {
      const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return t.length > PAINTER_RECENT_LINE_CHARS ? t.slice(0, PAINTER_RECENT_LINE_CHARS) : t;
    };
    // 从后往前按「旁白收口」切回合：一条旁白 = 一回合的结尾，紧邻它之前的玩家行动归这一回合
    const turns = [];
    let cur = null;
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (!e) continue;
      if (e.type === 'narration' && e.text) {
        if (cur) {
          turns.push(cur);
          if (turns.length >= keep) { cur = null; break; }
        }
        cur = { narration: e.text, action: '', mark: '' };
      } else if (cur && !cur.action && (e.type === 'player' || e.type === 'choice') && e.text) {
        cur.action = clip(e.text);
        cur.mark = PAINTER_KIND_MARKS[e.kind] || PAINTER_KIND_MARKS.do;
        if (/^（(?:做|说|导演)）/.test(cur.action)) cur.mark = '';   // 文本里已有标记就别再加一层
      }
    }
    if (cur && turns.length < keep) turns.push(cur);
    turns.reverse();
    const out = [];
    for (const t of turns) {
      if (t.action) out.push('· ' + t.mark + t.action);
      out.push('· ' + clip(t.narration));
    }
    return out;
  }

  // recall_recent_plot 的返回：最近 n 条完整记录（原文）
  function recentPlotText(story, n) {
    const log = (story && story.log) || [];
    return log.slice(-(n || 10)).map(e => {
      if (e.type === 'player' || e.type === 'choice') return '玩家：' + (e.text || '');
      if (e.type === 'narration') return '旁白：' + (e.text || '');
      if (e.type === 'image') return '（画面）' + (e.alt || '');
      if (e.type === 'tool') return '（' + (e.summary || e.tool || '') + '）';
      return (e.text || '');
    }).filter(Boolean).join('\n');
  }

  // 锚定任务的「故事设定」块：风格基调（向导栏）+ premise 前几行（§5：风格基调是候选生成依据）
  function storySettingText(story) {
    const tone = String((story && story.styleTone) || '').trim();
    const premise = String((story && story.premise) || '').trim();
    const head = premise.split('\n').slice(0, 6).join('\n');
    return [tone ? ('风格基调：' + tone) : '', head].filter(Boolean).join('\n') || '（未提供，自由发挥）';
  }

  /**
   * 组装画师子代理本轮请求的 messages（§3.2 + P4 锚定）。
   * @param {object} story
   * @param {object} [opts]
   *   sceneRef   画面参考（world.scene / scene_summary）
   *   styleHint  画风要求兜底（settings 画风预设，未锚定卡时用）
   *   mode       'scene'（自动作画）| 'chat'（工作台对话）
   *              | 'styles'（锚定：出 4 组画风候选）| 'card'（锚定：起草设定卡）| 'cardchat'（锚定：说着改）
   *              | 'video'（生视频的动态提示词，§6；子类型看 videoKind）
   *   videoKind  'i2v'（图生：只写动起来的部分）| 't2v'（文生：完整画面 + 动作）
   *   userText   工作台 / 锚定对话里用户的话
   *   plot       工作台已召回最近记录（作为工具结果附上）
   *   tools      是否下发 recall_recent_plot 工具定义（仅工作台）
   *   batch      锚定批次（styles 任务，「再试一批」时递增）
   *   tried      已试过的画风关键词（styles 任务，避免重复）
   *   picked     选定的候选 { keywords, promptEn, alt }（card 任务）
   *   currentCard 当前设定卡对象（cardchat 任务）
   */
  function assemblePainter(story, opts) {
    opts = opts || {};
    const mode = opts.mode || 'scene';

    if (mode === 'styles') {
      const out = [{ role: 'system', content: PAINTER_STYLES_SYSTEM }];
      out.push({ role: 'system', content: '[锚定任务]\nstyles' });
      out.push({ role: 'system', content: '[锚定批次]\n' + (opts.batch || 1) });
      out.push({ role: 'system', content: '[故事设定]\n' + storySettingText(story) });
      if (opts.tried && opts.tried.length) {
        out.push({ role: 'system', content: '[已试过的方向]\n' + opts.tried.join('；') });
      }
      out.push({ role: 'user', content: '请给出 4 组画风关键词与试画提示词。' });
      return out;
    }

    if (mode === 'card' || mode === 'cardchat') {
      const out = [{ role: 'system', content: PAINTER_CARD_SYSTEM }];
      out.push({ role: 'system', content: '[锚定任务]\n' + mode });
      out.push({ role: 'system', content: '[故事设定]\n' + storySettingText(story) });
      const chars = (((story && story.world) || {}).characters || []).filter(c => c && c.name);
      out.push({
        role: 'system',
        content: '[人物]\n' + (chars.length
          ? chars.map(c => '· ' + c.name + (c.personality ? '（' + c.personality + '）' : '')).join('\n')
          : '（未提供，按故事设定自拟 2~3 个主要人物）'),
      });
      if (mode === 'card') {
        const s = opts.picked || {};
        const kw = (s.keywords || []).filter(Boolean).join(', ');
        out.push({
          role: 'system',
          content: '[选定画风]\n' + (kw || '（无）')
            + (s.alt ? '\n感觉：' + s.alt : '')
            + (s.promptEn ? '\n试画提示词：' + s.promptEn : ''),
        });
        out.push({ role: 'user', content: '请按选定画风写视觉设定卡。' });
      } else {
        out.push({ role: 'system', content: '[当前设定卡]\n' + JSON.stringify(opts.currentCard || {}, null, 1) });
        out.push({ role: 'user', content: String(opts.userText || '') });
      }
      return out;
    }

    // 视频动态提示词（§6）：隔离规则不变——系统提示 + 画风锚 + 最近两张图 + 最近 3 回合剧情
    if (mode === 'video') {
      const out = [{ role: 'system', content: PAINTER_VIDEO_SYSTEM }];
      out.push({ role: 'system', content: '[画风锚]\n' + painterAnchorText(story) + ANCHOR_SCOPE_HINT });
      const vimgs = recentImageLines(story, 2);
      if (vimgs.length) out.push({ role: 'system', content: '[最近两张图]\n' + vimgs.join('\n') });
      const vturns = recentTurnLines(story, PAINTER_RECENT_TURNS);
      if (vturns.length) out.push({ role: 'system', content: '[最近剧情]\n' + vturns.join('\n') });
      const vkind = opts.videoKind === 'i2v' ? 'i2v' : 't2v';
      const vbits = ['[视频类型] ' + (vkind === 'i2v' ? '图生（以「源画面」为首帧，只写动起来的部分）' : '文生（完整画面 + 动作）')];
      if (vkind === 'i2v') {
        // 图生：输入多带源图的 alt 与 promptRaw（§6）
        if (opts.imageAlt) vbits.push('[源画面说明] ' + opts.imageAlt);
        if (opts.imagePrompt) vbits.push('[源画面提示词] ' + opts.imagePrompt);
      } else if (opts.sceneRef) {
        vbits.push('[画面参考] ' + opts.sceneRef);
      }
      if (opts.styleHint) vbits.push('[画风要求] ' + opts.styleHint);
      out.push({ role: 'user', content: vbits.join('\n') });
      return out;
    }

    const chatMode = mode === 'chat';
    const out = [{ role: 'system', content: chatMode ? PAINTER_CHAT_SYSTEM : PAINTER_SYSTEM }];
    out.push({ role: 'system', content: '[画风锚]\n' + painterAnchorText(story) + ANCHOR_SCOPE_HINT });
    const imgs = recentImageLines(story, 2);
    if (imgs.length) out.push({ role: 'system', content: '[最近两张图]\n' + imgs.join('\n') });
    // 差分基底（仅 scene 模式）：把上一次出图的完整 prompt 单独再给一遍，
    // 让画师「在它上面改」而不是另起一段 —— 纯文生图没有图片参考，风格稳定全靠这个锚。
    // 工作台对话模式已有「[当前这张图]」，不重复。
    if (!chatMode) {
      const basePrompt = lastImagePrompt(story);
      if (basePrompt) {
        out.push({
          role: 'system',
          content: '[基底 prompt]（上一次出图的完整提示词：风格部分原样保留，只改剧情变化的部分）\n' + basePrompt,
        });
      }
    }
    // [最近剧情]：scene 模式按 §4 只带最近 PAINTER_RECENT_TURNS 回合的「玩家行动 + 旁白」（P-1）；
    // chat（工作台）模式保持最近 3 条旁白不动（§4 不动范围，另有 recall_recent_plot）
    const narr = chatMode ? recentNarrationLines(story, 3) : recentTurnLines(story, PAINTER_RECENT_TURNS);
    if (narr.length) out.push({ role: 'system', content: '[最近剧情]\n' + narr.join('\n') });
    if (chatMode) {
      if (opts.currentPrompt || opts.currentAlt) {
        out.push({ role: 'system', content: '[当前这张图]\n提示词：' + (opts.currentPrompt || '') + '\nalt：' + (opts.currentAlt || '') });
      }
      if (opts.plot) out.push({ role: 'system', content: '[最近记录]\n' + recentPlotText(story, 10) });
      if (opts.tools) out.push({ role: 'system', content: '[可用工具] recall_recent_plot：需要时调用，取回最近 10 条完整记录' });
    }
    const user = chatMode
      ? String(opts.userText || '')
      : ('[画面参考] ' + (opts.sceneRef || '') + (opts.styleHint ? '\n[画风要求] ' + opts.styleHint : ''));
    out.push({ role: 'user', content: user });
    return out;
  }

  /* ---------------- 剧情文本整理（R12 路径② / §4.11，T-P6-1） ----------------
   * 粘贴任意剧情文本（设定文 / 小说片段 / 别人游戏的聊天记录）→ 整理向导 →
   * premise + world 草稿 + 画风关键词 → 用户确认修改（不可跳过）→ 建新档 → 试画锚定。
   * 默认一次调用；**仅当所选模型装不下该文本**时才 map-reduce（分段摘要 → 合并 → 一次性整理）。
   * 三个提示词共用「[导入任务] map|merge|final」标记，模型据此回包（与画师子代理同思路）。
   */

  const IMPORT_FINAL_SYSTEM = [
    '你是视觉小说的「整理员」。用户会给你一段任意来源的剧情文本，请把它整理成一部可以直接开演的视觉小说的开局材料。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"title":"故事标题（不超过 20 字）","premise":"给剧情模型看的故事设定，4~6 行，行首用「标题：/世界：/你的角色：/主要人物：/风格：/想看的发展：」这样的标签","world":{"place":"当前地点","time":"当前时间","characters":[{"name":"","presence":"在场或离场","personality":"","speech":"","note":""}],"threads":["尚未回收的伏笔，一行一条"],"scene":"画面参考一句话"},"styleKeywords":["画风关键词，3~6 个，英文或中文"]}',
    '',
    '规则：',
    '- 只整理文本里真实存在的信息，绝不编造；文本没写的字段留空字符串或空数组；',
    '- 人物取文本里真正出现过的角色（最多 6 个），world.characters 里的名字要在 premise 里出现；',
    '- premise 是给剧情模型看的故事地基，用客观叙述，不要写成摘要报告、不要出现「本文」「文本」字样；',
    '- styleKeywords 是画面与文字的基调，之后用于试画 4 张画风候选；',
    '- 只输出 JSON，不要解释。',
  ].join('\n');

  const IMPORT_MAP_SYSTEM = [
    '你在为「剧情文本整理」做分段摘要：用户给你一段长文本中的某一段。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"summary":"这一段的事实要点：出场人物（姓名 / 性格 / 说话方式线索）、地点与时间、发生了什么、埋下的伏笔、画面氛围线索。150 字以内。"}',
    '',
    '规则：只写文本里有的信息，不要推测、不要编造，不要在回复里提「段」「摘要」「文本」。',
  ].join('\n');

  const IMPORT_MERGE_SYSTEM = [
    '你在为「剧情文本整理」合并分段摘要：用户按顺序给你若干段摘要。',
    '',
    '只输出一个 JSON 对象（禁止多余文字）：',
    '{"summary":"合并后的要点：人物（姓名 / 性格 / 说话方式）、地点与时间、主要事件链、未回收伏笔、画风线索。400 字以内。"}',
    '',
    '规则：去掉重复、保留最具体的信息、按时间顺序；不要编造摘要里没有的内容。',
  ].join('\n');

  const IMPORT_TASKS = ['map', 'merge', 'final'];

  // 整理任务组装：[system 提示词] + [system 任务标记（模型与留痕靠它识别）] + [user 文本]
  function assembleImporter(task, text, meta) {
    meta = meta || {};
    const t = IMPORT_TASKS.indexOf(task) >= 0 ? task : 'final';
    const sys = t === 'map' ? IMPORT_MAP_SYSTEM : (t === 'merge' ? IMPORT_MERGE_SYSTEM : IMPORT_FINAL_SYSTEM);
    const tag = ['[导入任务] ' + t];
    if (meta.index) tag.push('[分段] 第 ' + meta.index + ' / ' + (meta.total || '?') + ' 段');
    return [
      { role: 'system', content: sys },
      { role: 'system', content: tag.join('\n') },
      { role: 'user', content: String(text == null ? '' : text) },
    ];
  }

  const IMPORT_CALL_RESERVE = 800;    // 每次调用留给 system + 输出的余量（字 ≈ token）
  const IMPORT_FIT_RATIO = 0.7;       // 与 C-C 同口径：文本 + 余量 > 窗口 70% 才算「装不下」
  const IMPORT_MIN_BUDGET = 600;      // 单段下限，窗口很小时也别切得太碎

  // 按段落切块，超长段落再按句子边界切；单块 ≤ budget
  function splitImportChunks(text, budget) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    if (!src) return [];
    if (!(budget > 0) || src.length <= budget) return [src];
    const blocks = src.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    const chunks = [];
    let cur = '';
    for (const b of blocks) {
      if (b.length > budget) {
        if (cur) { chunks.push(cur); cur = ''; }
        let rest = b;
        while (rest.length > budget) {
          let cut = budget;
          const from = Math.floor(budget * 0.6);
          const tail = rest.slice(from, budget);
          const m = tail.match(/[。！？!?；;…\n][^。！？!?；;…\n]*$/);
          if (m && m.index != null) cut = from + m.index + 1;
          chunks.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (rest) chunks.push(rest);
        continue;
      }
      if (cur && (cur.length + b.length + 2) > budget) { chunks.push(cur); cur = ''; }
      cur = cur ? (cur + '\n\n' + b) : b;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  /**
   * 整理计划（§4.11 长文处理）：默认一次调用；只有「已知窗口且装不下」才 map-reduce。
   * @param {string} text
   * @param {number} contextWindow 整理模型的有效窗口（0 / 未知 → 一次调用）
   * @returns {{needsMap:boolean, chunks:string[], budget:number, window:number}}
   */
  function planImport(text, contextWindow) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    const win = (+contextWindow > 0) ? Math.floor(+contextWindow) : 0;
    if (!win) return { needsMap: false, chunks: src ? [src] : [], budget: 0, window: 0 };
    const budget = Math.max(IMPORT_MIN_BUDGET, Math.floor(win * IMPORT_FIT_RATIO) - IMPORT_CALL_RESERVE);
    if (src.length + IMPORT_CALL_RESERVE <= win * IMPORT_FIT_RATIO) {
      return { needsMap: false, chunks: src ? [src] : [], budget: budget, window: win };
    }
    const chunks = splitImportChunks(src, budget);
    return { needsMap: chunks.length > 1, chunks: chunks, budget: budget, window: win };
  }

  // 摘要合并批次：每组拼接长度 ≤ budget；返回多组时需要多轮合并（返回 [] 表示无可合并内容）
  function planImportMerge(summaries, budget) {
    const list = (summaries || []).map(s => String(s == null ? '' : s).trim()).filter(Boolean);
    if (!list.length) return [];
    const b = Math.max(IMPORT_MIN_BUDGET, +budget > 0 ? Math.floor(+budget) : IMPORT_MIN_BUDGET);
    if (list.join('\n\n').length <= b) return [list];
    const batches = [];
    let cur = [], len = 0;
    for (const s of list) {
      if (cur.length && (len + s.length + 2) > b) { batches.push(cur); cur = []; len = 0; }
      cur.push(s);
      len += s.length + 2;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /* ---------------- token 估算 ---------------- */

  // token 估算：中文 1 字 ≈ 1 token；ASCII（英文/数字/符号）≈ 4 字符 / token。
  // P1-8（2026-10-14）：此前按字符全长计，英文输入会把 70% 压缩阈值高估约 4 倍、压缩晚触发。
  function estimateTokens(text) {
    const s = String(text == null ? '' : text);
    const ascii = (s.match(/[\x00-\x7F]/g) || []).length;
    return Math.ceil((s.length - ascii) + ascii * 0.25);
  }

  /* ---------------- 世界卡工具函数 ---------------- */

  // 「最重要的 2 条」伏笔：优先未回收、越早越重要
  function topThreads(threads, n) {
    const list = (threads || []).filter(Boolean).map(String);
    const open = list.filter(t => !/回收|已了结|解决/.test(t));
    const pick = open.slice(0, n);
    for (const t of list) { if (pick.length >= n) break; if (pick.indexOf(t) < 0) pick.push(t); }
    return pick.slice(0, n);
  }

  // 常驻摘要行（固定格式，§4.10 C-C）
  function buildSummaryLine(world) {
    world = world || {};
    const place = world.place || '（地点未知）';
    const time = world.time || '（时间未知）';
    const names = (world.characters || []).filter(c => c && c.name && c.presence !== '离场').map(c => c.name);
    const threads = topThreads(world.threads, 2);
    return place + '｜' + time + '｜在场：' + (names.length ? names.join('、') : '（无）') + '｜伏笔：' + (threads.length ? threads.join('；') : '（无）');
  }

  // 完整世界卡文本（recall 工具 / 强制注入 / 面板用）
  function worldCardText(world) {
    world = world || {};
    const lines = ['地点：' + (world.place || ''), '时间：' + (world.time || '')];
    const cs = (world.characters || []).map(c =>
      '· ' + (c.name || '') + '（' + (c.presence || '') + '）性格：' + (c.personality || '') + '；说话：' + (c.speech || '') + (c.note ? '；备注：' + c.note : ''));
    if (cs.length) lines.push('人物：\n' + cs.join('\n'));
    if ((world.threads || []).length) lines.push('伏笔：\n' + world.threads.map(t => '· ' + t).join('\n'));
    const r = world.relationship || {};
    if (r.stage || r.notes || (r.bonds || []).length) {
      lines.push('关系：' + [r.stage, (r.bonds || []).join('、'), r.notes].filter(Boolean).join('；'));
    }
    if (world.scene) lines.push('画面：' + world.scene);
    return lines.join('\n');
  }

  // 浅合并 world 自报增量；数组整段替换；保护用户手改的 note（noteLocked）
  // opts.allowEmpty=true 时允许空数组清空（书记员整卡重写用）；AI1 自报的空数组视为「未提供」，不覆盖既有值
  function mergeWorld(world, delta, opts?) {
    const out = world || {};
    if (!delta || typeof delta !== 'object') return out;
    const allowEmpty = !!(opts && opts.allowEmpty);
    for (const k of ['place', 'time', 'scene']) if (delta[k]) out[k] = String(delta[k]);
    if (Array.isArray(delta.threads) && (allowEmpty || delta.threads.length)) {
      out.threads = delta.threads.filter(Boolean).map(String);
    }
    if (Array.isArray(delta.characters) && (allowEmpty || delta.characters.length)) {
      const prevByName = {};
      (out.characters || []).forEach(c => { if (c && c.name) prevByName[c.name] = c; });
      out.characters = delta.characters.filter(Boolean).map(c => {
        const prev = prevByName[c && c.name] || {};
        const merged = Object.assign({ presence: '', personality: '', speech: '', note: '', noteLocked: false }, prev, c);
        if (prev.noteLocked) merged.note = prev.note; // 书记员/自报不覆盖用户手改的 note
        return merged;
      });
    }
    if (delta.relationship && typeof delta.relationship === 'object') {
      out.relationship = Object.assign({ stage: '', bonds: [], notes: '' }, out.relationship || {}, delta.relationship);
    }
    out.updatedAt = Date.now();
    return out;
  }

  // 本地「书记员」兜底：规范化世界卡（去重/裁剪），返回重写后的卡与显式 diff
  function localScribe(world) {
    const before = JSON.stringify({ p: (world || {}).place, t: (world || {}).time, th: (world || {}).threads, c: ((world || {}).characters || []).map(x => x.name) });
    const out = Object.assign({ place: '', time: '', characters: [], threads: [], relationship: { stage: '', bonds: [], notes: '' }, scene: '' }, world || {});
    const seen = {};
    out.threads = (out.threads || []).filter(Boolean).map(String).filter(t => (seen[t] ? false : (seen[t] = 1)));
    if (out.threads.length > 12) out.threads = out.threads.slice(-12);
    out.characters = (out.characters || []).filter(c => c && c.name);
    out.updatedAt = Date.now();
    const diff = [];
    if (before !== JSON.stringify({ p: out.place, t: out.time, th: out.threads, c: out.characters.map(x => x.name) })) diff.push('规范世界卡（去重/裁剪）');
    else diff.push('世界卡无变化');
    return { world: out, diff };
  }

  /* ---------------- 场景摘要与压缩（C-A / C-B） ---------------- */

  function sceneSlot(index, world, texts) {
    world = world || {};
    const place = world.place || '';
    const time = world.time || '';
    const names = (world.characters || []).map(c => c && c.name).filter(Boolean).join('、');
    const happen = world.scene || ((texts && texts[0]) ? String(texts[0]).slice(0, 40) : '');
    const threads = topThreads(world.threads, 2).join('；');
    return '【第' + index + '幕】' + place + '｜' + time + '｜在场：' + (names || '无') + '｜发生：' + (happen || '—') + '｜伏笔：' + (threads || '无');
  }

  // 默认（失败兜底）摘要器：用世界卡 + 旁白拼出固定槽位，确定性、不花 API
  function localSummarize(ctx) {
    return { slot: sceneSlot(ctx.index, ctx.world, ctx.texts) };
  }

  // 越老越模糊：合并两幕为一条
  function mergeSummaries(a, b) {
    const clean = s => String(s || '').replace(/^【[^】]*】/, '').trim();
    return ('【旧幕·合并】' + clean(a) + ' ／ ' + clean(b)).slice(0, 240);
  }

  // 按 scene_change 把 turn 分组（scene_change=true 的那一轮开启新的一幕）
  function groupScenes(msgs) {
    const groups = [];
    let cur = [];
    for (let i = 0; i + 1 < msgs.length; i += 2) {
      let sc = false;
      try { sc = !!JSON.parse(msgs[i + 1].content).scene_change; } catch (_) {}
      if (sc && cur.length) { groups.push(cur); cur = []; }
      cur.push(msgs[i], msgs[i + 1]);
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  // chat / rp 纯文本没有 scene_change：按固定条数切幕（4 条 = 2 个回合），
  // 避免整个积压被压成一条摘要，保留「越老越模糊」的层次
  const PLAIN_SCENE_MESSAGES = 4;
  function groupByTurns(msgs, size?) {
    const n = Math.max(2, size || PLAIN_SCENE_MESSAGES);
    const groups = [];
    for (let i = 0; i < msgs.length; i += n) groups.push(msgs.slice(i, i + n));
    return groups;
  }

  // 可压缩的完整场景边界：只压到最后一幕起点之前，避免把当前幕切一半
  function lastSceneStart(msgs) {
    let idx = 0;
    for (let i = 0; i + 1 < msgs.length; i += 2) {
      let sc = false;
      try { sc = !!JSON.parse(msgs[i + 1].content).scene_change; } catch (_) {}
      if (sc) idx = i;
    }
    return idx;
  }

  // 动态组装窗口（P1-3，2026-10-14）：已知 contextWindow 时按 token 从最近往前装，
  // 装到窗口一半为止，条数 ∈ [4, 40]；未知容量退回 fallback（评测与旧档口径不变）。
  // 组装（assembleAI1）与压缩保留（planCompression）共用同一函数，保证「压多少 / 留多少」同口径。
  function fitWindow(msgs, contextWindow, fallback?) {
    const cw = +contextWindow;
    if (!Number.isFinite(cw) || cw <= 0) return fallback || DEFAULT_KEEP_MESSAGES;
    const budget = Math.floor(cw * WINDOW_TOKEN_RATIO);
    let acc = 0, n = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = estimateTokens(String((msgs[i] && msgs[i].content) || ''));
      if (n > 0 && acc + t > budget) break;
      acc += t;
      n += 1;
      if (n >= WINDOW_MAX_MESSAGES) break;
    }
    return Math.max(WINDOW_MIN_MESSAGES, n);
  }

  /**
   * 压缩 story：把超出保留窗口的旧回合压进摘要栈。
   * 触发条件（§4.10 C-C）：
   *   ① 积压条数 > maxMessages（兜底，容量未知时也保证有界）；
   *   ② 组装后的 token 估算 > contextWindow × 0.7（T-M-1：容量来自能力登记表或用户手填）。
   * @param {object} story
   * @param {object} [opts] { keepMessages, maxMessages, maxSummaries, summarize, contextWindow }
   * @returns {null|{compressedTurns, messagesRemoved, summaries}}
   */
  // 压缩阈值（纯函数，UI-3 §6-8）：contextWindow × 70%；0 = 容量未知（回退按条数压缩）。
  // 有效 contextWindow 来自 resolveChatCfg 的 cfg（模型库 profile 可各不相同）。
  function compressThreshold(contextWindow) {
    const cw = +contextWindow;
    if (!Number.isFinite(cw) || cw <= 0) return 0;
    return Math.floor(cw * COMPRESS_RATIO);
  }

  // 压缩判定与切分（纯函数，同步）：返回 { candidate, groups } 或 null。
  // 运行时（app.js）用它决定「交给书记员模型压」还是「本地兜底压」，评测也走它，避免两份判定。
  // opts.estimatedTokens：调用方手上已有「组装结果的 token 估算」时直接传入（审查 三·3：
  // 此前这里会再组装一次全量上下文只为估算，每回合 2~3 次组装）；不传则自己组装估算。
  function planCompression(story, opts) {
    opts = opts || {};
    if (!story || !Array.isArray(story.messages)) return null;
    const keep0 = opts.keepMessages || fitWindow(story.messages, opts.contextWindow);
    const max = opts.maxMessages || Math.max(DEFAULT_MAX_MESSAGES, keep0 * 2);
    let overBudget = false;
    const cw = +opts.contextWindow;
    if (Number.isFinite(cw) && cw > 0) {
      const threshold = compressThreshold(cw);
      const est = (opts.estimatedTokens !== undefined && Number.isFinite(+opts.estimatedTokens))
        ? +opts.estimatedTokens
        : estimateContextTokens(story, '');
      overBudget = est > threshold;
    }
    if (story.messages.length <= max && !overBudget) return null;

    // P1-4（2026-10-14）：超预算但常规保留条数下无可压（小窗口 + 长旁白）时，
    // 降级保留窗口（×0.75 → ×0.5 → ×0.25，下限 2 条）再压，别每轮超发；
    // 纯条数触发（未超预算）时维持原 keep（slice 不会误伤最近消息）。
    let keep = keep0;
    let cut = story.messages.length - keep;
    if (cut <= 0 && overBudget) {
      for (const frac of [0.75, 0.5, 0.25]) {
        const k = Math.max(2, Math.floor(keep0 * frac));
        if (story.messages.length - k > 0) { keep = k; cut = story.messages.length - k; break; }
      }
    }
    if (cut <= 0) return null;
    let candidate = story.messages.slice(0, cut);
    const boundary = lastSceneStart(candidate);
    if (boundary > 0) candidate = candidate.slice(0, boundary);
    if (!candidate.length) return null;
    // chat / rp 纯文本恒无 scene_change，按回合数切幕（groupByTurns）代替按场景切
    const plain = (story.mode === 'chat' || story.mode === 'rp');
    return { candidate: candidate, groups: plain ? groupByTurns(candidate) : groupScenes(candidate) };
  }

  // 摘要栈超限：递归合并最旧两幕（越老越模糊）
  function trimSummaries(list, maxSummaries) {
    const arr = list || [];
    const max = maxSummaries || DEFAULT_MAX_SUMMARIES;
    while (arr.length > max) arr.splice(0, 2, mergeSummaries(arr[0], arr[1]));
    return arr;
  }

  function compressStory(story, opts) {
    opts = opts || {};
    const plan = planCompression(story, opts);
    if (!plan) return null;
    const summarize = typeof opts.summarize === 'function' ? opts.summarize : localSummarize;

    story.summaries = story.summaries || [];
    let n = story.summaries.length;
    let scenes = 0;
    for (const grp of plan.groups) {
      n += 1;
      const texts = grp.filter(m => m.role === 'assistant').map(m => {
        try { return JSON.parse(m.content).narration || ''; } catch (_) { return ''; }
      }).filter(Boolean);
      const res = summarize({ turns: grp, texts, world: story.world, index: n });
      const slot = typeof res === 'string' ? res : (res && res.slot) || '';
      story.summaries.push(slot);
      if (res && res.worldDelta) mergeWorld(story.world, res.worldDelta);
      scenes += 1;
    }
    story.messages = story.messages.slice(plan.candidate.length);
    trimSummaries(story.summaries, opts.maxSummaries);
    return { compressedTurns: scenes, messagesRemoved: plan.candidate.length, summaries: story.summaries.length };
  }

  /* ---------------- C-E 启发式注入（§4.10 C-E / T-P5-3） ----------------
   * 玩家输入里出现世界卡 / 伏笔中的实体词 → 本轮自动带上「对应条目」（不是整张卡）。
   * 与工具召回并行：模型乐意调工具就调（拿全文），不乐意也不会失忆（覆盖「静默忽略工具」）。
   * 纯客户端字符串匹配（最长公共子串，不做分词），零额外调用、确定性；同一份匹配也供 P7 画像 Top-N 复用。
   */

  const ENTITY_MIN_MATCH = 3;         // 地点/时间/伏笔/画面：连续命中至少 3 个字才算实体词
  const NAME_MIN_MATCH = 2;           // 人名是专名，两个字也认
  const HEURISTIC_MAX_ENTRIES = 4;    // 单轮最多带回的条目数（C-C 预算：世界卡 ~200 token）
  const HEURISTIC_MAX_CHARS = 600;    // 注入块总长上限，防世界卡很大时 token 爆炸

  function normTerm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // 最长公共子串：命中长度 < min 返回 ''；返回的片段取自「值」一侧（便于留痕显示）
  function longestCommonSubstring(value, input, min) {
    const raw = String(value == null ? '' : value);
    const a = raw.toLowerCase();
    const b = String(input == null ? '' : input).toLowerCase();
    if (!a || !b) return '';
    let best = 0, end = 0;
    let prev = new Uint16Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      const cur = new Uint16Array(b.length + 1);
      for (let j = 1; j <= b.length; j++) {
        if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
          const v = prev[j - 1] + 1;
          cur[j] = v;
          if (v > best) { best = v; end = i; }
        }
      }
      prev = cur;
    }
    if (best < (min || 1)) return '';
    return (raw.length === a.length ? raw : a).slice(end - best, end);
  }

  // 值可当实体词用吗（空 / 占位符 / 太短不算）
  function usableEntity(s) {
    const t = normTerm(s);
    if (t.length < ENTITY_MIN_MATCH) return '';
    if (/^[（(【\[][^）)】\]]*[）)】\]]$/.test(t)) return '';   // 「（未知）」这类占位
    return t;
  }

  // 全是常用虚词 / 泛用字的连续片段不算实体词（输入里的「是什么」「不知道」不该触发注入）
  const COMMON_CHARS = '的是了吗呢吧啊呀嘛么什怎不没无我你您他她它们这那哪谁一个有些在就还也都又再很太更最只才刚正已曾将把被让给对向从到往于与和或而但却则因为以之其此该每各另别好多少大小能会要想说看去来上下里外中前后时候样点儿得着过起出进回开等待知道';
  function looksGeneric(hit) {
    for (const ch of String(hit || '')) if (COMMON_CHARS.indexOf(ch) < 0) return false;
    return true;
  }

  /**
   * C-E 匹配：玩家输入 ↔ 世界卡实体词（纯函数）。
   * @returns {{entries:Array<{kind:string,label:string,text:string,term:string}>, terms:string[]}}
   *   entries = 要注入的条目（人物 → 地点 / 时间 → 伏笔 → 画面，封顶 HEURISTIC_MAX_ENTRIES）
   *   terms   = 命中的实体词（留痕用，去重，最多 4 个）
   */
  function matchEntityTerms(text, world) {
    const input = normTerm(text);
    const low = input.toLowerCase();
    const entries = [], terms = [];
    function push(kind, label, body, term) {
      if (entries.length >= HEURISTIC_MAX_ENTRIES) return;
      const t = normTerm(body);
      if (!t) return;
      const line = label + '｜' + t;
      if (entries.some(e => e.text === line)) return;
      entries.push({ kind: kind, label: label, text: line, term: term || '' });
      if (term && terms.indexOf(term) < 0 && terms.length < 4) terms.push(term);
    }
    if (!input || !world || typeof world !== 'object') return { entries: entries, terms: terms };

    // 1) 人物：名字是专名（两个字也认）→ 带回整条人物条目
    for (const c of (world.characters || [])) {
      if (!c || !c.name) continue;
      const name = normTerm(c.name);
      if (name.length < NAME_MIN_MATCH || low.indexOf(name.toLowerCase()) < 0) continue;
      const body = [
        c.presence || '',
        c.personality ? '性格：' + c.personality : '',
        c.speech ? '说话：' + c.speech : '',
        c.note ? '备注：' + c.note : '',
      ].filter(Boolean).join('；');
      push('character', '人物·' + name, body, name);
    }

    // 2) 地点 / 时间 / 伏笔 / 画面：连续命中 ≥3 个字、且不全是虚词，才算实体词
    const matchField = (value, kind, label) => {
      const v = usableEntity(value);
      if (!v) return;
      const hit = longestCommonSubstring(v, input, ENTITY_MIN_MATCH);
      if (hit && !looksGeneric(hit)) push(kind, label, v, hit);
    };
    matchField(world.place, 'place', '地点');
    matchField(world.time, 'time', '时间');
    for (const th of (world.threads || [])) matchField(th, 'thread', '伏笔');
    matchField(world.scene, 'scene', '画面');
    return { entries: entries, terms: terms };
  }

  // 注入块：只带对应条目 + 一句「保持一致」的指令（不提「自动/召回/系统」）
  function heuristicBlock(story, playerAction) {
    const m = matchEntityTerms(playerAction, story && story.world);
    if (!m.entries.length) return '';
    let body = m.entries.map(e => '· ' + e.text).join('\n');
    if (body.length > HEURISTIC_MAX_CHARS) body = body.slice(0, HEURISTIC_MAX_CHARS) + '…';
    return '[自动带回 · 玩家本轮提到的设定]\n' + body
      + '\n（这些是玩家输入里提到的设定，回答时保持一致；不要在回复里提「自动」「召回」「系统」这类字眼。）';
  }

  /* ---------------- R13：角色卡 / 关系记忆 / 用户画像（§4.12） ----------------
   * rp 模式玩的是「关系」：角色卡常驻（学口吻）+ 关系记忆常驻 + 用户画像按需（Top-N）。
   * 画像防 token 爆炸的三条（§4.12）：存储无上限、注入有预算、常驻只有一行摘要。
   */

  const CHAR_CARD_MAX_CHARS = 1200;      // 角色卡块上限（C-C 预算：BUDGET.characterCard）
  const CARD_OPENING_MAX_CHARS = 300;
  const CARD_EXAMPLE_MAX_CHARS = 600;
  const RELATIONSHIP_MAX_CHARS = 240;
  const PROFILE_TOP_N = 3;               // 每轮最多注入的相关条目数
  const PROFILE_ENTRY_MAX_CHARS = 40;
  const PROFILE_MAX_CHARS = 200;         // 画像块总长上限（≈ BUDGET.profile）
  const PROFILE_SUMMARY_CHARS = 90;      // 常驻一行摘要（~30 token）
  const PROFILE_KIND_LABEL = { fact: '事实', preference: '偏好', taboo: '忌讳' };

  function clip(s, max) {
    const t = String(s == null ? '' : s);
    return t.length > max ? (t.slice(0, max) + '…') : t;
  }

  // 角色卡全文（rp 常驻；开场白交代第一幕、示例对话只喂口吻，都截断控体积）
  function characterCardText(card) {
    if (!card) return '';
    const lines = ['[角色卡]'];
    if (card.name) lines.push('名字：' + card.name);
    if (card.appearance) lines.push('外貌：' + card.appearance);
    if (card.personality) lines.push('性格：' + card.personality);
    if (card.scene) lines.push('场景：' + card.scene);
    if (card.systemNote) lines.push('设定要求：' + card.systemNote);
    if (card.opening) lines.push('开场白（故事是这样开场的，保持一致）：\n' + clip(card.opening, CARD_OPENING_MAX_CHARS));
    if (card.exampleDialogue) lines.push('示例对话（学这个人的口吻，不要照抄内容）：\n' + clip(card.exampleDialogue, CARD_EXAMPLE_MAX_CHARS));
    const text = lines.join('\n');
    return text.length > CHAR_CARD_MAX_CHARS ? (text.slice(0, CHAR_CARD_MAX_CHARS) + '\n…') : text;
  }

  // 关系记忆（§4.12：世界卡 relationship 区块；chat / rp 常驻，choice 靠召回）
  function relationshipBlock(world) {
    const r = (world && world.relationship) || {};
    const parts = [];
    if (r.stage) parts.push('阶段：' + r.stage);
    const bonds = (r.bonds || []).filter(Boolean);
    if (bonds.length) parts.push('纽带：' + bonds.join('、'));
    if (r.notes) parts.push('备注：' + r.notes);
    if (!parts.length) return '';
    return '[你们的关系]\n' + clip(parts.join('；'), RELATIONSHIP_MAX_CHARS);
  }

  // 画像条目规范化（字符串也接；kind 只认 fact/preference/taboo）
  function normalizeProfile(list) {
    const out = [];
    for (const it of (list || [])) {
      if (!it) continue;
      const text = normTerm(typeof it === 'string' ? it : it.text);
      if (!text) continue;
      const kind = (typeof it === 'object' && PROFILE_KIND_LABEL[it.kind]) ? it.kind : 'fact';
      out.push({ text: clip(text, 80), kind: kind, updatedAt: +((it && it.updatedAt) || 0) || Date.now() });
    }
    return out;
  }

  // 条目合并去重（书记员「同类只留最新」，§4.12）：同文视为同一条，更新 kind 与时间
  function mergeProfile(existing, incoming) {
    const out = normalizeProfile(existing);
    const byText = {};
    out.forEach(e => { byText[e.text] = e; });
    for (const e of normalizeProfile(incoming)) {
      const prev = byText[e.text];
      if (prev) { prev.kind = e.kind; prev.updatedAt = Date.now(); }
      else { out.push(e); byText[e.text] = e; }
    }
    return out;
  }

  // 每轮只注入与当前话题相关的 Top-N（§4.12；匹配思路复用 C-E：最长公共子串，命中 ≥2 字且不全是虚词）
  function pickProfileEntries(text, entries, max) {
    const input = normTerm(text);
    const list = normalizeProfile(entries);
    const n = Math.max(0, max == null ? PROFILE_TOP_N : max);
    if (!input || !list.length || !n) return [];
    const scored = [];
    list.forEach((e, i) => {
      const hit = longestCommonSubstring(e.text, input, 2);
      if (!hit || looksGeneric(hit)) return;
      scored.push({ e: e, score: hit.length, i: i });
    });
    scored.sort((a, b) => (b.score - a.score) || (b.i - a.i));
    return scored.slice(0, n).map(x => x.e);
  }

  // 常驻一行画像摘要（~30 token）：只报条数与最近 3 条，不整表注入
  function profileSummaryLine(entries) {
    const list = normalizeProfile(entries);
    if (!list.length) return '';
    const bits = [];
    for (let i = list.length - 1; i >= 0 && bits.length < 3; i--) bits.push(clip(list[i].text, 16));
    return clip('[关于玩家] 画像 ' + list.length + ' 条：' + bits.join('；'), PROFILE_SUMMARY_CHARS);
  }

  // 画像注入块 = 一行摘要（常驻）+ 与当前话题相关的 Top-N 条
  function profileBlock(entries, playerAction, max?) {
    const list = normalizeProfile(entries);
    if (!list.length) return '';
    const parts = [profileSummaryLine(list)];
    const picked = pickProfileEntries(playerAction, list, max);
    if (picked.length) {
      parts.push('这轮可能相关：\n' + picked.map(e => '· ' + PROFILE_KIND_LABEL[e.kind] + '｜' + clip(e.text, PROFILE_ENTRY_MAX_CHARS)).join('\n'));
    }
    return clip(parts.join('\n'), PROFILE_MAX_CHARS);
  }

  // 画像开关（§2 settings.userProfile.enabled）：'all' 或按模式单独开
  function profileEnabledFor(enabledCfg, mode) {
    if (enabledCfg === 'all') return true;
    if (enabledCfg && typeof enabledCfg === 'object') return !!enabledCfg[mode];
    return false;
  }

  // 离线 / 失败兜底的本地画像提取：确定性规则，只认玩家明确的「我…」句式（真实模式走书记员）
  const PROFILE_TABOO_RE = /(害怕|怕|讨厌|不喜欢|受不了|不敢|忌讳|过敏|别叫我|不要叫)/;
  const PROFILE_PREFER_RE = /(喜欢|最爱|偏爱|爱吃|爱看|爱听|习惯)/;
  const PROFILE_FACT_RE = /(我叫|我的名字|我住在|我来自|我养了|我今年)/;
  function localProfileExtract(text) {
    const out = [];
    const s = normTerm(text);
    if (!s) return out;
    const frags = s.split(/[，。！？；、,.!?;\n]+/).map(x => x.trim()).filter(Boolean);
    for (const f of frags) {
      if (f.length < 3 || f.length > 80) continue;
      if (f.indexOf('我') < 0) continue;                     // 只认玩家第一人称说的事
      if (/^我?(不|没)(知道|是|想|会|能|要)/.test(f)) continue;   // 「我不知道/我不想」这类不算画像
      if (/什么|怎么|为什么|多少|吗$|呢$|吧$/.test(f)) continue;   // 问句 / 商量语气不是画像
      let kind = '';
      if (PROFILE_TABOO_RE.test(f)) kind = 'taboo';
      else if (PROFILE_PREFER_RE.test(f)) kind = 'preference';
      else if (PROFILE_FACT_RE.test(f)) kind = 'fact';
      if (!kind) continue;
      const t = clip(f, PROFILE_ENTRY_MAX_CHARS);
      if (out.some(e => e.text === t)) continue;
      out.push({ text: t, kind: kind, updatedAt: Date.now() });
      if (out.length >= PROFILE_TOP_N) break;
    }
    return out;
  }

  /* ---------------- AI1 回包的宽容 JSON 解析（§3.1：模型必须回 JSON，但真实模型常越界）
   * 实测三种常见坏包：① 字符串里有裸换行（长旁白很常见）；② 写到一半被工具调用 / 超长截断；
   * ③ 前后裹 markdown 围栏或说明文字。解析失败时客户端本来就要兜底（沿用旧卡 / 纯工具回合重发），
   * 这里先把能救的救回来，避免把原始 JSON 当旁白展示给玩家。 */

  // 字符串字面量里的裸换行 / 制表符转义（JSON.parse 会因此报错）
  function escapeRawControls(s) {
    let out = '', inStr = false, esc = false;
    for (const ch of String(s || '')) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr && (ch === '\n' || ch === '\r')) { out += '\\n'; continue; }
      if (inStr && ch === '\t') { out += '\\t'; continue; }
      out += ch;
    }
    return out;
  }

  // 补齐未闭合的字符串 / 括号（截断的 JSON 还能捞出已经写好的字段）
  function completeJson(s) {
    let inStr = false, esc = false;
    const stack = [];
    for (const ch of String(s || '')) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (inStr) { if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    let out = String(s || '');
    if (inStr) out += '"';
    while (stack.length) out += (stack.pop() === '{' ? '}' : ']');
    return out;
  }

  // 宽容解析的唯一入口（审查 三·7）：原样 → 转义裸控制符 → 补括号，依次尝试；全失败返回 null。
  // escapeRawControls / completeJson 只是这里的内部步骤（不导出，避免第二入口）；容错四条路径
  // 的 eval 用例见 eval/run.js「宽容解析」段。
  function tolerantJSONParse(text) {
    const s = String(text == null ? '' : text).trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = s.indexOf('{');
    if (a === -1) return null;
    const b = s.lastIndexOf('}');
    const body = (b > a) ? s.slice(a, b + 1) : s.slice(a);
    const attempts = [body, escapeRawControls(body), completeJson(escapeRawControls(body)), completeJson(body)];
    for (const t of attempts) {
      try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (_) {}
    }
    return null;
  }

  /* ---------------- 剧情模式中文字段契约（v0.3）→ 内部英文结构归一化
   * 模型按中文键回包（旁白 / 人物 / 地点 / 时间 / 伏笔 / 画面 / 场景切换 / 选项），
   * 这里映射回 narration / world / scene_summary / scene_change / choices，
   * 压缩、书记员、世界卡合并等下游链路一律不用改。
   * 旧英文键（narration / world / …）与 chat / rp 模式原样透传，向后兼容旧存档。 */
  function normalizeAIReply(j) {
    if (!j || typeof j !== 'object') return j;
    // 没有中文键 → 原样返回（英文契约 / 旧存档）
    const hasCn = ['旁白', '人物', '地点', '时间', '伏笔', '画面', '场景切换', '选项']
      .some(k => Object.prototype.hasOwnProperty.call(j, k));
    if (!hasCn) return j;

    const str = v => (v == null ? '' : String(v));
    const chars = Array.isArray(j['人物']) ? j['人物'].filter(Boolean).map(c => ({
      name: str(c['名字'] || c.name),
      presence: str(c['在场'] || c.presence),
      personality: str(c['性格'] || c.personality),
      speech: str(c['说话方式'] || c.speech),
    })).filter(c => c.name) : [];
    const world: any = {};
    if (j['地点'] != null && str(j['地点'])) world.place = str(j['地点']);
    if (j['时间'] != null && str(j['时间'])) world.time = str(j['时间']);
    if (Array.isArray(j['伏笔'])) world.threads = j['伏笔'].filter(Boolean).map(str);
    if (str(j['画面'])) world.scene = str(j['画面']);
    if (chars.length) world.characters = chars;

    const out: any = {
      narration: str(j['旁白'] || j.narration),
      choices: Array.isArray(j['选项']) ? j['选项'] : (Array.isArray(j.choices) ? j.choices : []),
      scene_change: !!(Object.prototype.hasOwnProperty.call(j, '场景切换') ? j['场景切换'] : j.scene_change),
      scene_summary: str(j['画面'] || j.scene_summary),
    };
    if (Object.keys(world).length) out.world = world;
    if (Array.isArray(j.tool_calls)) out.tool_calls = j.tool_calls;
    return out;
  }

  /* ---------------- 组装 ---------------- */

  // 剧情模式 v0.3：存档里的 assistant 消息是英文键 JSON（slimReply），组装进请求体时
  // 转回中文键，让模型看到的历史与本轮契约一致；存档本身不动（压缩 / 书记员链路不受影响）
  function toChineseHistory(content) {
    let j = null;
    try { j = JSON.parse(content); } catch (_) { return content; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return content;
    if (Object.prototype.hasOwnProperty.call(j, '旁白')) return content;   // 已是中文键
    const w = (j.world && typeof j.world === 'object') ? j.world : {};
    const out = {
      '旁白': j.narration || '',
      '选项': Array.isArray(j.choices) ? j.choices : [],
      '场景切换': !!j.scene_change,
      '画面': j.scene_summary || w.scene || '',
    };
    if (w.place) out['地点'] = w.place;
    if (w.time) out['时间'] = w.time;
    if (Array.isArray(w.threads)) out['伏笔'] = w.threads;
    if (Array.isArray(w.characters) && w.characters.length) {
      out['人物'] = w.characters.map(c => ({
        '名字': (c && c.name) || '', '在场': (c && c.presence) || '',
        '性格': (c && c.personality) || '', '说话方式': (c && c.speech) || '',
      }));
    }
    return JSON.stringify(out);
  }

  // chat / rp 纯文本契约（2026-10-07）：存档里的 assistant 消息仍是 {"narration":"…"} 包装，
  // 组装进请求体前拍平成正文——否则模型看到历史里全是 JSON，会照着继续输出 JSON
  function toPlainHistory(content) {
    let j = null;
    try { j = JSON.parse(content); } catch (_) { return content; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return content;
    if (typeof j['旁白'] === 'string') return j['旁白'];      // 模式切换后可能混入中文键
    if (typeof j.narration === 'string') return j.narration;
    return content;
  }

  function playerContent(premise, action, opts) {
    opts = opts || {};
    const head = opts.includePremise ? ('[设定]\n' + (premise || '') + '\n\n') : '';
    return head + '[玩家行动] ' + (action || '');
  }

  // 手动层「🧠 注入记忆」（§4.4）：完整世界卡 + 设定 + 视觉设定卡直接注入，并要求先复述处境再继续。
  // 第十六轮定案：不走 tool_choice（DeepSeek 思考模式不支持），客户端直接注入，跨模型一致、零额外往返。
  // R13：rp 的完整记忆还包括角色卡；开启画像时再带一行画像摘要。
  function forceInjectBlock(story, playerAction, opts) {
    story = story || {};
    if (playerAction && typeof playerAction === 'object' && !opts) { opts = playerAction; playerAction = ''; }
    opts = opts || {};
    const parts = ['[强制注入 · 完整记忆]'];
    const w = worldCardText(story.world);
    if (w) parts.push('【世界状态卡】\n' + w);
    const premise = String(story.premise || '').trim();
    if (premise) parts.push('【故事设定】\n' + premise);
    if (story.characterCard && story.mode === 'rp') {
      const ct = characterCardText(story.characterCard);
      if (ct) parts.push('【角色卡】\n' + ct);
    }
    const rb = (story.mode === 'chat' || story.mode === 'rp') ? relationshipBlock(story.world) : '';
    if (rb) parts.push(rb);
    if (opts.profile && opts.profile.length) {
      const pb = profileBlock(opts.profile, playerAction || '');
      if (pb) parts.push('【关于玩家】\n' + pb);
    }
    // 视觉设定卡只给「文本侧视图」：英文外观 / 负面提示词是给画师的生图参数，
    // 灌给旁白模型只会让它把提示词念出来（用户看到的「画师的提示词混进思考链」就是这么来的）。
    const va = textAnchorText(story);
    if (va) parts.push('【画面基调】（来自视觉设定卡）\n' + va);
    parts.push('[指令] 先用一两句复述当前处境（地点 / 时间 / 在场者 / 伏笔），再继续剧情；复述要与以上记忆一致。不要提「注入」「系统」「工具」这类字眼。');
    return parts.join('\n\n');
  }

  /**
   * 组装 AI1 本轮请求的 messages。
   * @param {object} story
   * @param {string} playerAction
   * @param {object} [opts] { system, includePremise, includeWorld, tools, windowMessages }
   */
  function assembleAI1(story, playerAction, opts) {
    opts = opts || {};
    const mode = (story && story.mode) || 'choice';
    const out = [{
      role: 'system',
      // P2-13：rp 无角色卡（导入 / 旧档可能产生）时换降级提示，别让指令指向不存在的卡
      content: opts.system || systemForMode(mode, { noCharacterCard: !(story && story.characterCard) }),
    }];
    // P1-6（2026-10-14）：风格基调此前只影响画面，现在也进文本侧（三模式通用，≤120 字）
    const tone = String((story && story.styleTone) || '').trim();
    if (tone) out.push({ role: 'system', content: '[风格基调] ' + clip(tone, TONE_MAX_CHARS) });
    // P1-7（2026-10-14）：premise 此前只在开局一回合在场，地基设定随摘要合并流失——改为常驻摘要
    const premise = String((story && story.premise) || '').trim();
    if (premise) out.push({ role: 'system', content: '[故事设定（常驻）]\n' + clip(premise, PREMISE_MAX_CHARS) });
    // R13：rp 角色卡常驻（§4.12）；chat / rp 关系记忆常驻（choice 靠召回工具，不占常驻预算）
    if (mode === 'rp' && story && story.characterCard) {
      const ct = characterCardText(story.characterCard);
      if (ct) out.push({ role: 'system', content: ct });
    }
    if (mode === 'chat' || mode === 'rp') {
      const rb = relationshipBlock(story && story.world);
      if (rb) out.push({ role: 'system', content: rb });
    }
    // 用户画像（§4.12）：由调用方按开关 / 范围传入（opts.profile）；没开启时不传，零成本
    if (opts.profile && opts.profile.length) {
      const pb = profileBlock(opts.profile, playerAction);
      if (pb) out.push({ role: 'system', content: pb });
    }
    if (opts.includeWorld) out.push({ role: 'system', content: '[世界状态卡]\n' + worldCardText(story && story.world) });
    if (!opts.omitSummaryLine) out.push({ role: 'system', content: '[当前情势] ' + buildSummaryLine(story && story.world) });
    const summaries = ((story && story.summaries) || []).filter(Boolean);
    if (summaries.length) out.push({ role: 'system', content: '[前情摘要]\n' + summaries.join('\n') });
    if (Array.isArray(opts.tools) && opts.tools.length) {
      let block = '[可用工具] ' + opts.tools.join(' / ') + '\n' + toolPolicyText(opts.tools);
      if (opts.tools.indexOf('schedule_once') >= 0) block += '\n' + SCHEDULE_POLICY_TEXT;
      if (opts.tools.indexOf('email_propose') >= 0) block += '\n' + EMAIL_POLICY_TEXT;
      if (opts.tools.indexOf('payment_propose') >= 0) block += '\n' + PAYMENT_POLICY_TEXT;
      out.push({ role: 'system', content: block });
    }
    const msgs = (story && story.messages) || [];
    // 组装窗口（P1-3）：已知容量时按 token 动态装（≤ 窗口一半，∈ [4, 40]），未知退回 8 条；
    // 更早的原文交给摘要栈。opts.windowMessages 显式指定时永远最优先。
    const windowSize = opts.windowMessages != null
      ? opts.windowMessages
      : fitWindow(msgs, opts.contextWindow);
    const slice = windowSize > 0 ? msgs.slice(-windowSize) : msgs.slice();
    // 只取 role/content：reasoning 等私有字段留在存档里，不进请求体（T-P5-2）
    // 剧情模式：历史 assistant 消息转回中文键，与本轮契约一致（存档不动）
    for (const m of slice) {
      let content = m.content;
      if (m.role === 'assistant') {
        if (mode === 'choice') content = toChineseHistory(content);
        else if (mode === 'chat' || mode === 'rp') content = toPlainHistory(content);
      } else if (m.role === 'user' && mode === 'chat') {
        // 切换兼容（v0.6.0）：rp 存档切成 chat 后，历史用户消息里的内层标记要剥掉
        content = stripKindMarker(content);
      }
      out.push({ role: m.role, content });
    }
    // 单次注入层（召回 / 工具回传 / 启发式 / 强制注入）都并入本轮 user 消息前缀（P2-12，2026-10-14）。
    // 此前是插在历史与 user 之间的 role:'system' 块——部分兼容层（Gemini 的 OpenAI 端点、
    // 某些网关）会合并或忽略中段 system，注入会静默失效；并入 user 前缀语义不丢、兼容面最广。
    const preUser = [];
    if (Array.isArray(opts.recall) && opts.recall.length) {
      for (const scope of opts.recall) {
        const t = recallBlock(story, scope);
        if (t) preUser.push(t);
      }
    }
    // 工具执行结果的回传块（出图成功/失败、记忆已更新），同样贴在本轮行动之前
    if (Array.isArray(opts.inject) && opts.inject.length) {
      for (const t of opts.inject) if (t) preUser.push(String(t));
    }
    // C-E 启发式注入（§4.10 C-E / T-P5-3）：玩家输入命中世界卡 / 伏笔实体词 → 自动带上对应条目
    if (opts.heuristic !== false) {
      const hb = heuristicBlock(story, playerAction);
      if (hb) preUser.push(hb);
    }
    // 「🧠 注入记忆」：本轮强制注入完整记忆（§4.4 手动层）
    if (opts.forceInject) preUser.push(forceInjectBlock(story, playerAction, opts));
    out.push({
      role: 'user',
      content: (preUser.length ? preUser.join('\n\n') + '\n\n' : '')
        + (mode === 'chat'
          ? stripKindMarker(playerContent(story && story.premise, playerAction, opts))   // chat 不带内层标记
          : playerContent(story && story.premise, playerAction, opts)),
    });
    return out;
  }

  // 调试 / 评测用：拍平成纯文本
  function messagesToText(messages) {
    return (messages || []).map(m => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return '[' + m.role + '] ' + c;
    }).join('\n');
  }

  // 组装结果的 token 估算（纯函数）：估算与实发同源，不再各组一份上下文（审查 三·3）
  function estimateTokensOf(messages) {
    return estimateTokens(messagesToText(messages));
  }

  function estimateContextTokens(story, playerAction, opts?) {
    return estimateTokensOf(assembleAI1(story, playerAction, opts));
  }

  /* ---------------- 一回合归档：条目形状 + 工具吸收（审查 可维护性 二·10） ----------------
   * 此前 src/app/turn.js 与 eval/run.js 各写一份归档，字段已漂移（run.js 缺 versions /
   * activeVersion、没跳过提案留痕、画像无门控）。这里收敛成纯函数，turn.js 与评测共用：
   *   slimReply / narrationEntry / assistantEntry —— 条目形状的唯一口径；
   *   absorbToolCalls(story, calls, opts)        —— 世界卡 / 画像吸收 + tool 留痕。
   * 画像写入门控由调用方注入（opts.applyProfile）：不传 = 不收集（对应「关开关即停止收集」，
   * app 传 A.applyProfileEntries，评测传自己的合并函数）。 */

  const REASONING_MAX = 4000;
  function clipReasoning(text) {
    const s = String(text || '');
    return s.length > REASONING_MAX ? (s.slice(0, REASONING_MAX) + '\n…（思考链过长，已截断）') : s;
  }

  // assistant 消息里的回包瘦身：只留叙事四字段（world / tool_calls 不进 messages）
  function slimReply(r) {
    return { narration: r.narration, choices: r.choices, scene_change: r.scene_change, scene_summary: r.scene_summary };
  }

  // 旁白日志条目（versions = 版本栈）；思考链随条目一起存，供折叠块渲染与以后带 tools 回传
  function narrationEntry(text, reasoning, now) {
    const e: any = { type: 'narration', text: text, versions: [text], activeVersion: 0, ts: now || Date.now() };
    if (reasoning) e.reasoning = clipReasoning(reasoning);
    return e;
  }

  // AI1 原始对话里的 assistant 条目：reasoning 一并存档（不进请求体，§4.5）
  function assistantEntry(reply, reasoning) {
    const m: any = { role: 'assistant', content: JSON.stringify(slimReply(reply)) };
    if (reasoning) m.reasoning = clipReasoning(reasoning);
    return m;
  }

  // 工具留痕文案（per-tool 摘要，§3.A.6：chat / rp 没有画师，措辞中立）
  function toolSummary(name, args) {
    if (name === 'update_memory') return args.text ? ('更新记忆：' + args.text) : '更新记忆';
    if (name === 'recall_world_state') return '查阅了世界状态卡';
    if (name === 'recall_style_card') return '查阅了视觉设定卡';
    if (name === 'request_image') return '排队生图';
    if (name === 'schedule_once') return '安排了一次主动联系（待确认）';
    if (name === 'schedule_heartbeat') return '安排了定时主动联系（待确认）';
    if (name === 'schedule_cron') return '安排了日历主动联系（待确认）';
    if (name === 'list_triggers') return '查看了主动联系安排';
    if (name === 'cancel_trigger') return '取消了主动联系安排';
    return name;
  }

  // 把 tool_calls 吸收进 story（世界卡 / 画像）并留痕：
  //   - 提案类工具不留 tool 留痕（留痕是 {type:'proposal'} 提案卡本身，确认后另记一条）；
  //   - update_memory 的画像条目经 opts.applyProfile 门控写入（不传 = 不收集）。
  function absorbToolCalls(story, calls, opts) {
    if (!story || !Array.isArray(calls)) return;
    const o = opts || {};
    for (const c of calls) {
      const fn = (c && c.function) ? c.function : c;
      const name = (fn && fn.name) || '';
      let args: any = {};
      try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {}); } catch (_) { args = {}; }
      if (isProposalTool(name)) continue;   // 提案留痕跳过（提案卡本身就是留痕）
      if (name === 'update_memory') {
        if (args.world && typeof args.world === 'object') mergeWorld(story.world, args.world);
        if (args.relationship) mergeWorld(story.world, { relationship: args.relationship });
        if (Array.isArray(args.profile) && typeof o.applyProfile === 'function') o.applyProfile(args.profile);
      }
      story.log.push({ type: 'tool', tool: name, summary: toolSummary(name, args), ts: o.now || Date.now() });
    }
  }

  const Context = {
    BUDGET, COMPRESS_RATIO,
    DEFAULT_KEEP_MESSAGES, DEFAULT_MAX_MESSAGES, DEFAULT_MAX_SUMMARIES,
    TONE_MAX_CHARS, PREMISE_MAX_CHARS,
    WINDOW_MIN_MESSAGES, WINDOW_MAX_MESSAGES, WINDOW_TOKEN_RATIO, fitWindow,
    AI1_SYSTEM, systemForMode, RP_SYSTEM_FALLBACK,
    PAINTER_SYSTEM, PAINTER_CHAT_SYSTEM, PAINTER_STYLES_SYSTEM, PAINTER_CARD_SYSTEM,
    PAINTER_VIDEO_SYSTEM,
    RECALL_RECENT_PLOT_TOOL, storySettingText,
    RECALL_WORLD_STATE_TOOL, RECALL_STYLE_CARD_TOOL, TOOLS_RECALL, TOOL_NAMES_RECALL,
    REQUEST_IMAGE_DIRECT_TOOL, UPDATE_MEMORY_TOOL,
    TOOLS_AI1, TOOLS_AI1_DIRECT, TOOL_NAMES_AI1, MAX_TOOL_CALLS_PER_TURN,
    SCHEDULE_TOOLS, TOOL_NAMES_SCHEDULE, SCHEDULE_POLICY_TEXT, toolsForMode, toolNamesForMode, isScheduleTool,
    EMAIL_TOOLS, PAYMENT_TOOLS, TOOL_NAMES_PROPOSAL, EMAIL_POLICY_TEXT, PAYMENT_POLICY_TEXT,
    isProposalTool, stripKindMarker, KIND_MARK_HINT_SHORT,
    TOOL_POLICY_TEXT, TOOL_POLICY_IMAGE, toolPolicyText, RECALL_TOOL_SCOPE, isRecallTool, recallBlock, forceInjectBlock,
    styleCardText, styleCardTextForText, rollingStyleText, painterAnchorText, textAnchorText,
    PAINTER_RECENT_TURNS, PAINTER_RECENT_LINE_CHARS,
    recentImageLines, recentNarrationLines, recentTurnLines, recentPlotText, assemblePainter,
    ENTITY_MIN_MATCH, NAME_MIN_MATCH, HEURISTIC_MAX_ENTRIES, HEURISTIC_MAX_CHARS,
    longestCommonSubstring, matchEntityTerms, heuristicBlock,
    CHAR_CARD_MAX_CHARS, CARD_OPENING_MAX_CHARS, CARD_EXAMPLE_MAX_CHARS, RELATIONSHIP_MAX_CHARS,
    PROFILE_TOP_N, PROFILE_ENTRY_MAX_CHARS, PROFILE_MAX_CHARS, PROFILE_SUMMARY_CHARS, PROFILE_KIND_LABEL,
    characterCardText, relationshipBlock,
    normalizeProfile, mergeProfile, pickProfileEntries, profileSummaryLine, profileBlock,
    profileEnabledFor, localProfileExtract,
    tolerantJSONParse, normalizeAIReply,
    IMPORT_FINAL_SYSTEM, IMPORT_MAP_SYSTEM, IMPORT_MERGE_SYSTEM, IMPORT_TASKS,
    IMPORT_CALL_RESERVE, IMPORT_FIT_RATIO, IMPORT_MIN_BUDGET,
    assembleImporter, splitImportChunks, planImport, planImportMerge,
    estimateTokens, playerContent,
    topThreads, buildSummaryLine, worldCardText, mergeWorld, localScribe,
    sceneSlot, localSummarize, mergeSummaries, compressThreshold, planCompression, trimSummaries, compressStory,
    assembleAI1, messagesToText, estimateContextTokens, estimateTokensOf,
    slimReply, narrationEntry, assistantEntry, toolSummary, absorbToolCalls,
  };
  export { Context };