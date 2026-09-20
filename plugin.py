"""Ask AI Chat 插件入口。"""

from __future__ import annotations

from typing import cast

from src.app.plugin_system.base import BasePlugin, register_plugin
from src.kernel.logger import get_logger

from . import WEB_AGENT_SERVICE_SIGNATURE
from .config import AskAIChatConfig
from .event_handler import ImageAutoRecognizeHandler, LensMediaRecognizeHandler
from .service import AskAIChatService, WebAgentController
from .tools import ALL_TOOLS

logger = get_logger("ask-ai-chat.plugin")


@register_plugin
class AskAIChatPlugin(BasePlugin):
    """无头浏览器网页 AI 反代与图片自动识别插件。"""

    plugin_name = "ask-ai-chat"
    plugin_description = (
        "无头浏览器驱动：Google Lens 以图搜图抓取结果；豆包/DeepSeek/Gemini 网页版反代；"
        "支持模型/档位/深度思考/联网能力探测、按标题历史续聊、命名登录 profile 与风险状态管理"
    )
    plugin_version = "1.0.0"
    plugin_author = "MoFox Team"
    configs: list[type] = [AskAIChatConfig]
    dependent_components: list[str] = []

    def __init__(self, config: AskAIChatConfig | None = None) -> None:
        """初始化共享无头浏览器控制器；构造阶段不启动任何进程。"""
        super().__init__(config)
        self.controller = WebAgentController(self)

    def get_components(self) -> list[type]:
        """返回服务、事件处理器与按配置启用的工具。"""
        config = cast(AskAIChatConfig, self.config) if self.config else None
        if config is not None and not config.plugin.enabled:
            return []
        components: list[type] = [
            AskAIChatService,
            LensMediaRecognizeHandler,
            ImageAutoRecognizeHandler,
        ]
        if config is None or config.tools.enabled:
            components.extend(ALL_TOOLS)
        return components

    async def on_plugin_loaded(self) -> None:
        """记录插件边界，按配置预热 worker 并清理过期临时文件。"""
        config = cast(AskAIChatConfig, self.config) if self.config else None
        if config is None or not config.plugin.enabled:
            logger.info("Ask AI Chat 已禁用")
            return
        logger.info(
            f"Ask AI Chat 已加载：无头模式={config.browser.headless}，"
            f"接管框架识图={config.auto.intercept_builtin}，"
            f"识图引擎={config.auto.vision_engine}，"
            f"识图自动触发={config.auto.enabled}，反搜重试={config.browser.lens_retries}"
        )
        self.controller.cleanup_tmp_dir(max_age_seconds=3600)
        if config.browser.auto_start_worker:
            try:
                await self.controller.request("status")
            except Exception as error:
                logger.warning(f"无头浏览器 worker 预热失败，可在首次调用时重试: {error}")

    async def on_plugin_unloaded(self) -> None:
        """取消后台识图任务并关闭 worker 与自启的无头浏览器。"""
        await ImageAutoRecognizeHandler.cancel_pending()
        await self.controller.shutdown()


__all__ = ["AskAIChatPlugin", "WEB_AGENT_SERVICE_SIGNATURE"]
