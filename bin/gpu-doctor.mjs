#!/usr/bin/env node
// gpu-doctor: finds the places where your renders silently fall back to the CPU.
// Linux first. Zero dependencies. Every check is read-only and times out on its own.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has("--json");
const QUICK = args.has("--quick");
if (args.has("-h") || args.has("--help")) {
  console.log(`gpu-doctor: is your GPU actually doing the work?

usage: npx github:yigit-builds/gpu-doctor [--json] [--quick]

checks: gpu + driver, vulkan, opengl, headless chrome (webgl), ffmpeg hw encode,
        blender (cycles + eevee), pytorch. read-only, nothing is installed.
  --quick   skip the slow checks (blender, ffmpeg encode test)
  --json    machine-readable output`);
  process.exit(0);
}

const color = !JSON_OUT && process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const ICON = { ok: c(32, "✓"), warn: c(33, "!"), fail: c(31, "✗"), skip: c(90, "·") };

const results = [];
function report(name, status, detail, fix) {
  results.push({ name, status, detail, fix: fix || null });
  if (JSON_OUT) return;
  console.log(`${ICON[status]} ${c(1, name.padEnd(20))} ${detail}`);
  if (fix) for (const line of fix.split("\n")) console.log(`  ${c(36, "→")} ${line}`);
}

