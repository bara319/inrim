import express from "express";
import cors from "cors";
import multer from "multer";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/* ──────────────────────────────────────────────
   node-canvas は optionalDependency。
   入らなかった環境では「静止サムネ＋音声」へ自動フォールバック。
────────────────────────────────────────────── */
let createCanvas = null, loadImage = null;
try {
  const canvasMod = await import("canvas");
  createCanvas = canvasMod.createCanvas;
  loadImage = canvasMod.loadImage;
  console.log("canvas: OK (動的レンダリング有効)");
} catch (e) {
  console.warn("canvas: 利用不可。静止サムネモードで動きます。", e?.message);
}

const PORT = Number(process.env.PORT || 3000);
const FPS = Number(process.env.RENDER_FPS || 24);
const W = 720, H = 1280;
const MAX_DURATION = 31;          // 秒
const FFMPEG_TIMEOUT_MS = 180000; // 3分で強制終了
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RENDERS || 1);

/* フォント: アプリは 'MS Gothic' だが、MSゴシックはライセンス上
   サーバーに入れられない。Linux定番の代替で見た目が最も近い
   IPAゴシック(fonts-ipafont-gothic)を第一候補にする。 */
const FONT_MONO = "'IPAGothic','IPAゴシック','Noto Sans Mono CJK JP','Noto Sans CJK JP',monospace";
const FONT_SANS = "'IPAGothic','IPAゴシック','Noto Sans CJK JP',sans-serif";

const app = express();
const upload = multer({
  dest: tmpdir(),
  limits: { fileSize: 30 * 1024 * 1024, files: 3 }
});
app.use(cors());

app.get("/", (_req, res) => {
  res.type("text").send("inrim video server ok" + (createCanvas ? " (dynamic)" : " (static only)"));
});
app.get("/healthz", (_req, res) => res.json({ ok: true, dynamic: !!createCanvas }));

/* 同時レンダリング数を制限（Render無料プラン向け） */
let active = 0;
const waiters = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  if (waiters.length >= 4) return Promise.reject(new Error("busy"));
  return new Promise(resolve => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next(); else active--;
}

app.post("/render", upload.fields([
  { name: "audio", maxCount: 1 },
  { name: "poster", maxCount: 1 },
  { name: "photo", maxCount: 1 }
]), async (req, res) => {
  const audio = req.files?.audio?.[0];
  const poster = req.files?.poster?.[0];
  const photo = req.files?.photo?.[0];
  const cleanupTargets = [audio, poster, photo].filter(Boolean).map(f => f.path);

  if (!audio) {
    await cleanup(null, cleanupTargets);
    res.status(400).json({ error: "audio is required" });
    return;
  }

  try {
    await acquire();
  } catch {
    await cleanup(null, cleanupTargets);
    res.status(503).json({ error: "server busy, retry shortly" });
    return;
  }

  const work = await mkdtemp(join(tmpdir(), "inrim-"));
  try {
    const duration = Math.min(MAX_DURATION, (await probeDuration(audio.path)) || 30);
    const output = join(work, "inrim.mp4");

    let rendered = false;
    if (createCanvas) {
      try {
        await renderDynamic({
          output,
          audioPath: audio.path,
          photoPath: photo?.path || null,
          duration,
          topic: String(req.body?.topic || "").slice(0, 60),
          lyrics: String(req.body?.lyrics || "").slice(0, 2000),
          beatName: String(req.body?.beat || "BEAT").slice(0, 20),
          color: sanitizeColor(req.body?.color) || "#ff0066",
          bpm: String(req.body?.bpm || "").slice(0, 4)
        });
        rendered = true;
      } catch (e) {
        console.warn("dynamic render failed, falling back to poster:", e?.message);
      }
    }

    if (!rendered) {
      if (!poster) throw new Error("poster required for static render");
      await renderStatic({ output, audioPath: audio.path, posterPath: poster.path, duration });
    }

    const buf = await readFile(output);
    if (!buf.length) throw new Error("empty output");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Content-Disposition", 'attachment; filename="inrim.mp4"');
    res.send(buf);
  } catch (error) {
    console.error("render error:", error);
    if (!res.headersSent) res.status(500).json({ error: "render failed" });
  } finally {
    release();
    await cleanup(work, cleanupTargets);
  }
});

async function cleanup(work, files) {
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  await Promise.all(files.map(f => rm(f, { force: true }).catch(() => {})));
}

function sanitizeColor(v) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v) : null;
}

function probeDuration(path) {
  return new Promise(resolve => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", path]);
    let out = "";
    p.stdout.on("data", d => out += d);
    p.on("close", () => {
      const n = parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0.5 ? n : null);
    });
    p.on("error", () => resolve(null));
  });
}

