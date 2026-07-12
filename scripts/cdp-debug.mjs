// Minimal Chrome DevTools Protocol client for poking the live Tauri WebView2
// that's exposing its debugger on http://127.0.0.1:9222.
//
// Usage: node scripts/cdp-debug.mjs <command> [args...]
// Commands:
//   probe                          — list DOM size, error count, settingsOpen state, etc.
//   eval "<js expression>"         — run arbitrary JS via Runtime.evaluate
//   click "<css selector>"         — programmatic click (via .click() in page)
//   click-and-probe "<css>"        — click, wait, then probe
//   screenshot <out.png>           — Page.captureScreenshot to file
//   console                        — dump recent console messages
//
// Node 22's built-in WebSocket is used; no external deps.

import { writeFileSync } from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9222";

const consoleBuf = [];

async function findPageWs() {
  const res = await fetch(`${CDP_HTTP}/json`);
  const pages = await res.json();
  const target = pages.find((p) => p.type === "page" && p.url.includes("localhost:1420"));
  if (!target) throw new Error(`no Tauri page found; got ${pages.length} pages`);
  return target.webSocketDebuggerUrl;
}

function keyCode(name) {
  const map = {
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Backspace: 8,
    Delete: 46,
  };
  return map[name] ?? 0;
}

let nextId = 1;
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    ws.addEventListener("open", () => {
      // Enable the domains we need
      const cmd = (method, params = {}) => {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      };
      const ready = async () => {
        await cmd("Runtime.enable");
        await cmd("Page.enable");
        await cmd("DOM.enable");
        await cmd("Log.enable");
        resolve({ ws, cmd });
      };
      ready().catch(reject);
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id != null) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.res(msg.result);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const args = msg.params.args.map((a) => a.value ?? a.description ?? `[${a.type}]`).join(" ");
        consoleBuf.push(`[console.${msg.params.type}] ${args}`);
      } else if (msg.method === "Log.entryAdded") {
        consoleBuf.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const ex = msg.params.exceptionDetails;
        consoleBuf.push(`[EXCEPTION] ${ex.text} ${ex.exception?.description ?? ""}`);
      }
    });
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message ?? e}`)));
  });
}

async function withSession(fn) {
  const wsUrl = await findPageWs();
  const { ws, cmd } = await connect(wsUrl);
  try {
    return await fn(cmd);
  } finally {
    ws.close();
  }
}

async function evalJS(cmd, expression, { awaitPromise = false, timeoutMs = 5000 } = {}) {
  const ev = cmd("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    timeout: timeoutMs,
  });
  const timer = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`Runtime.evaluate timed out after ${timeoutMs}ms`)), timeoutMs + 500),
  );
  const r = await Promise.race([ev, timer]);
  if (r.exceptionDetails) {
    return { error: r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? "") };
  }
  return { value: r.result?.value };
}

const PROBE_JS = `(() => {
  const root = document.getElementById('root');
  const overlays = document.querySelectorAll('.fixed.inset-0');
  const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
    text: (b.textContent || '').trim().slice(0, 40),
    cls: b.className.slice(0, 60),
    disabled: b.disabled,
  }));
  return {
    rootChildren: root ? root.children.length : 0,
    bodyTextLen: document.body.innerText.length,
    bodyTextSample: document.body.innerText.slice(0, 250),
    overlayCount: overlays.length,
    overlayHTML: overlays[0] ? overlays[0].outerHTML.slice(0, 400) : null,
    buttonCount: buttons.length,
    buttons,
    win: { w: innerWidth, h: innerHeight },
    docReady: document.readyState,
  };
})()`;

const [, , cmd_, ...rest] = process.argv;

await withSession(async (cmd) => {
  switch (cmd_) {
    case "probe": {
      const r = await evalJS(cmd, PROBE_JS);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "eval": {
      // Async-aware: if the expression returns a Promise, await it.
      const r = await evalJS(cmd, rest.join(" "), {
        awaitPromise: true,
        timeoutMs: 30000,
      });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "click": {
      const sel = rest.join(" ");
      const r = await evalJS(
        cmd,
        `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return { error: 'no match' };
          const rect = el.getBoundingClientRect();
          el.click();
          return { clicked: true, text: el.textContent?.slice(0, 50), rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
        })()`,
      );
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "click-and-probe": {
      const sel = rest.join(" ");
      const clickRes = await evalJS(
        cmd,
        `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return { error: 'no match' };
          el.click();
          return { clicked: true };
        })()`,
      );
      console.log("CLICK:", JSON.stringify(clickRes));
      // Give React a tick
      await new Promise((r) => setTimeout(r, 600));
      const probeRes = await evalJS(cmd, PROBE_JS, { timeoutMs: 8000 });
      console.log("PROBE:", JSON.stringify(probeRes, null, 2));
      console.log("CONSOLE BUFFER:", consoleBuf.slice(-20));
      break;
    }
    case "mouse-click": {
      // Simulate a REAL OS mouse click via Input.dispatchMouseEvent. This goes
      // through the input pipeline (mousemove → mousedown → mouseup → click)
      // same way a physical mouse would, so we can reproduce input-only bugs.
      const sel = rest.join(" ");
      const rect = await evalJS(
        cmd,
        `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()`,
      );
      if (!rect.value) {
        console.log("no element matched", sel);
        break;
      }
      const { x, y } = rect.value;
      console.log(`mouse → (${x}, ${y})`);
      await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 500));
      const probeRes = await evalJS(cmd, PROBE_JS, { timeoutMs: 8000 });
      console.log("PROBE:", JSON.stringify(probeRes, null, 2));
      console.log("CONSOLE:", consoleBuf.slice(-15));
      break;
    }
    case "press": {
      // Dispatch a single named key (Tab, Enter, Escape, ArrowDown, etc.)
      const key = rest.join(" ");
      await cmd("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: keyCode(key) });
      await cmd("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: keyCode(key) });
      await new Promise((r) => setTimeout(r, 200));
      const probeRes = await evalJS(cmd, PROBE_JS, { timeoutMs: 8000 });
      console.log(JSON.stringify(probeRes, null, 2));
      break;
    }
    case "type": {
      // Dispatch real OS-level keypresses into whatever element has focus.
      const text = rest.join(" ");
      for (const ch of text) {
        await cmd("Input.dispatchKeyEvent", {
          type: "keyDown",
          text: ch,
          unmodifiedText: ch,
          key: ch,
        });
        await cmd("Input.dispatchKeyEvent", {
          type: "keyUp",
          text: ch,
          unmodifiedText: ch,
          key: ch,
        });
      }
      await new Promise((r) => setTimeout(r, 600));
      const probeRes = await evalJS(cmd, PROBE_JS, { timeoutMs: 8000 });
      console.log(JSON.stringify(probeRes, null, 2));
      break;
    }
    case "screenshot": {
      const out = rest[0] || "screenshot.png";
      const r = await cmd("Page.captureScreenshot", { format: "png" });
      writeFileSync(out, Buffer.from(r.data, "base64"));
      console.log(`wrote ${out}`);
      break;
    }
    case "console": {
      // Wait briefly to collect any messages
      await new Promise((r) => setTimeout(r, 500));
      console.log(consoleBuf.join("\n"));
      break;
    }
    default:
      console.error(`unknown command: ${cmd_}\nusage: probe | eval <js> | click <sel> | click-and-probe <sel> | screenshot <file> | console`);
      process.exit(1);
  }
});
