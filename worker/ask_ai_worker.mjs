// Ask AI Chat 无头浏览器 worker。
// 协议：stdin 每行一个 JSON {id, action, params}，stdout 回 {id, ok, result|error}。
// 所有网页操作都通过 playwright-core 驱动本机 Chromium，默认无头运行。

import readline from "node:readline";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const WINDOWS_EXECUTABLES = [
  ["PROGRAMFILES", "Google", "Chrome", "Application", "chrome.exe"],
  ["PROGRAMFILES(X86)", "Google", "Chrome", "Application", "chrome.exe"],
  ["LOCALAPPDATA", "Google", "Chrome", "Application", "chrome.exe"],
  ["PROGRAMFILES", "Microsoft", "Edge", "Application", "msedge.exe"],
  ["PROGRAMFILES(X86)", "Microsoft", "Edge", "Application", "msedge.exe"],
  ["LOCALAPPDATA", "Microsoft", "Edge", "Application", "msedge.exe"],
  ["PROGRAMFILES", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
  ["LOCALAPPDATA", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
];

// 网页 AI 反代站点配置。选择器为多候选列表（站点改版时按顺序探测），
// 全部失配时回退到 textarea / contenteditable / filechooser 等通用逻辑。
const PROFILES = {
  doubao: {
    label: "豆包",
    domain: "doubao.com",
    newChatUrl: "https://www.doubao.com/chat/",
    composer: [
      'textarea[data-testid="chat_text_input"]',
      'div[data-testid="chat_text_input"]',
      'textarea[placeholder*="豆包" i]',
      "textarea",
      'div[contenteditable="true"]',
    ],
    attachButton: [
      'button[data-testid="upload_file_btn"]',
      '[data-testid*="upload" i]',
      'div[aria-label*="上传" i]',
      'button[aria-label*="上传" i]',
      'button[aria-label*="attach" i]',
    ],
    fileInput: ['input[type="file"]'],
    stop: [
      '[data-testid*="stop" i]',
      'button[aria-label*="停止" i]',
      'div[aria-label*="停止" i]',
      'button[aria-label*="stop" i]',
    ],
    reply: [
      '[data-testid="receive_message"]',
      '[data-testid*="receive" i]',
      '[class*="receive" i][class*="message" i]',
      '[class*="markdown-body"]',
      '[class*="answer" i]',
    ],
    loginMarkers: ["扫码登录", "短信登录", "登录后即可", "请先登录"],
    banMarkers: ["当前地区不支持", "地区限制", "无法在当前地区使用", "访问受到限制"],
    captchaMarkers: ["请选择所有符合上文描述的图片", "拖拽到这里", "人机验证", "安全验证", "验证码"],
    settings: {
      model: { trigger: ['button[aria-label*="模型" i]', '[data-testid*="model" i]'], options: {} },
      tier: { trigger: ['button:has-text("快速")', 'button:has-text("超能模式")', '[role="menuitem"]'], options: { fast: ["快速"], super: ["超能模式", "超级模式"] } },
      deepThinking: { coupled: "tier", on: "super", off: "fast" },
      webSearch: { coupled: "tier", on: "super", independent: false },
    },
    history: {
      item: ['a[href*="/chat/"]', '[data-testid="chat_list_thread_item"]', '[class*="conversation-item"]'],
      newChat: ['text=新对话', 'button:has-text("新对话")'],
      more: ['button[aria-label*="更多" i]', '[class*="more" i]'],
    },
  },
  deepseek: {
    label: "DeepSeek",
    domain: "chat.deepseek.com",
    newChatUrl: "https://chat.deepseek.com/",
    composer: [
      "textarea#chat-input",
      'textarea[placeholder*="DeepSeek" i]',
      'textarea[placeholder*="消息" i]',
      "textarea",
      'div[contenteditable="true"]',
    ],
    attachButton: [
      'div[role="button"][aria-label*="attach" i]',
      'button[aria-label*="attach" i]',
      'div[aria-label*="上传" i]',
      'button[aria-label*="上传" i]',
      'div[class*="upload" i][role="button"]',
    ],
    fileInput: ['input[type="file"]'],
    stop: [
      'div[role="button"][aria-label*="stop" i]',
      'button[aria-label*="stop" i]',
      'div[aria-label*="停止" i]',
      '[class*="stop" i][role="button"]',
    ],
    reply: [
      "div.ds-markdown",
      "div[class*='ds-markdown']",
      "[class*='markdown']",
      "[class*='answer' i]",
    ],
    loginMarkers: ["扫码登录", "验证码登录", "继续使用手机", "Log in to continue", "登录 DeepSeek", "进入网页版 App"],
    captchaMarkers: ["人机验证", "验证码", "异常流量", "unusual traffic", "verify"],
    settings: {
      tier: { trigger: ['[role="radio"][aria-label="快速模式"]', '[role="radio"][aria-label="专家模式"]'], options: { fast: ["快速模式", "Fast mode"], expert: ["专家模式", "Expert mode"] } },
      deepThinking: { selectors: ['[role="button"][aria-label="深度思考"]', '[role="button"][aria-label*="DeepThink" i]', '[role="button"][aria-label*="Reasoning" i]'], label: "深度思考" },
      webSearch: { selectors: ['[role="button"][aria-label="智能搜索"]', '[role="button"][aria-label*="Smart search" i]', '[role="button"][aria-label*="Search" i]'], label: "智能搜索", mutuallyExclusive: true },
    },
    history: { item: ['a[href*="/a/chat/"]', '[class*="conversation" i]', '[class*="history" i]'], newChat: ['text=开启新对话', 'text=新对话', 'button[aria-label*="new chat" i]'] },
  },
  gemini: {
    label: "Gemini",
    domain: "gemini.google.com",
    newChatUrl: "https://gemini.google.com/app",
    composer: [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="输入" i]',
      'div[contenteditable="true"]',
      "textarea",
    ],
    attachButton: [
      'button[aria-label*="Upload" i]',
      'button[aria-label*="Add files" i]',
      'button[mattooltip*="Upload" i]',
      'button[aria-label*="上传" i]',
      'button[aria-label*="添加" i]',
    ],
    fileInput: ['input[type="file"]'],
    stop: [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止" i]',
      'button[aria-label*="stop" i]',
    ],
    reply: [
      "model-response message-content",
      "message-content",
      "model-response",
      "[class*='markdown' i]",
    ],
    loginMarkers: ["Sign in to continue", "选择账号", "使用您的账号登录"],
    banMarkers: ["not yet available in your country", "你所在的国家/地区", "目前不支持你所在的地区"],
    captchaMarkers: ["unusual traffic", "captcha", "验证", "人机验证"],
    settings: {
      model: { trigger: ['button[aria-label*="模式选择器" i]', 'button[aria-label*="mode picker" i]', 'button[aria-label*="model" i]', 'button[aria-label*="picker" i]'], options: { "Flash-Lite": ["Flash-Lite"], Flash: ["Flash"], Pro: ["Pro"] } },
      deepThinking: { selectors: ['[role="menuitem"]:has-text("扩展思考")', '[role="menuitem"]:has-text("Extended thinking")', 'button[aria-label*="thinking" i]'], label: "扩展思考" },
      webSearch: { selectors: ['button[aria-label*="Search" i]', 'button[aria-label*="搜索" i]', 'button:has-text("Search")', 'button:has-text("搜索")'], label: "Search" },
      deepResearch: { selectors: ['button:has-text("Deep research")', 'button:has-text("深度研究")'] },
    },
    history: { item: ['a[href*="/app/"]', '[class*="conversation" i]', '[class*="history-item" i]'], newChat: ['button[aria-label*="新对话" i]', 'button[aria-label*="new chat" i]', 'a[href="/app"]'], more: ['button[aria-label*="更多" i]', 'button[aria-label*="more" i]'] },
  },
};

const state = {
  driver: null,
  browser: null,
  context: null,
  ownedBrowser: false,
  connectedOverCdp: false,
  headless: true,
  profileDir: "",
  loginProfile: "default",
  sessionMetaPath: "",
  sessionMeta: {},
  sessions: {},
  sessionMaxCount: 12,
  historyMaxCount: 100,
  risk: {},
};

// ── 基础工具 ─────────────────────────────────────────────────────

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function existingLocatorAlive(locator) {
  try {
    return (await locator.count()) > 0 && (await locator.isVisible());
  } catch {
    return false;
  }
}

function assertString(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${name} 不能为空`);
  return result;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertSafeName(value, name, maxLength = 96) {
  const result = assertString(value, name);
  if (result.length > maxLength || !/^[\w\-.\u4e00-\u9fff ]+$/u.test(result)) {
    throw new Error(`${name} 含有非法字符或过长`);
  }
  return result;
}

function riskStateFor(provider) {
  const current = state.risk[provider] || { state: "normal", cooldown_until: 0, last_error: "" };
  if (current.state === "cooldown" && current.cooldown_until && current.cooldown_until <= Date.now()) {
    state.risk[provider] = { state: "normal", cooldown_until: 0, last_error: "" };
    return state.risk[provider];
  }
  return current;
}

function markRisk(provider, riskState, message = "", cooldownMs = 60000) {
  state.risk[provider] = {
    state: riskState,
    cooldown_until: riskState === "cooldown" ? Date.now() + Math.max(10000, cooldownMs) : 0,
    last_error: String(message || "").slice(0, 240),
  };
}

function sessionMetaFile(profileDir) {
  return path.join(profileDir, "ask-ai-chat-sessions.json");
}

async function loadSessionMeta(profileDir) {
  state.sessionMetaPath = sessionMetaFile(profileDir);
  try {
    const raw = await fs.readFile(state.sessionMetaPath, "utf8");
    const parsed = JSON.parse(raw);
    state.sessionMeta = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    state.sessionMeta = {};
  }
}

async function saveSessionMeta() {
  if (!state.sessionMetaPath) return;
  const entries = Object.entries(state.sessionMeta);
  const maxCount = Math.max(10, toInt(state.historyMaxCount, 100));
  if (entries.length > maxCount) {
    entries.sort((a, b) => String(b[1]?.updated_at || "").localeCompare(String(a[1]?.updated_at || "")));
    state.sessionMeta = Object.fromEntries(entries.slice(0, maxCount));
  }
  const target = state.sessionMetaPath;
  const temp = `${target}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temp, JSON.stringify(state.sessionMeta, null, 2), "utf8");
    await fs.rename(temp, target);
  } catch {
    await fs.unlink(temp).catch(() => {});
  }
}

function profileUrlAllowed(provider, url) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  const allowed = {
    doubao: ["doubao.com", ".doubao.com"],
    deepseek: ["chat.deepseek.com"],
    gemini: ["gemini.google.com", ".gemini.google.com", "accounts.google.com"],
  }[provider] || [];
  return allowed.some((item) => item.startsWith(".") ? host.endsWith(item) : host === item);
}

function isForbiddenHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (net.isIP(host)) {
    if (host.includes(":")) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
    return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|22[4-9]\.|23\.)/.test(host) || host.startsWith("198.18.");
  }
  return false;
}

