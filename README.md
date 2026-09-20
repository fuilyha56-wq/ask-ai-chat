# Ask AI Chat（AI 网页反代与识图搜索）

用**无头浏览器**把网页能力直接接进 MoFox：

- **Google 以图搜图**：走 Google 首页「按图搜索」（智能镜头）流程，抓回 **AI 概览**（Google AI 对图片的识别结论，如角色/物体/场景）、**外观匹配**（相似图片的来源页面与标题）、相似图与页面文本；可选 `full_ai=true` 额外抓取 Google AI 模式的完整回答。
- **接管框架识图**：图片消息默认由本插件**优先**识别（Google Lens → 网页 AI），插件识图失败自动回落框架内置 VLM——同一时刻只跑一条链路，结果写入消息描述并进入框架缓存，双模式可切。
- **网页版 AI 反代**：豆包 / DeepSeek / Gemini 网页版，**单次调用**完成「打开网页 → 上传图片/文件 → 发送提示词 → 等待生成 → 抓取回复」，结果直接写回 LLM 会话。
- **多轮持续对话**：传相同 `session_id` 即在同一聊天中继续，AI 记得之前的上下文。
- **登录态持久化**：登录一次长期有效，worker/浏览器重启无需重新登录。
- **文件下载与发送**：下载网络文件（共享浏览器 Cookie），可直接把文件/图片发送到当前聊天。
- **图片自动识图**：收到含图片的消息时**无需 LLM 决策**，插件自动下载并识别，结果直接注入 LLM 上下文。

## 安装

```powershell
cd .\neo-mofox\plugins\ask-ai-chat
npm install
```

然后在 MoFox 中启用 `ask-ai-chat` 插件。配置文件自动生成于 `config/plugins/ask-ai-chat/config.toml`。

依赖说明：worker 优先使用 `rebrowser-playwright`（修复 CDP 自动化检测特征，Google 等站点不会因此触发人机验证），不可用时自动回退 `playwright-core`，两者都在 `npm install` 时一并安装。

## 登录态持久化

所有网页（豆包/DeepSeek/Gemini/Google）的登录态都保存在浏览器用户数据目录：

- 新配置默认按 `data/browser_profiles/<provider>/<login_profile>/` 隔离；
- 旧 `browser.user_data_dir` 配置仍兼容；
- 目录持久存在 → Cookie/LocalStorage 跨重启保留，**登录一次长期有效**；
- `connect` 模式则直接使用你已登录的本机浏览器，无需额外登录；
- 如需更换账号：关闭 MoFox → 使用新的 `login_profile`，或确认后调用 `web_ai_session(action="logout", provider="...", confirm=true)` 清理指定 profile。

首次登录步骤：

1. 把 `browser.headless` 临时改为 `false`（或改用 `mode="connect"` 连接已登录的浏览器）；
2. 触发一次 `web_ai_chat`（或先调 `web_ai_session(action="login_check", provider=...)` 打开对应网页），手动完成登录；
3. 把 `headless` 改回 `true`。之后所有调用都在无头模式下复用该登录态。

## 工具（供 LLM 调用）

| 工具 | 作用 |
| --- | --- |
| `web_image_search` | Google 按图搜图（智能镜头）。支持 `image_url` / `image_base64`；不传时自动用当前消息里的图片。返回 AI 概览、外观匹配、相似图与页面文本；`full_ai=true` 额外抓 AI 模式完整回答（多花 3~6 秒）。 |
| `web_ai_chat` | 豆包/DeepSeek/Gemini 网页反代。支持 `provider`、`prompt`、上传文件、`session_id`/`conversation_title` 续聊，以及模型/档位/深度思考/联网参数；返回实际生效设置和风险状态。 |
| `web_file_download` | 下载文件（共享浏览器 Cookie）→ 保存到 `data/downloads` → 可选直接发送到当前聊天（图片走图片通道，其余走文件通道）。 |
| `web_ai_session` | 会话、能力、历史标题和登录 profile 管理：`list`/`close`/`close_all`、`capabilities`、`settings`、`history_list`/`history_get`/`history_resume`/`history_rename`/`history_delete`、`login_check`/`login_profiles`/`logout`。 |

