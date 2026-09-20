"""Ask AI Chat 的 MoFox Tool 组件。

设计目标：把“打开网页 → 上传文件 → 提问 → 等待 → 抓取回复”的繁琐多步
压缩为单次工具调用，结果文本直接写回 LLM 会话，无需二次抓取。
同时支持同一网页 AI 会话的多轮持续对话、文件下载与直接发送到聊天。
"""

from __future__ import annotations

import base64
import json
import re
from typing import Annotated, Any, Literal

import httpx
from src.app.plugin_system.api import service_api
from src.app.plugin_system.base import BaseTool
from src.kernel.logger import get_logger

from . import WEB_AGENT_SERVICE_SIGNATURE
from .config import AskAIChatConfig
from .service import AskAIChatError
from .url_guard import UnsafeURLError, validate_public_http_url

ToolResult = tuple[bool, str | dict[str, Any]]

logger = get_logger("ask-ai-chat.tools")

_PROVIDER_LABEL = {"doubao": "豆包", "deepseek": "DeepSeek", "gemini": "Gemini"}


def _get_config(tool: BaseTool) -> AskAIChatConfig:
    """获取工具所属插件的配置。"""
    config = getattr(tool.plugin, "config", None)
    if isinstance(config, AskAIChatConfig):
        return config
    return AskAIChatConfig()


def _get_service() -> Any:
    """获取共享无头浏览器服务。"""
    service = service_api.get_service(WEB_AGENT_SERVICE_SIGNATURE)
    if service is None:
        raise AskAIChatError("网页反代服务未注册，请确认 ask-ai-chat 插件已启用")
    return service


async def _download_url_bytes(
    url: str,
    *,
    max_bytes: int,
    ssrf_mode: str = "hostname",
) -> bytes:
    """校验并下载图片/文件（仅 http/https 公网地址）。"""
    validated = validate_public_http_url(url, mode=ssrf_mode)
    async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
        response = await client.get(validated)
        response.raise_for_status()
        content = response.content
    if len(content) > max_bytes:
        raise AskAIChatError(f"文件超过体积上限 {max_bytes} 字节")
    if not content:
        raise AskAIChatError("下载到的内容为空")
    return content


def _extract_trigger_image_base64(tool: BaseTool) -> str | None:
    """从触发消息中提取第一张图片的 base64。"""
    message = tool.trigger_message
    if message is None:
        return None
    extra = getattr(message, "extra", {}) or {}
    if not isinstance(extra, dict):
        return None
    for item in extra.get("media", []) or []:
        if isinstance(item, dict) and item.get("type") == "image" and item.get("data"):
            return str(item["data"])
    return None


async def _resolve_upload_file(
    tool: BaseTool,
    *,
    url: str | None,
    base64_data: str | None,
    use_trigger_image: bool,
    max_bytes: int,
    ssrf_mode: str = "hostname",
    suffix_hint: str | None = None,
) -> tuple[str, bool]:
    """统一解析上传来源（URL / base64 / 触发消息图片），返回 (临时文件路径, 是否需清理)。"""
    service = _get_service()
    controller = service.controller
    if base64_data:
        path = controller.save_temp_file(data_b64=base64_data, suffix=suffix_hint)
        return str(path), True
    if url:
        data = await _download_url_bytes(url, max_bytes=max_bytes, ssrf_mode=ssrf_mode)
        path = controller.save_temp_file(raw=data, suffix=suffix_hint)
        return str(path), True
    if use_trigger_image:
        trigger_b64 = _extract_trigger_image_base64(tool)
        if trigger_b64:
            path = controller.save_temp_file(data_b64=trigger_b64, suffix=suffix_hint)
            return str(path), True
    raise AskAIChatError(
        "未提供文件：请传 file_url / file_base64（或 image_url / image_base64），"
        "或在包含图片的消息中触发本工具"
    )


