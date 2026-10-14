# 第三方资源与许可

本项目的**运行时代码没有任何第三方 JavaScript 依赖**：`js/` 下的代码均为本项目原创，只依赖浏览器原生 API（`fetch`、`localStorage`、`FileReader`、`createImageBitmap` 等）。**可选本地服务（`sidecar/`）同样零第三方依赖**，只用 Node 内置能力（`node:http`、`node:sqlite`、`node:fs`、`node:crypto`）。

唯一的第三方资源是**字体**。下面是完整清单，以及分发时需要随附的许可。

---

## 一、字体

字体目前以**外链**方式从 CDN 加载（见 `index.html` 的 `<link>` 标签），仓库内**未包含字体文件**。若后续做本地化 / 打包分发，请把字体文件与对应许可文本（OFL 全文）一并放入仓库并在本文件补充路径。

| 字体 | 用途 | 来源 | 许可 |
|---|---|---|---|
| 霞鹜文楷 LXGW WenKai | 正文 / 旁白 | npm `lxgw-wenkai-webfont@1.7.0`，经 jsDelivr 分发 | SIL Open Font License 1.1 |
| Noto Serif SC（思源宋体） | 标题 / 正文本 | Google Fonts | SIL Open Font License 1.1 |
| Liu Jian Mao Cao（刘建毛草） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| Ma Shan Zheng（马善政毛笔楷书） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| Long Cang（龙藏） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| ZCOOL XiaoWei（站酷小薇） | 装饰字 | Google Fonts | SIL Open Font License 1.1 |
| Cormorant Garamond | 西文衬线 | Google Fonts | SIL Open Font License 1.1 |
| IM Fell English | 西文复古 | Google Fonts | SIL Open Font License 1.1 |

> Google Fonts 上架的字体一律以 OFL-1.1 或同类自由许可发布；上表的许可类别以各字体官方仓库 / Google Fonts 页面声明为准。

**OFL-1.1 的要点**（完整条款以 [OFL-1.1 原文](https://openfontlicense.org/) 为准）：

- 允许免费使用、修改、再分发，包括用于商业项目；
- 再分发字体文件时必须随附 OFL 全文，并保留字体名称与版权声明；
- 修改后的字体**不得**继续使用原「保留字体名称」；
- 不得单独售卖字体文件本身。

## 二、外部服务（非本项目代码，仅作默认值提示）

`index.html` 的 Base URL 下拉框里预置了一批服务商地址（智谱、阿里云百炼、DeepSeek、OpenAI、Ollama…），仅为**填表方便**，不构成任何推荐或合作：

- 不预置模型名，不需要任何服务商 SDK；
- 用哪个服务、是否收费、数据如何处理，由使用者与该服务商的条款决定；
- 使用时请自行注意各服务商的 API 速率、计费与内容政策。

## 三、格式兼容性声明

- **SillyTavern 角色卡 V2/V3**：本项目只实现对 PNG 内嵌 JSON 元数据（`tEXt: chara` / `iTXt: ccv3`）的**格式兼容解析**，未复制其任何代码（SillyTavern 为 AGPL-3.0）。
- 竞品（SillyTavern、InfiPlot、Open Dungeon、NeverEndingQuest 等）仅作**思路参考**，未引入其源码，相关调研见 `docs/NOTES.md`。

## 四、可选本地服务（sidecar）

`sidecar/` 是**可选**的本地伴侣进程，**本期零第三方依赖**，只使用 Node 内置模块：

| 用途 | 使用的东西 | 位置 |
|---|---|---|
| HTTP 服务 | `node:http`（内置） | `sidecar/server.mjs` |
| 存储 | `node:sqlite`（内置，Node ≥ 22.5） | `sidecar/db.mjs` |
| 文件 / 随机数 / 哈希比较 | `node:fs` / `node:crypto`（内置） | `sidecar/config.mjs` 等 |
| 时区与夏令时 | `Intl.DateTimeFormat`（内置） | `sidecar/cron.mjs` |
| 邮件渠道 | 本期只实现 `mock` 与 `resend`（用内置 `fetch` 调 Resend 的 HTTP API） | `sidecar/email.mjs` |

**计划中、尚未引入**的依赖（引入前会先在此登记并征求确认）：

| 依赖 | 用途 | 许可 | 状态 |
|---|---|---|---|
| `nodemailer` | SMTP 发信（浏览器与 `fetch` 都做不到） | MIT | 计划中（邮件二期） |

如上表所示，本项目刻意**不引入** `express`、`croner` 等常见库：HTTP 路由只有十几个、cron 解析只有几十行，自写更符合本项目的零依赖取舍。

如你认为本清单有遗漏或不准确之处，欢迎提 Issue 指出。