### Google 反搜示例

```text
web_image_search(image_url="https://example.com/a.png")          # 基础：AI 概览 + 外观匹配 + 相似图
web_image_search(image_base64="...", full_ai=true)               # 额外抓取 AI 模式的完整识图回答
web_image_search()                                               # 不传图片 → 自动用当前消息里的图
```

返回内容按优先级排列：AI 概览（Google AI 的识别结论）→ 外观匹配（每条带来源与标题）→
概览引用链接 → AI 模式完整回答（可选）→ 相似图直链 → 结果页 URL。
AI 概览并非必然出现（未登录会话、纯色/无意义图常见缺失），此时外观匹配列表仍有效。

### 多轮持续对话

```text
web_ai_chat(provider="gemini", prompt="帮我写一首关于秋天的诗", session_id="poem-1")
web_ai_chat(provider="gemini", prompt="把第二句改得更婉约", session_id="poem-1")   # 延续同一对话
web_ai_chat(provider="gemini", prompt="再来一首关于雪的", session_id="poem-2")     # 另一个独立会话
web_ai_session(action="list")                                                     # 查看所有会话
web_ai_chat(provider="gemini", prompt="换个主题", session_id="poem-1", new_chat=true)  # 重置会话
```

- 每个 `session_id` 对应一张独立站点页面，对话轮数与页面 URL 可用 `web_ai_session` 查看；
- 会话数量有上限（`providers.session_max_count`，默认 12），超出按最久未使用关闭；
- worker 超时重启会丢掉会话页面，但**登录态不受影响**；下次传相同 `session_id` 会自动重建页面并在结果中提示"上下文已不在本页"；
- 回复超时不会销毁会话，下一轮可用同一 `session_id` 继续等待或追问。

### 网页 AI 设置与历史

`web_ai_chat` 现在支持按站点能力选择并验证：

- `model`：模型（Gemini 支持 Flash-Lite/Flash/Pro 等可见选项；不支持时返回 warning）
- `tier`：档位（DeepSeek `fast/expert`、豆包 `fast/super`，其他站点按能力探测）
- `deep_thinking`：深度思考开关
- `web_search`：联网/智能搜索开关（DeepSeek 支持独立开关；豆包可能与超能模式耦合；Gemini 不把 Deep Research 冒充普通联网）
- `deep_research`：Gemini Deep Research 独立开关（如果当前账号/页面提供）
- `conversation_title`：按历史标题恢复/续聊
- `login_profile`：命名登录 profile，不同账号相互隔离

未传设置参数时不会扰动网页当前状态；页面无法确认切换结果时返回 warning，不会虚报已经生效。返回中包含 `requested_settings`、`effective_settings`、`settings_warnings` 与 `risk_state`。

`web_ai_session` 管理动作：

- `capabilities`：探测当前站点登录状态、模型/档位/深度思考/联网/历史能力；
- `settings`：单独应用并验证网页设置；
- `history_list` / `history_get` / `history_resume`：按标题查看、读取摘要、恢复历史会话；
- `history_rename` / `history_delete`：管理插件本地历史元数据（删除需要 `confirm=true`，不会强行删除站点原生历史）；
- `login_profiles`：列出 provider 的命名登录 profile；
- `logout`：清理指定 profile（必须 `confirm=true`，不可逆）。

历史元数据只保存 provider、标题、原生会话 ID（如果页面能读到）、时间、设置快照和短摘要索引，保存在运行时 `data/` 下，不打包、不写入 Git，不保存 Cookie 或完整历史正文。

### 登录态隔离与风险状态

默认 profile 路径为 `data/browser_profiles/<provider>/<login_profile>/`；旧 `browser.user_data_dir` 配置仍兼容。登录 profile 使用普通持久化浏览器上下文复用 Cookie/LocalStorage，不硬编码 token。不同账号必须使用不同 `login_profile`，同一 profile 不应被多个浏览器进程同时占用。