def _clean_overview_text(text: str) -> str:
    """去掉 AI 概览文本中的标签行与「显示更多」按钮文案。"""
    lines = [line.strip() for line in str(text or "").splitlines()]
    while lines and re.fullmatch(r"AI\s*(概览|Overview)", lines[0]):
        lines.pop(0)
    while lines and re.search(r"显示更多|Show more", lines[-1]):
        lines.pop()
    return "\n".join(line for line in lines if line).strip()


def _format_lens_result(result: dict[str, Any]) -> str:
    """把 Lens 反搜结果（AI 概览 + 外观匹配）整理成适合 LLM 阅读的文本。"""
    lines: list[str] = []
    ai_overview = result.get("ai_overview") or {}
    overview = _clean_overview_text(str(ai_overview.get("text") or ""))

    if overview:
        lines.append("AI 概览（Google AI 对这张图片的识别结论）:")
        lines.append(overview)

    matches = result.get("visual_matches") or []
    if matches:
        lines.append("外观匹配（相似图片所在页面）:")
        for item in matches[:15]:
            title = str(item.get("title") or "").strip() or "(无标题)"
            source = str(item.get("source") or "").strip()
            suffix = f"（来源: {source}）" if source and source != title else ""
            lines.append(f"- {title}{suffix}: {item.get('url')}")

    overview_links = ai_overview.get("links") or []
    if overview_links:
        lines.append("AI 概览引用的来源链接:")
        for item in overview_links[:10]:
            title = str(item.get("title") or "").strip() or "(无标题)"
            lines.append(f"- {title}: {item.get('url')}")

    full_ai = str(result.get("full_ai_text") or "").strip()
    if full_ai:
        lines.append("AI 模式完整回答:")
        lines.append(full_ai)

    if not overview and not matches:
        # 降级流程或 Google 未生成 AI 概览：回退到页面文本与原始链接
        body = str(result.get("text") or "").strip()
        if body:
            lines.append("页面文本:")
            lines.append(body)
        links = result.get("links") or []
        if links:
            lines.append("相关链接（可用 web_file_download 下载后发送到聊天）:")
            for link in links[:15]:
                text = str(link.get("text") or "").strip() or "(无文字)"
                lines.append(f"- {text}: {link.get('href')}")

    images = result.get("similar_images") or []
    if images:
        lines.append("相似图片（可用 web_file_download 下载后发送到聊天）:")
        for image in images[:8]:
            alt = str(image.get("alt") or "").strip() or "(无描述)"
            lines.append(f"- {alt}: {image.get('src')}")

    page_url = str(result.get("result_page_url") or result.get("page_url") or "").strip()
    if page_url:
        lines.append(f"结果页: {page_url}")
    return "\n".join(lines).strip() or "(Google 未返回可读内容)"


