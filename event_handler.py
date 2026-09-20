"""图片识图事件处理器。

本模块提供两条识图链路，由 ``auto.intercept_builtin`` 切换：

- ``LensMediaRecognizeHandler``（默认）：订阅 ``ON_MEDIA_RECOGNIZE``，在框架
  媒体识别链上**优先接管**图片识别（识图引擎由 ``auto.vision_engine`` 选择：
  Lens/网页 AI 优先或仅用其一，失败可回落内置 VLM），成功则回写
  description 并标记 engine_processed，框架内置 VLM 跳过。识别结果经框架
  统一写入消息的 ``[图片(hash):description]`` 占位符并进入媒体描述缓存。
- ``ImageAutoRecognizeHandler``（旧行为，``intercept_builtin=false`` 时启用）：
  订阅 ``ON_MESSAGE_RECEIVED``，插件识图与框架 VLM **并行**，结果以流级
  system reminder（bucket=actor, dynamic+once）注入 LLM 上下文。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from src.app.plugin_system.api import prompt_api
from src.app.plugin_system.base import BaseEventHandler
from src.app.plugin_system.types import EventType, Message
from src.core.prompt import (
    SystemReminderBucket,
    SystemReminderConsumeType,
    SystemReminderInsertType,
)
from src.kernel.event import EventDecision
from src.kernel.logger import get_logger

from .tools import _format_lens_result

logger = get_logger("ask-ai-chat.auto")

_PROVIDER_LABEL = {"doubao": "豆包", "deepseek": "DeepSeek", "gemini": "Gemini"}

# 拦截模式下写入消息描述的最大长度（描述会进入聊天历史与框架缓存，需控制体积）
_INTERCEPT_DESCRIPTION_MAX_CHARS = 4000


class LensMediaRecognizeHandler(BaseEventHandler):
    """接管框架图片识别：识图引擎由 ``auto.vision_engine`` 选择。

    订阅 ``ON_MEDIA_RECOGNIZE``（weight=10，高于内置 VLM 回调的 priority=0）：
    按 ``lens_first / lens_vlm / web_ai_first / lens_only / web_ai_only / builtin``
    选择识图引擎——任一插件引擎成功即回写 ``description`` 与
    ``engine_processed=True``（内置 VLM 回调看到后直接 PASS，不再重复识图）；
    ``lens_first / lens_vlm / web_ai_first`` 引擎全部失败时返回 PASS，
    框架内置 VLM 照常兜底（lens_vlm 的插件通道只有 Lens，失败直达 VLM）；
    ``*_only`` 引擎失败时标记 ``skip_engine`` 阻止内置 VLM（图片保持无描述，
    节省 VLM 调用）；``builtin`` 完全交回框架。识别结果由框架写回消息占位符
    并进入媒体描述缓存（同一张图后续命中缓存，不再发起任何识图请求）。
    """

    name = "lens_media_recognize"
    description = "接管框架图片识别：识图引擎可选（Lens/网页 AI 优先或仅用其一/框架内置 VLM）"
    weight = 10  # 高于内置 VLM 回调（priority=0），先拦截
    intercept_message = False
    timeout = 0  # 识图可能超过 30s，禁用订阅者级超时（预算由 auto.block_timeout_ms 控制）
    init_subscribe = [EventType.ON_MEDIA_RECOGNIZE]

    # 类级共享：并发闸门 / 失败短缓存（防冷却期内同一张图反复撞 Google/网页 AI）
    _semaphore: asyncio.Semaphore | None = None
    _recent_failures: dict[str, float] = {}
    _FAILURE_COOLDOWN = 300.0

    async def execute(
        self, event_name: str, params: dict[str, Any]
    ) -> tuple[EventDecision, dict[str, Any]]:
        """尝试用插件识图接管本次媒体识别；失败时按所选引擎决定回落或阻断。"""
        # 只拦图片的 VLM 识别；语音/视频/表情包交回框架处理
        if str(params.get("engine") or "") != "vlm":
            return EventDecision.PASS, params
        if str(params.get("media_type") or "") != "image":
            return EventDecision.PASS, params
        # 已被更高优先级处理器识别 / 上层明确要求跳过引擎 → 不抢
        if (
            params.get("description")
            or params.get("engine_processed")
            or params.get("skip_engine")
        ):
            return EventDecision.PASS, params

        plugin = getattr(self, "plugin", None)
        auto = getattr(getattr(plugin, "config", None), "auto", None)
        if auto is None or not bool(getattr(auto, "enabled", False)):
            return EventDecision.PASS, params
        if not bool(getattr(auto, "intercept_builtin", True)):
            return EventDecision.PASS, params

        engine = self._normalize_engine(getattr(auto, "vision_engine", None))
        if engine == "builtin":
            # 用户明确选择框架内置 VLM，插件不接管
            return EventDecision.PASS, params
        channels = self._engine_channels(engine, auto)
        if not channels:
            logger.warning(
                f"识图引擎为 {engine} 但没有可用通道（web_ai_only 需在 auto.vision_provider 选择网页 AI），"
                "交回框架内置 VLM"
            )
            return EventDecision.PASS, params

        base64_data = params.get("base64_data")
        if not isinstance(base64_data, str) or not base64_data:
            return EventDecision.PASS, params
        min_bytes = int(getattr(auto, "min_image_bytes", 1024))
        if len(base64_data) * 3 // 4 < min_bytes:
            return EventDecision.PASS, params

        controller = getattr(plugin, "controller", None)
        if controller is None:
            return EventDecision.PASS, params

        # 失败短缓存：冷却期内同一张图不再重撞 Google/网页 AI
        media_hash = str(params.get("media_hash") or "") or str(hash(base64_data))
        now = time.time()
        last_failed_at = self._recent_failures.get(media_hash, 0)
        if last_failed_at and now - last_failed_at < self._FAILURE_COOLDOWN:
            return self._plugin_failed_result(params, engine)

        budget_ms = int(getattr(auto, "block_timeout_ms", 90000))
        if LensMediaRecognizeHandler._semaphore is None:
            LensMediaRecognizeHandler._semaphore = asyncio.Semaphore(2)

        async with LensMediaRecognizeHandler._semaphore:
            description = await self._recognize(
                controller, auto, base64_data, channels, budget_ms
            )

        if description:
            self._recent_failures.pop(media_hash, None)
            if len(self._recent_failures) > 256:
                cutoff = time.time() - self._FAILURE_COOLDOWN
                LensMediaRecognizeHandler._recent_failures = {
                    key: failed_at
                    for key, failed_at in self._recent_failures.items()
                    if failed_at > cutoff
                }
            params["description"] = description
            params["engine_processed"] = True
            logger.info(
                f"插件接管识图成功（{len(description)} 字符），内置 VLM 已跳过: "
                f"{media_hash[:8]}..."
            )
            return EventDecision.SUCCESS, params

        self._recent_failures[media_hash] = time.time()
        return self._plugin_failed_result(params, engine)

    def _plugin_failed_result(
        self, params: dict[str, Any], engine: str
    ) -> tuple[EventDecision, dict[str, Any]]:
        """插件识图失败后的决策：仅插件引擎 → 阻断内置 VLM；其余 → 回落。"""
        if engine in ("lens_only", "web_ai_only"):
            # 用户明确选择仅用插件引擎：标记 skip_engine 阻止内置 VLM 兜底，
            # 图片保持无描述（节省 VLM 调用）
            logger.info(f"插件识图失败且引擎为 {engine}，内置 VLM 已按配置跳过")
            params["skip_engine"] = True
            return EventDecision.SUCCESS, params
        logger.info("插件识图失败，回落框架内置 VLM")
        return EventDecision.PASS, params

    @staticmethod
    def _normalize_engine(value: Any) -> str:
        """归一化引擎名，非法值回退默认 lens_first。"""
        engine = str(value or "").strip().lower()
        if engine in (
            "lens_first",
            "lens_vlm",
            "web_ai_first",
            "lens_only",
            "web_ai_only",
            "builtin",
        ):
            return engine
        return "lens_first"

    @staticmethod
    def _engine_channels(engine: str, auto: Any) -> list[str]:
        """按所选引擎展开有序识图通道（"lens" / "web_ai"，靠前者优先）。"""
        provider = str(getattr(auto, "vision_provider", "none") or "none").lower()
        has_web = provider in _PROVIDER_LABEL
        if engine == "web_ai_first":
            return (["web_ai"] if has_web else []) + ["lens"]
        if engine in ("lens_only", "lens_vlm"):
            # lens_vlm 失败后直接回落内置 VLM（不走网页 AI），通道里只有 Lens
            return ["lens"]
        if engine == "web_ai_only":
            return ["web_ai"] if has_web else []
        # lens_first（默认）：Lens 优先，网页 AI 次之
        return ["lens"] + (["web_ai"] if has_web else [])

    async def _recognize(
        self,
        controller: Any,
        auto: Any,
        base64_data: str,
        channels: list[str],
        budget_ms: int,
    ) -> str:
        """按通道顺序识图（靠前者优先），全部失败返回空串。"""
        temp_path = ""
        try:
            temp_path = str(controller.save_temp_file(data_b64=base64_data))
            for channel in channels:
                if channel == "lens":
                    try:
                        result = await controller.request(
                            "lens_search", {"image_path": temp_path}, timeout_ms=budget_ms
                        )
                        text = _format_lens_result(result).strip()
                        if text and text != "(Google 未返回可读内容)":
                            description = f"Google Lens 反搜结果:\n{text}"
                            if len(description) > _INTERCEPT_DESCRIPTION_MAX_CHARS:
                                description = (
                                    description[:_INTERCEPT_DESCRIPTION_MAX_CHARS]
                                    + "\n…（识图结果过长已截断）"
                                )
                            return description
                        logger.warning("Lens 返回空结果，尝试下一识图通道")
                    except Exception as error:
                        logger.warning(f"Lens 拦截识图失败: {error}")
                elif channel == "web_ai":
                    provider = str(
                        getattr(auto, "vision_provider", "none") or "none"
                    ).lower()
                    try:
                        result = await controller.request(
                            "web_ai_chat",
                            {
                                "provider": provider,
                                "prompt": str(
                                    getattr(auto, "vision_prompt", "请详细描述这张图片")
                                ),
                                "image_path": temp_path,
                                "new_chat": True,
                            },
                            timeout_ms=budget_ms,
                        )
                        reply = str(result.get("reply") or "").strip()
                        if reply:
                            return f"{_PROVIDER_LABEL[provider]} 识图结果:\n{reply}"
                        logger.warning(
                            f"{_PROVIDER_LABEL[provider]} 返回空回复，尝试下一识图通道"
                        )
                    except Exception as error:
                        logger.warning(f"{_PROVIDER_LABEL[provider]} 拦截识图失败: {error}")
            return ""
        finally:
            if temp_path:
                controller.cleanup_file(temp_path)


class ImageAutoRecognizeHandler(BaseEventHandler):
    """图片消息自动识图并注入 reminder（并行模式，``intercept_builtin=false`` 时生效）。

    订阅 ``ON_MESSAGE_RECEIVED``（weight 高于消息分发器）：消息携带图片时，
    插件自行用无头浏览器完成 Google 反搜 / 网页 AI 识图（与框架内置 VLM
    **并行**），并把结果以流级 system reminder（bucket=actor, dynamic+once）
    注入 LLM 上下文。默认的接管模式下本处理器不工作（识图由
    :class:`LensMediaRecognizeHandler` 在媒体识别链上完成并写入消息描述）。
    """

    name = "image_auto_recognize"
    description = "并行模式：检测图片消息并自动完成识图/反搜，结果直接注入 LLM 上下文"
    # 高于消息分发器（priority=0）的默认权重：识图完成后才放行消息进入聊天管线
    weight = 20
    intercept_message = False
    timeout = 0  # 识图可能超过 30s，禁用订阅者级超时保护
    init_subscribe = [EventType.ON_MESSAGE_RECEIVED]

    # 类级共享：并发闸门 / 去重缓存 / TTL 清理任务
    _semaphore: asyncio.Semaphore | None = None
    _recent_images: dict[str, float] = {}
    _cleanup_tasks: set[asyncio.Task] = set()

    async def execute(
        self, event_name: str, params: dict[str, Any]
    ) -> tuple[EventDecision, dict[str, Any]]:
        """识别图片消息；无论成功失败都不阻断事件链。"""
        # 接管模式下识图已由 LensMediaRecognizeHandler 在媒体识别链上完成，
        # 结果写在消息的 [图片(hash):description] 占位符里，不再重复识图注入；
        # 引擎选为 builtin 时插件同样不参与识图
        plugin = getattr(self, "plugin", None)
        auto = getattr(getattr(plugin, "config", None), "auto", None)
        if auto is None:
            return EventDecision.SUCCESS, params
        if bool(getattr(auto, "intercept_builtin", True)):
            return EventDecision.SUCCESS, params
        if LensMediaRecognizeHandler._normalize_engine(
            getattr(auto, "vision_engine", None)
        ) == "builtin":
            return EventDecision.SUCCESS, params

        message = params.get("message")
        if not isinstance(message, Message):
            return EventDecision.SUCCESS, params

        plugin = getattr(self, "plugin", None)
        config = getattr(plugin, "config", None)
        if config is None or not getattr(getattr(config, "auto", None), "enabled", False):
            return EventDecision.SUCCESS, params

        images = self._extract_images(message)
        if not images:
            return EventDecision.SUCCESS, params

        limit = int(getattr(config.auto, "max_images_per_message", 2))
        min_bytes = int(getattr(config.auto, "min_image_bytes", 1024))
        selected = [
            item for item in images
            if len(str(item.get("data") or "")) * 3 // 4 >= min_bytes
        ][:limit]
        if not selected:
            return EventDecision.SUCCESS, params

        stream_id = str(getattr(message, "stream_id", "") or "")
        if not stream_id:
            return EventDecision.SUCCESS, params

        # 同一张图短时间去重（QQ 端转发/重发会复用同一 base64）
        fresh: list[dict[str, Any]] = []
        now = time.time()
        for item in selected:
            key = str(item.get("image_id") or hash(item.get("data")))[:64]
            last_seen = self._recent_images.get(key, 0)
            if now - last_seen < 300:
                continue
            self._recent_images[key] = now
            fresh.append({**item, "_dedupe_key": key})
        # 清理过期去重记录
        if len(self._recent_images) > 512:
            cutoff = now - 3600
            self._recent_images = {
                key: seen for key, seen in self._recent_images.items() if seen > cutoff
            }
        if not fresh:
            return EventDecision.SUCCESS, params

        if bool(getattr(config.auto, "block_mode", True)):
            # 阻塞模式：识图完成后再放行，确保本轮 LLM 请求即可看到结果
            try:
                await self._recognize_all(plugin, message, fresh)
            except Exception as error:
                logger.warning(f"图片自动识图失败: {error}")
        else:
            task = asyncio.create_task(self._recognize_all(plugin, message, fresh))
            self._cleanup_tasks.add(task)
            task.add_done_callback(self._cleanup_tasks.discard)
        return EventDecision.SUCCESS, params

    # ── 识图与注入 ──────────────────────────────────────────────

    async def _recognize_all(self, plugin: Any, message: Message, images: list[dict[str, Any]]) -> None:
        """逐张识图并把结果写入流级 reminder。"""
        config = plugin.config
        stream_id = str(message.stream_id)
        if ImageAutoRecognizeHandler._semaphore is None:
            ImageAutoRecognizeHandler._semaphore = asyncio.Semaphore(2)
        semaphore = ImageAutoRecognizeHandler._semaphore

        async with semaphore:
            sections: list[str] = []
            for index, item in enumerate(images, start=1):
                try:
                    section = await self._recognize_one(plugin, item)
                except Exception as error:
                    # 识别失败不注入，避免把错误文案当结果喂给 LLM
                    logger.warning(f"第 {index} 张图片识图失败（已跳过注入）: {error}")
                    continue
                if section.strip():
                    sections.append(f"▍图片{index}\n{section}")

        if not sections:
            # 全部失败：不写入任何 reminder，LLM 仍可使用核心 VLM 的图片描述
            logger.info(f"图片识图全部失败，跳过注入（{len(images)} 张）: stream={stream_id}")
            return

        content = self._build_reminder_content(message, sections)
        dedupe_key = str(images[0].get("_dedupe_key", "")) or f"{int(time.time())}"
        name = f"ask_ai_chat:image:{dedupe_key[:16]}"
        try:
            # 注意：必须传枚举的 .value 字符串。Python 3.11 下 f-string 会把
            # (str, Enum) 渲染成 "SystemReminderBucket.ACTOR"，导致 bucket key
            # 与 chatter 拾取的 "actor" 不一致，注入永远到不了 LLM。
            prompt_api.add_stream_reminder(
                stream_id=stream_id,
                bucket=SystemReminderBucket.ACTOR.value,
                name=name,
                content=content,
                insert_type=SystemReminderInsertType.DYNAMIC.value,
                consume=SystemReminderConsumeType.ONCE.value,
            )
        except Exception as error:
            logger.warning(f"写入识图 reminder 失败: {error}")
            return
        ttl = int(getattr(config.auto, "reminder_ttl_seconds", 900))
        task = asyncio.create_task(self._expire_reminder(stream_id, name, ttl))
        self._cleanup_tasks.add(task)
        task.add_done_callback(self._cleanup_tasks.discard)
        logger.info(f"图片识图结果已注入会话 {stream_id}（{len(images)} 张）")

    async def _recognize_one(self, plugin: Any, item: dict[str, Any]) -> str:
        """对单张图片按所选引擎识图，返回结果文本。"""
        config = plugin.config
        controller = plugin.controller
        engine = LensMediaRecognizeHandler._normalize_engine(
            getattr(config.auto, "vision_engine", None)
        )
        channels = LensMediaRecognizeHandler._engine_channels(engine, config.auto)
        parts: list[str] = []

        temp_path = ""
        try:
            temp_path = str(controller.save_temp_file(data_b64=str(item.get("data"))))
            for channel in channels:
                if channel == "lens":
                    try:
                        result = await controller.request(
                            "lens_search", {"image_path": temp_path}
                        )
                        parts.append(
                            "Google Lens 反搜结果:\n" + _format_lens_result(result)
                        )
                    except Exception as error:
                        logger.warning(f"Lens 识图失败: {error}")
                elif channel == "web_ai":
                    provider = str(
                        getattr(config.auto, "vision_provider", "none") or "none"
                    ).lower()
                    try:
                        result = await controller.request(
                            "web_ai_chat",
                            {
                                "provider": provider,
                                "prompt": str(
                                    getattr(config.auto, "vision_prompt", "请描述这张图片")
                                ),
                                "image_path": temp_path,
                                "new_chat": True,
                            },
                        )
                        parts.append(
                            f"{_PROVIDER_LABEL[provider]} 识图结果:\n"
                            f"{str(result.get('reply') or '').strip()}"
                        )
                    except Exception as error:
                        logger.warning(f"{_PROVIDER_LABEL[provider]} 识图失败: {error}")
        finally:
            if temp_path:
                controller.cleanup_file(temp_path)
        return "\n\n".join(part for part in parts if part.strip()).strip()

    async def _expire_reminder(self, stream_id: str, name: str, ttl_seconds: int) -> None:
        """TTL 到期后清理仍未被消费的 reminder，避免污染后续对话。"""
        try:
            await asyncio.sleep(max(60, ttl_seconds))
            deleted = prompt_api.delete_stream_reminder(stream_id, "actor", name)
            if deleted:
                logger.debug(f"识图 reminder 超时未消费，已清理: {name}")
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.debug(f"清理识图 reminder 失败: {error}")

    def _build_reminder_content(self, message: Message, sections: list[str]) -> str:
        """组装注入 LLM 的识图报告。"""
        user_text = str(message.processed_plain_text or message.content or "").strip()
        user_text = user_text[:200] or "（无文字）"
        header = (
            "[系统注入 | 图片自动识别结果]\n"
            f"用户在消息中发送了图片，其中 {len(sections)} 张完成自动识别（用户附言: {user_text}）。"
            "以下是插件无头浏览器自动完成的识别结果，可直接引用作答，无需再调用任何识图工具：\n"
        )
        footer = (
            "\n[注入结束] 如果以上结果与用户问题无关或已过时，请忽略；"
            "需要更深入分析时可调用 web_image_search 或 web_ai_chat 工具。"
        )
        return header + "\n\n".join(sections) + footer

    @staticmethod
    def _extract_images(message: Message) -> list[dict[str, Any]]:
        """从消息 content / extra 中提取带原始数据的图片列表。"""
        items: list[dict[str, Any]] = []

        def collect(candidate: Any) -> None:
            if isinstance(candidate, list):
                for entry in candidate:
                    if (
                        isinstance(entry, dict)
                        and entry.get("type") == "image"
                        and entry.get("data")
                    ):
                        items.append(entry)

        content = getattr(message, "content", None)
        if isinstance(content, dict):
            collect(content.get("media"))
        extra = getattr(message, "extra", None)
        if isinstance(extra, dict):
            collect(extra.get("media"))
        return items

    @classmethod
    async def cancel_pending(cls) -> None:
        """取消所有未完成的后台任务（插件卸载时调用）。"""
        tasks = set(cls._cleanup_tasks)
        cls._cleanup_tasks.clear()
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


__all__ = ["ImageAutoRecognizeHandler", "LensMediaRecognizeHandler"]