function assertProviderUrl(provider, url) {
  const target = assertString(url, "provider url");
  const parsed = new URL(target);
  if (isForbiddenHost(parsed.hostname)) throw new Error(`provider 地址指向禁止访问的主机: ${parsed.hostname}`);
  if (!profileUrlAllowed(provider, target)) {
    throw new Error(`${PROFILES[provider]?.label || provider} 地址不在允许的站点范围内`);
  }
  return target;
}

function normalizeProviderProfile(provider, value) {
  const profile = assertSafeName(value || "default", "login_profile", 64);
  return `${provider}/${profile}`;
}

function resolveProfilePath(params, provider) {
  const configured = String(params.user_data_dir || "").trim();
  const root = String(params.profile_root || "").trim();
  const loginProfile = assertSafeName(params.login_profile || "default", "login_profile", 64);
  if (configured && !root) return { path: path.resolve(configured), loginProfile };
  if (configured && root && loginProfile === "default" && params.use_legacy_profile !== false) {
    return { path: path.resolve(configured), loginProfile };
  }
  const base = root || path.join(process.env.NEO_ASK_AI_PLUGIN_DIR || process.cwd(), "data", "browser_profiles");
  return { path: path.resolve(base, provider, loginProfile), loginProfile };
}

function sanitizePageUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function nativeConversationId(provider, url) {
  try {
    const parsed = new URL(String(url || ""));
    const patterns = {
      doubao: /\/chat\/([^/?#]+)/i,
      deepseek: /\/a\/chat\/s\/([^/?#]+)/i,
      gemini: /\/app\/([^/?#]+)/i,
    };
    const match = String(parsed.pathname).match(patterns[provider]);
    return match ? String(match[1]).slice(0, 160) : "";
  } catch {
    return "";
  }
}

function sessionMetaKey(provider, loginProfile, sessionId) {
  return `${provider}#${loginProfile}#${sessionId}`;
}

function getSessionRecord(provider, sessionId) {
  const key = sessionMetaKey(provider, state.loginProfile, sessionId);
  return state.sessionMeta[key] || null;
}

function updateSessionRecord(provider, session, extra = {}) {
  const pageUrl = session.page && !session.page.isClosed() ? session.page.url() : "";
  const nativeId = nativeConversationId(provider, pageUrl);
  const key = sessionMetaKey(provider, state.loginProfile, session.sessionKey);
  const previous = state.sessionMeta[key] || {};
  state.sessionMeta[key] = {
    ...previous,
    provider,
    session_id: session.sessionKey,
    login_profile: state.loginProfile,
    native_conversation_id: extra.native_conversation_id || nativeId || previous.native_conversation_id || "",
    title: String(extra.title || previous.title || session.sessionKey).slice(0, 160),
    turns: sessionEntryTurns(session.sessionKey),
    page_url: sanitizePageUrl(pageUrl),
    created_at: previous.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    settings: extra.settings || previous.settings || {},
  };
  saveSessionMeta().catch(() => {});
  return state.sessionMeta[key];
}

function sessionEntryTurns(sessionId) {
  return state.sessions[sessionId] ? state.sessions[sessionId].turns || 0 : 0;
}

function titleMatches(candidate, target) {
  const left = String(candidate || "").trim();
  const right = String(target || "").trim();
  return Boolean(left && right && (left === right || left.startsWith(right) || left.includes(right)));
}

async function readVisibleText(locator) {
  try {
    if ((await locator.count()) === 0 || !(await locator.isVisible())) return "";
    return (await locator.innerText()).replace(/\s+/g, " ").trim().slice(0, 240);
  } catch {
    return "";
  }
}

async function findTextOption(page, values, timeoutMs = 1200) {
  const labels = (values || []).map(String).filter(Boolean);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const label of labels) {
      try {
        const locator = page.getByText(label, { exact: true }).first();
        if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
      } catch {
        // 文案探测失败继续下一个候选
      }
    }
    await sleep(150);
  }
  return null;
}

async function clickTextOption(page, values, timeoutMs = 2000) {
  const locator = await findTextOption(page, values, timeoutMs);
  if (!locator) return false;
  try {
    await locator.click({ timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function readToggleState(page, selectors) {
  for (const selector of selectors || []) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0 || !(await locator.isVisible())) continue;
      const pressed = await locator.getAttribute("aria-pressed");
      const checked = await locator.getAttribute("aria-checked");
      const stateValue = await locator.getAttribute("data-state");
      if (pressed != null) return pressed === "true";
      if (checked != null) return checked === "true";
      if (stateValue != null) return /on|checked|active|selected|true/i.test(stateValue);
      const cls = String((await locator.getAttribute("class")) || "");
      if (/active|selected|checked|enabled/i.test(cls)) return true;
      return false;
    } catch {
      // 继续
    }
  }
  return null;
}

async function setToggle(page, selectors, desired) {
  const current = await readToggleState(page, selectors);
  if (current === desired) return { requested: desired, effective: current, changed: false, warning: null };
  for (const selector of selectors || []) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0 || !(await locator.isVisible())) continue;
      await locator.click({ timeout: 2500 });
      await sleep(350);
      const effective = await readToggleState(page, selectors);
      return {
        requested: desired,
        effective,
        changed: true,
        warning: effective === desired ? null : "已点击候选开关，但未能确认目标状态",
      };
    } catch {
      // 继续尝试
    }
  }
  return { requested: desired, effective: null, changed: false, warning: "未找到可用开关控件" };
}

async function probeProfileCapabilities(page, profile) {
  const settings = profile.settings || {};
  const result = {};
  for (const [name, descriptor] of Object.entries(settings)) {
    if (descriptor.selectors) {
      const stateValue = await readToggleState(page, descriptor.selectors);
      result[name] = { available: stateValue !== null, current: stateValue, options: descriptor.options || [] };
      continue;
    }
    const trigger = descriptor.trigger || [];
    let triggerVisible = false;
    for (const selector of trigger) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0 && await locator.isVisible()) { triggerVisible = true; break; }
      } catch {
        // 忽略
      }
    }
    result[name] = { available: triggerVisible, current: null, options: descriptor.options || [] };
  }
  const historyItems = profile.history?.item || [];
  let historyAvailable = false;
  for (const selector of historyItems) {
    try {
      if ((await page.locator(selector).count()) > 0) { historyAvailable = true; break; }
    } catch {
      // 忽略
    }
  }
  result.history = { available: historyAvailable, options: [] };
  return result;
}

