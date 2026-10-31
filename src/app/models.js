/*
 * src/app/models.js —— 模型能力
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { Prefs } from '../core/prefs.ts';
import { Nav } from '../ui/navigation.js';
import { A } from './core.js';


  const S = A.state;
  const { $, Cap } = A;


  /* ---------------- 模型能力 ---------------- */

  function capChat() {
    // 参考表是纯数据查询（只登记上下文窗口）；查不到 / 抛错都按「未登记」处理，界面退回手填提示
    try { return Cap && Cap.find ? Cap.find(S.settings.chat.model) : null; } catch (_) { /* 未登记 = 无参考值 */ return null; }
  }

  // 有效主模型配置：story.prefs.profileId → 模型库；缺省 / 找不到 → 默认主模型。
  // 所有发给主模型的请求与派生量（contextWindow / extraParams / noTools 键）都走它，
  // 不再直接读 S.settings.chat。
  function chatCfg() {
    const P = Prefs;
    if (P && typeof P.resolveChatCfg === 'function') return P.resolveChatCfg(S.settings, S.story).cfg;
    return S.settings.chat;
  }

  // 有效上下文窗口：用户手填优先，其次参考表；0 = 未知（压缩退回条数兜底）
  function chatContextWindow() {
    const cfg = chatCfg();
    const manual = +cfg.contextWindow || 0;
    if (manual > 0) return manual;
    try {
      const cap = Cap && Cap.find ? Cap.find(cfg.model, cfg.provider) : null;
      return (cap && +cap.contextWindow > 0) ? +cap.contextWindow : 0;
    } catch (_) { return 0; }   // 参考表查询失败 = 未知窗口（压缩按条数兜底，功能不受影响）
  }

  // 设置面板：上下文窗口的参考值与手填说明。
  // 模型 / 尺寸 / 质量等「按能力显隐」的控件已下线——参考表只剩上下文窗口这一个数字，
  // 厂商形参（思考档位等）一律写「自定义请求参数」。
  function renderCapabilityFields() {
    const cap = capChat();
    const ctxInput = $('#s-chat-ctx');
    ctxInput.value = (+S.settings.chat.contextWindow > 0) ? +S.settings.chat.contextWindow : '';
    ctxInput.placeholder = (cap && +cap.contextWindow > 0)
      ? (+cap.contextWindow + '（自动，按参考表）')
      : '不知道就留空（回退按条数压缩）';
    const parts = [];
    if (cap) {
      parts.push('参考值：' + cap.model + (Cap.summarize ? '（' + Cap.summarize(cap) + '）' : ''));
      if (cap.deprecated) parts.push('注意：该模型名可能已弃用，可改填新的');
    } else {
      parts.push('参数全部手填即可，不影响使用：上下文容量可在服务商「模型广场 / 文档」查到，不知道就留空（回退按条数压缩）；思考档位等厂商参数写进上面的「自定义请求参数」');
    }
    $('#s-chat-cap').textContent = parts.join(' · ');
  }

  // 背景图只作用于右栏舞台：底层是当前图的模糊放大副本（CSS 负责模糊 / 压暗）。
  // 全页背景图已取消——阅读面必须是纯 --bg，图不能透到文字后面。
  // 阶段 5：换画走 Nav.stageArt —— 新旧图同名 stage-art，rich 档是共享元素过渡
  //（同一元素的旧 / 新快照做补间，过渡期暂停 Ken Burns，结束按档位恢复）。
  // 换画的两条路都汇到这里：AI 出图后 stagePlaySwap 的 animationend、点缩略图（renderStage → 同一条链）、
  // 视频场景取封面；同图重复调用（renderStage 反复跑）不再开新的一段。
  let stageArtSrc = '';   // 上一次真正落到模糊副本上的 src
  function setStageArt(src) {
    const bd = $('#stage-backdrop');
    if (!bd) return;
    const next = src || '';
    if (next === stageArtSrc) return;
    stageArtSrc = next;
    Nav.stageArt(() => {
      if (!next) {
        bd.classList.remove('show');
        bd.style.backgroundImage = '';
        return;
      }
      bd.style.backgroundImage = 'url(' + JSON.stringify(next) + ')';
      bd.classList.add('show');
    });
  }

  function thumb(dataUrl, maxW) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, (maxW || 560) / img.width);
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        try { resolve(cv.toDataURL('image/jpeg', 0.7)); }
        catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  A.reg({ chatContextWindow, renderCapabilityFields, setStageArt, thumb });

