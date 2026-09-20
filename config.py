"""Ask AI Chat 插件的配置定义。"""

from __future__ import annotations

from typing import ClassVar

from src.core.components.base.config import (
    BaseConfig,
    Field,
    SectionBase,
    config_section,
)


class AskAIChatConfig(BaseConfig):
    """配置无头浏览器、网页 AI 反代目标、图片自动识别与工具行为。"""

    name: ClassVar[str] = "config"
    display_name: ClassVar[str] = "AI 网页反代与识图搜索配置"
    description: ClassVar[str] = "ask-ai-chat 插件配置"
    config_name: ClassVar[str] = "config"
    config_description: ClassVar[str] = "ask-ai-chat 插件配置"

    @config_section("plugin", title="插件设置", tag="plugin")
    class PluginSection(SectionBase):
        """插件总开关。"""

        enabled: bool = Field(
            default=True,
            description="是否启用 ask-ai-chat 插件",
            label="启用插件",
            tag="plugin",
        )

    @config_section("browser", title="无头浏览器设置", tag="general")
    class BrowserSection(SectionBase):
        """Node worker 与无头 Chromium 的运行参数。"""

        node_command: str = Field(
            default="node",
            description="Node.js 命令或绝对路径",
            label="Node 命令",
            tag="general",
        )
        mode: str = Field(
            default="launch",
            description="浏览器接入方式：launch=插件启动无头浏览器；connect=连接已开启远程调试端口的浏览器",
            label="接入方式",
            input_type="select",
            choices=["launch", "connect"],
            tag="general",
        )
        headless: bool = Field(
            default=True,
            description="launch 模式是否无头运行；如需登录网页 AI，可临时关闭并用同一浏览器配置目录完成登录",
            label="无头模式",
            tag="general",
        )
        cdp_url: str = Field(
            default="http://127.0.0.1:9222",
            description="connect 模式使用的 CDP 地址",
            label="CDP 地址",
            tag="network",
        )
        executable_path: str = Field(
            default="",
            description="launch 模式浏览器可执行文件路径；留空自动探测 Chrome/Edge/Brave",
            label="浏览器路径",
            tag="file",
        )
        user_data_dir: str = Field(
            default="",
            description="兼容旧配置的浏览器用户数据目录；留空时按 browser_profile_root/provider/login_profile 隔离保存",
            label="旧版用户数据目录",
            tag="file",
        )
        browser_profile_root: str = Field(
            default="",
            description="命名登录 profile 根目录；留空使用插件 data/browser_profiles，运行时数据不会打包",
            label="登录 profile 根目录",
            tag="file",
        )
        default_login_profile: str = Field(
            default="default",
            description="默认登录 profile 名称；不同账号请使用不同名称，profile 之间 Cookie 完全隔离",
            label="默认登录 profile",
            tag="advanced",
        )
        user_agent: str = Field(
            default="",
            description="自定义 User-Agent；留空时无头模式自动使用普通 Chrome UA 以降低被识别概率",
            label="User-Agent",
            tag="advanced",
        )
        window_width: int = Field(
            default=1440,
            description="无头视口宽度",
            label="视口宽度",
            ge=320,
            le=7680,
            tag="general",
        )
        window_height: int = Field(
            default=900,
            description="无头视口高度",
            label="视口高度",
            ge=240,
            le=4320,
            tag="general",
        )
        extra_args: list[str] = Field(
            default_factory=lambda: [
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            description="传给浏览器的额外启动参数",
            label="额外启动参数",
            tag="advanced",
        )
        default_timeout_ms: int = Field(
            default=30000,
            description="单个页面操作默认超时（毫秒）",
            label="页面操作超时",
            ge=1000,
            le=300000,
            tag="performance",
        )
        request_timeout_ms: int = Field(
            default=240000,
            description="单次 worker 请求总超时（毫秒），网页 AI 生成耗时较长建议保持较大值",
            label="请求总超时",
            ge=5000,
            le=600000,
            tag="performance",
        )
        auto_start_worker: bool = Field(
            default=False,
            description="插件加载后是否立即预热 Node worker（不会打开任何网页）",
            label="自动启动 worker",
            tag="advanced",
        )
        max_download_bytes: int = Field(
            default=20971520,
            description="通过浏览器下载文件时的体积上限（字节）",
            label="下载体积上限",
            ge=102400,
            le=104857600,
            tag="performance",
        )
        download_dir: str = Field(
            default="",
            description="下载文件保存目录；留空使用插件 data/downloads",
            label="下载目录",
            tag="file",
        )
        lens_retries: int = Field(
            default=3,
            description="Google 反搜触发 /sorry 风控时的重试次数（递增退避）；出口 IP 信誉波动时调大可提高成功率",
            label="反搜重试次数",
            ge=1,
            le=10,
            tag="advanced",
        )
        lens_request_gap_ms: int = Field(
            default=3000,
            description="两次 Google 反搜之间的最小间隔（毫秒），实际会附加 0~5 秒随机抖动模拟人工节奏（合计约 3~8 秒）；0 表示关闭",
            label="反搜请求间隔",
            ge=0,
            le=60000,
            tag="advanced",
        )

    @config_section("providers", title="网页 AI 反代设置", tag="general")
    class ProvidersSection(SectionBase):
        """豆包 / DeepSeek / Gemini 网页版反代参数。"""

        doubao_url: str = Field(
            default="https://www.doubao.com/chat/",
            description="豆包网页版入口地址",
            label="豆包地址",
            tag="network",
        )
        deepseek_url: str = Field(
            default="https://chat.deepseek.com/",
            description="DeepSeek 网页版入口地址",
            label="DeepSeek 地址",
            tag="network",
        )
        gemini_url: str = Field(
            default="https://gemini.google.com/app",
            description="Gemini 网页版入口地址",
            label="Gemini 地址",
            tag="network",
        )
        reply_timeout_ms: int = Field(
            default=180000,
            description="等待网页 AI 生成完整回复的超时（毫秒）",
            label="回复等待超时",
            ge=5000,
            le=600000,
            tag="performance",
        )
        poll_interval_ms: int = Field(
            default=1500,
            description="抓取回复时的轮询间隔（毫秒）",
            label="轮询间隔",
            ge=300,
            le=10000,
            tag="performance",
        )
        max_chars: int = Field(
            default=12000,
            description="抓取回复/搜索结果最多返回的字符数",
            label="内容字符上限",
            ge=500,
            le=200000,
            tag="performance",
        )
        default_model: str = Field(
            default="",
            description="网页 AI 默认模型；留空不修改站点当前模型（Gemini 支持 Flash/Pro 等，其他站点按能力探测）",
            label="默认模型",
            tag="advanced",
        )
        default_tier: str = Field(
            default="",
            description="网页 AI 默认档位；留空不修改站点当前档位",
            label="默认档位",
            tag="advanced",
        )
        default_deep_thinking: bool | None = Field(
            default=None,
            description="默认深度思考开关；留空不修改站点当前状态",
            label="默认深度思考",
            tag="advanced",
        )
        default_web_search: bool | None = Field(
            default=None,
            description="默认联网/搜索开关；留空不修改站点当前状态，站点不支持时返回 warning",
            label="默认联网搜索",
            tag="advanced",
        )
        session_max_count: int = Field(
            default=12,
            description="worker 内同时保留的网页 AI 会话（页面）数量上限，超出时按最久未使用关闭",
            label="会话数量上限",
            ge=1,
            le=64,
            tag="advanced",
        )
        history_max_count: int = Field(
            default=100,
            description="每个 provider/login profile 保留的本地历史元数据数量上限；只保存标题、ID、时间和设置快照，不保存 Cookie 或完整历史正文",
            label="历史数量上限",
            ge=10,
            le=1000,
            tag="advanced",
        )
        risk_cooldown_seconds: int = Field(
            default=60,
            description="网页 AI 触发验证码/异常流量后的单站点冷却时间（秒）",
            label="风控冷却时间",
            ge=10,
            le=3600,
            tag="security",
        )

    @config_section("auto", title="图片自动识别设置", tag="plugin")
    class AutoSection(SectionBase):
        """图片消息自动触发识图的行为。"""

        enabled: bool = Field(
            default=True,
            description="消息中携带图片时自动识别（接管模式下由本插件优先识图，失败回落框架内置 VLM）",
            label="启用图片自动识别",
            tag="plugin",
        )
        intercept_builtin: bool = Field(
            default=True,
            description=(
                "接管框架图片识别：由本插件优先识图（引擎见 vision_engine），"
                "结果写入消息描述并进入框架缓存；"
                "关闭后恢复旧并行模式（插件识图注入 reminder + 框架 VLM 各跑各的）"
            ),
            label="接管框架识图",
            tag="plugin",
        )
        vision_engine: str = Field(
            default="lens_first",
            description=(
                "识图引擎选择：lens_first=Google Lens 优先（失败依次回落网页 AI/框架内置 VLM，默认）；"
                "lens_vlm=Google Lens 优先，失败直接回落框架内置 VLM（不经过网页 AI）；"
                "web_ai_first=网页 AI 优先（失败回落 Lens/内置 VLM）；"
                "lens_only=仅 Google Lens（失败不回落，图片可能无描述但节省 VLM 调用）；"
                "web_ai_only=仅网页 AI（需先在下方选择网页 AI 识图通道，失败不回落）；"
                "builtin=完全使用框架内置 VLM，本插件不参与识图"
            ),
            label="识图引擎",
            input_type="select",
            choices=["lens_first", "lens_vlm", "web_ai_first", "lens_only", "web_ai_only", "builtin"],
            tag="plugin",
        )
        use_google_lens: bool = Field(
            default=True,
            description="（已废弃）识图通道由 vision_engine 统一选择；保留此字段仅为兼容旧配置文件，不再生效",
            label="使用 Google 反搜（已废弃）",
            tag="plugin",
        )
        vision_provider: str = Field(
            default="none",
            description="自动识图时额外使用的网页 AI：none/doubao/deepseek/gemini（需要对应网页已登录）",
            label="网页 AI 识图",
            input_type="select",
            choices=["none", "doubao", "deepseek", "gemini"],
            tag="plugin",
        )
        vision_prompt: str = Field(
            default="请详细描述这张图片：主体、文字（原文抄录）、品牌/角色/场景等可识别要素。",
            description="使用网页 AI 识图时发送的提示词",
            label="网页 AI 识图提示词",
            tag="plugin",
        )
        block_mode: bool = Field(
            default=True,
            description="识图期间暂缓消息进入聊天管线，确保 LLM 第一轮回复即可看到识图结果",
            label="阻塞等待识图",
            tag="advanced",
        )
        block_timeout_ms: int = Field(
            default=90000,
            description=(
                "单张图片识图的整体预算（毫秒）：接管模式下超时即回落内置 VLM，"
                "旧并行模式下超时注入失败说明并放行"
            ),
            label="识图预算",
            ge=5000,
            le=300000,
            tag="advanced",
        )
        reminder_ttl_seconds: int = Field(
            default=900,
            description="识图结果 reminder 的保留时长（秒），到期未消费会自动清理避免污染后续对话",
            label="结果保留时长",
            ge=60,
            le=86400,
            tag="advanced",
        )
        max_images_per_message: int = Field(
            default=2,
            description="单条消息最多自动识别的图片数量",
            label="单消息识图上限",
            ge=1,
            le=9,
            tag="performance",
        )
        min_image_bytes: int = Field(
            default=1024,
            description="小于该体积的图片（如小表情）跳过自动识别",
            label="最小识别体积",
            ge=0,
            le=1048576,
            tag="performance",
        )

    @config_section("tools", title="工具设置", tag="plugin")
    class ToolsSection(SectionBase):
        """LLM 工具暴露与结果大小设置。"""

        enabled: bool = Field(
            default=True,
            description="是否向 LLM 暴露 web_image_search / web_ai_chat 工具",
            label="启用工具",
            tag="plugin",
        )
        max_upload_bytes: int = Field(
            default=20971520,
            description="上传到网页 AI 的文件体积上限（字节）",
            label="上传体积上限",
            ge=10240,
            le=104857600,
            tag="performance",
        )

    @config_section("security", title="安全设置", tag="security")
    class SecuritySection(SectionBase):
        """服务端请求 URL 的 SSRF 防护。"""

        ssrf_check_mode: str = Field(
            default="hostname",
            description=(
                "URL 校验模式：hostname=校验协议/内网主机名/IP 字面量；"
                "strict=额外做 DNS 解析校验（TUN 代理 fake-IP 环境勿用）"
            ),
            label="SSRF 校验模式",
            input_type="select",
            choices=["hostname", "strict"],
            tag="security",
        )

    plugin: PluginSection = Field(default_factory=PluginSection)
    browser: BrowserSection = Field(default_factory=BrowserSection)
    providers: ProvidersSection = Field(default_factory=ProvidersSection)
    auto: AutoSection = Field(default_factory=AutoSection)
    tools: ToolsSection = Field(default_factory=ToolsSection)
    security: SecuritySection = Field(default_factory=SecuritySection)


__all__ = ["AskAIChatConfig"]