worker 会区分 `logged_in`、`login_required`、`captcha_required`、`region_banned`、`unknown`，并对验证码/异常流量设置 provider 风险状态和冷却。风控只检测、停止并提示人工处理，不自动绕过验证码。所有服务端 URL 仍只允许 http/https，发请求前校验 host，拒绝 localhost、环回、私有和保留地址；provider URL 也按站点 host 白名单校验。
## 图片自动识图（无需工具调用）

支持两种模式，由 `auto.intercept_builtin` 切换：

### 接管模式（默认，`intercept_builtin=true`）

`LensMediaRecognizeHandler` 订阅框架的 `ON_MEDIA_RECOGNIZE` 媒体识别事件
（weight=10，高于内置 VLM 回调的 priority=0），识图引擎由 **`auto.vision_engine`** 选择：

| 取值 | 行为 |
| --- | --- |
| `lens_first`（默认） | Google Lens 优先 → 失败回落网页 AI → 再失败回落框架内置 VLM |
| `lens_vlm` | Google Lens 优先 → 失败**直接**回落框架内置 VLM（跳过网页 AI） |
| `web_ai_first` | 网页 AI 优先（需配置 `auto.vision_provider`）→ 失败回落 Lens → 再失败回落内置 VLM |
| `lens_only` | 仅 Google Lens；失败不回落（图片可能无描述，但完全不消耗 VLM 调用） |
| `web_ai_only` | 仅网页 AI；失败不回落。需先在 `auto.vision_provider` 选择通道，未配置时放行给内置 VLM |
| `builtin` | 完全使用框架内置 VLM，本插件不参与识图 |

执行流程：

1. 框架收到含图消息时对每张图发布媒体识别事件，**本插件优先拦截**，
   按所选引擎依次尝试识图通道；
2. 识图成功 → 回写 `description` 并标记 `engine_processed`，**框架内置 VLM 直接跳过**，
   不再重复识图；结果由框架写入消息的 `[图片(hash):description]` 占位符，
   并进入框架媒体描述缓存（同一张图再次出现直接命中缓存，零识图成本）；
3. 带回落的引擎（`lens_first` / `lens_vlm` / `web_ai_first`）全部失败
   （超时/风控/空结果）→ 放行事件，**框架内置 VLM 自动兜底**；
   `*_only` 引擎失败 → 标记 `skip_engine` 阻止内置 VLM，图片保持无描述；
4. 失败短缓存：同一张图识图失败后 5 分钟内不再重撞所选引擎，直接按上述回落规则处理。

### 并行模式（`intercept_builtin=false`，旧行为）

`ImageAutoRecognizeHandler` 订阅 `on_message_received`，插件识图与框架 VLM
**并行**，结果以流级 system reminder（bucket=`actor`，dynamic + once，TTL 自动清理）
注入该会话，`auto.block_mode=true` 时识图完成前暂缓消息进入聊天管线。

配置项（`config.toml` 的 `[auto]`）可关闭自动识图、选择识图引擎（`vision_engine`）、
切换识图通道、调整识图预算（接管模式下即回落 VLM 的超时线）与单消息识图上限。

## Google 反搜实现说明

主流程（2026-09 实测验证）：Google 首页 `?hl=zh-CN` → 点「按图搜索」→ 智能镜头对话框
（隐藏 `input[type=file]` 直接注入，`filechooser` 事件兜底）→ 自动跳转结果页
（`/search?...vsrid=`）→ 等 AI 概览流式生成稳定（文本长度两次采样不变）→
结构化提取 AI 概览正文/引用链接、外观匹配（h3 + `/goto` 跳转锚点）、相似图缩略图。

可靠性设计：

- **地区钉定**：打开结果页前先请求 `google.com/ncr`（no country redirect）。部分代理出口会被
  Google 302 到 `google.com.hk` 等地区域名，其下 Lens 结果页必触发 `/sorry` 风控，且 AI 概览
  不支持香港；钉在 google.com 后实测畅通；
- **UA 一致性**：无头模式自动探测真实 UA → 剥掉 `Headless` 标记 → 同品牌同版本重启，
  保证 HTTP UA / JS UA / Client-Hints 三者一致，不被一致性风控识别；
