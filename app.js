// Air Purifier one-time USB installer (Ready_V1.7+). Runs entirely in the browser (Web Serial).
// Link format:  index.html#fw=<TEMPLATE_ID>&t=<32-char Blynk device token>&n=<purifier name>
// The token stays in the URL fragment (never sent to the web server) and is removed from the address bar.
import { ESPLoader, Transport } from "./vendor/esptool-js-0.5.7/bundle.js";
import { md5, binStrToBytes, bytesToBinStr } from "./md5.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const logLines = [];
function log(s) {
  const line = `[${new Date().toLocaleTimeString()}] ${s}`;
  logLines.push(line);
  if (logLines.length > 3000) logLines.shift();
  logEl.textContent = logLines.slice(-400).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}
const say = (id, html, cls = "") => { $(id).innerHTML = cls ? `<span class="${cls}">${html}</span>` : html; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stepState(n, state) {               // state: on | done | off
  const c = $("s" + n);
  c.classList.toggle("off", state === "off");
  c.classList.toggle("done", state === "done");
  if (state === "on") c.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- link parameters ----------
// Kept in this tab's sessionStorage so a page reload still works (cleared when the tab closes).
let frag = location.hash.slice(1);
try {
  if (frag.includes("t=")) sessionStorage.setItem("purifierLink", frag);
  else frag = sessionStorage.getItem("purifierLink") || "";
} catch (e) {}
const hp = new URLSearchParams(frag);
const FW = (hp.get("fw") || "").trim();
const TOKEN = (hp.get("t") || "").trim();
const NAME = (hp.get("n") || "").trim();
if (location.hash) history.replaceState(null, "", location.pathname);
if (NAME) $("who").textContent = `${NAME}: one-time update. About 5 minutes. After this, updates happen over WiFi.`;
log(`page loaded; fw=${FW || "?"} token=${TOKEN ? "…" + TOKEN.slice(-4) : "none"}`);

let manifest = null, parts = null;
let port = null, transport = null, loader = null;
let backup = null, backupName = "", flashBytes = 0, mac = "";

async function loadFirmware() {
  if (!/^TMPL[0-9A-Za-z]+$/.test(FW) || !/^[A-Za-z0-9_-]{32}$/.test(TOKEN)) throw new Error("link");
  const base = `fw/${FW}/`;
  manifest = await (await fetch(base + "manifest.json", { cache: "no-store" })).json();
  parts = [];
  for (const p of manifest.parts) {
    const buf = new Uint8Array(await (await fetch(base + p.file, { cache: "no-store" })).arrayBuffer());
    const h = md5(buf);
    if (buf.length !== p.size || h !== p.md5) throw new Error(`download check failed for ${p.file}`);
    parts.push({ address: p.address, bytes: buf, md5: h });
  }
  log(`firmware ${manifest.version} for ${manifest.template} downloaded and verified (${parts.length} parts)`);
}

const ready = (async () => {
  if (!("serial" in navigator)) { $("unsupported").classList.remove("hide"); $("bConnect").disabled = true; return false; }
  try { await loadFirmware(); return true; }
  catch (e) {
    log("firmware load error: " + e.message);
    $("badlink").classList.remove("hide");
    if (e.message !== "link") $("badlink").querySelector("p").textContent = "Couldn't download the software. Check the internet and reload this page.";
    $("bConnect").disabled = true;
    return false;
  }
})();

// ---------- esptool terminal ----------
const term = { clean() {}, writeLine(d) { log("esptool: " + d); }, write(d) { if (String(d).trim()) log("esptool: " + d); } };

// Fast speed first; if the link is noisy (long wires, some cables) fall back to slower, safer speeds.
let goodBaud = 0;
async function openLoader() {
  const speeds = goodBaud ? [goodBaud] : [460800, 230400, 115200];
  let lastErr = null;
  for (const baud of speeds) {
    try {
      log(`connecting at ${baud} baud`);
      transport = new Transport(port, false);
      loader = new ESPLoader({ transport, baudrate: baud, romBaudrate: 115200, terminal: term, debugLogging: false });
      const desc = await loader.main();
      await loader.chip.readMac(loader);           // quick read to prove the link works at this speed
      goodBaud = baud;
      return desc;
    } catch (e) {
      lastErr = e;
      log(`failed at ${baud}: ${e.message}`);
      await closeLoader();
      await sleep(800);
      say("m1", `Connecting… (trying a slower, safer speed)`);
    }
  }
  throw lastErr;
}
async function closeLoader() {
  try { if (transport) await transport.disconnect(); } catch (e) { log("disconnect: " + e.message); }
  transport = null; loader = null;
}

// ---------- step 1+2+3 ----------
$("bConnect").onclick = async () => {
  if (!(await ready)) return;
  $("bConnect").disabled = true;
  $("tips1").classList.add("hide");
  try {
    say("m1", "Waiting for you to pick the purifier in the box…");
    port = await navigator.serial.requestPort();
  } catch (e) {
    say("m1", "No device picked.", "warn"); $("tips1").classList.remove("hide"); $("bConnect").disabled = false; return;
  }
  try {
    say("m1", "Connecting…");
    const desc = await openLoader();
    if (loader.chip.CHIP_NAME !== "ESP32") throw new Error(`This board is ${loader.chip.CHIP_NAME}, not the expected ESP32. Stop here and send Nikhil a screenshot.`);
    mac = await loader.chip.readMac(loader);
    const kb = await loader.getFlashSize();
    flashBytes = (kb || 0) * 1024;
    if (flashBytes < 4 * 1024 * 1024) throw new Error(`Flash size ${kb} KB is unexpected. Stop here and send Nikhil a screenshot.`);
    log(`chip: ${desc}, mac ${mac}, flash ${kb} KB`);
    say("m1", `Connected ✓ <span class="mut">(${desc}, ${mac})</span>`, "ok");
    stepState(1, "done");
  } catch (e) {
    log("connect error: " + (e.stack || e.message));
    say("m1", "Couldn't connect: " + e.message, "bad");
    $("tips1").classList.remove("hide");
    await closeLoader();
    $("bConnect").disabled = false;
    return;
  }
  try { await doBackup(); } catch (e) { return fail(2, e); }
  try { await doInstall(); } catch (e) { return fail(3, e); }
  await afterInstall();
};

function fail(step, e) {
  log(`step ${step} error: ` + (e.stack || e.message));
  say("m" + step, "Something went wrong: " + e.message + "<br>Nothing is lost. Unplug the USB cable, plug it back in, reload this page and try again. If it happens again, open “Something went wrong?” below and send Nikhil the details.", "bad");
  $("help").open = true;
  closeLoader();
}

async function doBackup() {
  stepState(2, "on");
  const CH = 0x10000;                         // read in 64 KB pieces
  const out = new Uint8Array(flashBytes);
  const t0 = Date.now();
  for (let a = 0; a < flashBytes; a += CH) {
    const n = Math.min(CH, flashBytes - a);
    let piece = null;
    for (let tries = 0; tries < 3 && !piece; tries++) {
      try { piece = await loader.readFlash(a, n); }
      catch (e) { log(`read 0x${a.toString(16)} retry ${tries + 1}: ${e.message}`); await sleep(300); }
    }
    if (!piece || piece.length < n) throw new Error("backup read failed");
    out.set(piece.subarray(0, n), a);
    const pct = Math.round(((a + n) / flashBytes) * 100);
    $("p2").style.width = pct + "%";
    say("m2", `Reading… ${pct}%`);
  }
  backup = out;
  const h = md5(out);
  const flashH = await loader.flashMd5sum(0, flashBytes);
  if (String(flashH) !== h) throw new Error("backup check failed (the copy doesn't match). Please try again.");
  backupName = `purifier-backup-${mac.replace(/:/g, "")}-${new Date().toISOString().slice(0, 10)}.bin`;
  downloadBackup();
  $("bBackup").disabled = false; $("bRestore").disabled = false;
  log(`backup ${flashBytes} bytes md5 ${h} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  say("m2", `Backup saved ✓ <span class="mut">(${backupName} in your Downloads)</span>`, "ok");
  stepState(2, "done");
}
function downloadBackup() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([backup], { type: "application/octet-stream" }));
  a.download = backupName;
  document.body.appendChild(a); a.click(); a.remove();
}
$("bBackup").onclick = () => backup && downloadBackup();

async function flashFiles(files, barId, msgId) {
  const total = files.reduce((s, f) => s + f.bytes.length, 0);
  const done = new Array(files.length).fill(0);
  await loader.writeFlash({
    fileArray: files.map((f) => ({ data: bytesToBinStr(f.bytes), address: f.address })),
    flashSize: "keep", flashMode: "keep", flashFreq: "keep", eraseAll: false, compress: true,
    reportProgress: (i, written, tot) => {
      done[i] = (written / tot) * files[i].bytes.length;
      const pct = Math.round((done.reduce((s, v) => s + v, 0) / total) * 100);
      $(barId).style.width = pct + "%";
      say(msgId, `Writing… ${pct}%`);
    },
    calculateMD5Hash: (img) => md5(binStrToBytes(img)),
  });
}

async function doInstall() {
  stepState(3, "on");
  await flashFiles(parts, "p3", "m3");
  $("p3").style.width = "100%";
  log("install verified, restarting purifier");
  say("m3", `Installed and checked ✓ <span class="mut">(V${manifest.version})</span>`, "ok");
  await loader.after("hard_reset");
  await closeLoader();
  stepState(3, "done");
}

// ---------- talking to the new firmware ----------
let reader = null, rxBuf = "", waiters = [], lastStatus = null;
async function openConsole() {
  await port.open({ baudRate: 115200 });
  try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (e) { log("signals: " + e.message); }
  const dec = new TextDecoder();
  reader = port.readable.getReader();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rxBuf += dec.decode(value, { stream: true });
        let i;
        while ((i = rxBuf.indexOf("\n")) >= 0) {
          const line = rxBuf.slice(0, i).replace(/\r$/, "");
          rxBuf = rxBuf.slice(i + 1);
          onLine(line);
        }
      }
    } catch (e) { log("console read: " + e.message); }
  })();
}
async function closeConsole() {
  try { if (reader) { await reader.cancel(); reader.releaseLock(); } } catch (e) {}
  reader = null;
  try { await port.close(); } catch (e) {}
}
function onLine(line) {
  if (!line.trim()) return;
  log("purifier: " + line.replace(/(token=set\(\.\.\.\.)\w+/, "$1****"));
  if (line.startsWith("#STATUS|")) {
    lastStatus = {};
    for (const kv of line.split("|").slice(1)) { const j = kv.indexOf("="); if (j > 0) lastStatus[kv.slice(0, j)] = kv.slice(j + 1); }
  }
  waiters = waiters.filter((w) => { if (w.test(line)) { w.resolve(line); return false; } return true; });
}
function waitFor(test, ms) {
  return new Promise((resolve) => {
    const w = { test: typeof test === "string" ? (l) => l.startsWith(test) : test, resolve };
    waiters.push(w);
    setTimeout(() => { waiters = waiters.filter((x) => x !== w); resolve(null); }, ms);
  });
}
async function send(cmd) {
  const w = port.writable.getWriter();
  await w.write(new TextEncoder().encode(cmd + "\n"));
  w.releaseLock();
  log("sent: " + (cmd.startsWith("@TOKEN") ? "@TOKEN ****" : cmd.startsWith("@WIFI") ? "@WIFI " + cmd.slice(6).split("\t")[0] + " ****" : cmd));
}
async function cmd(c, expect, ms = 8000) { const p = waitFor(expect, ms); await send(c); return p; }
async function status(ms = 3000) { const r = await cmd("@STATUS", "#STATUS|", ms); return r ? lastStatus : null; }
async function waitAlive(totalMs) {
  const end = Date.now() + totalMs;
  while (Date.now() < end) { const s = await status(2500); if (s) return s; }
  return null;
}

async function afterInstall() {
  stepState(4, "on");
  say("m4", "Starting the purifier…");
  try { await openConsole(); } catch (e) { return fail(4, e); }
  let s = await waitAlive(30000);
  if (!s) { say("m4", "The purifier didn't answer. Unplug the USB cable, plug it back in, then reload this page and click Connect again. (Your backup is already saved.)", "bad"); $("help").open = true; return; }
  log(`firmware ${s.fw} screen ${s.screen} (${s.src}) wifi ${s.wifi} blynk ${s.blynk}`);
  const t = await cmd("@TOKEN " + TOKEN, (l) => l.startsWith("#OK|TOKEN") || l.startsWith("#ERR|TOKEN"));
  if (!t || !t.startsWith("#OK")) { say("m4", "Couldn't save the purifier's Blynk key. Send Nikhil the details below.", "bad"); $("help").open = true; return; }
  await cmd("@TEST", "#OK|TEST");
  $("q4").classList.remove("hide");
  say("m4", "");
}

let screenTries = 0;
document.querySelectorAll("#q4 [data-a]").forEach((b) => (b.onclick = async () => {
  const a = b.dataset.a;
  document.querySelectorAll("#q4 button").forEach((x) => (x.disabled = true));
  try {
    if (a === "ok") {
      await cmd("@DONE", "#OK|DONE");
      $("q4").classList.add("hide");
      say("m4", `Screen OK ✓ <span class="mut">(${lastStatus ? lastStatus.screen : ""})</span>`, "ok");
      stepState(4, "done");
      return wifiStep();
    }
    screenTries++;
    const c = a === "blank" ? "@SCREEN SWAP" : a === "inv" ? "@INVERT" : a === "rb" ? "@COLOR" : "@FLIP";
    say("m4", "Trying a different screen setting… look at the screen again in 3 seconds.");
    await cmd(c, "#OK|SCREEN", 10000);
    await status();
    if (screenTries >= 6) say("m4", "Still not right? Choose the closest answer, or send Nikhil a photo of the screen.", "warn");
    else say("m4", "Look at the screen again and choose:");
  } finally {
    document.querySelectorAll("#q4 button").forEach((x) => (x.disabled = false));
  }
}));

// ---------- WiFi ----------
async function wifiStep() {
  stepState(5, "on");
  const s = await status();
  if (s && s.wifi === "CONNECTED") {
    say("m5", `The purifier is already connected to <b>${escapeHtml(s.ssid)}</b> ✓`, "ok");
    $("k5").classList.remove("hide");
    return;
  }
  say("m5", s && s.ssid ? `The saved WiFi <b>${escapeHtml(s.ssid)}</b> isn't connecting. Pick your WiFi:` : "Pick your home WiFi:");
  showWifiForm();
}
$("bKeep").onclick = async () => { $("k5").classList.add("hide"); await finish(true); };
$("bChange").onclick = () => { $("k5").classList.add("hide"); say("m5", "Pick your home WiFi:"); showWifiForm(); };
$("bShow").onclick = () => { const p = $("pass"); p.type = p.type === "password" ? "text" : "password"; $("bShow").textContent = p.type === "password" ? "Show" : "Hide"; };
$("bRescan").onclick = () => scan();

async function showWifiForm() { $("w5").classList.remove("hide"); await scan(); }
async function scan() {
  const sel = $("ssid");
  sel.innerHTML = "<option>Searching…</option>";
  const nets = new Map();
  const collect = (l) => { if (l.startsWith("#NET|")) { const [, rssi, open, ...nm] = l.split("|"); const n = nm.join("|"); if (n && (!nets.has(n) || nets.get(n) < +rssi)) nets.set(n, +rssi); } return l.startsWith("#SCANEND"); };
  await cmd("@SCAN", collect, 15000);
  const list = [...nets.entries()].sort((a, b) => b[1] - a[1]);
  sel.innerHTML = list.map(([n, r]) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}  (${r > -60 ? "strong" : r > -75 ? "ok" : "weak"})</option>`).join("") +
    `<option value="__other">Other (type the name)…</option>`;
  sel.onchange = () => {
    if (sel.value === "__other") { const n = prompt("Type the WiFi name exactly:"); if (n) { sel.insertAdjacentHTML("afterbegin", `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`); sel.selectedIndex = 0; } }
  };
}
$("bWifi").onclick = async () => {
  const ssid = $("ssid").value, pass = $("pass").value;
  if (!ssid || ssid === "__other") return say("m5", "Pick the WiFi name first.", "warn");
  if (pass.includes("\t") || ssid.includes("\t")) return say("m5", "That name or password has an unusual character. Send Nikhil a message.", "bad");
  $("bWifi").disabled = true;
  say("m5", "Saving and restarting the purifier…");
  await cmd(`@WIFI ${ssid}\t${pass}`, (l) => l.startsWith("#OK|WIFI") || l.startsWith("#ERR|WIFI"));
  await sleep(3000);
  const ok = await waitWifi(45000);
  $("bWifi").disabled = false;
  if (!ok) { say("m5", "It couldn't join that WiFi. Check the password (use Show) and click Connect WiFi again. The purifier must be within reach of the router.", "bad"); return; }
  $("w5").classList.add("hide");
  say("m5", `Connected to <b>${escapeHtml(ssid)}</b> ✓`, "ok");
  await finish(false);
};
async function waitWifi(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await status(2500);
    if (s) say("m5", `Connecting… <span class="mut">(${s.wifi.toLowerCase().replace("_", " ")})</span>`);
    if (s && s.wifi === "CONNECTED") return true;
    await sleep(2000);
  }
  return false;
}

// ---------- finish ----------
async function finish(needRestartForToken) {
  stepState(5, "done");
  stepState(6, "on");
  if (needRestartForToken) {                   // the new token is used after a restart
    say("m6", "Restarting the purifier once…");
    await cmd("@RESTART", "#OK|RESTART");
    await sleep(3000);
    await waitAlive(20000);
    const w = await waitWifi(40000);
    say("m5", w ? `Connected to <b>${escapeHtml(lastStatus ? lastStatus.ssid : "")}</b> ✓` : "WiFi is reconnecting…", w ? "ok" : "warn");
  }
  say("m6", "Checking the connection to Blynk… (up to a minute)");
  let s = null;
  const end = Date.now() + 75000;
  while (Date.now() < end) { s = await status(2500); if (s && s.blynk === "ONLINE") break; await sleep(3000); }
  const online = s && s.blynk === "ONLINE";
  $("sum").innerHTML = s ? [
    ["Software", "V" + s.fw], ["Screen", s.screen], ["WiFi", `${escapeHtml(s.ssid)} (${s.wifi.toLowerCase()})`],
    ["Blynk", online ? "online ✓" : s.blynk.toLowerCase()], ["Air sensor", s.pms === "OK" ? `working (AQI ${s.aqi})` : "warming up"], ["Board", s.mac],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("") : "";
  if (online) {
    say("m6", "All done ✅ You can unplug the USB cable and use the purifier normally.<br><span class='mut'>Please take a screenshot of this page and send it to Nikhil.</span>", "ok");
    stepState(6, "done");
  } else {
    say("m6", "The purifier works, but it isn't online in Blynk yet. Leave it plugged in for 2 more minutes; if it still isn't online, send Nikhil a screenshot and the details below.", "warn");
    $("help").open = true;
  }
}

// ---------- restore ----------
async function restore(bytes) {
  if (!port) { say("m1", "Click Connect first (pick the purifier), then use restore.", "warn"); return; }
  if (!confirm("Put the old software back on the purifier? (Takes about 2 minutes.)")) return;
  await closeConsole();
  try {
    await openLoader();
    $("help").open = true;
    log(`restoring ${bytes.length} bytes`);
    await flashFiles([{ address: 0, bytes }], "p3", "m3");
    await loader.after("hard_reset");
    await closeLoader();
    say("m3", "Old software restored ✓. Unplug the USB cable.", "ok");
  } catch (e) { fail(3, e); }
}
$("bRestore").onclick = () => backup && restore(backup);
$("fRestore").onchange = async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const b = new Uint8Array(await f.arrayBuffer());
  if (b.length < 1024 * 1024 || b[0x1000] !== 0xe9) { alert("That doesn't look like a purifier backup file."); return; }
  if (!port) { try { port = await navigator.serial.requestPort(); } catch { return; } }
  restore(b);
};
$("bLog").onclick = async () => {
  try { await navigator.clipboard.writeText(logLines.join("\n")); $("bLog").textContent = "Copied ✓ (paste it into WhatsApp)"; }
  catch { $("help").open = true; }
};

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