/* ──────────────────────────────────────────────
   静止サムネ + 音声（フォールバック）
────────────────────────────────────────────── */
function renderStatic({ output, audioPath, posterPath, duration }) {
  return runFfmpeg([
    "-y",
    "-loop", "1", "-i", posterPath,
    "-i", audioPath,
    "-t", String(duration),
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast",
    "-profile:v", "baseline", "-level", "3.1", "-r", "24",
    "-c:a", "aac", "-b:a", "160k",
    "-shortest", "-movflags", "+faststart",
    output
  ]);
}

/* ──────────────────────────────────────────────
   動的レンダリング:
   アプリ内 drawEmotionLog() と同じ見た目をサーバーで再現。
   - 写真背景(暗めオーバーレイ) or 黒+グラデ
   - 細い枠線 + スキャンライン
   - 流れる歌詞（中央・小さめ・等幅）
   - レインボー波形
   - お題は左上に小さく / 韻リム表記は控えめ
────────────────────────────────────────────── */
async function renderDynamic({ output, audioPath, photoPath, duration, topic, lyrics, beatName, color, bpm }) {
  const photoImg = photoPath ? await loadImage(photoPath).catch(() => null) : null;
  const totalFrames = Math.ceil(duration * FPS);

  const ff = spawn("ffmpeg", [
    "-y",
    "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-i", audioPath,
    "-t", String(duration),
    "-vf", "format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast",
    "-profile:v", "baseline", "-level", "3.1",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    output
  ], { stdio: ["pipe", "ignore", "pipe"] });

  let stderr = "";
  ff.stderr.on("data", d => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-4000); });

  const done = new Promise((resolve, reject) => {
    const killer = setTimeout(() => { ff.kill("SIGKILL"); }, FFMPEG_TIMEOUT_MS);
    ff.on("error", e => { clearTimeout(killer); reject(e); });
    ff.on("close", code => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
  });

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const scene = { W, H, topic, lyrics, beatName, color, bpm, photoImg, duration };

  for (let frame = 0; frame < totalFrames; frame++) {
    drawEmotionLog(ctx, scene, frame / FPS);
    const jpg = canvas.toBuffer("image/jpeg", { quality: 0.92 });
    if (!ff.stdin.write(jpg)) {
      await new Promise(r => ff.stdin.once("drain", r));
    }
  }
  ff.stdin.end();
  await done;
}

/* ── 以下、アプリ側 drawEmotionLog の移植 ── */

function hexRgb(c) {
  return { r: parseInt(c.slice(1, 3), 16), g: parseInt(c.slice(3, 5), 16), b: parseInt(c.slice(5, 7), 16) };
}

function canvasLines(ctx, text, maxWidth, maxLines = 4) {
  const chars = String(text).replace(/\s+/g, "").split("");
  const lines = []; let line = "";
  for (const ch of chars) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = ch; }
    else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(1, kept[maxLines - 1].length - 1)) + "…";
    return kept;
  }
  return lines.length ? lines : ["今の気分"];
}

function fitTextLines(ctx, text, { maxWidth, maxLines = 4, maxSize = 80, minSize = 24, font = FONT_SANS, weight = 900 }) {
  let size = maxSize, lines = [];
  while (size >= minSize) {
    ctx.font = `${weight} ${size}px ${font}`;
    lines = canvasLines(ctx, text, maxWidth, maxLines);
    if (lines.every(l => ctx.measureText(l).width <= maxWidth)) break;
    size -= 2;
  }
  return { size, lines };
}

