"""无头浏览器 worker 控制器与 MoFox Service 适配层。"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

from src.core.components.base import BaseService
from src.kernel.logger import get_logger

from . import WEB_AGENT_SERVICE_SIGNATURE
from .config import AskAIChatConfig
from .url_guard import UnsafeURLError, validate_public_http_url

if TYPE_CHECKING:
    from src.core.components.base import BasePlugin


logger = get_logger("ask-ai-chat")

_SUFFIX_BY_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"RIFF", ".webp"),
    (b"%PDF-", ".pdf"),
    (b"PK\x03\x04", ".zip"),
)

_SUFFIX_BY_CONTENT_TYPE: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
    "text/html": ".html",
    "video/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
}


class AskAIChatError(RuntimeError):
    """ask-ai-chat worker 返回的可预期错误。"""


def _suffix_for(data: bytes, explicit: str | None) -> str:
    """根据显式后缀或文件魔数确定临时文件扩展名。"""
    if explicit:
        cleaned = re.sub(r"[^A-Za-z0-9.]", "", explicit)
        if cleaned:
            return cleaned if cleaned.startswith(".") else f".{cleaned}"
    for magic, suffix in _SUFFIX_BY_MAGIC:
        if data.startswith(magic):
            return suffix
    return ".bin"


class WebAgentController:
    """管理一个无头浏览器 Node worker，并复用其浏览器会话。"""

    def __init__(self, plugin: "BasePlugin") -> None:
        """创建延迟启动的控制器；此时不会启动 Node 或浏览器。"""
        self.plugin = plugin
        self.plugin_dir = Path(__file__).resolve().parent
        self.worker_path = self.plugin_dir / "worker" / "ask_ai_worker.mjs"
        self._process: asyncio.subprocess.Process | None = None
        self._request_lock = asyncio.Lock()
        self._sequence = 0
        self._data_dir = self.plugin_dir / "data"
        self._tmp_dir = self._data_dir / "tmp"

    @property
    def config(self) -> AskAIChatConfig:
        """返回插件配置，不可用时回退到默认配置。"""
        raw_config = getattr(self.plugin, "config", None)
        if isinstance(raw_config, AskAIChatConfig):
            return raw_config
        return AskAIChatConfig()

    @property
    def is_worker_running(self) -> bool:
        """返回 Node worker 是否仍在运行。"""
        return self._process is not None and self._process.returncode is None

    # ── 临时文件管理 ────────────────────────────────────────────────

    def _ensure_tmp_dir(self) -> Path:
        """确保临时目录存在。"""
        self._tmp_dir.mkdir(parents=True, exist_ok=True)
        return self._tmp_dir

    def resolve_profile_dir(self, provider: str | None = None, login_profile: str | None = None) -> Path:
        """解析隔离的浏览器用户数据目录（兼容旧 user_data_dir）。"""
        configured = str(self.config.browser.user_data_dir or "").strip()
        root_raw = str(self.config.browser.browser_profile_root or "").strip()
        if configured and not root_raw:
            target = Path(configured).expanduser()
        else:
            root = Path(root_raw).expanduser() if root_raw else self._data_dir / "browser_profiles"
            provider_name = re.sub(r"[^A-Za-z0-9_.-]", "_", str(provider or "global").lower())
            profile_name = re.sub(r"[^\w.\-\u4e00-\u9fff ]", "_", str(login_profile or self.config.browser.default_login_profile or "default")).strip("._") or "default"
            target = root / provider_name / profile_name
        target.mkdir(parents=True, exist_ok=True)
        return target.resolve()

    def resolve_download_dir(self) -> Path:
        """解析下载文件保存目录（默认插件 data/downloads）。"""
        configured = str(self.config.browser.download_dir or "").strip()
        target = Path(configured).expanduser() if configured else self._data_dir / "downloads"
        target.mkdir(parents=True, exist_ok=True)
        return target.resolve()

    def save_download(self, *, raw: bytes, content_type: str = "", file_name: str = "") -> Path:
        """把下载内容保存到下载目录，返回实际文件路径。"""
        if not raw:
            raise AskAIChatError("下载内容为空")
        # 文件名清洗：仅保留基础名与安全字符
        safe_stem = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", Path(file_name or "").stem).strip("._")
        suffix = ""
        if file_name and Path(file_name).suffix:
            candidate = re.sub(r"[^\w.\-]", "", Path(file_name).suffix)
            if candidate:
                suffix = candidate if candidate.startswith(".") else f".{candidate}"
        if not suffix:
            suffix = _SUFFIX_BY_CONTENT_TYPE.get((content_type or "").split(";")[0].strip().lower(), "")
        if not suffix:
            suffix = _suffix_for(raw, None)
        if not safe_stem:
            safe_stem = f"{int(time.time() * 1000):x}-{uuid.uuid4().hex[:8]}"
        target = self.resolve_download_dir() / f"{safe_stem}{suffix}"
        counter = 1
        while target.exists():
            target = self.resolve_download_dir() / f"{safe_stem}-{counter}{suffix}"
            counter += 1
        target.write_bytes(raw)
        return target.resolve()

    @staticmethod
    def is_image_bytes(raw: bytes) -> bool:
        """根据魔数判断内容是否为图片（决定发送通道）。"""
        return any(raw.startswith(magic) for magic, _ in _SUFFIX_BY_MAGIC[:5])

    def save_temp_file(
        self,
        *,
        data_b64: str | None = None,
        raw: bytes | None = None,
        suffix: str | None = None,
    ) -> Path:
        """把 base64 或原始字节写入插件临时目录，返回文件路径。"""
        if raw is None:
            if not data_b64:
                raise AskAIChatError("缺少要保存的文件数据")
            payload = str(data_b64)
            if payload.startswith("data:"):
                payload = payload.partition(",")[2]
            elif payload.startswith("base64|"):
                payload = payload[7:]
            elif payload.startswith("base64://"):
                payload = payload[9:]
            try:
                raw = base64.b64decode(payload, validate=False)
            except Exception as error:
                raise AskAIChatError(f"base64 数据解码失败: {error}") from error
        if not raw:
            raise AskAIChatError("文件数据为空")
        stem = f"{int(time.time() * 1000):x}-{uuid.uuid4().hex[:8]}"
        target = self._ensure_tmp_dir() / f"{stem}{_suffix_for(raw, suffix)}"
        target.write_bytes(raw)
        return target.resolve()

    def cleanup_file(self, path: str | Path) -> None:
        """删除临时文件；失败仅记录调试日志。"""
        try:
            Path(path).unlink(missing_ok=True)
        except Exception as error:  # pragma: no cover - 清理失败不影响主流程
            logger.debug(f"临时文件清理失败 {path}: {error}")

    def cleanup_tmp_dir(self, max_age_seconds: int = 3600) -> None:
        """清理超过时限的临时文件，防止上传文件长期堆积。"""
        if not self._tmp_dir.is_dir():
            return
        cutoff = time.time() - max_age_seconds
        for item in self._tmp_dir.iterdir():
            try:
                if item.is_file() and item.stat().st_mtime < cutoff:
                    item.unlink(missing_ok=True)
            except Exception:
                continue

    # ── worker 进程管理 ────────────────────────────────────────────

    def _resolve_node_command(self) -> str:
        """解析 Node 命令，给出可执行的错误信息。"""
        configured = str(self.config.browser.node_command or "node").strip()
        resolved = shutil.which(configured)
        if resolved:
            return resolved
        if Path(configured).is_file():
            return str(Path(configured).resolve())
        raise AskAIChatError(
            f"找不到 Node.js 命令: {configured}；请安装 Node.js 并加入 PATH，"
            "或在 config/plugins/ask-ai-chat/config.toml 中填写绝对路径"
        )

    def _build_worker_environment(self) -> dict[str, str]:
        """构造补充插件路径的 worker 环境变量。"""
        env = {**os.environ, "NEO_ASK_AI_PLUGIN_DIR": str(self.plugin_dir)}
        # 兜底：本插件未安装依赖时，尝试复用 browser_control 的 node_modules
        sibling_modules = self.plugin_dir.parent / "browser_control" / "node_modules"
        if not (self.plugin_dir / "node_modules").is_dir() and sibling_modules.is_dir():
            existing = env.get("NODE_PATH", "")
            env["NODE_PATH"] = f"{sibling_modules}{os.pathsep}{existing}" if existing else str(sibling_modules)
        return env

    async def _ensure_worker(self) -> asyncio.subprocess.Process:
        """按需启动 Node worker，不打开任何网页。"""
        if self.is_worker_running:
            process = self._process
            assert process is not None
            return process

        node_command = self._resolve_node_command()
        if not self.worker_path.is_file():
            raise AskAIChatError(f"无头浏览器 worker 不存在: {self.worker_path}")

        self._process = await asyncio.create_subprocess_exec(
            node_command,
            str(self.worker_path),
            cwd=str(self.plugin_dir),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=self._build_worker_environment(),
        )
        process = self._process
        if process.stdout is None or process.stdin is None:
            await self._terminate_worker()
            raise AskAIChatError("无法建立无头浏览器 worker 的标准输入输出管道")
        return process

    async def request(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        """向 worker 发送一个 JSON 请求并等待对应响应。"""
        action_name = str(action or "").strip()
        if not action_name:
            raise AskAIChatError("worker 操作 action 不能为空")

        config = self.config
        async with self._request_lock:
            process = await self._ensure_worker()
            if process.stdin is None or process.stdout is None:
                raise AskAIChatError("无头浏览器 worker 管道不可用")

            self._sequence += 1
            request_id = str(self._sequence)
            request_params = dict(params or {})
            # 浏览器会话默认值：worker 内所有可能触发 ensureBrowser 的动作都可用
            request_params.setdefault("mode", config.browser.mode)
            request_params.setdefault("headless", bool(config.browser.headless))
            request_params.setdefault("cdp_url", config.browser.cdp_url)
            request_params.setdefault("executable_path", config.browser.executable_path)
            request_params.setdefault("user_agent", config.browser.user_agent)
            request_params.setdefault("window_width", int(config.browser.window_width))
            request_params.setdefault("window_height", int(config.browser.window_height))
            request_params.setdefault("extra_args", list(config.browser.extra_args))
            request_params.setdefault("default_timeout_ms", int(config.browser.default_timeout_ms))
            request_params.setdefault("profile_root", str(config.browser.browser_profile_root or ""))
            request_params.setdefault("login_profile", str(config.browser.default_login_profile or "default"))
            request_params.setdefault("user_data_dir", str(self.resolve_profile_dir(
                str(request_params.get("provider") or "global"),
                str(request_params.get("login_profile") or self.config.browser.default_login_profile),
            )))
            if action_name in {"web_ai_chat", "capabilities", "provider_settings", "history_list", "history_resume", "history_get", "history_rename", "history_delete", "login_check", "login_profiles", "logout"}:
                provider = str(request_params.get("provider") or "").strip().lower()
                urls = {
                    "doubao": str(config.providers.doubao_url),
                    "deepseek": str(config.providers.deepseek_url),
                    "gemini": str(config.providers.gemini_url),
                }
                if provider in urls:
                    request_params.setdefault("url", self.validate_provider_url(provider, urls[provider]))
            request_params.setdefault("user_agent", config.browser.user_agent)
            request_params.setdefault("window_width", int(config.browser.window_width))
            request_params.setdefault("window_height", int(config.browser.window_height))
            request_params.setdefault("extra_args", list(config.browser.extra_args))
            request_params.setdefault("default_timeout_ms", int(config.browser.default_timeout_ms))
            request_params.setdefault("profile_root", str(config.browser.browser_profile_root or ""))
            request_params.setdefault("login_profile", str(config.browser.default_login_profile or "default"))
            if action_name == "web_ai_chat":
                request_params.setdefault("reply_timeout_ms", int(config.providers.reply_timeout_ms))
                request_params.setdefault("poll_interval_ms", int(config.providers.poll_interval_ms))
                request_params.setdefault("max_chars", int(config.providers.max_chars))
                request_params.setdefault("session_max_count", int(config.providers.session_max_count))
                request_params.setdefault("model", str(config.providers.default_model or ""))
                request_params.setdefault("tier", str(config.providers.default_tier or ""))
                request_params.setdefault("deep_thinking", config.providers.default_deep_thinking)
                request_params.setdefault("web_search", config.providers.default_web_search)
                request_params.setdefault("history_max_count", int(config.providers.history_max_count))
            request_params.setdefault("risk_cooldown_seconds", int(config.providers.risk_cooldown_seconds))
            if action_name == "fetch_binary":
                request_params.setdefault("max_bytes", int(config.browser.max_download_bytes))
            if action_name == "lens_search":
                request_params.setdefault("max_chars", int(config.providers.max_chars))
                request_params.setdefault("lens_retries", int(config.browser.lens_retries))
                request_params.setdefault(
                    "lens_gap_ms", int(config.browser.lens_request_gap_ms)
                )

            payload = {
                "id": request_id,
                "action": action_name,
                "params": request_params,
            }
            try:
                process.stdin.write(
                    (json.dumps(payload, ensure_ascii=False, default=str) + "\n").encode("utf-8")
                )
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionError) as error:
                await self._terminate_worker()
                raise AskAIChatError("无头浏览器 worker 已断开") from error

            effective_timeout = int(timeout_ms or config.browser.request_timeout_ms)
            timeout_seconds = max(1.0, effective_timeout / 1000.0)
            while True:
                try:
                    raw_line = await asyncio.wait_for(process.stdout.readline(), timeout=timeout_seconds)
                except asyncio.TimeoutError as error:
                    await self._terminate_worker()
                    raise AskAIChatError(
                        f"无头浏览器操作超时: {action_name} ({timeout_seconds:g}s)"
                    ) from error

                if not raw_line:
                    return_code = process.returncode
                    await self._terminate_worker()
                    raise AskAIChatError(f"无头浏览器 worker 已退出，退出码: {return_code}")

                try:
                    response = json.loads(raw_line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise AskAIChatError("无头浏览器 worker 返回了无法解析的 JSON") from error

                if str(response.get("id", "")) != request_id:
                    continue
                if not bool(response.get("ok", False)):
                    detail = response.get("error") or "未知无头浏览器错误"
                    raise AskAIChatError(str(detail))
                result = response.get("result")
                if isinstance(result, dict):
                    return result
                return {"value": result}

    async def restart(self) -> None:
        """强制重启 worker（浏览器会话一并重置）。"""
        await self._terminate_worker()

    async def shutdown(self) -> None:
        """停止 worker 并关闭由本插件启动的无头浏览器。"""
        if not self.is_worker_running:
            await self._terminate_worker()
            return
        try:
            await self.request("shutdown", {"close_owned_browser": True})
        except Exception as error:
            logger.warning(f"关闭无头浏览器 worker 时出现异常: {error}")
        await self._terminate_worker()

    async def _terminate_worker(self) -> None:
        """终止已退出或卡住的 worker 进程。"""
        process = self._process
        self._process = None
        if process is None:
            return
        if process.returncode is None:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                    await process.stdin.wait_closed()
                except Exception:
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    @staticmethod
    def validate_provider_url(provider: str, url: str) -> str:
        allowed = {
            "doubao": ["www.doubao.com", "doubao.com"],
            "deepseek": ["chat.deepseek.com"],
            "gemini": ["gemini.google.com", "accounts.google.com"],
        }.get(str(provider or "").lower())
        if not allowed:
            raise AskAIChatError(f"不支持的 provider: {provider}")
        try:
            return validate_public_http_url(url, allowed_hosts=allowed, mode="hostname")
        except UnsafeURLError as error:
            raise AskAIChatError(f"provider 地址不安全: {error}") from error


class AskAIChatService(BaseService):
    """供其他 MoFox 组件复用的无头浏览器网页代理服务。"""

    service_name = "web_agent"
    display_name = "网页 AI 反代服务"
    service_description = (
        "无头浏览器服务：Google Lens 以图搜图、豆包/DeepSeek/Gemini 网页 AI 反代，"
        "模型/档位/深度思考/联网能力探测、标题历史续聊、命名登录 profile、风险状态与受控下载"
    )
    name = "web_agent"
    description = service_description
    version = "1.1.0"

    def __init__(self, plugin: "BasePlugin") -> None:
        """绑定到插件实例持有的共享控制器。"""
        super().__init__(plugin)
        controller = getattr(plugin, "controller", None)
        if not isinstance(controller, WebAgentController):
            raise AskAIChatError("无头浏览器控制器尚未初始化")
        self.controller = controller

    async def request(
        self,
        action: str,
        params: dict[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        """执行一个无头浏览器 worker 操作。"""
        return await self.controller.request(action, params, timeout_ms=timeout_ms)

    async def shutdown(self) -> None:
        """关闭共享 worker 与无头浏览器。"""
        await self.controller.shutdown()


__all__ = [
    "AskAIChatError",
    "AskAIChatService",
    "WebAgentController",
    "WEB_AGENT_SERVICE_SIGNATURE",
]
