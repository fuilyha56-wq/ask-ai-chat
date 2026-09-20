import importlib
import json
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = PLUGIN_DIR.parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

package_name = "ask_ai_chat_test"
package = types.ModuleType(package_name)
package.__path__ = [str(PLUGIN_DIR)]
package.WEB_AGENT_SERVICE_SIGNATURE = "ask-ai-chat:service:web_agent"
sys.modules[package_name] = package
config_module = importlib.import_module(f"{package_name}.config")
service_module = importlib.import_module(f"{package_name}.service")
guard_module = importlib.import_module(f"{package_name}.url_guard")
AskAIChatConfig = config_module.AskAIChatConfig
WebAgentController = service_module.WebAgentController
UnsafeURLError = guard_module.UnsafeURLError
validate_public_http_url = guard_module.validate_public_http_url
def test_url_guard_rejects_private_loopback_and_non_http() -> None:
    for url in (
        "file:///tmp/a",
        "http://127.0.0.1/a",
        "http://localhost/a",
        "http://192.168.1.2/a",
        "http://[::1]/a",
    ):
        with pytest.raises(UnsafeURLError):
            validate_public_http_url(url)


def test_url_guard_allows_public_http_and_host_allowlist() -> None:
    assert validate_public_http_url(
        "https://chat.deepseek.com/", allowed_hosts=["chat.deepseek.com"]
    ).startswith("https://")
    with pytest.raises(UnsafeURLError):
        validate_public_http_url(
            "https://evil.example/", allowed_hosts=["chat.deepseek.com"]
        )


def test_config_has_engine_history_and_profile_defaults() -> None:
    config = AskAIChatConfig()
    assert config.browser.default_login_profile == "default"
    assert config.providers.history_max_count == 100
    assert config.providers.default_model == ""
    assert config.providers.default_deep_thinking is None
    assert config.auto.vision_engine == "lens_first"


def test_profile_path_isolated_by_provider_and_name(tmp_path: Path) -> None:
    class Plugin:
        config = AskAIChatConfig()

    Plugin.config.browser.browser_profile_root = str(tmp_path)
    controller = WebAgentController(Plugin())
    deepseek = controller.resolve_profile_dir("deepseek", "work")
    gemini = controller.resolve_profile_dir("gemini", "work")
    assert deepseek != gemini
    assert deepseek.name == "work"
    assert deepseek.parent.name == "deepseek"


def test_profile_name_is_sanitized(tmp_path: Path) -> None:
    class Plugin:
        config = AskAIChatConfig()

    Plugin.config.browser.browser_profile_root = str(tmp_path)
    controller = WebAgentController(Plugin())
    target = controller.resolve_profile_dir("gemini", "../escape")
    assert target.parent.name == "gemini"
    assert "escape" in target.name


def test_provider_url_validation_uses_allowlist() -> None:
    assert WebAgentController is not None
    with pytest.raises(Exception):
        # static helper is on the service class; use a minimal object only for error behavior
        WebAgentController.validate_provider_url("deepseek", "http://127.0.0.1:8080/")


def test_manifest_declares_new_handler() -> None:
    manifest = json.loads(Path("manifest.json").read_text(encoding="utf-8"))
    names = {item["component_name"] for item in manifest["include"]}
    assert "lens_media_recognize" in names
    assert "web_ai_session" in names