def _format_ai_reply(result: dict[str, Any]) -> str:
    """把网页 AI 反代结果（含会话信息与可下载资源）整理为文本。"""
    provider_label = _PROVIDER_LABEL.get(str(result.get("provider") or ""), "")
    session_id = str(result.get("session_id") or "")
    turns = int(result.get("session_turns") or 1)
    notes: list[str] = []
    if result.get("session_restored"):
        notes.append("注意: 原会话页面已丢失（worker 重启），已重新开启会话，之前的对话上下文不在本页")
    if result.get("timed_out"):
        notes.append("注意: 等待回复超时，以下为最后抓取到的部分内容")
    if result.get("reply_truncated"):
        notes.append("注意: 回复因长度限制被截断")
    if session_id and not session_id.endswith("#onetime"):
        notes.insert(
            0,
            f"本次为多轮会话第 {turns} 轮；下次调用继续传 session_id=\"{session_id}\" 即可延续本对话上下文"
            "（传 new_chat=true 可重置该会话）",
        )
        header = f"[{provider_label} 网页版回复 | 会话 {session_id} 第{turns}轮]"
    else:
        header = f"[{provider_label} 网页版回复]"

    lines = [header, *notes, str(result.get("reply") or "").strip()]

    settings = result.get("effective_settings") or {}
    requested = result.get("requested_settings") or {}
    warnings = result.get("settings_warnings") or []
    if settings or requested:
        lines.append("本次实际网页设置:")
        for key, label in (
            ("model", "模型"),
            ("tier", "档位"),
            ("deep_thinking", "深度思考"),
            ("web_search", "联网搜索"),
            ("deep_research", "深度研究"),
        ):
            if key in settings:
                lines.append(f"- {label}: {settings.get(key)}")
    for warning in warnings:
        lines.append(f"设置提示: {warning}")
    risk_state = result.get("risk_state")
    if risk_state and risk_state not in ("normal", {"state": "normal"}):
        lines.append(f"风险状态: {risk_state}")

    links = result.get("reply_links") or []
    if links:
        lines.append("回复中包含的链接（可用 web_file_download 下载后发送到聊天）:")
        for link in links[:10]:
            text = str(link.get("text") or "").strip() or "(无文字)"
            lines.append(f"- {text}: {link.get('href')}")
    images = result.get("reply_images") or []
    if images:
        lines.append("回复中包含的图片（可用 web_file_download 下载后发送到聊天）:")
        for image in images[:8]:
            alt = str(image.get("alt") or "").strip() or "(无描述)"
            lines.append(f"- {alt}: {image.get('src')}")
    return "\n".join(line for line in lines if line).strip()


class WebImageSearchTool(BaseTool):
    """Google 以图搜图（无头）：一次调用上传图片并抓取识别结果。"""

    name = "web_image_search"
    display_name = "Google 图片反搜"
    description = (
        "用无头浏览器把图片提交到 Google 按图搜图（Google 智能镜头），直接返回识别结果："
        "AI 概览（Google AI 对图片内容的识别结论，如角色/物体/场景）、"
        "外观匹配（相似图片的来源页面与标题）和相似图片链接。"
        "单次调用即返回最终结果，无需二次抓取；不传图片时自动使用当前消息中的图片；"
        "full_ai=true 可额外抓取 AI 模式的完整回答（更完整但多花数秒）。"
    )
    tool_name = name
    tool_description = description

    async def execute(
        self,
        image_url: Annotated[
            str | None, "图片直链（http/https 公网地址）；与 image_base64 二选一"
        ] = None,
        image_base64: Annotated[
            str | None, "图片内容的 base64 编码；与 image_url 二选一"
        ] = None,
        use_trigger_image: Annotated[
            bool, "未提供图片时是否使用当前消息中的图片；默认 true"
        ] = True,
        full_ai: Annotated[
            bool,
            "是否额外跳转 Google AI 模式页抓取更完整的识图回答（约多花 3~6 秒）；默认 false",
        ] = False,
        max_chars: Annotated[int | None, "返回文本上限字符数；留空使用配置"] = None,
    ) -> ToolResult:
        """执行 Google Lens 反搜并直接返回抓取结果。"""
        config = _get_config(self)
        service = _get_service()
        try:
            image_path, is_temp = await _resolve_upload_file(
                self,
                url=image_url,
                base64_data=image_base64,
                use_trigger_image=use_trigger_image,
                max_bytes=config.browser.max_download_bytes,
                ssrf_mode=str(config.security.ssrf_check_mode),
            )
        except (UnsafeURLError, AskAIChatError) as error:
            return False, str(error)
        try:
            result = await service.request(
                "lens_search",
                {
                    "image_path": image_path,
                    "max_chars": max_chars or config.providers.max_chars,
                    "full_ai": bool(full_ai),
                },
            )
        except AskAIChatError as error:
            return False, f"Google 图片反搜失败: {error}"
        except Exception as error:  # pragma: no cover - 防御性兜底
            logger.exception("web_image_search 异常")
            return False, f"Google 图片反搜异常: {error}"
        finally:
            if is_temp:
                service.controller.cleanup_file(image_path)
        return True, _format_lens_result(result)


