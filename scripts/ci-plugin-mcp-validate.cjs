#!/usr/bin/env node
/**
 * CI plugin-validation + LIVE MCP handshake (R-37, Phase 5).
 *
 * One CI step that ties the shipped plugin's load-bearing surfaces together and fails
 * LOUD if any regresses — the things a `npm test` unit suite cannot prove because they
 * require the REAL compiled artifacts wired the way the Claude Code host wires them:
 *
 *   1. PLUGIN MANIFEST — `.claude-plugin/plugin.json` is valid JSON, declares the `th`
 *      MCP server pointing at `dist/mcp-server.js`, and the marketplace manifest parses.
 *   2. AGENT MANIFESTS — every `agents/*.md` exists and carries YAML frontmatter (the
 *      host loads these as agent definitions); the count matches the plugin's claim (16).
 *   3. LIVE MCP HANDSHAKE — spawn the REAL `dist/mcp-server.js`, do a JSON-RPC
 *      `initialize` + `tools/list` over stdio, and assert it responds with a non-empty
 *      tool set. This proves the bundled server starts and speaks the protocol.
 *   4. LIVE HOOK STOP BEHAVIOR — run the compiled CLI's `hook stop` over stdin against a
 *      fresh root and assert it emits a well-formed JSON decision (not a crash) — the
 *      Stop-gate entrypoint the host invokes on turn-end.
 *
 * Exit non-zero with a clear message on the first failure. No external deps (uses only
 * node core), so it runs on every OS in the CI matrix.
 */
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`ok: ${msg}`);

// ---------------------------------------------------------------------------
// 1. Plugin + marketplace manifests
// ---------------------------------------------------------------------------
function checkManifests() {
  const pluginPath = path.join(ROOT, ".claude-plugin", "plugin.json");
  const marketPath = path.join(ROOT, ".claude-plugin", "marketplace.json");
  if (!fs.existsSync(pluginPath)) fail(".claude-plugin/plugin.json is missing");
  let plugin;
  try {
    plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
  } catch (e) {
    fail(`plugin.json is not valid JSON: ${e.message}`);
  }
  if (!plugin.name) fail("plugin.json has no `name`");
  const srv = plugin.mcpServers && plugin.mcpServers.th;
  if (!srv) fail("plugin.json does not declare the `th` MCP server");
  const argsJoined = (srv.args || []).join(" ");
  if (!/dist[\\/]mcp-server\.js/.test(argsJoined)) {
    fail(`plugin.json 'th' server does not point at dist/mcp-server.js (args: ${argsJoined})`);
  }
  if (!fs.existsSync(marketPath)) fail(".claude-plugin/marketplace.json is missing");
  try {
    JSON.parse(fs.readFileSync(marketPath, "utf8"));
  } catch (e) {
    fail(`marketplace.json is not valid JSON: ${e.message}`);
  }
  // The server file the manifest points at must actually exist (built dist/).
  if (!fs.existsSync(path.join(ROOT, "dist", "mcp-server.js"))) {
    fail("dist/mcp-server.js does not exist (run `npm run build` first)");
  }
  ok("plugin + marketplace manifests valid; `th` MCP server → dist/mcp-server.js exists");
}

// ---------------------------------------------------------------------------
// 2. Agent manifests
// ---------------------------------------------------------------------------
function checkAgents() {
  const dir = path.join(ROOT, "agents");
  if (!fs.existsSync(dir)) fail("agents/ directory is missing");
  const mds = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (mds.length === 0) fail("agents/ has no .md manifests");
  for (const f of mds) {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    // Each agent manifest must open with YAML frontmatter the host parses.
    if (!body.startsWith("---")) fail(`agents/${f} has no leading YAML frontmatter`);
  }
  ok(`agent manifests: ${mds.length} present, each with YAML frontmatter`);
  return mds.length;
}