async function loadDriver() {
  if (state.driver) return state.driver;
  // 优先使用 rebrowser-playwright（修复 CDP Runtime.enable 检测特征，
  // 否则 Google 等站点会对自动化会话触发 /sorry 人机验证）；
  // 不可用时回退到原版 playwright-core。
  const candidates = ["rebrowser-playwright", "playwright-core"];
  let lastError = null;
  for (const packageName of candidates) {
    try {
      const module = await import(packageName);
      state.driver = module;
      state.driverPackage = packageName;
      return state.driver;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    "无法加载 rebrowser-playwright / playwright-core。请在插件目录执行 npm install；" +
      `原始错误: ${errorMessage(lastError)}`,
  );
}

function findExecutable(configured) {
  const explicit = String(configured || "").trim();
  if (explicit) return explicit;
  const candidates = [];
  if (process.platform === "win32") {
    for (const [envName, ...parts] of WINDOWS_EXECUTABLES) {
      const root = process.env[envName];
      if (root) candidates.push(path.join(root, ...parts));
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser",
      "/usr/bin/chromium",
    );
  }
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

const HIDE_WEBDRIVER_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = window.chrome || { runtime: {} };
`;

// ── 浏览器会话管理 ───────────────────────────────────────────────

function resetState() {
  state.browser = null;
  state.context = null;
  state.ownedBrowser = false;
  state.connectedOverCdp = false;
  state.profileDir = "";
  state.loginProfile = "default";
  state.sessionMetaPath = "";
  state.sessionMeta = {};
  state.sessions = {};
}

async function launchPersistentContext(driver, profileDir, options) {
  const explicitUa = String(options.user_agent || "").trim();
  if (explicitUa) {
    return driver.chromium.launchPersistentContext(profileDir, { ...options, userAgent: explicitUa });
  }
  // 无头模式的默认 UA 含 "HeadlessChrome" 标记且缺少品牌后缀（如 Edg/），
  // 与 Client-Hints 指纹不一致本身就是风控信号；显式覆盖 UA 又会引入版本错配
  // （HTTP UA / JS UA / Sec-CH-UA 三者对不上）。做法：先以真实 UA 启动一次，
  // 剥掉 Headless 标记后用完全一致的品牌与版本号重启。
  const probe = await driver.chromium.launchPersistentContext(profileDir, options);
  let realUa = "";
  try {
    const page = probe.pages()[0] || (await probe.newPage());
    await page.goto("about:blank");
    realUa = await page.evaluate(() => navigator.userAgent);
  } catch {
    realUa = "";
  } finally {
    try {
      await probe.close();
    } catch {
      // 探测浏览器关不掉时直接继续（进程由 launchPersistentContext 管理）
    }
  }
  const maskedUa = realUa.replace(/Headless([A-Za-z]+)/g, "$1");
  if (!realUa || maskedUa === realUa) {
    // 有头模式或探测失败：UA 本身无需处理，直接正常启动
    return driver.chromium.launchPersistentContext(profileDir, options);
  }
  await sleep(800); // 等 profile 锁释放
  return driver.chromium.launchPersistentContext(profileDir, { ...options, userAgent: maskedUa });
}

async function ensureBrowser(params = {}) {
  if (state.context) return { context: state.context, reused: true };
  const mode = String(params.mode || "launch").toLowerCase();
  const driver = await loadDriver();
  if (mode === "connect") {
    const cdpUrl = assertString(params.cdp_url, "cdp_url");
    const browser = await driver.chromium.connectOverCDP(cdpUrl, {
      timeout: toInt(params.connect_timeout_ms, 15000),
    });
    state.browser = browser;
    state.context = browser.contexts()[0] || (await browser.newContext());
    state.connectedOverCdp = true;
    state.headless = false;
  } else {
    const headless = params.headless === undefined ? true : Boolean(params.headless);
    const executablePath = findExecutable(params.executable_path);
    if (!executablePath && !params.allow_bundled_browser) {
      throw new Error(
        "未找到本机 Chrome/Edge/Brave，请在配置中填写 browser.executable_path，" +
          "或用 connect 模式连接已开启远程调试端口的浏览器",
      );
    }
    const profileInfo = await resolveProfilePath(params, String(params.provider || "global").toLowerCase());
    const profileDir = profileInfo.path;
    await fs.mkdir(profileDir, { recursive: true });
    await loadSessionMeta(profileDir);
    state.loginProfile = profileInfo.loginProfile;
    const launchOptions = {
      headless,
      executablePath: executablePath || undefined,
      viewport: {
        width: toInt(params.window_width, 1440),
        height: toInt(params.window_height, 900),
      },
      args: Array.isArray(params.extra_args) ? params.extra_args.map(String) : [],
      ignoreHTTPSErrors: true,
      timeout: toInt(params.launch_timeout_ms, 45000),
      user_agent: params.user_agent,
    };
    if (!headless) {
      // 有头模式 UA 无需处理，也不能拆两步启动
      const context = await driver.chromium.launchPersistentContext(profileDir, launchOptions);
      state.browser = context;
      state.context = context;
      state.ownedBrowser = true;
      state.headless = false;
    } else {
      const context = await launchPersistentContext(driver, profileDir, launchOptions);
      state.browser = context;
      state.context = context;
      state.ownedBrowser = true;
      state.headless = true;
    }
  }
  state.profileDir = state.profileDir || String(params.user_data_dir || "");
  try {
    await state.context.addInitScript(HIDE_WEBDRIVER_SCRIPT);
  } catch {
    // 已存在的 CDP context 可能不支持 addInitScript，忽略
  }
  return { context: state.context, reused: false };
}

// ── 页面辅助函数 ─────────────────────────────────────────────────

async function findVisibleLocator(page, selectors, { deadline, pollMs = 250 } = {}) {
  const limit = deadline || Date.now() + 15000;
  while (Date.now() < limit) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0 && (await locator.isVisible())) return locator;
      } catch {
        // 选择器失配继续尝试下一个
      }
    }
    await sleep(pollMs);
  }
  return null;
}

async function clickFirstVisible(page, selectors, clickTimeoutMs = 2500) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        await locator.click({ timeout: clickTimeoutMs });
        return true;
      }
    } catch {
      // 换下一个候选
    }
  }
  return false;
}

async function detectLoginWall(page, profile) {
  const url = page.url().toLowerCase();
  // 任何跳到登录路径/登录域名的页面都视为登录墙（含提供方自身的 /sign_in）
  if (/accounts\.google\.com|\/login|\/sign[-_]?in|sso\.|passport\.|\/auth[/?]|serviceLogin/.test(url)) {
    return true;
  }
  try {
    const bodyText = (await page.locator("body").innerText({ timeout: 3000 })).slice(0, 3000);
    for (const marker of profile.loginMarkers || []) {
      if (bodyText.includes(marker)) return true;
    }
  } catch {
    // 读不到正文时不误判
  }
  return false;
}

async function detectRegionBan(page, profile) {
  const url = page.url().toLowerCase();
  if (/region[-_]ban|unsupported[-_]region|not[-_]available[-_]in/.test(url)) return true;
  try {
    const bodyText = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 2000);
    for (const marker of profile.banMarkers || []) {
      if (bodyText.includes(marker)) return true;
    }
  } catch {
    // 忽略
  }
  return false;
}

function loginErrorMessage(profile, page) {
  return (
    `${profile.label} 网页版未登录（当前页面: ${page.url()}）。` +
    "请用同一浏览器配置目录（user_data_dir）临时关闭无头模式登录一次，" +
    "或改用 connect 模式连接已登录的浏览器"
  );
}

// 标记"页面已不可用"的会话级致命错误：web_ai_chat 失败后清理该会话。
// 超时等非致命错误不标记，保留页面供下一轮继续。
function fatalSessionError(message) {
  const error = new Error(message);
  error.sessionFatal = true;
  return error;
}

// 等待输入框出现；期间持续复查登录墙/封锁页，处理慢速 JS 跳转
async function waitForComposerOrLogin(page, profile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captcha = await detectCaptcha(page, profile);
    if (captcha) {
      throw fatalSessionError(`${profile.label} 触发验证或异常流量（${captcha}），已停止继续请求，请人工处理后重试`);
    }
    if (await detectRegionBan(page, profile)) {
      throw fatalSessionError(
        `${profile.label} 当前网络出口被限制使用（当前页面: ${page.url()}）。请更换代理节点或使用可用的网络出口`,
      );
    }
    if (await detectLoginWall(page, profile)) {
      throw fatalSessionError(loginErrorMessage(profile, page));
    }
    const composer = await findVisibleLocator(page, profile.composer, {
      deadline: Math.min(Date.now() + 1200, deadline),
    });
    if (composer) return composer;
  }
  throw fatalSessionError(
    `等待 ${profile.label} 输入框超时（当前页面: ${page.url()}）。` +
      "若页面要求登录，请先用同一 user_data_dir 关闭无头登录一次",
  );
}

async function uploadFileToPage(page, profile, filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // 1) 页面上已有可用的 file input
  for (const selector of profile.fileInput || ['input[type="file"]']) {
    try {
      const locator = page.locator(selector).last();
      if ((await locator.count()) > 0) {
        await locator.setInputFiles(filePath, { timeout: 10000 });
        return "input";
      }
    } catch {
      // 尝试 filechooser 路径
    }
  }
  // 2) 点击上传按钮触发 filechooser
  const attachSelectors = profile.attachButton || [];
  if (attachSelectors.length > 0) {
    try {
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
      const clicked = await clickFirstVisible(page, attachSelectors);
      if (clicked) {
        const chooser = await chooserPromise;
        await chooser.setFiles(filePath);
        return "filechooser";
      }
    } catch {
      // 继续兜底
    }
  }
  // 3) 兜底：全页任意 file input（可能在 shadow DOM 外层）
  try {
    const locator = page.locator('input[type="file"]').last();
    await locator.waitFor({ state: "attached", timeout: Math.max(1000, deadline - Date.now()) });
    await locator.setInputFiles(filePath, { timeout: 10000 });
    return "input-fallback";
  } catch (error) {
    throw new Error(`找不到可用的上传入口（上传按钮/文件选择器均失配）: ${errorMessage(error)}`);
  }
}

async function fillComposer(page, profile, prompt, existingComposer = null) {
  const composer =
    existingComposer && (await existingLocatorAlive(existingComposer))
      ? existingComposer
      : await findVisibleLocator(page, profile.composer, { deadline: Date.now() + 20000 });
  if (!composer) {
    throw fatalSessionError(
      `找不到 ${profile.label} 的输入框（当前页面: ${page.url()}）。` +
        "若页面要求登录，请先用同一 user_data_dir 关闭无头登录一次",
    );
  }
  const head = prompt.slice(0, 32);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await composer.click({ timeout: 3000 });
      await composer.fill(prompt, { timeout: 5000, force: true });
    } catch {
      try {
        await composer.click({ timeout: 3000 });
        await page.keyboard.insertText(prompt);
      } catch {
        // 下一次重试
      }
    }
    try {
      const content = (await composer.innerText({ timeout: 2000 })).trim();
      const value = await composer.inputValue().catch(() => "");
      if ((content + value).includes(head) || head.length === 0) return composer;
    } catch {
      return composer; // 读取失败时按已填入处理
    }
    await sleep(400);
  }
  throw new Error("输入框内容校验失败，未能确认提示词已填入");
}

async function pressSend(page, profile, composer) {
  try {
    await composer.click({ timeout: 2000 });
    await page.keyboard.press("Enter");
    return "enter";
  } catch {
    // 尝试点击发送按钮
  }
  const sendSelectors = [
    'button[aria-label*="Send" i]',
    'button[aria-label*="发送" i]',
    'div[role="button"][aria-label*="Send" i]',
    'button[data-testid*="send" i]',
  ];
  if (await clickFirstVisible(page, sendSelectors)) return "button";
  throw new Error("无法发送提示词（Enter 与发送按钮均失败）");
}

async function collectChatState(page, profile) {
  const payload = {
    reply: profile.reply || [],
    stop: profile.stop || [],
  };
  return await page.evaluate(({ reply, stop }) => {
    let nodes = [];
    for (const selector of reply) {
      try {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length > 0) {
          nodes = found;
          break;
        }
      } catch {
        // 非法选择器跳过
      }
    }
    // 保留最深层的回复节点，避免祖先容器重复计入
    const deepest = nodes.filter(
      (node) => !nodes.some((other) => other !== node && node.contains(other)),
    );
    const texts = deepest
      .map((node) => (node.innerText || "").trim())
      .filter((text) => text.length > 0);
    let stopVisible = false;
    for (const selector of stop) {
      try {
        const element = document.querySelector(selector);
        if (element && element.offsetParent !== null) {
          stopVisible = true;
          break;
        }
      } catch {
        // 跳过
      }
    }
    // 回复节点内的可下载资源（供后续下载/发送）
    const links = [];
    const seenLink = new Set();
    const images = [];
    const seenImage = new Set();
    for (const node of deepest) {
      for (const anchor of node.querySelectorAll("a[href]")) {
        const href = anchor.href || "";
        if (!/^https?:/i.test(href) || seenLink.has(href)) continue;
        seenLink.add(href);
        links.push({
          text: (anchor.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
          href,
        });
        if (links.length >= 12) break;
      }
      for (const img of node.querySelectorAll("img[src]")) {
        const src = img.src || "";
        if (!/^https?:/i.test(src) || seenImage.has(src)) continue;
        seenImage.add(src);
        images.push({ alt: (img.alt || "").slice(0, 100), src });
        if (images.length >= 8) break;
      }
      if (links.length >= 12 && images.length >= 8) break;
    }
    return { texts, stopVisible, links, images, url: location.href };
  }, payload);
}

async function waitForReply(page, profile, options) {
  const { preTexts, replyTimeoutMs, pollIntervalMs, maxChars } = options;
  const deadline = Date.now() + replyTimeoutMs;
  const sendTime = Date.now();
  const preSet = new Set((preTexts || []).map((text) => text.trim()).filter((text) => text));
  let stableCount = 0;
  let prevLast = "";
  let lastState = null;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let chat;
    try {
      chat = await collectChatState(page, profile);
    } catch {
      continue; // 页面跳转/重渲染瞬间的采集失败直接重试
    }
    lastState = chat;
    // 只认发送前不存在的文本，避免把欢迎语/静态文案当成回复
    const newTexts = chat.texts.filter((text) => !preSet.has(text.trim()));
    const last = newTexts.length > 0 ? newTexts[newTexts.length - 1] : "";
    if (last && last === prevLast) {
      stableCount += 1;
    } else {
      prevLast = last;
      stableCount = 0;
    }
    const generated = Date.now() - sendTime > 2500;
    if (
      generated &&
      !chat.stopVisible &&
      last &&
      last.trim().length > 0 &&
      stableCount >= 2
    ) {
      return {
        reply: last.slice(0, maxChars),
        texts: chat.texts.length,
        url: chat.url,
        links: chat.links || [],
        images: chat.images || [],
      };
    }
  }
  const remainingTexts = lastState
    ? lastState.texts.filter((text) => !preSet.has(text.trim()))
    : [];
  return {
    reply: (remainingTexts.pop() || "").slice(0, maxChars),
    timedOut: true,
    url: lastState ? lastState.url : page.url(),
    links: lastState ? lastState.links || [] : [],
    images: lastState ? lastState.images || [] : [],
  };
}

// ── 会话管理 ─────────────────────────────────────────────────────
// 每个会话 = 一张独立的站点页面（同一站点聊天线程持续多轮）。
// session_id 由调用方命名；未命名时使用 provider#default 常驻会话，
// 匿名一次性请求使用 provider#onetime（每次覆盖）。

function sessionKeyFor(provider, params) {
  const requested = String(params.session_id || "").trim();
  const profile = assertSafeName(params.login_profile || state.loginProfile || "default", "login_profile", 64);
  const scoped = (value) => `${provider}#${profile}#${value}`;
  if (requested) return scoped(requested);
  const explicitNewChat = params.new_chat;
  const newChat = explicitNewChat === undefined ? true : Boolean(explicitNewChat);
  return scoped(newChat ? "onetime" : "default");
}

function enforceSessionCap() {
  const cap = Math.max(1, toInt(state.sessionMaxCount, 12));
  const entries = Object.entries(state.sessions).sort(
    (a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0),
  );
  while (entries.length > cap) {
    const [key, entry] = entries.shift();
    if (entry.page && !entry.page.isClosed()) {
      entry.page.close().catch(() => {});
    }
    delete state.sessions[key];
  }
}

async function resolveSessionPage(context, provider, profile, params) {
  const key = sessionKeyFor(provider, params);
  const explicitNewChat = params.new_chat;
  const newChat =
    explicitNewChat === undefined ? key.endsWith("#onetime") : Boolean(explicitNewChat);

  const entry = state.sessions[key];
  const pageAlive =
    entry &&
    entry.page &&
    !entry.page.isClosed() &&
    entry.page.url().includes(profile.domain || provider);

  if (entry && (!pageAlive || newChat) && entry.page && !entry.page.isClosed()) {
    try {
      await entry.page.close();
    } catch {
      // 关闭旧页失败不影响新会话
    }
  }

  let page = pageAlive && !newChat ? entry.page : null;
  let sessionRestored = false;
  if (!page) {
    // 有会话名但页面已丢失（worker 重启/页面被关）时标记 restored
    sessionRestored = Boolean(entry && entry.page);
    page = await context.newPage();
    const target = assertProviderUrl(provider, params.url || profile.newChatUrl);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
  }

  state.sessions[key] = {
    page,
      provider,
      title: String(params.conversation_title || entry?.title || key).slice(0, 160),
      nativeConversationId: entry?.nativeConversationId || "",
      createdAt: entry && pageAlive ? entry.createdAt : Date.now(),
      lastUsed: Date.now(),
    turns: pageAlive && !newChat ? (entry.turns || 0) : 0,
  };
  enforceSessionCap();
  return { page, sessionKey: key, isNewChat: newChat || !pageAlive, sessionRestored };
}

function listSessions() {
  return Object.entries(state.sessions).map(([key, entry]) => ({
    session_id: key,
    provider: entry.provider,
    turns: entry.turns || 0,
    page_url: entry.page && !entry.page.isClosed() ? sanitizePageUrl(entry.page.url()) : "",
    title: String(entry.title || key).slice(0, 160),
    login_profile: state.loginProfile,
    alive: Boolean(entry.page && !entry.page.isClosed()),
    created_at: entry.createdAt,
    last_used_at: entry.lastUsed,
  }));
}

async function actionSessionList() {
  return { sessions: listSessions() };
}

async function actionSessionClose(params) {
  if (params.close_all) {
    const closed = [];
    for (const [key, entry] of Object.entries(state.sessions)) {
      if (entry.page && !entry.page.isClosed()) {
        try {
          await entry.page.close();
        } catch {
          // 忽略
        }
      }
      closed.push(key);
      delete state.sessions[key];
    }
    return { closed };
  }
  const key = assertString(params.session_id, "session_id");
  const entry = state.sessions[key];
  if (!entry) return { closed: [], not_found: key };
  if (entry.page && !entry.page.isClosed()) {
    try {
      await entry.page.close();
    } catch {
      // 忽略
    }
  }
  delete state.sessions[key];
  return { closed: [key] };
}

async function actionLoginCheck(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const profile = PROFILES[provider];
  if (!profile) {
    throw new Error(`不支持的 provider: ${provider || "(空)"}；可选 doubao / deepseek / gemini`);
  }
  const { context } = await ensureBrowser(params);
  const page = await context.newPage();
  try {
    await page.goto(assertProviderUrl(provider, params.url || profile.newChatUrl), {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    const login = await detectLoginState(page, profile);
    if (login.state === "captcha_required") markRisk(provider, "captcha", login.reason);
    if (login.state === "region_banned") markRisk(provider, "region_banned", "地区限制");
    if (login.state === "login_required") markRisk(provider, "login_required", "需要登录");
    if (login.logged_in) markRisk(provider, "normal", "");
    const capabilities = await probeProfileCapabilities(page, profile);
    return { provider, ...login, login_profile: state.loginProfile, capabilities, risk_state: riskStateFor(provider), page_url: sanitizePageUrl(page.url()) };
  } finally {
    try {
      await page.close();
    } catch {
      // 忽略
    }
  }
}

async function applyProfileSettings(page, profile, params = {}) {
  const requested = {};
  const effective = {};
  const warnings = [];
  const settings = profile.settings || {};

  const setTier = async (value) => {
    const descriptor = settings.tier;
    if (!descriptor || value == null) return null;
    const normalized = String(value).trim().toLowerCase();
    const labels = Object.entries(descriptor.options || {}).find(([key]) => key.toLowerCase() === normalized)?.[1];
    if (!labels) return { requested: value, effective: null, warning: `不支持的 ${profile.label} 档位: ${value}` };
    const trigger = await findVisibleLocator(page, descriptor.trigger || [], { deadline: Date.now() + 1500 });
    if (trigger) await trigger.click({ timeout: 2000 }).catch(() => {});
    const clicked = await clickTextOption(page, labels, 1800);
    if (!clicked) return { requested: value, effective: null, warning: `${profile.label} 未找到档位选项: ${value}` };
    await sleep(300);
    return { requested: value, effective: keyForOption(descriptor.options, labels), warning: null };
  };

  const setModel = async (value) => {
    const descriptor = settings.model;
    if (!descriptor || value == null) return null;
    const normalized = String(value).trim().toLowerCase();
    const labels = Object.entries(descriptor.options || {}).find(([key]) => key.toLowerCase() === normalized)?.[1] || [String(value)];
    const trigger = await findVisibleLocator(page, descriptor.trigger || [], { deadline: Date.now() + 1500 });
    if (!trigger) return { requested: value, effective: null, warning: `${profile.label} 模型选择器不可用` };
    await trigger.click({ timeout: 2000 }).catch(() => {});
    const clicked = await clickTextOption(page, labels, 1800);
    if (!clicked) return { requested: value, effective: null, warning: `${profile.label} 未找到模型选项: ${value}` };
    await sleep(350);
    return { requested: value, effective: String(value), warning: null };
  };

  const setNamedToggle = async (name, value) => {
    const descriptor = settings[name];
    if (!descriptor || value == null) return null;
    const result = await setToggle(page, descriptor.selectors || [], Boolean(value));
    return { requested: Boolean(value), effective: result.effective, warning: result.warning };
  };

  const engine = profile === PROFILES.doubao ? "doubao" : profile === PROFILES.deepseek ? "deepseek" : "gemini";
  if (params.model != null && String(params.model).trim()) {
    requested.model = params.model;
    const result = await setModel(params.model);
    if (result) {
      effective.model = result.effective;
      if (result.warning) warnings.push(result.warning);
    }
  }

  let tierValue = params.tier;
  if (engine === "doubao" && params.deep_thinking != null) {
    tierValue = params.deep_thinking ? "super" : "fast";
    requested.deep_thinking = Boolean(params.deep_thinking);
  }
  if (tierValue != null) {
    requested.tier = tierValue;
    const result = await setTier(tierValue);
    if (result) {
      effective.tier = result.effective;
      if (result.warning) warnings.push(result.warning);
    }
  }

  if (engine === "deepseek") {
    const deep = params.deep_thinking;
    const search = params.web_search;
    if (deep != null && search != null && Boolean(deep) && Boolean(search)) {
      warnings.push("DeepSeek 的深度思考与智能搜索不能同时启用，已优先深度思考");
    }
    const deepResult = await setNamedToggle("deepThinking", deep != null ? Boolean(deep) : null);
    const searchResult = await setNamedToggle("webSearch", deep === true ? false : search != null ? Boolean(search) : null);
    if (deepResult) { requested.deep_thinking = deepResult.requested; effective.deep_thinking = deepResult.effective; if (deepResult.warning) warnings.push(deepResult.warning); }
    if (searchResult) { requested.web_search = searchResult.requested; effective.web_search = searchResult.effective; if (searchResult.warning) warnings.push(searchResult.warning); }
  } else if (engine === "gemini") {
    const thinkingResult = await setNamedToggle("deepThinking", params.deep_thinking != null ? Boolean(params.deep_thinking) : null);
    const searchResult = await setNamedToggle("webSearch", params.web_search != null ? Boolean(params.web_search) : null);
    const researchResult = await setNamedToggle("deepResearch", params.deep_research != null ? Boolean(params.deep_research) : null);
    for (const [name, result] of [["deep_thinking", thinkingResult], ["web_search", searchResult], ["deep_research", researchResult]]) {
      if (result) { requested[name] = result.requested; effective[name] = result.effective; if (result.warning) warnings.push(result.warning); }
    }
  } else if (engine === "doubao" && params.web_search != null) {
    requested.web_search = Boolean(params.web_search);
    if (params.web_search) {
      if (params.deep_thinking === false) warnings.push("豆包的联网能力与超能模式耦合，无法同时保证关闭深度思考");
      const result = await setTier("super");
      effective.web_search = result?.effective ?? null;
      if (result?.warning) warnings.push(result.warning);
    } else {
      effective.web_search = false;
    }
  }

  return { requested, effective, warnings };
}

function keyForOption(options, labels) {
  const first = String(labels?.[0] || "").toLowerCase();
  return Object.entries(options || {}).find(([, values]) => values.some((value) => String(value).toLowerCase() === first))?.[0] || labels?.[0] || null;
}

async function actionCapabilities(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const profile = PROFILES[provider];
  if (!profile) throw new Error(`不支持的 provider: ${provider || "(空)"}`);
  const { context } = await ensureBrowser({ ...params, provider });
  const page = await context.newPage();
  try {
    await page.goto(assertProviderUrl(provider, params.url || profile.newChatUrl), { waitUntil: "domcontentloaded", timeout: 45000 });
    const login = await detectLoginState(page, profile);
    const capabilities = await probeProfileCapabilities(page, profile);
    return { provider, login, capabilities, login_profile: state.loginProfile, risk_state: riskStateFor(provider), page_url: sanitizePageUrl(page.url()), warnings: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

async function detectLoginState(page, profile) {
  const captcha = await detectCaptcha(page, profile);
  if (captcha) return { state: "captcha_required", logged_in: false, reason: captcha };
  const region = await detectRegionBan(page, profile);
  if (region) return { state: "region_banned", logged_in: false };
  const loginWall = await detectLoginWall(page, profile);
  if (loginWall) return { state: "login_required", logged_in: false };
  const composer = await findVisibleLocator(page, profile.composer, { deadline: Date.now() + 5000 });
  return { state: composer ? "logged_in" : "unknown", logged_in: Boolean(composer) };
}

async function detectCaptcha(page, profile) {
  const url = page.url().toLowerCase();
  if (/captcha|verifycenter|rmc\.bytedance|unusual[-_ ]?traffic|challenge/.test(url)) return "页面 URL 命中风控验证";
  try {
    const body = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 5000);
    for (const marker of profile.captchaMarkers || []) if (body.includes(marker)) return marker;
    const iframe = page.locator('iframe[src*="captcha"], iframe[src*="verifycenter"], iframe[src*="rmc.bytedance"]');
    if ((await iframe.count()) > 0) return "验证码 iframe";
  } catch {
    // 忽略
  }
  return "";
}

async function listNativeHistory(page, profile, provider) {
  const items = [];
  const seen = new Set();
  for (const selector of profile.history?.item || []) {
    try {
      for (const node of await page.locator(selector).all()) {
        const title = (await node.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
        const href = await node.getAttribute("href").catch(() => "") || "";
        const id = nativeConversationId(provider, href || page.url());
        const key = `${title}|${id}|${href}`;
        if (!title && !id || seen.has(key)) continue;
        seen.add(key);
        items.push({ provider, title, native_conversation_id: id, href: sanitizePageUrl(href), source: "native_probe" });
        if (items.length >= 100) return items;
      }
    } catch {
      // selector 改版时继续其它候选
    }
  }
  return items;
}

async function actionHistoryList(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  if (!PROFILES[provider]) throw new Error(`不支持的 provider: ${provider || "(空)"}`);
  const local = Object.values(state.sessionMeta).filter((item) => item.provider === provider && item.login_profile === state.loginProfile).slice(-100);
  let native = [];
  const entry = Object.values(state.sessions).find((item) => item.provider === provider && item.page && !item.page.isClosed());
  if (entry) native = await listNativeHistory(entry.page, PROFILES[provider], provider);
  const merged = [...local];
  const seen = new Set(merged.map((item) => `${item.title}|${item.native_conversation_id}`));
  for (const item of native) {
    const key = `${item.title}|${item.native_conversation_id}`;
    if (!seen.has(key)) { seen.add(key); merged.push(item); }
  }
  return { provider, login_profile: state.loginProfile, histories: merged.slice(-100), risk_state: riskStateFor(provider) };
}

async function actionHistoryResume(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const profile = PROFILES[provider];
  if (!profile) throw new Error(`不支持的 provider: ${provider || "(空)"}`);
  const title = assertSafeName(params.title || params.conversation_title, "title", 160);
  const candidates = Object.values(state.sessionMeta).filter((item) => item.provider === provider && item.login_profile === state.loginProfile && titleMatches(item.title, title));
  const selected = candidates.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!selected) return { provider, title, session_restored: false, reason: "history_title_not_found", warnings: [] };
  const key = selected.session_id;
  const live = state.sessions[key];
  if (live?.page && !live.page.isClosed()) return { provider, title: selected.title, session_id: key, session_restored: true, native_conversation_id: selected.native_conversation_id || "", warnings: [] };
  const { context } = await ensureBrowser({ ...params, provider });
  const page = await context.newPage();
  try {
    let target = profile.newChatUrl;
    if (selected.native_conversation_id) {
      if (provider === "doubao") target = `https://www.doubao.com/chat/${selected.native_conversation_id}`;
      if (provider === "deepseek") target = `https://chat.deepseek.com/a/chat/s/${selected.native_conversation_id}`;
      if (provider === "gemini") target = `https://gemini.google.com/app/${selected.native_conversation_id}`;
    }
    await page.goto(assertProviderUrl(provider, target), { waitUntil: "domcontentloaded", timeout: 45000 });
    const login = await detectLoginState(page, profile);
    if (!login.logged_in) { await page.close().catch(() => {}); return { provider, title, session_id: key, session_restored: false, reason: login.state, warnings: [] }; }
    state.sessions[key] = { page, provider, title: selected.title, createdAt: selected.created_at || Date.now(), lastUsed: Date.now(), turns: selected.turns || 0 };
    return { provider, title: selected.title, session_id: key, session_restored: true, native_conversation_id: selected.native_conversation_id || "", warnings: selected.native_conversation_id ? [] : ["未找到站点原生会话 ID，已打开新页面；上下文可能不可恢复"] };
  } catch (error) {
    await page.close().catch(() => {});
    return { provider, title, session_id: key, session_restored: false, reason: errorMessage(error), warnings: [] };
  }
}

async function actionHistoryRename(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const sessionId = assertSafeName(params.session_id, "session_id");
  const title = assertSafeName(params.title, "title", 160);
  const key = sessionMetaKey(provider, state.loginProfile, sessionId);
  if (!state.sessionMeta[key]) return { renamed: false, not_found: sessionId };
  state.sessionMeta[key].title = title;
  state.sessionMeta[key].updated_at = new Date().toISOString();
  await saveSessionMeta();
  return { renamed: true, session_id: sessionId, title, native_renamed: false, warning: "仅更新插件历史标题；站点原生重命名未强行执行" };
}

async function actionHistoryDelete(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const sessionId = assertSafeName(params.session_id, "session_id");
  if (params.confirm !== true) throw new Error("删除历史会话必须显式 confirm=true");
  const key = sessionMetaKey(provider, state.loginProfile, sessionId);
  const entry = state.sessions[key];
  if (entry?.page && !entry.page.isClosed()) await entry.page.close().catch(() => {});
  delete state.sessions[key];
  const deleted = Boolean(state.sessionMeta[key]);
  delete state.sessionMeta[key];
  await saveSessionMeta();
  return { deleted, session_id: sessionId, native_deleted: false, warning: "仅删除插件元数据与活动页面；站点原生历史未强行删除" };
}

async function actionLoginProfiles(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  if (!PROFILES[provider]) throw new Error(`不支持的 provider: ${provider || "(空)"}`);
  const root = path.join(process.env.NEO_ASK_AI_PLUGIN_DIR || process.cwd(), "data", "browser_profiles", provider);
  await fs.mkdir(root, { recursive: true });
  const names = (await fs.readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).filter((name) => /^[\w\-.\u4e00-\u9fff ]+$/u.test(name));
  return { provider, active_profile: state.loginProfile, profiles: names };
}

async function actionLogout(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  if (!PROFILES[provider]) throw new Error(`不支持的 provider: ${provider || "(空)"}`);
  if (params.confirm !== true) throw new Error("清理登录态必须显式 confirm=true");
  const profileInfo = resolveProfilePath(params, provider);
  if (path.resolve(profileInfo.path) === path.resolve(state.profileDir) && state.ownedBrowser) await actionShutdown({ close_owned_browser: true });
  await fs.rm(profileInfo.path, { recursive: true, force: true });
  return { provider, login_profile: profileInfo.loginProfile, logged_out: true };
}

async function actionProviderSettings(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const profile = PROFILES[provider];
  if (!profile) throw new Error(`不支持的 provider: ${provider || "(空)"}`);
  const browser = state.context ? { context: state.context } : await ensureBrowser({ ...params, provider });
  const session = await resolveSessionPage(browser.context, provider, profile, {
    ...params,
    new_chat: false,
    session_id: params.session_id || `${provider}#settings`,
  });
  const applied = await applyProfileSettings(session.page, profile, params);
  return { provider, session_id: session.sessionKey, ...applied, capabilities: await probeProfileCapabilities(session.page, profile), risk_state: riskStateFor(provider) };
}

async function actionHistoryGet(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const sessionId = assertSafeName(params.session_id, "session_id");
  const key = sessionMetaKey(provider, state.loginProfile, sessionId);
  const record = state.sessionMeta[key];
  if (!record) return { found: false, session_id: sessionId };
  const entry = state.sessions[key];
  let context = "";
  if (entry?.page && !entry.page.isClosed()) context = (await entry.page.locator("body").innerText().catch(() => "")).slice(-12000);
  return { found: true, ...record, context, context_truncated: context.length >= 12000 };
}

async function actionWriteSessionRecord(session, provider, settings = {}) {
  const meta = updateSessionRecord(provider, session, { title: session.title, settings });
  return meta;
}

async function writeTempFile(dataB64, suffix) {
  const safeSuffix = /^[A-Za-z0-9.]{1,12}$/.test(String(suffix || "")) ? String(suffix) : ".bin";
  const target = path.join(os.tmpdir(), `ask-ai-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeSuffix}`);
  const buffer = Buffer.from(String(dataB64 || ""), "base64");
  if (!buffer.length) throw new Error("图片 base64 数据为空");
  await fs.writeFile(target, buffer);
  return target;
}

// ── 动作实现 ─────────────────────────────────────────────────────

async function actionStatus() {
  const pages = [];
  if (state.context) {
    try {
      for (const page of state.context.pages()) {
        pages.push({ url: sanitizePageUrl(page.url()), closed: page.isClosed() });
      }
    } catch {
      // 忽略
    }
  }
  return {
    connected: Boolean(state.context),
    owned_browser: state.ownedBrowser,
    connected_over_cdp: state.connectedOverCdp,
    headless: state.headless,
    profile_dir: state.profileDir,
    login_profile: state.loginProfile,
    driver_package: state.driverPackage || "",
    sessions: listSessions(),
    pages,
    risk: state.risk,
  };
}

async function actionConnect(params) {
  await ensureBrowser({ ...params, mode: "connect" });
  return actionStatus();
}

async function actionLaunch(params) {
  if (state.context) return actionStatus();
  await ensureBrowser({ ...params, mode: "launch" });
  return actionStatus();
}

// Lens 风控冷却：触发 /sorry 后短时间内拒绝新请求，避免加重 Google 对出口 IP 的限流
const lensCooldown = { lastSorryAt: 0, cooldownMs: 60000 };
// 拟人间隔：两次反搜之间的最小间隔 + 随机抖动（约 3~8 秒），降低风控风险
const lensPacing = { lastFinishedAt: 0 };
const LENS_HOME_URL = "https://www.google.com/?hl=zh-CN";
const LENS_DEBUG_DIR = path.join(
  process.env.NEO_ASK_AI_PLUGIN_DIR || process.cwd(),
  "data",
  "debug",
);

function isCaptchaUrl(url) {
  // /sorry 可能出现在 google.com 或地区域名（如 google.com.hk）下
  return String(url || "").includes("/sorry");
}

function lensCaptchaError(pageUrl) {
  return new Error(
    `Google 触发了人机验证（/sorry 风控页，页面: ${pageUrl}）。当前网络出口 IP 信誉较差，` +
      "请在代理中为 Google 域名更换节点/直连，或用同一 user_data_dir 关闭无头完成一次 Google 登录后重试",
  );
}

async function handleGoogleConsent(page) {
  // Google 同意页兜底
  try {
    if (!page.url().includes("consent.google.")) return;
    await clickFirstVisible(
      page,
      [
        'button:has-text("Accept all")',
        'button:has-text("我同意")',
        'button:has-text("全部接受")',
        'form[action*="consent"] button',
      ],
      4000,
    );
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
  } catch {
    // 无法处理同意页时继续尝试
  }
}

async function saveLensDebugScreenshot(page, tag) {
  // 失败截图存档（保留 7 天），便于排查页面改版/风控
  try {
    await fs.mkdir(LENS_DEBUG_DIR, { recursive: true });
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const name of await fs.readdir(LENS_DEBUG_DIR)) {
      const old = path.join(LENS_DEBUG_DIR, name);
      try {
        const stat = await fs.stat(old);
        if (stat.isFile() && stat.mtimeMs < cutoff) await fs.unlink(old);
      } catch {
        // 忽略
      }
    }
    const shot = path.join(LENS_DEBUG_DIR, `lens_${tag}_${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    return shot;
  } catch {
    return "";
  }
}

// AI 概览定位（等待与提取共用）：「AI 概览」是带图标的小标签（非标题），
// 从标签向上逐层找第一个包含完整正文（>80 字符）的容器。
async function lensOverviewText(page) {
  try {
    return await page.evaluate(() => {
      const labels = [];
      for (const el of document.querySelectorAll("span, div, h1, h2, h3, h4, h5, h6, p")) {
        if (el.children.length > 1) continue;
        const text = (el.textContent || "").trim();
        if ((text === "AI 概览" || text === "AI Overview") && text.length <= 16) labels.push(el);
      }
      if (labels.length === 0) return "";
      let node = labels[labels.length - 1].parentElement;
      for (let depth = 0; depth < 4 && node; depth += 1) {
        const inner = (node.innerText || "").trim();
        if (inner.length > 80) return inner;
        node = node.parentElement;
      }
      return "";
    });
  } catch {
    return "";
  }
}

// AI 概览为流式生成：文本长度连续两次采样（约 1 秒）不变即视为完成。
// 页面顶部另有 3 个永不消失的装饰性 progressbar，不能作为完成信号。
// 未登录会话可能根本不生成 AI 概览：结果区已渲染但 15 秒内始终没有
// 「AI 概览」标签时提前放弃，直接提取外观匹配，避免白等满 60 秒。
async function waitLensOverviewDone(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastLen = -1;
  let stable = 0;
  let noOverviewSince = 0;
  while (Date.now() < deadline) {
    if (isCaptchaUrl(page.url())) return false;
    const text = await lensOverviewText(page);
    if (text) {
      noOverviewSince = 0;
      if (text.length === lastLen) {
        stable += 1;
        if (stable >= 2) return true;
      } else {
        stable = 0;
      }
      lastLen = text.length;
    } else {
      lastLen = -1;
      stable = 0;
      if (!noOverviewSince) noOverviewSince = Date.now();
      else if (Date.now() - noOverviewSince > 15000) return false;
    }
    await sleep(500);
  }
  return lastLen > 0; // 超时但已有内容 → 部分成功
}

// 单页提取：AI 概览正文与链接、外观匹配、相似图缩略图
async function extractLensPageData(page) {
  return page.evaluate(() => {
    const out = {
      overview_text: "",
      overview_links: [],
      visual_matches: [],
      similar_images: [],
      external_links: [],
      body_text: "",
    };
    try {
      out.body_text = (document.body.innerText || "").trim();
    } catch {
      out.body_text = "";
    }
    // AI 概览：标签向上找包含完整正文的容器
    const labels = [];
    for (const el of document.querySelectorAll("span, div, h1, h2, h3, h4, h5, h6, p")) {
      if (el.children.length > 1) continue;
      const text = (el.textContent || "").trim();
      if ((text === "AI 概览" || text === "AI Overview") && text.length <= 16) labels.push(el);
    }
    if (labels.length > 0) {
      let node = labels[labels.length - 1].parentElement;
      for (let depth = 0; depth < 4 && node; depth += 1) {
        const inner = (node.innerText || "").trim();
        if (inner.length > 80) {
          out.overview_text = inner;
          const seenUrl = new Set();
          for (const a of node.querySelectorAll("a[href]")) {
            const title = (a.innerText || "").replace(/\s+/g, " ").trim();
            let href = a.getAttribute("href") || "";
            if (!title || !href || href.startsWith("#")) continue;
            if (href.startsWith("/")) href = "https://www.google.com" + href;
            if (seenUrl.has(href)) continue;
            seenUrl.add(href);
            out.overview_links.push({ title: title.slice(0, 160), url: href });
          }
          break;
        }
        node = node.parentElement;
      }
    }
    // 外观匹配：「外观匹配」区块标题存在时全页扫 h3
    //（实测结果 h3 不在 <main> 里；每条 = h3 标题 + 最近的 ancestor <a>，首行多为来源名）
    const hasMatchesHeading = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    ).some((h) =>
      /外观匹配|视觉匹配|Visual matches|Exact matches|完全匹配/i.test(
        (h.textContent || "").trim(),
      ),
    );
    if (hasMatchesHeading) {
      const seenTitle = new Set();
      for (const item of document.querySelectorAll("h3")) {
        const title = (item.innerText || "").replace(/\s+/g, " ").trim();
        if (!title || seenTitle.has(title)) continue;
        const a = item.closest("a");
        if (!a) continue;
        let href = a.getAttribute("href") || "";
        if (!href) continue;
        if (href.startsWith("/")) href = "https://www.google.com" + href;
        const blockLines = (a.innerText || "").trim().split("\n");
        const source = (blockLines[0] || "").replace(/\s+/g, " ").trim().slice(0, 60);
        seenTitle.add(title);
        out.visual_matches.push({ title: title.slice(0, 200), source, url: href });
        if (out.visual_matches.length >= 30) break;
      }
      // 补充扫描：部分结果卡片不是 h3 结构，改扫 /goto 跳转锚点
      //（标题取锚点文本中最长的一行或图片 alt）
      if (out.visual_matches.length < 12) {
        const seenUrl = new Set(out.visual_matches.map((m) => m.url));
        for (const a of document.querySelectorAll('a[href*="/goto?url="]')) {
          if (out.visual_matches.length >= 30) break;
          const href = a.href || "";
          if (!href || seenUrl.has(href)) continue;
          const lines = (a.innerText || "")
            .split("\n")
            .map((line) => line.replace(/\s+/g, " ").trim())
            .filter(Boolean);
          if (lines.length === 0) continue;
          const title = lines.reduce((best, line) => (line.length > best.length ? line : best), lines[0]);
          if (!title || title.length < 3) continue;
          seenUrl.add(href);
          out.visual_matches.push({
            title: title.slice(0, 200),
            source: (lines[0] === title ? "" : lines[0]).slice(0, 60),
            url: href,
          });
        }
      }
    }
    // 外部直链（非 google 域的结果链接，补充进 links 列表）
    const seenExt = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.href || "";
      if (!/^https?:/i.test(href) || seenExt.has(href)) continue;
      let host;
      try {
        host = new URL(href).hostname;
      } catch {
        continue;
      }
      if (/(^|\.)google\.[a-z.]+$/.test(host) && !/imgres|url\?q=/.test(href)) continue;
      if (/(^|\.)gstatic\.com$|(^|\.)googleusercontent\.com$/.test(host)) continue;
      const text = (anchor.innerText || "").replace(/\s+/g, " ").trim();
      const hasImage = Boolean(anchor.querySelector("img"));
      if (!text && !hasImage) continue;
      seenExt.add(href);
      out.external_links.push({ text: text.slice(0, 200), href });
      if (out.external_links.length >= 30) break;
    }
    // 相似图缩略图（googleusercontent 直链，可直接下载）
    const seenImg = new Set();
    for (const img of document.querySelectorAll("img[src]")) {
      const src = img.src || "";
      if (!/googleusercontent|gstatic/.test(src) || seenImg.has(src)) continue;
      seenImg.add(src);
      out.similar_images.push({ alt: (img.alt || "").slice(0, 120), src });
      if (out.similar_images.length >= 10) break;
    }
    return out;
  });
}

// 兼容旧字段 links: [{text, href}] = AI 概览链接 + 外观匹配 + 外部直链
function mergeLensLinks(scraped) {
  const merged = [];
  const seen = new Set();
  const push = (text, href) => {
    if (!href || seen.has(href)) return;
    seen.add(href);
    merged.push({ text: String(text || "").slice(0, 200), href });
  };
  for (const link of scraped.overview_links || []) push(link.title, link.url);
  for (const match of scraped.visual_matches || []) {
    push(match.source ? `${match.title}（${match.source}）` : match.title, match.url);
  }
  for (const link of scraped.external_links || []) push(link.text, link.href);
  return merged.slice(0, 30);
}

// 可选增强：跳 AI 模式 tab（URL udm=26 → udm=50）取完整回答，正文在 <main> 对话区
async function lensFetchFullAi(page) {
  if (!/([?&])udm=26/.test(page.url())) return "";
  const aiUrl = page.url().replace("udm=26", "udm=50");
  try {
    await page.goto(aiUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page
      .locator('h1:has-text("AI 模式对话"), h1:has-text("AI Mode")')
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    await sleep(1500); // 等流式渲染
    const text = await page.locator("main").first().innerText({ timeout: 8000 }).catch(() => "");
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    return String(text || "").trim();
  } catch {
    return ""; // AI 模式页失配时保留概览结果
  }
}

// 主流程（移植自 2026-09-19 实测验证的 GoogleLensClient）：
// 首页「按图搜索」→ 智能镜头对话框「上传文件」→ 注入图片 → 自动跳转结果页 →
// 等 AI 概览流式生成稳定 → 提取 AI 概览/外观匹配/相似图。
async function lensHomepageFlow(context, imagePath, { fullAi }) {
  const page = await context.newPage();
  try {
    // 1. 先访问 /ncr 再开首页：防止 Google 按出口 IP 302 到地区域名
    //    （实测港区节点会跳 google.com.hk，其下 Lens 结果页必触发 /sorry 风控，
    //    且 AI 概览不支持香港；强制留在 google.com 后实测正常出结果）
    await page
      .goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.goto(LENS_HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await handleGoogleConsent(page);

    // 2. 点「按图搜索」并注入文件，按三种形态依次尝试：
    //    A. 点击直接弹 file chooser（仅 800ms 兜底）
    //    B. 点击后弹智能镜头对话框，其自带隐藏 input[type=file]，直接注入（实测最稳）
    //    C. 点对话框中的「上传文件」链接触发 file chooser
    const btn = page.getByRole("button", { name: /按图搜索|Search by image/i }).first();
    await btn.waitFor({ state: "visible", timeout: 15000 });

    let uploaded = false;
    try {
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 800 }).catch(() => null);
      await btn.click({ timeout: 8000 });
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(imagePath);
        uploaded = true;
      }
    } catch {
      // 点击失败时走下面的结构化错误
    }
    if (!uploaded) {
      // 形态 B：点击后弹出智能镜头对话框，其自带隐藏 input[type=file]，
      // 直接注入（实测最稳）。对话框渲染耗时波动，轮询最多 12 秒。
      const dialogDeadline = Date.now() + 12000;
      while (!uploaded && Date.now() < dialogDeadline) {
        try {
          const fileInput = page.locator('input[type="file"]').first();
          if ((await fileInput.count()) > 0) {
            await fileInput.setInputFiles(imagePath, { timeout: 10000 });
            uploaded = true;
          }
        } catch {
          // input 尚未就绪，继续轮询
        }
        if (!uploaded) await sleep(500);
      }
    }
    if (!uploaded) {
      // 形态 C：点「上传文件」链接触发 file chooser
      const uploadLink = page.getByText(/上传文件|Upload a? ?file/i).first();
      await uploadLink.waitFor({ state: "visible", timeout: 8000 });
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 });
      await uploadLink.click({ timeout: 8000 });
      const chooser = await chooserPromise;
      await chooser.setFiles(imagePath);
    }

    // 3. 等待跳转结果页（实测：选择文件后自动跳转，URL 形如 /search?...vsrid=）；
    //    被风控 302 到 /sorry 时立即短路，不白等整个超时窗口
    await page.waitForURL(
      (url) => /\/search\?.*vsrid=/.test(url) || isCaptchaUrl(url),
      { timeout: 30000 },
    );
    if (isCaptchaUrl(page.url())) throw lensCaptchaError(page.url());

    // 4. 等 AI 概览生成完毕（流式，约 8~15 秒）
    const aiDone = await waitLensOverviewDone(page, 60000);
    if (!aiDone) {
      const captcha =
        isCaptchaUrl(page.url()) ||
        (await page.getByText(/unusual traffic/i).count().catch(() => 0)) > 0;
      if (captcha) throw lensCaptchaError(page.url());
      // 无 AI 概览但可能有视觉匹配结果 → 不算致命，继续提取
    }

    // 5. 提取（先记录结果页 URL，full_ai 的跳转不覆盖它）
    const scraped = await extractLensPageData(page);
    const title = await page.title().catch(() => "");
    const resultUrl = page.url();

    // 6. 可选：跳 AI 模式取完整回答
    let fullAiText = "";
    if (fullAi) {
      fullAiText = await lensFetchFullAi(page);
    }

    return {
      flow: "homepage",
      page_url: resultUrl,
      result_page_url: resultUrl,
      title,
      ai_overview: { text: scraped.overview_text, links: scraped.overview_links },
      ai_overview_present: Boolean(scraped.overview_text),
      visual_matches: scraped.visual_matches,
      similar_images: scraped.similar_images,
      text: scraped.overview_text || scraped.body_text,
      links: mergeLensLinks(scraped),
      full_ai_text: fullAiText,
    };
  } catch (error) {
    // 失败截图存档，便于排查页面改版；风控页本身无诊断价值，不附截图路径
    const shot = await saveLensDebugScreenshot(page, "fail");
    if (shot && !errorMessage(error).includes("/sorry")) {
      error.message = `${errorMessage(error)}（失败截图: ${shot}）`;
    }
    throw error;
  } finally {
    try {
      await page.close();
    } catch {
      // 忽略
    }
  }
}

// 降级方案：lens.google.com 直传 file input（首页按钮流程结构性失败时使用）
async function lensLegacyFlow(context, imagePath, timeoutMs, maxChars) {
  const page = await context.newPage();
  try {
    // /ncr 前缀同主流程：防地区 302（.hk 域下 Lens 结果页会触发 /sorry 风控）
    await page
      .goto("https://www.google.com/ncr", { waitUntil: "domcontentloaded", timeout: 45000 })
      .catch(() => {});
    await page.goto("https://lens.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await handleGoogleConsent(page);

    const fileInput = page.locator('input[type="file"]').first();
    try {
      await fileInput.waitFor({ state: "attached", timeout: timeoutMs });
      await fileInput.setInputFiles(imagePath, { timeout: 15000 });
    } catch (error) {
      throw new Error(`Google Lens 上传入口不可用: ${errorMessage(error)}`);
    }

    // 轮询等待结果页渲染：上传后 URL 形态不定（lens.google.com/upload|search、
    // www.google.com/search?vsrid=...），以页面标志文本为准，不做 URL 阻塞等待
    const resultsDeadline = Date.now() + Math.max(Math.min(timeoutMs, 45000), 25000);
    let bodyText = "";
    let blocked = isCaptchaUrl(page.url());
    let sawResults = false;
    while (!blocked && Date.now() < resultsDeadline) {
      await sleep(1200);
      try {
        bodyText = (await page.locator("body").innerText({ timeout: 4000 })).trim();
      } catch {
        continue;
      }
      if (isCaptchaUrl(page.url())) {
        blocked = true;
        break;
      }
      if (bodyText.length > 400) break;
      if (/完全匹配|Exact matches|视觉匹配|Visual matches|搜索结果|Search results/i.test(bodyText)) {
        sawResults = true;
        await sleep(2000); // 让结果区渲染完整
        bodyText = (await page.locator("body").innerText({ timeout: 4000 }).catch(() => bodyText)).trim();
        break;
      }
    }
    if (blocked || isCaptchaUrl(page.url())) {
      throw lensCaptchaError(page.url());
    }
    if (!sawResults && bodyText.length <= 120) {
      throw new Error(
        `Google Lens 结果页未渲染出有效内容（页面: ${page.url()}），可能为上传失效或站点改版`,
      );
    }

    // 结构化提取（与主流程同款）：AI 概览 + 外观匹配 + 相似图；再补抓页面全文与原始链接
    const scraped = await extractLensPageData(page);
    const rawLinks = await page.evaluate(() => {
      const links = [];
      const seen = new Set();
      for (const anchor of document.querySelectorAll("a[href]")) {
        const href = anchor.href || "";
        if (!/^https?:/i.test(href)) continue;
        const isInternal =
          /(^|\.)google\./.test(new URL(href).hostname) &&
          !/imgres|url\?q=/.test(href);
        if (isInternal) continue;
        if (seen.has(href)) continue;
        const text = (anchor.innerText || "").replace(/\s+/g, " ").trim();
        const hasImage = Boolean(anchor.querySelector("img"));
        if (!text && !hasImage) continue;
        seen.add(href);
        links.push({ text: text.slice(0, 200), href });
        if (links.length >= 30) break;
      }
      return links;
    });

    const title = await page.title().catch(() => "");
    const mergedLinks = [];
    const seenMerged = new Set();
    const pushLink = (text, href) => {
      if (!href || seenMerged.has(href)) return;
      seenMerged.add(href);
      mergedLinks.push({ text: String(text || "").slice(0, 200), href });
    };
    for (const link of scraped.overview_links || []) pushLink(link.title, link.url);
    for (const match of scraped.visual_matches || []) {
      pushLink(match.source ? `${match.title}（${match.source}）` : match.title, match.url);
    }
    for (const link of rawLinks) pushLink(link.text, link.href);

    return {
      flow: "legacy",
      page_url: page.url(),
      result_page_url: page.url(),
      title,
      ai_overview: { text: scraped.overview_text, links: scraped.overview_links },
      ai_overview_present: Boolean(scraped.overview_text),
      visual_matches: scraped.visual_matches,
      similar_images: scraped.similar_images,
      links: mergedLinks.slice(0, 30),
      text: (scraped.overview_text || bodyText).slice(0, maxChars),
      full_ai_text: "",
    };
  } finally {
    try {
      await page.close();
    } catch {
      // 忽略
    }
  }
}

// 重试编排：主方案（首页按图搜索）失败 → 降级旧方案（lens.google.com 直传）；
// 风控 /sorry 时递增退避后整体重试。旧方案成功时附带 fallback_reason 说明降级原因。
async function lensSearchWithRetries(context, imagePath, options) {
  const { timeoutMs, maxChars, fullAi, lensRetries } = options;
  const maxAttempts = Math.max(1, Number.isFinite(lensRetries) ? lensRetries : 3);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const result = await lensHomepageFlow(context, imagePath, { fullAi });
      result.elapsed_ms = Date.now() - startedAt;
      if (maxChars > 0) {
        if (result.ai_overview && typeof result.ai_overview.text === "string") {
          result.ai_overview.text = result.ai_overview.text.slice(0, maxChars);
        }
        if (typeof result.text === "string") result.text = result.text.slice(0, maxChars);
        if (typeof result.full_ai_text === "string") {
          result.full_ai_text = result.full_ai_text.slice(0, maxChars);
        }
      }
      return result;
    } catch (error) {
      lastError = error;
    }
    // 主方案任何失败（结构性失败或 /sorry 风控）都降级尝试旧方案
    const legacyStartedAt = Date.now();
    try {
      const result = await lensLegacyFlow(context, imagePath, timeoutMs, maxChars);
      result.elapsed_ms = Date.now() - legacyStartedAt;
      result.fallback_reason = errorMessage(lastError);
      return result;
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) {
      // IP 信誉波动导致的 /sorry 通常几十秒内放行，做递增退避重试
      await sleep(5000 * attempt);
    }
  }
  throw lastError || new Error("Google 反搜失败");
}

async function actionLensSearch(params) {
  const elapsed = Date.now() - lensCooldown.lastSorryAt;
  if (lensCooldown.lastSorryAt > 0 && elapsed < lensCooldown.cooldownMs) {
    throw new Error(
      `Google 反搜冷却中（${Math.ceil((lensCooldown.cooldownMs - elapsed) / 1000)}s 后可重试）：` +
        "刚触发过风控限流，稍等片刻再试即可",
    );
  }
  const timeoutMs = toInt(params.timeout_ms, toInt(params.default_timeout_ms, 30000));
  const maxChars = toInt(params.max_chars, 12000);
  const fullAi = params.full_ai === undefined ? false : Boolean(params.full_ai);
  const gapMs = Math.max(0, toInt(params.lens_gap_ms, 3000));
  const { context } = await ensureBrowser(params);

  let imagePath = String(params.image_path || "").trim();
  let tempPath = "";
  if (!imagePath) {
    const imageB64 = String(params.image_b64 || "").trim();
    if (!imageB64) throw new Error("lens_search 需要 image_path 或 image_b64");
    tempPath = await writeTempFile(imageB64, params.image_suffix || ".png");
    imagePath = tempPath;
  }

  // 拟人间隔：距上次反搜至少 lens_gap_ms + 0~5 秒随机抖动（默认合计 3~8 秒）
  if (gapMs > 0 && lensPacing.lastFinishedAt > 0) {
    const waitUntil = lensPacing.lastFinishedAt + gapMs + Math.floor(Math.random() * 5000);
    const wait = waitUntil - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 65000));
  }

  try {
    // 预置 SOCS cookie 规避 consent 拦截
    await context
      .addCookies([{ name: "SOCS", value: "CAI", domain: ".google.com", path: "/" }])
      .catch(() => {});
    const result = await lensSearchWithRetries(context, imagePath, {
      timeoutMs,
      maxChars,
      fullAi,
      lensRetries: toInt(params.lens_retries, 3),
    });
    lensCooldown.lastSorryAt = 0;
    return result;
  } catch (error) {
    if (errorMessage(error).includes("/sorry")) {
      lensCooldown.lastSorryAt = Date.now();
    }
    throw error;
  } finally {
    lensPacing.lastFinishedAt = Date.now();
    if (tempPath) {
      fs.unlink(tempPath).catch(() => {});
    }
  }
}

async function actionWebAIChat(params) {
  const provider = String(params.provider || "").trim().toLowerCase();
  const profile = PROFILES[provider];
  if (!profile) {
    throw new Error(`不支持的 provider: ${provider || "(空)"}；可选 doubao / deepseek / gemini`);
  }
  const currentRisk = riskStateFor(provider);
  if (currentRisk.state === "cooldown" && currentRisk.cooldown_until > Date.now()) {
    throw new Error(`${profile.label} 当前处于风控冷却，请稍后再试`);
  }
  const prompt = String(params.prompt || "").trim();
  if (!prompt && !params.image_path && !params.image_b64) {
    throw new Error("prompt 与上传文件至少提供一项");
  }
  const timeoutMs = toInt(params.timeout_ms, toInt(params.default_timeout_ms, 30000));
  const replyTimeoutMs = toInt(params.reply_timeout_ms, 180000);
  const pollIntervalMs = toInt(params.poll_interval_ms, 1500);
  const maxChars = toInt(params.max_chars, 12000);
  state.sessionMaxCount = toInt(params.session_max_count, 12);
  state.historyMaxCount = Math.max(10, toInt(params.history_max_count, 100));
  const { context } = await ensureBrowser(params);

  const session = await resolveSessionPage(context, provider, profile, params);
  const page = session.page;

  try {
    return await runWebAIChatFlow(page, profile, params, {
      provider,
      timeoutMs,
      replyTimeoutMs,
      pollIntervalMs,
      maxChars,
      session,
    });
  } catch (error) {
    if (/captcha|验证码|unusual traffic|异常流量|人机验证/i.test(errorMessage(error))) {
      markRisk(provider, "cooldown", errorMessage(error), toInt(params.risk_cooldown_seconds, 60000));
    }
    // 仅清理"页面已不可用"的会话（未登录/封锁/输入框失配）；
    // 超时等非致命错误保留会话，下一轮可用同一 session_id 继续
    if (error && error.sessionFatal) {
      const failedEntry = state.sessions[session.sessionKey];
      if (failedEntry) {
        if (failedEntry.page && !failedEntry.page.isClosed()) {
          failedEntry.page.close().catch(() => {});
        }
        delete state.sessions[session.sessionKey];
      }
    }
    throw error;
  }
}

async function runWebAIChatFlow(page, profile, params, options) {
  const { provider, timeoutMs, replyTimeoutMs, pollIntervalMs, maxChars, session } = options;
  const prompt = String(params.prompt || "").trim();

  // 等输入框出现；期间持续复查登录墙/封锁页（兼容慢速 JS 跳转）
  let composer = await waitForComposerOrLogin(page, profile, Math.max(timeoutMs, 30000));

  // 只在调用方明确传入设置时修改页面；未传参数不扰动已有网页状态。
  const resultSettings = await applyProfileSettings(page, profile, params);
  if (resultSettings.warnings.length > 0) {
    markRisk(provider, "settings_warning", resultSettings.warnings.join("; "));
  }

  // 上传文件（可选）
  let uploadNote = "";
  let imagePath = String(params.image_path || "").trim();
  let tempPath = "";
  if (!imagePath && params.image_b64) {
    tempPath = await writeTempFile(params.image_b64, params.image_suffix || ".png");
    imagePath = tempPath;
  }
  if (imagePath) {
    await uploadFileToPage(page, profile, imagePath, timeoutMs);
    uploadNote = "uploaded";
    await sleep(2000); // 等待站点完成上传预览
    composer = await findVisibleLocator(page, profile.composer, { deadline: Date.now() + 5000 }) || composer;
  }

  // 发送前快照（内容级基线：只有发送前不存在的文本才算回复）
  let preTexts = [];
  try {
    preTexts = (await collectChatState(page, profile)).texts;
  } catch {
    preTexts = [];
  }
  if (prompt) {
    await fillComposer(page, profile, prompt, composer);
    await pressSend(page, profile, composer);
  } else if (uploadNote) {
    // 仅上传文件时尝试触发发送（部分站点上传后自动发送）
    await pressSend(page, profile, composer);
  }

  const result = await waitForReply(page, profile, {
    preTexts,
    replyTimeoutMs,
    pollIntervalMs,
    maxChars,
  });
  if (!result.reply || !result.reply.trim()) {
    const captcha = await detectCaptcha(page, profile);
    if (captcha) {
      markRisk(provider, "cooldown", captcha, toInt(params.risk_cooldown_seconds, 60000));
      throw fatalSessionError(`${profile.label} 触发验证或异常流量（${captcha}），请人工处理后重试`);
    }
    // 发送后可能被重定向到登录/封锁页，给出准确原因
    if (await detectLoginWall(page, profile)) {
      throw fatalSessionError(loginErrorMessage(profile, page));
    }
    if (await detectRegionBan(page, profile)) {
      throw fatalSessionError(
        `${profile.label} 当前网络出口被限制使用（当前页面: ${page.url()}）。请更换代理节点或使用可用的网络出口`,
      );
    }
    if (result.timedOut) {
      // 非致命：保留会话页面，下一轮可用同一 session_id 继续等待/追问
      throw new Error(
        `等待 ${profile.label} 回复超时（${Math.round(replyTimeoutMs / 1000)}s）且未抓到新内容`,
      );
    }
    throw fatalSessionError(`${profile.label} 返回了空回复`);
  }
  const sessionEntry = state.sessions[session.sessionKey];
  if (sessionEntry) sessionEntry.turns = (sessionEntry.turns || 0) + 1;
  // 记录实际会话设置与标题，供 history_list/resume 使用；不写入 prompt 或 Cookie。
  updateSessionRecord(provider, session, {
    title: params.conversation_title || state.sessions[session.sessionKey]?.title || session.sessionKey,
    settings: resultSettings,
  });
  return {
    provider,
    reply: result.reply,
    reply_truncated: result.reply.length >= maxChars,
    page_url: result.url,
    upload: uploadNote,
    timed_out: Boolean(result.timedOut),
    session_id: session.sessionKey,
    session_new: session.isNewChat,
    session_restored: session.sessionRestored,
    session_turns: sessionEntry ? sessionEntry.turns : 1,
    reply_links: result.links || [],
    reply_images: result.images || [],
    requested_settings: resultSettings.requested,
    effective_settings: resultSettings.effective,
    settings_warnings: resultSettings.warnings,
    risk_state: riskStateFor(provider),
  };
}

async function actionFetchBinary(params) {
  const url = assertString(params.url, "url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`URL 无法解析: ${errorMessage(error)}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("仅允许 http/https 协议");
  }
  const host = parsed.hostname.toLowerCase();
  const forbidden =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    /^(127\.|10\.|192\.168\.|169\.254\.|::1$|f[cd]|fe80)/.test(host) ||
    /^(22[4-9]|23\d)/.test(host.split(".")[0] || "");
  if (forbidden) {
    throw new Error(`禁止访问本地或保留地址: ${host}`);
  }
  if (!state.context) {
    await ensureBrowser(params);
  }
  const maxBytes = toInt(params.max_bytes, 20 * 1024 * 1024);
  const response = await state.context.request.get(url, {
    timeout: toInt(params.timeout_ms, toInt(params.default_timeout_ms, 30000)),
    maxRedirects: 5,
  });
  const finalUrl = response.url();
  const finalParsed = new URL(finalUrl);
  if (!/^https?:$/i.test(finalParsed.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)$/i.test(finalParsed.hostname)) {
    throw new Error(`下载重定向目标不安全: ${finalParsed.hostname}`);
  }
  const body = await response.body();
  if (body.length > maxBytes) {
    throw new Error(`下载数据超过上限 ${maxBytes} 字节（实际 ${body.length}）`);
  }
  const headers = response.headers();
  return {
    url: finalUrl,
    status: response.status(),
    content_type: headers["content-type"] || "",
    size: body.length,
    base64: body.toString("base64"),
  };
}

async function actionShutdown(params) {
  const closeOwned = params.close_owned_browser === undefined ? true : Boolean(params.close_owned_browser);
  const wasOwned = state.ownedBrowser;
  if (state.browser) {
    try {
      // CDP 连接的浏览器 close 仅断开连接；自启的无头浏览器会真正退出
      await state.browser.close();
    } catch {
      // 忽略
    }
  }
  resetState();
  return { closed: wasOwned && closeOwned };
}

// ── 分发循环 ─────────────────────────────────────────────────────

const ACTIONS = {
  capabilities: actionCapabilities,
  provider_settings: actionProviderSettings,
  history_list: actionHistoryList,
  history_get: actionHistoryGet,
  history_resume: actionHistoryResume,
  history_rename: actionHistoryRename,
  history_delete: actionHistoryDelete,
  login_profiles: actionLoginProfiles,
  logout: actionLogout,
  status: actionStatus,
  connect: actionConnect,
  launch: actionLaunch,
  lens_search: actionLensSearch,
  web_ai_chat: actionWebAIChat,
  fetch_binary: actionFetchBinary,
  session_list: actionSessionList,
  session_close: actionSessionClose,
  login_check: actionLoginCheck,
  shutdown: actionShutdown,
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });

let pendingRequests = 0;

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  pendingRequests -= 1;
}

rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    respond({ id: "?", ok: false, error: `请求 JSON 解析失败: ${errorMessage(error)}` });
    return;
  }
  const { id, action, params } = request;
  const handler = ACTIONS[String(action || "").trim()];
  if (!handler) {
    respond({ id, ok: false, error: `未知的 worker 动作: ${action}` });
    return;
  }
  pendingRequests += 1;
  handler(params || {})
    .then((result) => {
      respond({ id, ok: true, result });
    })
    .catch((error) => {
      respond({ id, ok: false, error: errorMessage(error) });
    });
});

rl.on("close", () => {
  // stdin 关闭后等待在途请求完成再退出，避免截断响应；上限 10s
  const startedAt = Date.now();
  const drain = setInterval(() => {
    if (pendingRequests <= 0 || Date.now() - startedAt > 10000) {
      clearInterval(drain);
      if (state.ownedBrowser && state.browser) {
        state.browser.close().catch(() => {});
      }
      process.exit(0);
    }
  }, 50);
});

process.on("uncaughtException", (error) => {
  respond({ id: "?", ok: false, error: `worker 未捕获异常: ${errorMessage(error)}` });
});