class WebAIChatTool(BaseTool):
    """豆包 / DeepSeek / Gemini 网页版反代：单次调用完成上传、提问与抓取，支持多轮会话。"""

    name = "web_ai_chat"
    display_name = "网页 AI 问答"
    description = (
        "通过无头浏览器调用网页版 AI（provider: doubao=豆包 / deepseek=DeepSeek / gemini=Gemini）。"
        "单次调用即完成：打开网页 → 可选上传图片/文件 → 发送提示词 → 等待生成 → 抓取完整回复文本。"
        "支持多轮持续对话：传相同 session_id 即在同一聊天中继续（AI 记得之前的上下文）；"
        "new_chat=true 重置该会话。返回即最终结果，回复中出现的文件/图片链接可用 web_file_download 下载。"
    )
    tool_name = name
    tool_description = description

    async def execute(
        self,
        provider: Annotated[
            Literal["doubao", "deepseek", "gemini"], "网页 AI 提供方"
        ],
        prompt: Annotated[str, "发送给网页 AI 的提示词/问题"],
        session_id: Annotated[
            str | None,
            "会话句柄（自定义字符串）：首次使用即创建，之后传相同值在同一聊天中持续多轮对话；"
            "留空则每次新开一次性聊天",
        ] = None,
        new_chat: Annotated[
            bool | None, "是否重置后新开聊天；默认：传了 session_id 时 false（延续对话），否则 true"
        ] = None,
        conversation_title: Annotated[
            str | None,
            "历史会话标题；传入后优先按标题恢复/续聊，标题由上次结果返回的 conversation_title 提供",
        ] = None,
        model: Annotated[
            str | None,
            "可选模型（Gemini: Flash-Lite/Flash/Pro；其他站点按能力探测；留空不改变当前模型）",
        ] = None,
        tier: Annotated[
            str | None,
            "可选档位（DeepSeek: fast/expert；豆包: fast/super；Gemini 按页面能力探测）",
        ] = None,
        deep_thinking: Annotated[
            bool | None, "深度思考开关；留空不改变当前状态，站点不支持时返回设置提示"
        ] = None,
        web_search: Annotated[
            bool | None, "联网/智能搜索开关；留空不改变当前状态，站点不支持时返回设置提示"
        ] = None,
        deep_research: Annotated[
            bool | None, "Gemini Deep Research 开关；不等同于普通联网搜索"
        ] = None,
        login_profile: Annotated[
            str | None, "命名登录 profile；不同账号使用不同名称，留空使用默认 profile"
        ] = None,
        image_url: Annotated[
            str | None, "可选：随消息上传的图片直链（http/https 公网地址）"
        ] = None,
        image_base64: Annotated[str | None, "可选：随消息上传的图片 base64"] = None,
        file_url: Annotated[
            str | None, "可选：随消息上传的任意文件直链（文档/音频等），与 file_base64 二选一"
        ] = None,
        file_base64: Annotated[
            str | None, "可选：随消息上传的任意文件 base64，与 file_url 二选一"
        ] = None,
        file_name: Annotated[
            str | None, "可选：上传文件名（用于确定扩展名，如 report.pdf）"
        ] = None,
        max_chars: Annotated[int | None, "回复文本上限字符数；留空使用配置"] = None,
    ) -> ToolResult:
        """执行网页 AI 单次反代调用（可在指定会话中继续多轮对话）。"""
        upload_url = file_url or image_url
        upload_b64 = file_base64 or image_base64
        if not str(prompt or "").strip() and not (upload_url or upload_b64):
            return False, "prompt 与上传文件至少提供一项"
        config = _get_config(self)
        service = _get_service()
        upload_path = ""
        is_temp = False
        try:
            if upload_b64 or upload_url:
                try:
                    upload_path, is_temp = await _resolve_upload_file(
                        self,
                        url=upload_url,
                        base64_data=upload_b64,
                        use_trigger_image=False,
                        max_bytes=config.tools.max_upload_bytes,
                        ssrf_mode=str(config.security.ssrf_check_mode),
                        suffix_hint=file_name,
                    )
                except (UnsafeURLError, AskAIChatError) as error:
                    return False, f"上传文件准备失败: {error}"
            params: dict[str, Any] = {
                "provider": provider,
                "prompt": str(prompt or "").strip(),
                "max_chars": max_chars or config.providers.max_chars,
            }
            if session_id is not None and str(session_id).strip():
                params["session_id"] = str(session_id).strip()
            if new_chat is not None:
                params["new_chat"] = bool(new_chat)
            if conversation_title and str(conversation_title).strip():
                params["conversation_title"] = str(conversation_title).strip()
            if model and str(model).strip():
                params["model"] = str(model).strip()
            if tier and str(tier).strip():
                params["tier"] = str(tier).strip()
            if deep_thinking is not None:
                params["deep_thinking"] = bool(deep_thinking)
            if web_search is not None:
                params["web_search"] = bool(web_search)
            if deep_research is not None:
                params["deep_research"] = bool(deep_research)
            if login_profile and str(login_profile).strip():
                params["login_profile"] = str(login_profile).strip()
            if upload_path:
                params["image_path"] = upload_path
            result = await service.request("web_ai_chat", params)
        except AskAIChatError as error:
            return False, f"网页 AI 反代失败: {error}"
        except Exception as error:  # pragma: no cover - 防御性兜底
            logger.exception("web_ai_chat 异常")
            return False, f"网页 AI 反代异常: {error}"
        finally:
            if is_temp and upload_path:
                service.controller.cleanup_file(upload_path)
        return True, _format_ai_reply(result)


