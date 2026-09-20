// 手动端到端测试：直接驱动 ask_ai_worker.mjs 执行动作（支持同一 worker 内多请求）。
// 用法: node tests/worker_e2e.mjs <action> <json-params-file>
//   或: node tests/worker_e2e.mjs --multi <json 文件，内容为 [{action, params}, ...]>

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..");
const baseParams = {
  mode: "launch",
  headless: true,
  user_data_dir: path.join(pluginDir, "data", "test_profile"),
  timeout_ms: 90000,
  reply_timeout_ms: 90000,
};

const requests = [];
if (process.argv[2] === "--multi") {
  const script = JSON.parse(fs.readFileSync(process.argv[3], "utf-8"));
  for (const item of script) {
    requests.push({ action: item.action, params: { ...baseParams, ...item.params } });
  }
} else {
  const action = process.argv[2] || "status";
  const paramsFile = process.argv[3];
  const params = paramsFile ? JSON.parse(fs.readFileSync(paramsFile, "utf-8")) : {};
  requests.push({ action, params: { ...baseParams, ...params } });
}

const child = spawn(process.execPath, [path.join(pluginDir, "worker", "ask_ai_worker.mjs")], {
  cwd: pluginDir,
  stdio: ["pipe", "pipe", "inherit"],
});

const overallTimeout = setTimeout(() => {
  console.error("TEST TIMEOUT");
  child.kill();
  process.exit(2);
}, 300000);

let index = 0;
let buffer = "";

function sendNext() {
  if (index >= requests.length) return;
  const request = requests[index];
  child.stdin.write(
    JSON.stringify({ id: String(index), action: request.action, params: request.params }) + "\n",
  );
}

function summarize(value) {
  if (typeof value === "string" && value.length > 800) {
    return value.slice(0, 800) + `...(共${value.length}字符)`;
  }
  if (Array.isArray(value)) return value.slice(0, 5).map(summarize);
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = summarize(item);
    return output;
  }
  return value;
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.id !== String(index)) continue;
    const { action } = requests[index];
    if (parsed.ok) {
      console.log(`[${index}] ${action} OK`, JSON.stringify(summarize(parsed.result), null, 2));
    } else {
      console.log(`[${index}] ${action} ERROR:`, parsed.error);
    }
    index += 1;
    if (index >= requests.length) {
      clearTimeout(overallTimeout);
      child.kill();
      process.exit(0);
    }
    sendNext();
  }
});

sendNext();