function drawCoverBackground(ctx, W, H, photoImg, rgb) {
  if (photoImg) {
    const ir = photoImg.width / photoImg.height, cr = W / H;
    let sx = 0, sy = 0, sw = photoImg.width, sh = photoImg.height;
    if (ir > cr) { sw = Math.round(photoImg.height * cr); sx = Math.round((photoImg.width - sw) / 2); }
    else { sh = Math.round(photoImg.width / cr); sy = Math.round((photoImg.height - sh) / 2); }
    ctx.drawImage(photoImg, sx, sy, sw, sh, 0, 0, W, H);
    ctx.fillStyle = "rgba(0,0,0,0.68)"; ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.35, H * 0.22, 0, W * 0.35, H * 0.22, W * 0.85);
    g.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0.18)`);
    g.addColorStop(0.55, "rgba(0,0,0,0.08)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  for (let y = 0; y < H; y += 4) { ctx.fillStyle = "rgba(0,0,0,0.13)"; ctx.fillRect(0, y, W, 1); }
  for (let i = 0; i < 420; i++) {
    const x = (i * 47 % 997) / 997 * W;
    const y = (i * 83 % 991) / 991 * H;
    const a = ((i * 29 % 100) / 100) * 0.018;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

function drawSimpleFrame(ctx, W, H, color, scale = 1) {
  const m = 34 * scale;
  ctx.strokeStyle = color; ctx.globalAlpha = 0.82; ctx.lineWidth = Math.max(1, 2 * scale);
  ctx.strokeRect(m, m, W - m * 2, H - m * 2);
  ctx.globalAlpha = 0.42;
  ctx.beginPath();
  ctx.moveTo(m, H * 0.2); ctx.lineTo(W - m, H * 0.2);
  ctx.moveTo(m, H * 0.79); ctx.lineTo(W - m, H * 0.79);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawRainbowWave(ctx, W, y, width, height, t = 0, bars = 48) {
  const x0 = (W - width) / 2;
  const colors = ["#ff1744", "#ff9100", "#ffea00", "#38ff4f", "#00e5ff", "#2979ff", "#d500f9"];
  const gap = Math.max(2, width / (bars * 5));
  const barW = (width - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i++) {
    const wave = Math.sin(t * 4 + i * 0.48) * 0.5 + 0.5;
    const pulse = Math.sin(t * 7 + i * 1.7) * 0.5 + 0.5;
    const h = height * (0.18 + wave * 0.52 + pulse * 0.2);
    const x = x0 + i * (barW + gap);
    ctx.fillStyle = colors[i % colors.length];
    ctx.globalAlpha = 0.72;
    ctx.fillRect(x, y - h / 2, barW, h);
  }
  ctx.globalAlpha = 1;
}

function drawEmotionLog(ctx, { W, H, topic, lyrics, beatName, color, bpm, photoImg, duration }, t) {
  const rgb = hexRgb(color);
  const s = W / 500;
  drawCoverBackground(ctx, W, H, photoImg, rgb);
  drawSimpleFrame(ctx, W, H, color, s);

  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.shadowBlur = 0;
  ctx.font = `700 ${Math.round(9 * s)}px ${FONT_MONO}`;
  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.fillText("韻リム / 30SEC LOG", 44 * s, 68 * s);

  if (topic) {
    const topicFit = fitTextLines(ctx, topic, { maxWidth: W - 88 * s, maxLines: 2, maxSize: 12 * s, minSize: 9 * s, font: FONT_MONO, weight: 400 });
    ctx.font = `400 ${topicFit.size}px ${FONT_MONO}`;
    ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.78)`;
    topicFit.lines.forEach((l, i) => ctx.fillText(l, 44 * s, 98 * s + i * topicFit.size * 1.4));
  }

  const lyricSource = (lyrics || "").split("\n").filter(l => l.trim());
  const lyricLines = lyricSource.length ? lyricSource : ["今日は少しだけ本音を書く", "言えなかったままのこと", "夜のすみっこに置いていく"];
  const centerY = H * 0.47;
  const lineStep = 62 * s;
  const secondsPerLine = Math.max(1.8, duration / (lyricLines.length + 2));
  const progress = Math.min(lyricLines.length - 1, t / secondsPerLine);
  const current = Math.floor(progress);
  const scrollOffset = (progress - current) * lineStep;

  ctx.textAlign = "center";
  for (let offset = -3; offset <= 3; offset++) {
    const idx = current + offset;
    if (idx < 0 || idx >= lyricLines.length) continue;
    const distance = Math.abs(offset - scrollOffset / lineStep);
    const isCurrent = distance < 0.65;
    const alpha = Math.max(0.16, 0.9 - distance * 0.22);
    const fit = fitTextLines(ctx, lyricLines[idx], { maxWidth: W - 90 * s, maxLines: 2, maxSize: 17 * s, minSize: 10 * s, font: FONT_MONO, weight: isCurrent ? 700 : 400 });
    const lineH = fit.size * 1.45;
    const blockH = fit.lines.length * lineH;
    const y = centerY + offset * lineStep - scrollOffset - blockH / 2 + fit.size;
    ctx.font = `${isCurrent ? 700 : 400} ${fit.size}px ${FONT_MONO}`;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.shadowColor = isCurrent ? `rgba(${rgb.r},${rgb.g},${rgb.b},0.45)` : "transparent";
    ctx.shadowBlur = isCurrent ? 5 * s : 0;
    fit.lines.forEach((l, j) => ctx.fillText(l, W / 2, y + j * lineH));
  }
  ctx.shadowBlur = 0;

  drawRainbowWave(ctx, W, H * 0.75, W - 92 * s, 68 * s, t, 48);

  ctx.textAlign = "left";
  ctx.font = `700 ${Math.round(9 * s)}px ${FONT_MONO}`;
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  const sec = Math.min(Math.max(0, Math.floor(duration) - 1), Math.floor(t || 0));
  ctx.fillText(`REC 00:${String(sec).padStart(2, "0")} / PRIVATE TRACK`, 44 * s, H - 54 * s);
  ctx.textAlign = "right";
  ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.72)`;
  ctx.fillText(beatName + (bpm ? `  BPM${bpm}` : ""), W - 44 * s, H - 54 * s);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const killer = setTimeout(() => child.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    child.on("error", e => { clearTimeout(killer); reject(e); });
    child.on("close", code => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-600) || `ffmpeg exited ${code}`));
    });
  });
}

app.listen(PORT, () => {
  console.log(`inrim video server listening on ${PORT}`);
});
