# PageGloss

选中一段文本，使用悬浮按钮或右键菜单把**整页所有重复出现的目标内容**用同一种浅色标出来，并调用**你自己配置的 LLM** 生成注释；鼠标悬停在标记上就能看解释，还能像用 AI 对话应用一样继续追问，且支持快捷笔记，还可查看、导出全部标注数据。

- Chrome / Edge 通用（Manifest V3）
- 零依赖原生 JS / CSS，无需构建，直接「加载已解压的扩展程序」
- 全部数据只保存在本机浏览器，不经过任何第三方服务器
- **标注数据总览**：设置页 → 数据 → 查看，按站点分层浏览全部标注与笔记，支持多选批量删除、JSON 导出/导入、全屏阅读

**语言 / Language:** [中文](#pagegloss) · [English](#english)

## 1.2.1 更新

- **修复全屏阅读页英文未覆盖**：页面先用浏览器语言渲染，设置里的语言加载后只重绘了正文，页头、按钮、占位提示仍停在旧语言。现在语言确定后会重新应用全部标签。
- **弹窗新增「查看全部标注数据」**：点击直接打开标注数据总览页，与设置页的「查看」一致。
- **许可证**：项目采用 **MIT License**（见 `LICENSE`），发行包内一并包含。
- 版本号提升到 **1.2.1**。

## 1.2.0 更新

- 版本号提升到 **1.2.0**，作为首个公开发布候选。
- 已完成仓库与发行包的隐私自检：无 API Key、令牌、个人路径或用户标注数据进入版本库。
- 演示数据仍由 `dev/seed-demo.html` 手动写入（不参与打包），可用于验证数据总览页。

## 1.1.13 更新

- **修「前端已显示标注、弹窗本页标注不更新」**：上一版命中带斜杠的旧 key 后，把 `state.urlKey` 改成了旧 key，而地址栏是不带斜杠的，于是弹窗每次查询都以为“URL 又变了”，走路由切换分支并返回空列表。
  现在改为：**URL key 规范化**（去掉结尾 `/`，根路径除外），一个页面永远只有一个 key；旧数据仍能被找到，并在加载时**自动迁移**到规范 key（先保存新 key，再删除旧 key，日志 `[PageGloss] migrated page key A -> B`）。
- 弹窗与内容脚本从此使用同一个规范 key，查询不再误判为路由变化。

## 1.1.12 更新

- **修复「无标注页 → 有标注页」切路由后不显示**：SPA 给的 URL 常与服务端重定向后的 URL 不完全一样（少/多一个结尾 `/`、残留查询参数），而标注是按后者存储的，于是按前者取到的是空页面。现在会依次尝试「原 URL、加/去结尾斜杠、去掉查询参数」等变体，命中哪个就用哪个的 key；同时把「同 key 但上次没加载到内容」的情况允许重试。
- 增加诊断日志：`[PageGloss] route key A -> B`（命中变体）、`[PageGloss] route has no cached annotations: …`（确实没有缓存）、`[PageGloss] route restore failed: …`（恢复异常），方便你下次直接贴控制台。
- 新增回归测试：存储里是带结尾斜杠的 key、路由切换给的是无斜杠 URL 时，必须能取到并恢复标注。

## 1.1.11 更新

- **修复 SPA 路由处理崩溃**：`handleUrlChange` 里引用了一个不存在的变量 `noteSaveTimer`，一进入就抛 `ReferenceError`，导致路由切换完全没执行——这才是上一轮「切 path 后仍不更新」的直接原因。已改为正确的 `pageSaveTimer`，并给整个路由处理套上异常捕获，出错只会写一条 `[PageGloss] route change failed` 警告，不会再中断轮询。
- 新增内容脚本回归测试：模拟后台发送 `pg:urlChanged`，要求不抛错且 `urlKey` 正确切换。

## 1.1.10 更新

- **SPA 路由改写：改为事件驱动 + 三重兜底**。之前只靠页面内的 `pushState` 补丁与轮询，很多框架（或隔离世界）下会漏掉，于是出现「旧列表 + 总数为 0」或「新页面不显示标注」。现在：
  1. 后台用 `chrome.tabs.onUpdated` 捕获 SPA 的 URL 变化，主动给内容脚本发 `pg:urlChanged`；
  2. 页面内保留 `pushState`/`replaceState`/`popstate`/`hashchange` 监听与 400ms 轮询；
  3. 弹窗查询状态时若发现当前 URL 与内容脚本记录的不一致，立即触发切换；
  4. 切换时先广播一次空列表（清掉上一页的行），再等服务端渲染出该 URL 的标注文本后恢复（最多约 6 秒），最后再广播一次。

## 1.1.9 更新

- **修中文短词被扩成整句**：标记「差异」二字时，实际标出了「…所以换算比例也存在差异…」整段。根因是绘制阶段会把匹配区间向外扩到“词边界”，而中文没有空格，于是扩到了整句。现在只对拉丁字母/数字做词边界扩展，中文严格按所选文字绘制（解释内容本来就是对的）。
- **SPA 切换 path 后弹窗列表同步**：内容脚本广播新 URL 时，弹窗会先采用广播里的 URL（`pushState` 不会触发 tabs 事件，弹窗缓存的 URL 还是旧的），再按新 URL 刷新；列表不再停留在旧页面，统计与列表保持一致。

## 1.1.8 更新

- **中文标记只标所选内容**：句子级“逐词标记”此前对中文也会生效，导致整句被标。现在该功能只对空格分词的文本（英文等）启用，中文只标你选中的部分。
- **SPA 路由切换后恢复标注**：不再在 URL 刚变化、新视图还没渲染时就去恢复。现在会等页面文本里出现该 URL 的标注内容（最多约 3 秒）再恢复，且“恢复失败”不会误清锚点或误标失效；弹窗同步刷新。
- **系统提示词一键填充**：点击为空的系统提示词输入框，会自动填入当前语言对应的默认提示词（中文 / 英文），可直接编辑。
- **README 英文简介对齐中文新版**：与中文一样强调悬浮按钮/右键入口、快捷笔记与标注数据总览。

## 1.1.7 更新

- **移除全局开关快捷键**：删掉 `Alt+Shift+G` 的启停命令，安装后默认生效；标记快捷键默认改为 **`Alt+W`**，旧默认值 `Alt+Q` 会自动迁移，自定义组合保持不动。帮助页改为**动态显示**你当前配置的快捷键。
- **帮助页中英双语**：右上角新增「中文 / English」切换（记忆上次选择），右下角加入与设置页同款的 GitHub 跳转；「三步上手」升级为**四步上手**，补充悬浮窗快速入口与**标注数据总览**说明。
- **修复 SPA 换 path 后弹窗不刷新**：内容脚本监听 `pushState` / `replaceState` / `popstate` / `hashchange`（含定时兜底），路由变化时清掉旧标记、按新 URL 加载各自的标注并广播；弹窗收到广播后立即刷新「本页标注」。
- **语言设置真正统一**：设置页「界面语言」更名为「语言」；选择中文/英文后，系统提示末尾会追加对应语言要求（自定义提示词也生效）；数据页、全屏阅读页也会读取该语言，不再跟随浏览器语言。

---

## 1.1.6 更新

- **修复「PageGloss 设置」跳到 GitHub**：弹窗页脚那个链接文案原本是「PageGloss 设置」，但地址被写成了 `homepage_url`（GitHub）。现在改为「使用帮助」并打开扩展内置的 `docs/help.html`；`homepage_url` 同时修正为真实仓库地址。
- **数据页按钮居中**：标注内容区域的按钮改为在格子内水平与垂直居中；多选模式为复选框预留的左侧间距仍做补偿，居中位置不变。
- **设置页 GitHub 入口**：设置页右下角新增固定胶囊按钮「GitHub · Self-Identity」，点击在新标签页打开 `github.com/Self-Identity`。
- **README 中英双语**：顶部提供语言跳转，中文文档之后新增完整英文版。

## 1.1.5 更新

- **数据页标记文字居中**：标记格子内的文本（含已失效标注）改为水平与垂直居中，失效徽标也居中显示；左侧为多选复选框预留的间距已做补偿，居中位置与格子中心一致。

---

## 1.1.4 更新

- **短词不再误命中**：`smart` 模式此前在整词匹配为 0 时会静默回退到子串匹配，导致标记 “MA” 时把 make / matter / mark / human 一起标上。现在只认整词；当文本仅出现在更长单词内部时，会先弹提示询问「是否仅本次改用子串匹配」，确认只影响这一次标记，不会更改全局匹配模式（已记录的标注会记住这次选择）。
- **数据页格子统一高度**：标记格子固定 80px、最多三行，超出省略；每页从 10 行 × 5 列改为 **4 行 × 5 列**（20 条/页）。
- **更新时间只留在注释窗**：数据页格子不再显示时间，改为在悬停注释窗口的最下方显示「更新于 …」；标签页的更新时间保持不变。
- **标记文字更醒目**：字号 13px、字重 700，颜色对比更强。
- **全选真正全选**：多选模式下点「全选」，站点、标签页与每条标记的复选框都会勾上（此前只勾站点）。
- **三级容器递进配色**：站点、标签页、标记矩阵三层背景由浅到深，并各带一条左侧色条，层级一眼可辨。

---

## 1.1.3 更新

- **修复演示数据页无响应**：`dev/seed-demo.html` 的按钮逻辑原先写在内联 `<script>` 里，被 MV3 扩展页 CSP（`script-src 'self'`）拦截，点按钮没有任何反应。已拆分到外部 `dev/seed-demo.js`，现在可以正常写入与清空演示数据。
- **官方接口地址直接粘贴即生效**：新增主流服务商的官方 base URL 规则，从文档复制后不用再手动补路径：
  - OpenAI `https://api.openai.com/v1`
  - DeepSeek `https://api.deepseek.com`（也支持 `/v1`）
  - Moonshot / Kimi `https://api.moonshot.cn`（自动补 `/v1`）
  - 智谱 `https://open.bigmodel.cn`（自动补 `/api/paas/v4`）
  - 阿里云百炼 `https://dashscope.aliyuncs.com/compatible-mode/v1`
  - 火山方舟 `https://ark.cn-beijing.volces.com/api/v3`
  - Groq `https://api.groq.com`（自动补 `/openai/v1`）
  - Mistral、xAI、OpenRouter、Together、SiliconFlow、MiniMax、本地 Ollama / LM Studio
  - Gemini 的 OpenAI 兼容入口 `https://generativelanguage.googleapis.com`（自动补 `/v1beta/openai`）
- **粘贴内容自动清洗**：自动去掉首尾引号/反引号、所有空白与末尾斜杠；URL 中的查询参数（例如 Azure 的 `api-version`）在追加路径后仍保留。
- **不兼容协议提前提示**：粘贴 Anthropic / Claude 地址时，设置页会直接说明它不使用 OpenAI 协议，避免得到一个看不懂的 404。
- **限流与网关错误自动重试一次**：遇到 429 / 500 / 502 / 503 / 504 时在同一端点重试一次（优先遵循 `Retry-After`，最多等 2 秒）；重试仍失败则报告真实状态码，不再误报成「接口地址不对」。
- **其它**：`obsidian-test/` 已加入 `.gitignore`，为后续 Obsidian 对接预留，本轮不实现。

---

## 1.1.2 更新

- **多选改为模式切换**：点「多选」才显示复选框；勾选站点会自动勾选其全部页面与标记，子项全选后父项自动勾选并支持半选状态；退出多选会清空选择。
- **数据页支持导入**：与导出使用同一份 `pagegloss-backup` 格式；按 URL 与标注 id 合并，文本与解释完全相同的标注不会重复导入。
- **数据页悬浮窗可全屏**：只读卡片右上角也有「全屏显示」，点击打开与页面内卡片相同的独立阅读页（左注释可追问、右笔记可编辑）。
- **设置页数据模块更舒展**：容器加高，按钮组贴底，不再显得拥挤。
- **笔记非空时默认双窗**：打开带笔记的标注时注释窗与笔记窗同时出现；笔记为空时仍按悬停 0.2 秒显示。
- **失效标注不再错位**：恢复缓存前先核对页面文本是否还存在，文本对不上时**不再在原位置绘制标记**，而是写入 `stale`/`staleAt` 并在数据页显示醒目的「已失效」徽标；弹窗列表里已失效条目变灰、显示删除线并提示「该标注在页面上已找不到对应文本」。
- **弹窗更清爽**：去掉了意义不明的 `×0`/`×1` 标记计数。

### 假数据怎么用（开发测试）

1. 先加载扩展（`chrome://extensions` → 加载 `build/pagegloss`），记下扩展 ID。
2. 打开 `chrome-extension://<扩展ID>/dev/seed-demo.html`。
3. 点「写入演示数据」：会生成 3 个站点、16 个页面、129 条标注（含 12 页与 60 条标注两组极端样本），与真实数据混排。
4. 打开设置页 → 数据 → 「查看」，即可检查分组、分页、多选、删除与导出。
5. 测试完点该页的「清空全部数据」。
6. `dev/` 不会进入发行包（`tools/package.js` 已排除），发布产物不含任何标注数据。

---

## 1.1.1 更新

- **笔记窗不再挤压注释窗**：笔记窗改为浮层，注释窗宽度恒定；显示与隐藏都有 150ms 渐入渐出，右侧放不下时依次翻到左侧或下方。
- **输入时页面滚动不关窗**：追问框或笔记框聚焦即受保护，滚动与鼠标移开都不会关闭；仍然可以点外部或关闭按钮关掉。
- **标记后窗口临时驻留**：任何入口执行「标记并解释」后，本次窗口只在点击外部、关闭按钮或切换到另一条标注时消失；「固定」按钮的作用不变。
- **打开即顶部**：进入注释窗默认停在内容最上方；流式生成时仍自动跟随，用户手动上滚后停止跟随。
- **失效标注检测**：进入页面后异步核对已缓存标注是否还存在于页面，找不到就写入 `stale`/`staleAt`（另有 `lastCheckedAt` 节流），只在数据页显示「已失效」徽标，不影响阅读、不自动删除。
- **数据页删除与导出**：站点、标签页、标记三级均可删除，支持跨层级多选与批量确认删除；支持站点级、标签页级和所选条目的 JSON 导出，文件格式可直接用设置页的导入功能还原。
- **数据页悬停窗一致**：悬停标记时复用真实注释卡片组件（只读模式），注释窗与笔记窗的样式、结构、动画与页面内完全一致。
- **弹窗分页**：本页标注每页 5 条，带上一页/下一页与页码；标签页前进、后退、刷新后保持页码与内容，不重复加载、不闪烁。
- **假数据**：继续用 `dev/seed-demo.html` 写入（与真实数据混在一起），打包时自动排除 `dev/`，发布产物不含任何历史标注数据。

---

## 1.1.0 更新

- **默认不固定**：点击标注只打开窗口，只有点右上角「固定」才固定；打开新窗口会自动关闭上一个固定窗口。
- **关闭更符合直觉**：未固定时点击窗口外部或滚动页面即关闭；正在追问框/笔记里输入时，鼠标移开不会误关。
- **渐隐动画**：窗口消失时 150ms 淡出并轻微下移，与淡入对称；系统开启「减少动效」时直接消失。
- **选中文本悬浮按钮**：选中文字后，在光标右侧 100px 出现「标记并解释」小按钮（右侧空间不足时自动放到左侧），点击即标记；选区取消后自动隐藏。可在设置页关闭。
- **可配置热键**：默认 `Alt+Q` 直接标记选中文本，设置页可录制任意组合键。
- **清空本页需确认**：页面内弹出确认框，避免误删。
- **未配置提示只在用时出现**：打开网页不再弹提示；只有真正发起标记/追问时才提醒，并修复了「配置好仍提示未配置」的判断时机问题。
- **笔记窗口**：注释窗右侧，指针停留 0.2 秒后滑出；纯文本编辑、停止输入自动保存，随注释一起存储，并记录 `updatedAt`（标记成功或修改笔记时更新）。
- **全屏显示**：注释窗右上角按钮打开独立标签页，左右分栏（左注释+追问，右笔记），字号为常规两倍。
- **标注数据页**：设置页「数据」模块移到「上下文策略」下方，新增高亮的「查看」按钮，打开按站点分组的层级视图：站点 → 标签页（每页 10 行）→ 标记内容（5 列 × 10 行分页，无表格线、开头对齐）。悬停显示注释与笔记，点击在新标签页打开原文并尽力定位到该标注。
- **开发用种子数据**：`dev/seed-demo.html`（不参与打包）可一键写入演示数据，便于验证数据页分页与分组。**发布前请删除 `dev/` 目录，确保产物里不含任何演示数据。**

---

## 1. 快速开始

### 1.1 加载扩展

```bash
git clone <your-repo> PageGloss
cd PageGloss
bash deploy/deploy.sh          # Windows 也可直接双击 deploy\deploy.bat
```

脚本会做四件事：静态校验 → 跑测试 → 打包 `build/pagegloss-<版本>.zip` → 把可直接加载的扩展暂存到 `build/pagegloss/`。

然后：

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `build/pagegloss` 目录

> 也可以完全不用脚本：直接把仓库根目录当成解压目录加载即可，根目录就是合法的 MV3 扩展。

### 1.2 配置 LLM

点扩展图标 → 「LLM 与界面设置」，填写：

| 配置项 | 说明 |
| --- | --- |
| 接口地址 | 按服务商文档原样填写，例如 OpenAI 用 `https://api.openai.com/v1`、DeepSeek 用 `https://api.deepseek.com`。**保存时不会改写你填的内容**，调用时才补全到具体接口，下方会实时显示实际请求地址 |
| API Key | 仅存本机，只会发给你填的接口地址 |
| 模型名称 | 可点「拉取模型列表」从 `/models` 自动获取（结果以可滚动列表展示全部模型，可点选）；服务商没有该接口时手动填写即可（见下） |
| 温度 / 回答长度上限 | 默认 `0.3` / `900` |
| 流式输出 | 默认开，边生成边显示 |

### 接口地址怎么填（各家不一样）

`/v1` 这一段**不是所有服务商都有**，这也是最容易踩的坑：

| 服务商 | 建议填写 | 实际请求地址 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` |
| DeepSeek | `https://api.deepseek.com` | `https://api.deepseek.com/chat/completions`（**没有 `/v1`**） |
| Ollama / LM Studio | `http://localhost:11434/v1` | `http://localhost:11434/v1/chat/completions` |
| 中转站 | `https://xxx/v1` 或对方给的完整路径 | 按你填的路径拼 `/chat/completions` |

只填裸域名（如 `https://api.deepseek.com`）时，PageGloss 会先试 `/v1/chat/completions`，**如果返回 404 就自动改用 `/chat/completions`** —— 所以你不用猜，两种填法都能连通。填了具体路径（`/v1`、`/api`、甚至完整 `/chat/completions`）则完全按你填的走。

> 为什么文档写 `base_url: https://api.deepseek.com`，却看不到 `/chat/completions`？
> 因为 SDK 会自己拼：DeepSeek 的 `base_url` 指向 `https://api.deepseek.com`，OpenAI 官方 SDK 会自动追加 `/chat/completions`（它把 base 当成"服务器根 + 版本前缀"）。所以每家文档给的 `base_url` 与最终 URL 的对应关系并不统一：OpenAI 的 base 含 `/v1`，DeepSeek 的不含。PageGloss 里你只需要照抄文档给的 `base_url`，剩下的拼接由插件在调用时完成。

### 关于推理模型（deepseek-reasoner、o 系列、QwQ 等）

推理模型会先输出一大段**思维链**（`reasoning_content`），再输出正式答案（`content`）。如果「回答长度上限」太小，预算会被思维链吃光，`content` 就是空的 —— 表现为「模型没有返回内容」。

PageGloss 的处理：

- 思维链单独走一条通道，在注释卡片里以**灰底虚线框**（标注「推理过程」）展示，不混进正式答案
- 如果预算被推理吃光（`finish_reason=length`），不会丢掉结果：把已产出的内容交回，并提示**调大「回答长度上限」（例如 2000）或改用 `deepseek-chat` 这类非推理模型**
- 「测试连接」的探测请求会预留至少 256 tokens，避免把推理模型误判成接口不通

**关于「拉取模型列表」**：各家的列表端点同样不统一，PageGloss 会按可能性依次尝试并在失败时报出试过的地址：

```
https://api.example.com/v1/models    ← 常见形式
https://api.example.com/models       ← 去掉 /v1 的回退（DeepSeek 属于这种）
```

拉到的模型会以**可滚动列表**展示（含总数与来源地址），点任意一项即可选中，也可以直接在输入框里手写。如果所有候选都 404，提示会说明「该服务没有提供模型列表接口」并列出试过的地址 —— **拉列表失败不影响聊天功能**。遇到 401/403 会立即停止重试并提示密钥问题。

任何 OpenAI 兼容服务都能用（OpenAI、DeepSeek、月之暗面、通义、硅基流动、各类中转站、Ollama、LM Studio、vLLM…）。保存时浏览器会请求访问该接口地址的权限，这是 MV3 的要求。

点「测试连接」确认可用后再去页面上使用。

---

## 2. 怎么用

### 2.1 标记并解释

1. 在网页上选中一个词、短语或一整句
2. 右键 → **PageGloss：标记并解释"xxx"**
3. 整页所有相同文本会被同一种浅色标出，右侧弹出一条注释卡片
4. 鼠标悬停任意一处标记，都能看到同一条注释

标记规则：

- 匹配**忽略大小写**：`The` / `the` 视为同一处
- 匹配**忽略多余空白**：跨行折断、连续空格、`&nbsp;` 都能命中
- **默认只标记独立整词**：选中 `art` 不会把 `start`、`cartography`、`matters` 里的 `art` 一起标上；页面上确实没有独立出现时，才回退标记包含它的位置并提示一次
- 三种匹配规则可在设置页切换：**智能（默认）/ 宽松（旧行为，只要包含就标记）/ 严格（只标独立整词，不回退）**
- 中文、日文等无空格语言按子串匹配（没有词边界可用）
- 不会跨段落/跨列表项匹配，也不会改动页面原有 DOM（标记是新增元素，取消时原样还原）
- 默认跳过 `code` / `pre` / 输入框 / 编辑器区域
- 单条标注默认最多标记 1500 处，超出会提示
- 高亮色按文本哈希取色（同一文本同色），**文字颜色按背景亮度自动取深/浅**，保证对比度 ≥ 4.5:1

### 2.2 悬停注释卡片

- 悬停 220ms 自动弹出；鼠标移开自动收起
- 卡片上方按钮：**取消标记**、**固定**（钉住 → 变成独立小窗，标题栏可拖动）、**复制**（复制全部回答）、**关闭**
- **取消标记**点开有两个选项，各自对应一种语义：
  - `取消此处标记（仅这一次）`：只去掉当前这一处
  - `取消该词的全部标记`：去掉该文本的所有位置（含聊天记录）
  - 原来的右键菜单项全部保留，两种入口等价
- 卡片底部是输入框：`Enter` 发送，`Shift + Enter` 换行，支持多轮追问
- 聊天记录按标注保存，下次悬停还能看到上次聊到哪
- `Esc` 关闭当前卡片（菜单打开时先关菜单）

### 2.3 取消标注

| 操作 | 效果 |
| --- | --- |
| 卡片上的「取消标记」→ 取消此处标记（仅这一次） | 只去掉这一处 |
| 卡片上的「取消标记」→ 取消该词的全部标记 | 去掉该文本的所有位置 |
| 在某个标记上右键 → 「取消此处标记」 | 只去掉这一处 |
| 在标记上右键 → 「取消"xxx"的全部标记」 | 去掉该文本的所有位置 |
| 点扩展图标 → 列表里逐条删除 | 删除某一条标注（含聊天记录） |
| 点扩展图标 → 「清空本页全部标注」 | 清空当前页面的全部标注 |

---

## 3. 三种上下文发送方式

在**扩展图标弹窗**里随时切换，鼠标悬停每个选项会有解释；切换后自动刷新当前标签页以套用新策略。设置页的「上下文策略」也可以调发送上限与「句子被选中时同时标记句中每个重复词」。

| 方式 | 发送给模型的内容 | 适用 |
| --- | --- | --- |
| **整页正文**（默认） | 页面全部正文 + 该段文本所在的完整句子 + 所在章节节选。超出上限自动头尾保留并截断 | 理解最充分，忠实原方案；长文 token 消耗最高 |
| **所在章节 + 关键片段** | 该文本所在段落/章节 + 完整句子 + 全页去重后的关键片段（按关键词相关性打分挑 ≤12 段） | 成本明显更低，绝大多数场景质量不下降 |
| **仅所在句子** | 该段文本所在的完整句子 + 相邻各一段 | 最省 token；脱离全文的术语可能解释不准 |

提示词形态（第一种方式为例）：

```
页面内容如下：

页面标题：…
页面网址：…
该段文本所在的完整句子：…
该段文本所在章节（节选）：…
页面全部正文：…

──────
问题：在“<完整句子>”这句话里，“<选中的文本>”是什么意思？

请先用一句话给出它在本页语境下的含义，再补充 2-4 条要点。
```

追问时会把该标注的聊天记录一起带上，问题变成「正在讨论的词语/短语：xxx / 用户追问：…」。

**系统提示词按你的要求不随标注保存**：默认提示词内置在代码里，设置页填写的内容只在每次请求时临时使用，既不写入页面的标注缓存，也可以通过「恢复默认提示词」一键清空。

---

## 4. 缓存与数据

- 标注位置、颜色、解释与聊天记录按**网址**（去掉 hash 与 utm 等跟踪参数）存在 `chrome.storage.local`
- 重新打开同一篇文章时会**尽力恢复**：用「容器路径 + 文本偏移」定位；页面结构变化导致定位失败时静默跳过，不会破坏页面
- 设置页可「导出全部数据」为 JSON、「导入数据」、或「清空全部缓存」
- 单页缓存过大时自动保留最近 4 条聊天摘要，防止存储膨胀

---

## 5. 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt + W`（默认，可在设置页自定义） | 标记并解释选中的文本 |
| `Esc` | 关闭当前注释卡片 / 取消选区 |
| 右键菜单 | 标记、取消此处、取消该词全部、清空本页 |

> 没有全局开关快捷键：安装后默认生效，需要暂停时用弹窗顶部的开关。帮助页会动态显示你当前配置的组合键。

---

## 6. 项目结构

```
manifest.json               MV3 清单（Chrome / Edge 通用）
_locales/{zh_CN,en}/        扩展名称与描述的本地化
icons/                      16/32/48/128 图标（由脚本生成，无第三方素材）
src/
  background/service-worker.js   右键菜单、OpenAI 兼容请求与流式转发、提示词构造
  content/
    matcher.js                   文本匹配与标记引擎（跨节点、忽略大小写/空白、锚点持久化）
    card.js                      悬停注释卡片（Shadow DOM 隔离、轻量 Markdown 渲染）
    main.js                      内容脚本主流程：菜单接线、卡片生命周期、缓存读写
    inject.css                   标记与宿主元素样式
  popup/                     扩展图标弹窗：开关、上下文方式选择、本页标注管理
  options/                   设置页：LLM 配置、上下文策略、数据导入导出
  shared/                    常量与默认提示词、i18n、存储层、Toast
    messages.js              经典脚本：常量与默认提示词（内容脚本/popup/options 直接加载）
    shared.mjs               纯 ESM 入口：把上面的经典脚本再导出给 service worker
    storage.js               经典脚本：chrome.storage.local 读写与数据整形
  styles/ui.css              共享 UI 基础样式
docs/help.html               扩展内使用说明页
deploy/deploy.sh             一键部署（bash，纯 ASCII + LF）
deploy/deploy.bat            一键部署（Windows 包装器）
deploy/deploy.ps1            Windows 无 bash 时的后备实现
tools/check.js               静态校验：清单/本地化/i18n 键/CSS 规范/脚本/图标
tools/make-icons.js          生成 PNG 图标
tools/package.js             生成发布 zip
tests/matcher.test.js        匹配引擎测试（14 项，含最小 DOM 实现，无外部依赖）
tests/integration.test.js    内容脚本集成测试（7 项，假 chrome API 跑通标记→缓存→恢复→取消）
tests/service-worker.test.js 后台请求管线测试（18 项，假 fetch 验证三种上下文、SSE 流式解析、菜单并发重建）
tests/esm.test.js            ES 模块冒烟测试（4 项，用真实 ESM 加载器加载 service worker）
tests/content-load.test.js   内容脚本加载测试（5 项，验证注入顺序、缺依赖提示、未配置 API Key 的提醒）
```

---

## 7. 开发与自测

```bash
node tools/check.js                # 静态校验（清单、本地化、i18n 键、模块边界、注入顺序、CSS、图标）
node tests/matcher.test.js         # 匹配引擎测试（14 项）
node tests/integration.test.js     # 内容脚本集成测试（7 项）
node tests/service-worker.test.js  # 后台请求管线测试（18 项）
node tests/esm.test.js             # ES 模块冒烟测试（4 项）
node tests/content-load.test.js    # 内容脚本加载测试（5 项）
node tools/make-icons.js           # 重新生成图标
node tools/package.js              # 重新打包 zip
bash deploy/deploy.sh --no-tests   # 跳过测试的部署
```

五套测试都不依赖浏览器：用最小 DOM 实现、假 chrome / fetch 和**真实 ESM 加载器**覆盖「跨节点匹配、忽略大小写与空白、不跨段落、标记不改变原文、取消后原样还原、按锚点恢复、单点取消并跨刷新保留、清空本页、三种上下文提示词、SSE 分片重组、错误映射与超时、中断请求、菜单并发重建、service worker 模块加载、内容脚本注入顺序」。目前 48 项全部通过。

修改代码后：`chrome://extensions` 上点该扩展的刷新按钮，再刷新网页即可。

`tests/esm.test.js` 尤其重要：它用 Node 的真实 ES 模块加载器把 `service-worker.js` 完整加载一遍（和 Chrome 的做法一致），并带有两个**故意写错的 fixture**（具名导入经典脚本、导入不存在的导出），确保这类错误一定会被拦住而不是带到浏览器里。

修改代码后：`chrome://extensions` 上点该扩展的刷新按钮，再刷新网页即可。

---

## 8. 模块边界（重要）

MV3 的内容脚本**不能**是 ES 模块，所以共享代码分成两层，改代码时别越界：

| 文件 | 形态 | 谁在用 |
| --- | --- | --- |
| `src/shared/messages.js` | 经典脚本，`globalThis.PageGlossShared` | 内容脚本、popup、options（HTML `<script>`） |
| `src/shared/storage.js` | 经典脚本，`globalThis.PageGlossStore` | 同上 |
| `src/shared/i18n.js`、`ui.js` | 经典脚本，挂到 `globalThis` | 同上 |
| `src/content/matcher.js`、`card.js` | 经典脚本，挂到 `window` | 内容脚本 |
| `src/shared/shared.mjs` | 纯 ESM，import 上面两个经典脚本并再导出 | `service-worker.js` |

**内容脚本的注入顺序是硬依赖**，`manifest.json` 里必须依次列出（缺一个都会让 `main.js` 起不来）：

```
src/shared/messages.js  →  src/shared/i18n.js  →  src/shared/storage.js
  →  src/content/matcher.js  →  src/content/card.js  →  src/content/main.js
```

- 经典脚本里**不要**写 `import` / `export`（Chrome 会当成语法错误，直接让 service worker 注册失败）
- ESM 里的 `import` 路径必须带扩展名，且目标必须有对应的具名导出
- 环境不完整时 `main.js` 会打印明确错误，并弹出「PageGloss 加载不完整」提示，而不是抛 `Cannot read properties of undefined`
- `tools/check.js` 会强制校验以上全部规则：注入顺序、缺失脚本、导入经典脚本、具名导出缺失、内容脚本里出现模块语法，都会直接报错并让部署失败
- **排错第一步**：打开 `chrome://extensions` → 找到 PageGloss → 点「Service worker」→ Console。看到 `[PageGloss] service worker 1.0.0 loaded (modules: shared.mjs)` 说明新代码已经生效；若看到的仍是 `does not provide an export named ...`，说明浏览器还在用旧的注册：点扩展卡片上的**刷新**（⟳），仍不行就**移除扩展再重新加载** `build/pagegloss`
- 确认加载目录：`chrome://extensions` 卡片里显示的路径应与 `deploy` 输出的一致（默认 `build/pagegloss`），不要指向旧的副本

---

## 9. 异常与提示

| 情况 | 表现 |
| --- | --- |
| 未配置接口地址 / API Key / 模型 | 打开页面时弹出轻提示（带【去设置】按钮），标注后卡片内同样提示并可重试 |
| API Key 无效或无权限（401/403） | 显示服务商返回的原文，并追加「API Key 可能无效或没有该模型的权限」 |
| 拉取模型列表失败（404） | 提示该服务没有模型列表接口，列出试过的地址，并说明可直接手动填模型名；**不影响聊天** |
| 拉取模型列表失败（401/403） | 显示服务商原文 + 密钥提示，且不再重试其他地址 |
| 接口地址写错 / 该服务需要或不需要 `/v1` | 自动换用另一个候选地址（都 404 时报出试过的全部地址） |
| 模型没有返回内容（200 但正文为空） | 区分原因给建议：被长度上限截断 / 推理占用全部预算（`finish_reason=length`）/ 内容过滤 / 仅返回推理内容 / 响应结构无法识别 |
| 推理模型只输出思维链 | 思维链在卡片内独立展示，并提示调大「回答长度上限」或换用非推理模型 |
| 模型名不存在或参数不支持（400） | 提示模型名可能写错 |
| 限流 / 额度不足（429）、服务端 5xx | 分别提示稍后重试 |
| 请求超时 | 按设置页的「请求超时」截断，提示已等待多少秒 |
| 请求体超过模型上下文（413） | 提示去设置页调低上下文长度 |
| 网络不可达 | 显示底层错误原因，可点重试 |
| 本地缓存读取失败 | 提示「本次标记不会保留」，本次会话内标记仍可用 |
| 内容脚本依赖缺失 | 弹出「PageGloss 加载不完整」，控制台给出缺失脚本名 |

---

## 10. 已知限制

- 不作用于浏览器内置页面（`chrome://`、扩展页、应用商店页），这是浏览器限制
- 以 `file://` 打开的本地页面需要额外开启「允许访问文件网址」
- 动态渲染（虚拟列表、无限滚动）的页面，尚未进入 DOM 的文本不会被标记
- 悬停卡片用的是 `position: fixed`，页面滚动时会自动收起（固定后的小窗不受影响，可拖动标题栏移动）
- 切换上下文方式会刷新当前标签页以套用新策略；只改系统提示词或接口地址不会刷新页面
- 后端要求能从浏览器直连；若服务商禁止跨域，需要在服务端放行或使用本地中转

## 11. 隐私

- 只有你配置的接口地址会收到页面内容与 API Key
- 扩展不采集任何遥测数据，不含远程脚本
- 所有渲染都经过转义，模型返回的 Markdown 不会执行 HTML/脚本

---

# English

Select text, then use the floating button or the context menu to highlight **every repeated occurrence of that text on the page** in one consistent light colour, and call **your own configured LLM** to explain it. Hover a mark to read the explanation, keep asking follow-up questions like in an AI chat app, take quick notes, and browse or export all of your annotation data.

- Chrome / Edge, Manifest V3
- Zero dependencies, plain JS/CSS, no build step: load the folder unpacked
- All data stays in your browser; nothing goes anywhere except the endpoint you configure

**Language:** [中文](#pagegloss) · [English](#english)

## Changes in 1.2.1

- Fixed the full-page reader not switching every label to English: it rendered with the browser language first and only re-rendered the body after the saved language loaded. All labels are re-applied once the language is known.
- The popup now has a "View all annotation data" button that opens the overview directly.
- Licensed under **MIT** (see `LICENSE`), included in the release archive.
- Version bumped to **1.2.1**.

## Changes in 1.2.0

- Version bumped to **1.2.0**, the first public-release candidate.
- Repository and release archive audited: no API keys, tokens, personal paths or user annotation data are committed.
- Demo data is still written manually through `dev/seed-demo.html` (excluded from the package) for checking the annotation overview.

## Changes in 1.1.13

- Fixed "marks show on the page but the popup list does not update": after a legacy trailing-slash key was found, `state.urlKey` was switched to that old key while the address bar kept the un-slashed URL, so every popup query looked like a new route and returned an empty list. URL keys are now canonical (trailing slash trimmed, root excepted) and legacy keys are found and migrated on load (`[PageGloss] migrated page key A -> B`).

## Changes in 1.1.12

- Fixed "unannotated page → annotated page" after an SPA route change: the URL the router reports often differs from the redirected URL the annotations were stored under (trailing slash, leftover query), so the lookup found an empty page. The loader now tries the plain URL, with/without a trailing slash, and without the query string, and adopts whichever key actually holds annotations. A same-key route that previously failed to load is retried.
- Added diagnostics: `[PageGloss] route key A -> B`, `[PageGloss] route has no cached annotations: …`, `[PageGloss] route restore failed: …`.
- Added a regression test where storage holds the trailing-slash key while the route reports the un-slashed URL.

## Changes in 1.1.11

- Fixed a crash in the SPA route handler: it referenced a non-existent `noteSaveTimer`, so every route change threw a `ReferenceError` and never switched pages. It now clears `pageSaveTimer`, and the whole handler is wrapped so a failure only logs `[PageGloss] route change failed` instead of breaking the poll.
- Added a content-script regression test that simulates `pg:urlChanged` and asserts no error plus a switched `urlKey`.

## Changes in 1.1.10

- SPA route changes are now event-driven with three fallbacks: the background worker forwards the new URL from `chrome.tabs.onUpdated`, the page keeps its `pushState`/`popstate`/`hashchange` listeners plus a 400 ms poll, and the popup's state query switches the route when it sees a URL mismatch. On a switch the old rows are cleared immediately, then the new route's annotations are restored once its text appears (up to ~6 s).

## Changes in 1.1.9

- Fixed a short Chinese word being highlighted as its whole sentence: the paint step used to extend a match to word boundaries, and CJK has no spaces. Only Latin/digit word characters are extended now; CJK is painted exactly as selected.
- The popup list now follows SPA route changes: it adopts the URL broadcast by the content script (pushState fires no tabs event) before refreshing, so the count and the rows stay in sync.

## Changes in 1.1.6

- The popup footer link labelled "PageGloss 设置" opened GitHub because it used `homepage_url`. It is now "Help" and opens the bundled `docs/help.html`; `homepage_url` points at the real repository.
- Data page mark buttons are centred inside their cells (the selection checkbox inset is compensated in select mode).
- The options page has a fixed GitHub chip in the bottom-right corner linking to `github.com/Self-Identity`.
- This README is bilingual.

## Install

1. Clone or download this repository and, on Windows, run `deploy\deploy.bat` (double-click). On Linux/macOS run `bash deploy/deploy.sh`. The script checks the sources, runs the tests, builds `build/pagegloss-<version>.zip` and stages `build/pagegloss/`.
2. Open `chrome://extensions` (or `edge://extensions`) and enable Developer mode.
3. Choose "Load unpacked" and pick `build/pagegloss`.
4. You can also load the repository root directly; it is a valid MV3 extension.

## Configure your LLM

Open the extension popup, then "LLM and interface settings":

| Field | Notes |
| --- | --- |
| Endpoint | Paste the base URL from your provider's docs. It is stored exactly as typed and completed per request; the page shows the resulting URL. |
| API key | Stored locally, sent only to the endpoint above. |
| Model | Use "Fetch models" or type a model id (for example `deepseek-chat`). |
| Temperature / max tokens | Defaults: `0.3` / `900`. |
| Stream | On by default. |

### Endpoint cheat sheet

| Provider | Paste this |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` (also accepts `/v1`) |
| Moonshot / Kimi | `https://api.moonshot.cn` |
| Zhipu GLM | `https://open.bigmodel.cn` |
| Alibaba DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Volcengine Ark | `https://ark.cn-beijing.volces.com/api/v3` |
| Groq | `https://api.groq.com` |
| Mistral / xAI / OpenRouter / Together / SiliconFlow / MiniMax | each provider's own base URL |
| Gemini (OpenAI compatibility) | `https://generativelanguage.googleapis.com` |
| Ollama / LM Studio | `http://localhost:11434/v1`, `http://localhost:1234/v1` |

A full endpoint (`.../chat/completions`) is used verbatim; query strings survive path completion. Anthropic/Claude endpoints are detected and rejected with a clear message because they do not speak the OpenAI protocol. Rate limits (429/5xx) are retried once.

## Usage

- Select text, then right-click and choose "Mark and explain", press the shortcut (default `Alt+W`, customisable), or click the floating button that appears 100px from the cursor.
- Every occurrence on the page is highlighted with one consistent colour; the note card opens automatically.
- Hover the card to read the explanation; the note pane slides out after 200 ms (immediately when the annotation already has a note).
- Ask follow-up questions in the card; answers are stored with the annotation.
- Pin the card to keep it open. Otherwise it closes on an outside click, on scroll (not while you are typing), or via the close button. A card opened right after marking stays until you click outside or close it.
- Right-click an existing mark to remove that occurrence or all occurrences; "Clear every mark on this page" asks for confirmation first.
- **Annotation overview**: options → Data → View lists everything grouped by site, with multi-select bulk delete, JSON export/import, and a full-page reader for each annotation.
- The help page is bilingual (中文 / English) and shows your own hotkey; there is no global toggle shortcut — the extension is active once installed.

## Privacy

- Only the endpoint you configure receives page text and your API key.
- No telemetry, no remote scripts.
- Model output is rendered through an escape-first Markdown renderer; raw HTML is never executed.

## Development

```bash
node tools/check.js        # static checks (manifest, i18n, layout rules, module boundaries)
npm test                   # matcher, integration, service worker, ESM smoke, content load
bash deploy/deploy.sh      # checks + tests + zip + staging
```

`dev/seed-demo.html` generates demo data for the data page; it is excluded from the release package.

Repository: <https://github.com/Self-Identity/PageGloss>