function run(cmd, argv, { timeout = 20000, env } = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", timeout, env: env || process.env });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "", err: r.error };
}
function which(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
const isSoftware = (s) => /llvmpipe|swiftshader|softpipe|software rasterizer|lavapipe/i.test(s || "");

if (platform() !== "linux") {
  report("platform", "skip", `${platform()} isn't covered yet. linux only for now, PRs welcome.`);
  finish();
}

// ---------------------------------------------------------------- gpu + driver
const VENDORS = { "0x1002": "AMD", "0x10de": "NVIDIA", "0x8086": "Intel" };
const gpus = [];
try {
  for (const card of readdirSync("/sys/class/drm").filter((d) => /^card\d+$/.test(d))) {
    const dev = `/sys/class/drm/${card}/device`;
    const vendor = readFileSync(`${dev}/vendor`, "utf8").trim();
    let driver = "none";
    try { driver = basename(readlinkSync(`${dev}/driver`)); } catch {}
    gpus.push({ card, vendor: VENDORS[vendor] || vendor, driver });
  }
} catch {}
const vendorSet = new Set(gpus.map((g) => g.vendor));
if (!gpus.length) report("gpu", "fail", "no gpu found under /sys/class/drm", "inside a container or vm? pass the gpu through (/dev/dri) first");
else {
  const bad = gpus.filter((g) => g.driver === "none" || g.driver === "nouveau" && g.vendor === "NVIDIA");
  const desc = gpus.map((g) => `${g.vendor} (${g.driver})`).join(", ");
  if (gpus.some((g) => g.driver === "none")) report("gpu", "fail", `${desc}: no kernel driver bound`, "install the vendor driver (amdgpu / nvidia / i915) and reboot");
  else if (bad.length) report("gpu", "warn", `${desc}: nouveau has no compute, most AI/render tools won't use it`, "install the proprietary nvidia driver");
  else report("gpu", "ok", desc);
}
const renderNode = existsSync("/dev/dri") ? readdirSync("/dev/dri").find((d) => d.startsWith("renderD")) : null;
if (gpus.length && renderNode) {
  const r = run("sh", ["-c", `test -r /dev/dri/${renderNode} && test -w /dev/dri/${renderNode}`]);
  if (!r.ok) report("permissions", "fail", `can't open /dev/dri/${renderNode}`, `sudo usermod -aG render,video $USER   (then log out and back in)`);
}

// ---------------------------------------------------------------- vulkan
let vkHw = null;
if (which("vulkaninfo")) {
  const r = run("vulkaninfo", ["--summary"]);
  const names = [...r.out.matchAll(/deviceName\s*=\s*(.+)/g)].map((m) => m[1].trim());
  const hw = names.filter((n) => !isSoftware(n));
  vkHw = hw[0] || null;
  if (hw.length) report("vulkan", "ok", hw.join(", "));
  else if (names.length) report("vulkan", "fail", `only software: ${names.join(", ")}`, vendorSet.has("AMD") || vendorSet.has("Intel") ? "sudo apt install mesa-vulkan-drivers   (or your distro's equivalent)" : "install the vendor vulkan driver (nvidia: comes with the proprietary driver)");
  else report("vulkan", "fail", "no vulkan device", "install mesa-vulkan-drivers / the vendor driver");
} else report("vulkan", "skip", "vulkaninfo not installed (apt install vulkan-tools)");

// ---------------------------------------------------------------- opengl
if (which("glxinfo")) {
  const r = run("glxinfo", ["-B"]);
  const m = r.out.match(/OpenGL renderer string:\s*(.+)/);
  if (!m) report("opengl", "skip", "glxinfo found no display");
  else if (isSoftware(m[1])) report("opengl", "fail", `${m[1].trim()} (cpu)`, "your desktop itself draws on the cpu. check the driver install before anything else");
  else report("opengl", "ok", m[1].trim());
} else report("opengl", "skip", "glxinfo not installed (apt install mesa-utils)");

// ---------------------------------------------------------------- headless chrome
function findChromes() {
  const found = [];
  const add = (label, p) => { if (p && existsSync(p) && !found.some((f) => f.path === p)) found.push({ label, path: p }); };
  add("$CHROME_PATH", process.env.CHROME_PATH);
  add("$PUPPETEER_EXECUTABLE_PATH", process.env.PUPPETEER_EXECUTABLE_PATH);
  for (const [label, root] of [["puppeteer", join(homedir(), ".cache/puppeteer")], ["playwright", join(homedir(), ".cache/ms-playwright")]]) {
    if (!existsSync(root)) continue;
    const r = run("find", [root, "-maxdepth", "4", "-type", "f", "(", "-name", "chrome", "-o", "-name", "chrome-headless-shell", "-o", "-name", "headless_shell", ")"]);
    const paths = r.stdout.split("\n").filter(Boolean).sort().reverse();
    if (paths[0]) add(label, paths[0]);
  }
  for (const b of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) add(b, which(b));
  return found;
}

function probeWebGL(bin, flags, envOverride) {
  const dir = mkdtempSync(join(tmpdir(), "gpu-doctor-"));
  const page = join(dir, "probe.html");
  writeFileSync(page, `<html><body><script>
let r='no-webgl';try{const g=document.createElement('canvas').getContext('webgl');if(g){const e=g.getExtension('WEBGL_debug_renderer_info');r=e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)}}catch(x){r='error'}
document.body.textContent='RENDERER='+r;</script></body></html>`);
  const headless = /headless/.test(basename(bin)) ? [] : ["--headless=new"];
  const r = run(bin, [...headless, "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(dir, "profile")}`, ...flags, "--dump-dom", pathToFileURL(page).href], { timeout: 30000, env: envOverride });
  rmSync(dir, { recursive: true, force: true });
  const m = r.stdout.match(/RENDERER=([^<]*)/);
  return m ? m[1].trim() : "no-output";
}
const short = (s) => s.replace(/^ANGLE \(/, "").replace(/\)$/, "").slice(0, 70);

const chromes = findChromes();
if (!chromes.length) report("chrome", "skip", "no chrome/chromium found (puppeteer, playwright or system)");
for (const chrome of chromes.slice(0, 2)) {
  const name = `chrome (${chrome.label.replace(/^google-chrome.*/, "system")})`;
  const def = probeWebGL(chrome.path, []);
  if (!isSoftware(def) && def !== "no-webgl" && def !== "no-output") { report(name, "ok", `webgl on ${short(def)}`); continue; }
  const tries = [
    ["--use-gl=angle --use-angle=vulkan", ["--use-gl=angle", "--use-angle=vulkan"]],
    ["--use-gl=angle --use-angle=gl-egl", ["--use-gl=angle", "--use-angle=gl-egl"]],
    ["--use-gl=angle --use-angle=gl", ["--use-gl=angle", "--use-angle=gl"]],
  ];
  const working = [];
  let waylandTrap = false;
  for (const [label, flags] of tries) {
    const got = probeWebGL(chrome.path, flags);
    if (!isSoftware(got) && /\w/.test(got) && got !== "no-webgl" && got !== "no-output") working.push([label, got]);
    else if (label.includes("gl-egl") && process.env.WAYLAND_DISPLAY) {
      const env = { ...process.env }; delete env.WAYLAND_DISPLAY;
      const got2 = probeWebGL(chrome.path, flags, env);
      if (!isSoftware(got2) && got2 !== "no-webgl" && got2 !== "no-output") waylandTrap = true;
    }
  }
  const what = def === "no-webgl" ? "headless webgl is off by default" : /swiftshader/i.test(def) ? "headless webgl runs on SwiftShader (cpu)" : `headless webgl runs on ${short(def)} (cpu)`;
  const fixes = [];
  if (working.length) fixes.push(`add these flags: ${working[0][0]}   → ${short(working[0][1])}`);
  if (waylandTrap) fixes.push("gl-egl only works with WAYLAND_DISPLAY unset. tools that pick gl-egl (e.g. hyperframes --browser-gpu)\nrender a blank webgl canvas on wayland. run them as: env -u WAYLAND_DISPLAY <command>");
  if (!working.length && !waylandTrap) fixes.push("no flag combo reached the gpu. check the vulkan / opengl lines above");
  report(name, "fail", what, fixes.join("\n"));
}

// ---------------------------------------------------------------- ffmpeg
if (which("ffmpeg")) {
  const enc = run("ffmpeg", ["-hide_banner", "-encoders"]).out;
  const tests = [];
  if ((vendorSet.has("AMD") || vendorSet.has("Intel")) && /h264_vaapi/.test(enc) && renderNode)
    tests.push(["h264_vaapi", ["-vaapi_device", `/dev/dri/${renderNode}`, "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi"]]);
  if (vendorSet.has("NVIDIA") && /h264_nvenc/.test(enc)) tests.push(["h264_nvenc", ["-c:v", "h264_nvenc"]]);
  if (!tests.length) report("ffmpeg encode", "warn", "this ffmpeg has no hw encoder for your gpu, encoding runs on the cpu", vendorSet.has("NVIDIA") ? "use an ffmpeg build with nvenc" : "use an ffmpeg build with vaapi (most distro builds have it)");
  else if (QUICK) report("ffmpeg encode", "skip", `has ${tests.map((t) => t[0]).join(", ")} (not tested, --quick)`);
  else {
    const okEnc = [];
    for (const [label, a] of tests) {
      const r = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=1280x720:rate=30", ...a, "-f", "null", "-"], { timeout: 30000 });
      if (r.ok) okEnc.push(label);
    }
    if (okEnc.length) report("ffmpeg encode", "ok", `${okEnc.join(", ")} works. most tools still default to libx264 (cpu)`, okEnc.includes("h264_vaapi") ? `ffmpeg -vaapi_device /dev/dri/${renderNode} -i in.mp4 -vf format=nv12,hwupload -c:v h264_vaapi out.mp4` : "ffmpeg -i in.mp4 -c:v h264_nvenc out.mp4");
    else report("ffmpeg encode", "fail", `${tests.map((t) => t[0]).join(", ")} listed but the test encode failed`, vendorSet.has("AMD") ? "sudo apt install mesa-va-drivers   (vaapi for amd)" : "check the va / nvenc driver");
  }
} else report("ffmpeg encode", "skip", "ffmpeg not installed");

// ---------------------------------------------------------------- blender
const blender = which("blender");
if (!blender) report("blender", "skip", "blender not on PATH");
else if (QUICK) report("blender", "skip", "skipped (--quick)");
else {
  const py = `
import bpy
p = bpy.context.preferences.addons['cycles'].preferences
print('PREF', p.compute_device_type)
print('VER', bpy.app.version_string)
for t in ('CUDA','OPTIX','HIP','ONEAPI'):
    try:
        p.compute_device_type = t; p.refresh_devices()
        print('DEV', t, '|'.join(d.name for d in p.devices if d.type == t))
    except Exception: pass
`;
  const r = run(blender, ["-b", "--python-expr", py], { timeout: 90000 });
  const pref = (r.out.match(/^PREF (\S+)/m) || [])[1];
  const ver = (r.out.match(/^VER (.+)/m) || [])[1] || "?";
  const devs = [...r.out.matchAll(/^DEV (\S+) (.+)$/gm)].map((m) => [m[1], m[2].trim()]).filter((d) => d[1]);
  if (!pref) report("blender cycles", "skip", "couldn't query blender");
  else if (!devs.length) report("blender cycles", "warn", `blender ${ver}: no cycles gpu backend sees your card, cycles = cpu`, vendorSet.has("AMD") ? "cycles on amd needs the HIP runtime (rocm). eevee still uses the gpu" : "install the vendor compute runtime");
  else if (pref === "NONE") {
    const [type] = devs[0];
    report("blender cycles", "fail", `blender ${ver}: ${type} sees ${devs[0][1]}, but cycles is set to cpu`,
      `enable it in Preferences > System > Cycles Render Devices > ${type}, or in your script:\n` +
      `p=bpy.context.preferences.addons['cycles'].preferences; p.compute_device_type='${type}'; p.refresh_devices()\n` +
      `[setattr(d,'use',d.type=='${type}') for d in p.devices]; bpy.context.scene.cycles.device='GPU'`);
  } else report("blender cycles", "ok", `blender ${ver}: ${pref} (${devs.map((d) => d[1]).join(", ")}). scenes still need device = GPU`);
}

// ---------------------------------------------------------------- pytorch
const py = which("python3");
if (py) {
  const r = run(py, ["-c", "import torch;print('T',torch.__version__,torch.cuda.is_available(),torch.version.hip,torch.version.cuda)"], { timeout: 30000 });
  const m = r.out.match(/^T (\S+) (True|False) (\S+) (\S+)/m);
  if (!m) report("pytorch", "skip", "torch not installed in python3");
  else if (m[2] === "True") report("pytorch", "ok", `torch ${m[1]} sees the gpu (${m[3] !== "None" ? "rocm " + m[3] : "cuda " + m[4]})`);
  else report("pytorch", "fail", `torch ${m[1]} is a ${m[3] !== "None" ? "rocm" : m[4] !== "None" ? "cuda" : "cpu-only"} build and sees no gpu`,
    vendorSet.has("AMD") ? "install the rocm build: pip install torch --index-url https://download.pytorch.org/whl/rocm6.4\nolder cards (rx 5000/6000) may need HSA_OVERRIDE_GFX_VERSION, unofficial" : "install the cuda build from pytorch.org");
}

finish();

function finish() {
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  if (JSON_OUT) console.log(JSON.stringify({ platform: platform(), gpus, results }, null, 2));
  else console.log(`\n${fails ? c(31, `${fails} place(s) where work lands on the cpu`) : c(32, "no cpu fallbacks found")}${warns ? `, ${warns} warning(s)` : ""}`);
  process.exit(fails ? 1 : 0);
}
