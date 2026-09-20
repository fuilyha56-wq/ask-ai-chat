"""插件内 URL 安全校验（SSRF 防护）。

凡是以服务端身份对外发起请求的 URL（下载用户/LLM 提供的图片、抓取网页等）
必须先经过 :func:`validate_public_http_url`：

- 仅允许 ``http`` / ``https`` 协议；
- 拒绝 ``localhost`` / ``*.localhost`` / ``*.local`` / ``*.internal`` 等内网主机名；
- 拒绝环回、私网、链路本地、保留与组播的 IP 字面量；
- ``strict`` 模式额外做 DNS 解析校验（解析结果全部为公网地址才放行）。

注意：TUN/透明代理（如 Clash fake-IP）会把公网域名解析到 198.18.0.0/15 等
保留段，此时应使用默认的 ``hostname`` 模式，否则所有域名都会被拒绝。
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

_MAX_PORT = 65535
_FORBIDDEN_HOST_SUFFIXES = (
    ".localhost",
    ".local",
    ".internal",
    ".home.arpa",
    ".lan",
)


class UnsafeURLError(ValueError):
    """URL 未通过安全校验。"""


def _ip_is_forbidden(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """判断单个 IP 是否落在禁止访问的地址段。"""
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or getattr(ip, "is_global", True) is False
    )


def _check_host(host: str, *, resolve: bool) -> None:
    """按模式校验主机名：字符串规则 + 可选的 DNS 解析校验。"""
    normalized = host.strip(".").lower()
    if normalized == "localhost" or normalized.endswith(_FORBIDDEN_HOST_SUFFIXES):
        raise UnsafeURLError(f"禁止访问内网主机名: {host}")

    try:
        ip = ipaddress.ip_address(normalized)
    except ValueError:
        ip = None
    if ip is not None:
        if _ip_is_forbidden(ip):
            raise UnsafeURLError(f"禁止访问私有或保留地址: {host}")
        return

    if resolve:
        try:
            infos = socket.getaddrinfo(normalized, None)
        except socket.gaierror as error:
            raise UnsafeURLError(f"无法解析主机名: {host} ({error})") from error
        for info in infos:
            candidate = info[4][0]
            try:
                resolved = ipaddress.ip_address(candidate)
            except ValueError:
                continue
            if _ip_is_forbidden(resolved):
                raise UnsafeURLError(
                    f"主机名 {host} 解析到被禁止的地址: {candidate}"
                )


def validate_public_http_url(
    url: str,
    *,
    allowed_hosts: list[str] | None = None,
    mode: str = "hostname",
) -> str:
    """校验一个可安全地从服务端访问的 http(s) URL。

    Args:
        url: 待校验的 URL 字符串。
        allowed_hosts: 可选主机白名单（精确匹配，忽略大小写）。
            提供时仅允许列表内的主机。
        mode: ``hostname``（默认）校验协议、主机名字符串与 IP 字面量；
            ``strict`` 额外做 DNS 解析校验（透明代理 fake-IP 环境勿用）。

    Returns:
        规范化后的 URL（原样返回）。

    Raises:
        UnsafeURLError: 协议、主机或解析结果不符合安全要求。
    """
    raw = str(url or "").strip()
    if not raw:
        raise UnsafeURLError("URL 不能为空")
    if any(ord(ch) < 0x20 or ch.isspace() for ch in raw):
        raise UnsafeURLError("URL 含有非法空白字符")

    parsed = urlparse(raw)
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise UnsafeURLError(f"仅允许 http/https 协议，收到: {scheme or '(空)'}")

    host = parsed.hostname
    if not host:
        raise UnsafeURLError("URL 缺少主机名")
    host = host.strip(".").lower()

    port = parsed.port
    if port is not None and not (0 < port <= _MAX_PORT):
        raise UnsafeURLError(f"URL 端口非法: {port}")

    if allowed_hosts is not None and host not in {h.strip(".").lower() for h in allowed_hosts}:
        raise UnsafeURLError(f"主机 {host} 不在允许列表内")

    _check_host(host, resolve=str(mode or "hostname").lower() == "strict")

    return raw


__all__ = ["UnsafeURLError", "validate_public_http_url"]