class WebFileDownloadTool(BaseTool):
    """下载网络文件并可立即发送到当前聊天。"""

    name = "web_file_download"
    display_name = "网页文件下载"
    description = (
        "通过无头浏览器会话下载文件（共享浏览器 Cookie，可下载需要登录态的资源），"
        "保存到插件下载目录，并可选直接把文件/图片发送到当前聊天。"
        "适合下载 web_ai_chat 回复里出现的链接、web_image_search 找到的图片等。"
        "单次调用完成下载与发送。"
    )
    tool_name = name
    tool_description = description

    async def execute(
        self,
        url: Annotated[str, "要下载的文件直链（http/https 公网地址）"],
        file_name: Annotated[str | None, "保存/发送时使用的文件名；留空自动推断"] = None,
        send_to_chat: Annotated[bool, "下载后是否直接发送到当前聊天；默认 true"] = True,
    ) -> ToolResult:
        """下载文件并可选发送到当前会话。"""
        config = _get_config(self)
        service = _get_service()
        controller = service.controller
        try:
            validated = validate_public_http_url(url, mode=str(config.security.ssrf_check_mode))
        except UnsafeURLError as error:
            return False, str(error)
        try:
            result = await service.request("fetch_binary", {"url": validated})
        except AskAIChatError as error:
            return False, f"文件下载失败: {error}"
        except Exception as error:  # pragma: no cover - 防御性兜底
            logger.exception("web_file_download 异常")
            return False, f"文件下载异常: {error}"

        raw = base64.b64decode(str(result.get("base64") or ""))
        content_type = str(result.get("content_type") or "")
        try:
            path = controller.save_download(
                raw=raw, content_type=content_type, file_name=file_name or ""
            )
        except AskAIChatError as error:
            return False, str(error)

        lines = [
            f"已下载: {path.name}（{len(raw)} 字节, {content_type or '未知类型'}）",
            f"保存路径: {path}",
        ]

        if send_to_chat:
            stream_id = self.get_current_stream_id()
            if not stream_id:
                lines.append("发送状态: 失败（当前没有可用的会话 stream_id，文件已保存在本地）")
                return True, "\n".join(lines)
            message = self.trigger_message
            platform = getattr(message, "platform", None)
            sent = False
            try:
                from src.app.plugin_system.api.send_api import send_file, send_image

                if controller.is_image_bytes(raw):
                    sent = await send_image(
                        base64.b64encode(raw).decode(),
                        stream_id,
                        platform=platform,
                        processed_plain_text=f"[网页图片] {path.name}",
                    )
                else:
                    sent = await send_file(
                        str(path),
                        stream_id,
                        platform=platform,
                        file_name=path.name,
                    )
            except Exception as error:
                logger.exception("发送下载文件异常")
                lines.append(f"发送状态: 异常（{error}），文件已保存在本地")
                return True, "\n".join(lines)
            lines.append(f"发送状态: {'已发送到当前聊天' if sent else '发送失败，文件已保存在本地'}")
        return True, "\n".join(lines)


