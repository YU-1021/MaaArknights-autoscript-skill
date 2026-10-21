/* 技能释放检测 —— 按"技能球颜色绿→金"来判定。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【MAA 是怎么做的，我为什么不照搬】
 *   MAA 的 BattlefieldClassifier::skill_ready_analyze（BattlefieldClassifier.cpp:45-110）：
 *     · 取干员格中心 + rectMove 偏移 → 得一块 64×64 区域（就是技能球）
 *     · resize 72×72 → 中心裁 64×64 → ImageNet 归一化
 *     · 喂 ONNX 模型 skill_ready_cls → softmax 三分类
 *   它用 CNN 是因为技能球有"充能中/就绪/生效中"三种状态，
 *   单靠颜色阈值分不干净（充能中也有黄边）。
 *
 *   我们**没法用**这条路：要 onnxruntime + 模型文件，是另一个量级的依赖。
 *
 * 【但 MAA 的 ROI 几何必须借】
 *   它已经把"技能球在干员格中心的哪个位置"调好了：
 *     BattleSkillReady  rectMove = [-28, -140, 64, 64]   （1280×720 基准）
 *   这是实测调出来的偏移，自己量会偏。直接拿来用。
 *
 * 【另外 MAA 自己也用数色】
 *     BattleOperCooling rectMove = [-68, 124, 114, 4]
 *     colorScales = HSV[[0,100,0],[20,255,150]]，specialParams=[300]
 *   这是干员下方一条 114×4 的细条，数橙红色像素 ≥300 判"技能生效中"。
 *   —— 所以"用代码数色"这条路 MAA 认可，不是我瞎搞。
 *
 * 【本模块采用：MAA 的区域 + 数色判据】
 *   技能球就绪时是**亮金色**（R 高、G 中高、B 低），充能中是**青绿色**
 *   （G 高、B 也高）。所以判据是「R-B 差值」和「金色占比」：
 *     gold:   R > 150 && R > B + 55 && G > 110
 *     green:  G > 120 && G > R + 25 && B > 90
 *   连续若干帧从 green 变 gold → 记录"技能就绪"时刻。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/* 直接抄 MAA 的 rectMove（1280×720 基准空间） */
const ROI = {
  /* 技能球：干员格中心 + (-28,-140)，64×64 */
  skillOrb: { x: -28, y: -140, w: 64, h: 64 },
  /* 下方冷却/生效细条：(-68,+124)，114×4 */
  coolingBar: { x: -68, y: 124, w: 114, h: 4 },
};

const DEF = {
  /* 金色判据 */
  gold: { rMin: 150, rbDiff: 55, gMin: 110 },
  /* 青绿判据（充能中） */
  green: { gMin: 120, grDiff: 25, bMin: 90 },
  /* 一帧里达到"金"的像素占比超过它 → 认为技能球是金色 */
  goldRatio: 0.30,
  /* 连续多少帧金色才算就绪（防单帧闪光误判）*/
  stableFrames: 3,
  fps: 5,
};

function ffmpeg() {
  try {
    const out = execFileSync('where.exe', ['ffmpeg'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const f = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (f && fs.existsSync(f)) return f;
  } catch {}
  for (const g of ['C:\\Program Files\\ffmpeg-9.0.1-essentials_build\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe']) {
    if (fs.existsSync(g)) return g;
  }
  return null;
}

/* 干员格中心（1280×720 基准）+ rectMove → 实际像素矩形（换算到视频尺寸） */
function roiFor(centerBase, move, videoW, videoH) {
  const sx = (videoW || 1280) / 1280, sy = (videoH || 720) / 720;
  const x = Math.round((centerBase.x + move.x) * sx);
  const y = Math.round((centerBase.y + move.y) * sy);
  const w = Math.max(2, Math.round(move.w * sx));
  const h = Math.max(2, Math.round(move.h * sy));
  return { x, y, w, h };
}

/* 抽某个固定小区域的时间序列（单次 ffmpeg） */
function grabRegion(file, rect, fromSec, durSec, fps) {
  const ff = ffmpeg();
  if (!ff) return null;
  const tmp = path.join(os.tmpdir(), 'skgrab-' + process.pid + '-' + Date.now() + '.rgb');
  /* 不缩放：区域本来就小，保留原始像素才能看颜色 */
  const vf = 'crop=' + rect.w + ':' + rect.h + ':' + rect.x + ':' + rect.y + ',fps=' + fps;
  try {
    execFileSync(ff, ['-y', '-v', 'error', '-ss', String(fromSec), '-t', String(durSec), '-i', file,
      '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', tmp],
      { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const buf = fs.readFileSync(tmp);
    const FB = rect.w * rect.h * 3;
    const n = Math.floor(buf.length / FB);
    return { buf, n, w: rect.w, h: rect.h, FB, times: Array.from({ length: n }, (_, i) => fromSec + i / fps) };
  } catch { return null; } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/* 单帧的区域颜色统计 */
function colorStats(frame, n, opt) {
  const o = Object.assign({}, DEF, opt || {});
  let gold = 0, green = 0, tot = 0;
  for (let p = 0; p < frame.length; p += 3) {
    const r = frame[p], g = frame[p + 1], b = frame[p + 2];
    tot++;
    if (r > o.gold.rMin && (r - b) > o.gold.rbDiff && g > o.gold.gMin) gold++;
    else if (g > o.green.gMin && (g - r) > o.green.grDiff && b > o.green.bMin) green++;
  }
  const gr = tot ? gold / tot : 0, gn = tot ? green / tot : 0;
  return { goldRatio: gr, greenRatio: gn, state: gr >= o.goldRatio ? 'gold' : (gn >= o.goldRatio * 0.6 ? 'green' : 'other') };
}

/* 扫描一个干员的技能球，找"绿→金"的就绪时刻。
 * 返回 { ok, timeline[], readyAt: [秒,...] } */
function scanSkillReady(file, centerBase, videoW, videoH, fromSec, durSec, opt) {
  const o = Object.assign({}, DEF, opt || {});
  const rect = roiFor(centerBase, ROI.skillOrb, videoW, videoH);
  const g = grabRegion(file, rect, fromSec, durSec, o.fps);
  if (!g || !g.n) return { ok: false, reason: '抽不到技能球区域', rect };
  const timeline = [];
  for (let i = 0; i < g.n; i++) {
    const f = g.buf.slice(i * g.FB, (i + 1) * g.FB);
    const s = colorStats(f, g.n, o);
    timeline.push({ t: g.times[i], ...s });
  }
  /* 找 green → gold 的转变（要求连续 stableFrames 帧为 gold） */
  const readyAt = [];
  let prevWasGreen = false, run = 0, lastReady = -1e9;
  for (const s of timeline) {
    if (s.state === 'green') { prevWasGreen = true; run = 0; }
    else if (s.state === 'gold') {
      run++;
      if (run >= o.stableFrames && prevWasGreen && s.t - lastReady > 1.0) {
        readyAt.push(s.t); lastReady = s.t; prevWasGreen = false; run = 0;
      }
    } else { run = 0; }
  }
  return { ok: true, rect, timeline, readyAt, fps: o.fps };
}

module.exports = { ROI, DEF, ffmpeg, roiFor, grabRegion, colorStats, scanSkillReady };