- **风控退避**：触发 `/sorry` 时进入 60 秒冷却并按递增退避重试（`browser.lens_retries`，默认 3）；
- **拟人间隔**：两次反搜之间强制间隔 `browser.lens_request_gap_ms` + 0~5 秒随机抖动
  （默认合计约 3~8 秒）；
- **自动降级**：主流程结构性失败（按钮/对话框改版等）自动降级到 `lens.google.com` 直传流程，
  结果带 `fallback_reason` 字段说明降级原因；
- **失败截图**：异常时自动截图到 `data/debug/`（保留 7 天）便于排查；
- **AI 概览等待**：AI 概览流式生成约 8~15 秒；15 秒内页面始终没有「AI 概览」标签则提前放弃，
  直接提取外观匹配，不白等满 60 秒。

已知限制：外观匹配的链接是 Google `/goto?url=` 加密跳转（点击后回到 Lens 单结果视图，
不直接落到外部页面），`visual_matches` 中的 `title`/`source` 文本可直接引用；
需要访问落地页时由 LLM 决定是否继续跟进。

## 服务（供其他插件复用）

签名 `ask-ai-chat:service:web_agent`，`await service.request(action, params)` 支持：

- `status` / `launch` / `connect`：无头浏览器会话管理；
- `lens_search`：`{image_path|image_b64, full_ai?, lens_gap_ms?}` → AI 概览 + 外观匹配 +
  相似图 + 页面文本（`flow` 字段标明 `homepage` 主流程 / `legacy` 降级流程）；
- `web_ai_chat`：`{provider, prompt, image_path?, session_id?, conversation_title?, model?, tier?, deep_thinking?, web_search?, deep_research?, login_profile?}` → 回复文本 + 会话信息 + 实际设置 + 风险状态 + 回复内链接/图片；
- `fetch_binary`：`{url}` → 经浏览器会话下载文件（共享 Cookie、绕过 CORS），返回 base64；
- `session_list` / `session_close` / `login_check`：会话与登录状态管理。

## 安全边界

- 所有服务端请求的 URL 仅允许 http/https；下载 LLM/用户提供文件前会做 host 校验，拒绝 localhost、环回、私网与保留地址（SSRF 防护）。
- 浏览器全程无头（可临时关闭用于登录），不会截取桌面或其他窗口。
- 登录态保存在插件 `data/browser_profile`，请勿提交到公开仓库或写入日志。
- `fetch_binary` 有协议、内网地址与体积上限三重限制。

## 常见问题

- **`无法加载 rebrowser-playwright / playwright-core`**：在本插件目录执行 `npm install`。
- **`未找到本机 Chrome/Edge/Brave`**：填写 `browser.executable_path`，或 `mode="connect"` + CDP。
- **Google 触发人机验证（/sorry）**：worker 已使用 `rebrowser-playwright` 驱动且结果页前会先请求
  `/ncr` 钉定地区，正常不会再触发；若仍出现，多为代理出口 IP 信誉问题，请在代理中为 Google
  域名更换节点或直连，或用同一 `user_data_dir` 登录 Google 提升信任。
- **AI 概览为空**：未登录会话或图片内容过于模糊时，Google 可能不生成 AI 概览，此时外观匹配
  列表仍然有效；登录 Google 可提高 AI 概览出现率。可在反搜冷却期后重试。
- **网页 AI 提示未登录**：先用 `web_ai_session(action="login_check", provider="...", login_profile="...")` 确认；不同账号使用不同命名 profile，再按“首次登录”流程处理。
- **模型/开关不可用**：先调用 `web_ai_session(action="capabilities", provider="...")` 查看当前账号/站点实际能力；插件不会把推测 selector 当成成功，也不会把 Gemini Deep Research 冒充普通联网搜索。
- **豆包提示地区限制**：当前代理出口 IP 被豆包封锁，请更换代理节点。
- **搜索/回复抓取为空**：站点改版或风控；可调大 `providers.reply_timeout_ms`，或在配置中更换 User-Agent。

## 许可证

本项目基于 [AGPL-3.0](LICENSE) 协议开源。