class WebAISessionTool(BaseTool):
    """查看/管理无头浏览器中的网页 AI 会话与登录状态。"""

    name = "web_ai_session"
    display_name = "网页 AI 会话管理"
    description = (
        "管理网页 AI 反代会话、能力、历史标题和命名登录 profile。"
        "action=list/close/close_all 管理活动页面；action=capabilities 探测模型/档位/深度思考/联网/历史能力；"
        "action=settings 应用并验证站点设置；action=history_list/history_get/history_resume/history_rename/history_delete 管理标题历史；"
        "action=login_check/login_profiles/logout 管理登录态（logout 与删除历史必须 confirm=true）。"
    )
    tool_name = name
    tool_description = description

    async def execute(
        self,
        action: Annotated[
            Literal[
                "list",
                "close",
                "close_all",
                "login_check",
                "capabilities",
                "settings",
                "history_list",
                "history_get",
                "history_resume",
                "history_rename",
                "history_delete",
                "login_profiles",
                "logout",
            ],
            "管理动作",
        ],
        session_id: Annotated[str | None, "会话 ID；close/history_get/history_rename/history_delete 时使用"] = None,
        provider: Annotated[
            Literal["doubao", "deepseek", "gemini"] | None,
            "provider；login_check/capabilities/settings/history/login profile 动作使用",
        ] = None,
        title: Annotated[str | None, "历史标题；history_resume/history_rename 使用"] = None,
        confirm: Annotated[bool, "logout/history_delete 的危险操作确认；必须显式 true"] = False,
        login_profile: Annotated[str | None, "命名登录 profile；不同账号使用不同名称"] = None,
        model: Annotated[str | None, "settings 动作可选模型"] = None,
        tier: Annotated[str | None, "settings 动作可选档位"] = None,
        deep_thinking: Annotated[bool | None, "settings 动作深度思考开关"] = None,
        web_search: Annotated[bool | None, "settings 动作联网搜索开关"] = None,
        deep_research: Annotated[bool | None, "settings 动作 Deep Research 开关"] = None,
    ) -> ToolResult:
        """执行会话管理动作。"""
        service = _get_service()
        try:
            if action == "list":
                result = await service.request("session_list")
                sessions = result.get("sessions") or []
                if not sessions:
                    return True, "当前没有存活的网页 AI 会话。"
                lines = [f"共 {len(sessions)} 个会话:"]
                for item in sessions:
                    state_text = "存活" if item.get("alive") else "页面已丢失"
                    label = _PROVIDER_LABEL.get(str(item.get("provider")), item.get("provider"))
                    lines.append(
                        f"- {item.get('session_id')} [{label}] {state_text}, "
                        f"已对话 {item.get('turns')} 轮, 页面: {item.get('page_url') or '(未知)'}"
                    )
                return True, "\n".join(lines)
            if action == "close":
                if not session_id or not str(session_id).strip():
                    return False, "action=close 时必须提供 session_id"
                result = await service.request(
                    "session_close", {"session_id": str(session_id).strip()}
                )
                closed = result.get("closed") or []
                if result.get("not_found"):
                    return False, f"会话不存在: {result['not_found']}"
                return True, f"已关闭会话: {', '.join(closed)}"
            if action == "close_all":
                result = await service.request("session_close", {"close_all": True})
                closed = result.get("closed") or []
                return True, f"已关闭 {len(closed)} 个会话" if closed else "当前没有可关闭的会话"
            if action == "login_check":
                if not provider:
                    return False, "action=login_check 时必须提供 provider"
                result = await service.request("login_check", {"provider": provider, "login_profile": login_profile} if login_profile else {"provider": provider})
                label = _PROVIDER_LABEL.get(provider, provider)
                if result.get("region_banned"):
                    return True, f"{label}: 当前网络出口被地区限制，需更换代理节点"
                logged_in = bool(result.get("logged_in"))
                detail = "已登录，可直接对话" if logged_in else "未登录，请使用命名 profile 关闭无头登录一次"
                return True, f"{label}: {detail}（风险: {result.get('risk_state')}, profile: {result.get('login_profile')}, 能力: {result.get('capabilities') or '(未探测)'}）"
            if action == "capabilities":
                if not provider:
                    return False, "action=capabilities 时必须提供 provider"
                result = await service.request("capabilities", {"provider": provider, **({"login_profile": login_profile} if login_profile else {})})
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            if action == "settings":
                if not provider:
                    return False, "action=settings 时必须提供 provider"
                params = {"provider": provider}
                for key, value in (
                    ("login_profile", login_profile),
                    ("model", model),
                    ("tier", tier),
                    ("deep_thinking", deep_thinking),
                    ("web_search", web_search),
                    ("deep_research", deep_research),
                ):
                    if value is not None and value != "":
                        params[key] = value
                result = await service.request("provider_settings", params)
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            if action == "history_list":
                if not provider:
                    return False, "action=history_list 时必须提供 provider"
                result = await service.request("history_list", {"provider": provider, **({"login_profile": login_profile} if login_profile else {})})
                histories = result.get("histories") or []
                return True, json.dumps({"provider": provider, "histories": histories, "risk_state": result.get("risk_state")}, ensure_ascii=False, indent=2)
            if action == "history_get":
                if not provider or not session_id:
                    return False, "action=history_get 时必须提供 provider 与 session_id"
                result = await service.request("history_get", {"provider": provider, "session_id": session_id})
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            if action == "history_resume":
                if not provider or not title:
                    return False, "action=history_resume 时必须提供 provider 与 title"
                result = await service.request("history_resume", {"provider": provider, "title": title, **({"login_profile": login_profile} if login_profile else {})})
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            if action == "history_rename":
                if not provider or not session_id or not title:
                    return False, "action=history_rename 时必须提供 provider、session_id 与 title"
                result = await service.request("history_rename", {"provider": provider, "session_id": session_id, "title": title})
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            if action == "history_delete":
                if not provider or not session_id or not confirm:
                    return False, "history_delete 必须提供 provider、session_id 且 confirm=true"
                result = await service.request("history_delete", {"provider": provider, "session_id": session_id, "confirm": True})
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            if action == "login_profiles":
                if not provider:
                    return False, "action=login_profiles 时必须提供 provider"
                result = await service.request("login_profiles", {"provider": provider})
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            if action == "logout":
                if not provider or not confirm:
                    return False, "logout 必须提供 provider 且 confirm=true"
                result = await service.request("logout", {"provider": provider, "confirm": True, **({"login_profile": login_profile} if login_profile else {})})
                return True, json.dumps(result, ensure_ascii=False, indent=2)
            return False, f"未知 action: {action}"
        except AskAIChatError as error:
            return False, f"会话管理失败: {error}"
        except Exception as error:  # pragma: no cover - 防御性兜底
            logger.exception("web_ai_session 异常")
            return False, f"会话管理异常: {error}"


ALL_TOOLS: list[type[BaseTool]] = [
    WebImageSearchTool,
    WebAIChatTool,
    WebFileDownloadTool,
    WebAISessionTool,
]

__all__ = [
    "ALL_TOOLS",
    "WebAIChatTool",
    "WebAISessionTool",
    "WebFileDownloadTool",
    "WebImageSearchTool",
]