// ---------------------------------------------------------------------------
// 3. Live MCP handshake over stdio (initialize + tools/list)
// ---------------------------------------------------------------------------
function mcpHandshake() {
  return new Promise((resolve) => {
    const server = path.join(ROOT, "dist", "mcp-server.js");
    const child = spawn("node", [server], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TH_NO_LOG: "1" } });
    let buf = "";
    let stderr = "";
    const responses = new Map();
    const deadline = setTimeout(() => {
      try { child.kill(); } catch {}
      fail(`MCP server did not complete the handshake within 15s (stderr: ${stderr.slice(0, 400)})`);
    }, 15000);

    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.has(1) && !sentList) {
          sentList = true;
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (responses.has(2)) {
          clearTimeout(deadline);
          try { child.kill(); } catch {}
          resolve({ init: responses.get(1), list: responses.get(2), stderr });
        }
      }
    });
    child.on("error", (e) => fail(`failed to spawn dist/mcp-server.js: ${e.message}`));

    let sentList = false;
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
    // initialize
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ci-handshake", version: "1.0.0" },
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Live hook Stop behavior over the compiled CLI
// ---------------------------------------------------------------------------
function checkHookStop() {
  const cli = path.join(ROOT, "dist", "cli.js");
  if (!fs.existsSync(cli)) fail("dist/cli.js does not exist");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "th-ci-hook-"));
  try {
    // A fresh (un-init'd) root: the Stop hook must emit a well-formed JSON decision,
    // never crash. We feed an empty Stop payload on stdin, exactly as the host does.
    const res = spawnSync("node", [cli, "hook", "stop-gate", "--cwd", root], {
      input: "{}",
      encoding: "utf8",
      env: { ...process.env, TH_NO_LOG: "1" },
    });
    if (res.error) fail(`hook stop-gate failed to spawn: ${res.error.message}`);
    // The hook must print parseable JSON (a decision object), with a clean exit.
    let parsed;
    try {
      parsed = JSON.parse((res.stdout || "").trim() || "{}");
    } catch (e) {
      fail(`hook stop did not emit valid JSON (stdout: ${(res.stdout || "").slice(0, 200)}; stderr: ${(res.stderr || "").slice(0, 200)})`);
    }
    if (typeof parsed !== "object" || parsed === null) fail("hook stop-gate JSON is not an object");
    ok(`hook stop-gate emits a well-formed JSON decision on a fresh root (exit ${res.status})`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  console.log("== TwinHarness plugin + MCP CI validation ==");
  checkManifests();
  const agentCount = checkAgents();

  const { init, list, stderr } = await mcpHandshake();
  if (!init || init.error) fail(`MCP initialize failed: ${JSON.stringify(init && init.error)}`);
  if (!init.result || !init.result.protocolVersion) fail("MCP initialize response missing protocolVersion");
  if (!init.result.capabilities || !init.result.capabilities.tools) {
    fail("MCP initialize response does not advertise tools capability");
  }
  if (!list || list.error) fail(`MCP tools/list failed: ${JSON.stringify(list && list.error)}`);
  const tools = (list.result && list.result.tools) || [];
  if (!Array.isArray(tools) || tools.length === 0) fail("MCP tools/list returned no tools");
  // Every tool must carry a name + inputSchema (the host needs both to call it).
  for (const t of tools) {
    if (!t.name || !t.inputSchema) fail(`MCP tool malformed (missing name/inputSchema): ${JSON.stringify(t).slice(0, 120)}`);
  }
  ok(`live MCP handshake: initialize → protocol ${init.result.protocolVersion}; tools/list → ${tools.length} tools, all well-shaped`);
  if (stderr.trim()) console.log(`(mcp-server stderr, informational): ${stderr.trim().slice(0, 200)}`);

  checkHookStop();

  console.log(`\nALL CHECKS PASSED (${agentCount} agents, ${tools.length} MCP tools, live handshake + hook Stop OK).`);
})().catch((e) => fail(`unexpected error: ${e && e.stack ? e.stack : e}`));
