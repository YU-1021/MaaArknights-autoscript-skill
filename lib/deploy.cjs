/* 部署事件抽取 —— 按"干员栏变动"来定位放置时刻。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 算法（按需求定的流程，不是我自己发挥）：
 *   ① 找**进入战斗那一帧**（作战 HUD 出现），以此为时间零点
 *   ② 从零点起**每 1.5 秒抽一帧**，只裁右下角**干员头像行**
 *   ③ 相邻两帧的干员栏做**色块差异度**比较；超过阈值 → 这 1.5 秒内放置了干员
 *   ④ 在这个 1.5 秒窗口内**逐帧抽**（30fps），得到三段关键帧：
 *        放之前 / 正在放 / 放之后
 *   ⑤ 朝向从"正在放"那一帧的**攻击范围延伸方向**读
 *
 * 【为什么只裁干员栏】
 *   全画面差分会被敌人移动、技能特效、水波动画淹没（我前面实测 196 个噪声事件）。
 *   而干员栏只有一件事会变：**某个头像被用掉了**（剩下的头像还会左移）。
 *   把观察范围缩到这一条，信噪比立刻拉开。
 *
 * 【为什么要避开费用数字】
 *   头像上方有部署费用数字，它随回费**一直在变**。
 *   所以取样区只取头像**本体**那一段（不含上方数字），否则每 1.5 秒都会"变动"。
 *
 * 【为什么要找"进入战斗"那一帧】
 *   视频开头有片头、加载、编队界面，它们的干员栏长得完全不同。
 *   不先对齐零点，前面几秒会全是假变动。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/* 默认区域（相对画面，0~1）——右下角干员头像行。
 * 避开了上方的费用数字（那些一直在变）和下方的"剩余可放置角色"文字。 */
const DEF = {
  barRect: { x: 0.68, y: 0.828, w: 0.32, h: 0.108 },
  /* 粗扫间隔（秒）*/
  coarseSec: 1.5,
  /* 色块差异阈值：把栏切成 GRID×GRID 块，逐块平均色差，取"变化块占比" */
  grid: 6,
  /* 变化块占比超过它才算"干员栏变了" */
  changeRatio: 0.18,
  /* 细扫帧率 */
  fineFps: 30,
  /* 单块颜色差异的判据（0~255 三通道和的平均） */
  blockDelta: 26,
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

function probe(file) {
  const ff = ffmpeg(); if (!ff) return null;
  const pr = path.join(path.dirname(ff), 'ffprobe.exe');
  try {
    const out = execFileSync(fs.existsSync(pr) ? pr : ff, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration', '-show_entries', 'format=duration',
      '-of', 'json', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const j = JSON.parse(out);
    const st = (j.streams && j.streams[0]) || {};
    let fps = 30;
    if (st.r_frame_rate) { const [a, b] = String(st.r_frame_rate).split('/').map(Number); if (b) fps = a / b; }
    return {
      width: Number(st.width) || 0, height: Number(st.height) || 0,
      fps: fps || 30,
      durationMs: Math.round((Number(st.duration) || Number(j.format && j.format.duration) || 0) * 1000),
    };
  } catch { return null; }
}

/* 抽"干员栏"的彩色原始帧序列：只需一次 ffmpeg 调用。
 * 返回 { buf, w, h, n, times[] } —— 每帧 w*h*3 字节 RGB。 */
function grabBar(file, info, fromSec, durSec, fps, rect) {
  const ff = ffmpeg();
  const R = rect || DEF.barRect;
  const vw = info.width, vh = info.height;
  const cx = Math.round(R.x * vw), cy = Math.round(R.y * vh);
  const cw = Math.round(R.w * vw), ch = Math.round(R.h * vh);
  /* 缩到固定小尺寸，两块不同的栏尺寸也能比 */
  const ow = 96, oh = Math.max(8, Math.round(96 * ch / cw));
  const tmp = path.join(os.tmpdir(), 'bargrab-' + process.pid + '-' + Date.now() + '.rgb');
  const vf = 'crop=' + cw + ':' + ch + ':' + cx + ':' + cy + ',fps=' + fps + ',scale=' + ow + ':' + oh;
  try {
    execFileSync(ff, ['-y', '-v', 'error', '-ss', String(fromSec), '-t', String(durSec), '-i', file,
      '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', tmp],
      { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const buf = fs.readFileSync(tmp);
    const FB = ow * oh * 3;
    const n = Math.floor(buf.length / FB);
    const times = [];
    for (let i = 0; i < n; i++) times.push(fromSec + i / fps);
    return { buf, w: ow, h: oh, n, times, rect: { cx, cy, cw, ch } };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/* 色块差异度：把两块区域各切成 GRID×GRID，逐块算平均 RGB，
 * 返回"差异超过阈值的块占比"（0~1）。 */
function blockDiff(a, b, w, h, grid, blockDelta) {
  const G = grid || DEF.grid, TH = blockDelta || DEF.blockDelta;
  const cw = w / G, ch = h / G;
  let changed = 0, total = 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      let ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bb = 0, n = 0;
      const x0 = Math.floor(gx * cw), x1 = Math.min(w, Math.ceil((gx + 1) * cw));
      const y0 = Math.floor(gy * ch), y1 = Math.min(h, Math.ceil((gy + 1) * ch));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 3;
          ar += a[i]; ag += a[i + 1]; ab += a[i + 2];
          br += b[i]; bg += b[i + 1]; bb += b[i + 2];
          n++;
        }
      }
      if (!n) continue;
      total++;
      const d = (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)) / (3 * n);
      if (d >= TH) changed++;
    }
  }
  return total ? changed / total : 0;
}

/* ① 找进入战斗的帧。
 *
 * 判据演进（第一版是错的，记在这里免得再犯）：
 *   第一版用"区域方差"——结果片头 logo 方差 46（最高），战斗 HUD 只有 7，
 *   于是它把 t=0 当成了战斗起点。
 *   ⚠️ 教训：**高对比 ≠ 战斗**。片头是白字大 logo，对比度天然最高。
 *
 * 现在用两条：
 *   ① **色彩饱和度** —— 干员头像花花绿绿，饱和度占比高；片头/黑场/加载画面饱和度低；
 *   ② **持续性** —— 战斗 HUD 一旦出现就一直在；片头只有一两秒。
 *      要求连续 KEEP 个采样都达标才算数，片头过不了这一关。
 */
function findBattleStart(file, info, opts) {
  const o = Object.assign({}, DEF, opts);
  const sec = Math.min(60, Math.max(0, Math.round((info.durationMs || 60000) / 1000)));
  const g = grabBar(file, info, 0, sec, 2, o.barRect);   /* 前 60 秒，2fps 粗看 */
  if (!g.n) return { ok: false, reason: '抽不到帧' };
  const FB = g.w * g.h * 3;
  const scores = [];
  for (let i = 0; i < g.n; i++) {
    const f = g.buf.slice(i * FB, (i + 1) * FB);
    let sat = 0, n = 0;
    for (let p = 0; p < f.length; p += 3) {
      const r = f[p], gg = f[p + 1], b = f[p + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx > 60 && (mx - mn) > 45) sat++;
      n++;
    }
    scores.push({ t: g.times[i], v: n ? sat / n : 0 });
  }
  /* 参考值：全片饱和度的高分位（战斗段占多数） */
  const sorted = scores.map((s) => s.v).slice().sort((a, b) => a - b);
  const p70 = sorted[Math.floor(sorted.length * 0.7)] || 0;
  const thr = Math.max(0.06, p70 * 0.55);
  /* 持续性：连续 KEEP 个采样（2fps → KEEP=8 约 4 秒）都达标 */
  const KEEP = 8;
  let start = null;
  for (let i = 0; i + KEEP <= scores.length; i++) {
    let all = true;
    for (let k = 0; k < KEEP; k++) if (scores[i + k].v < thr) { all = false; break; }
    if (all) { start = scores[i].t; break; }
  }
  return {
    ok: start !== null, startSec: start,
    scores: scores.slice(0, 40),
    ref: p70, threshold: thr, keep: KEEP,
  };
}

/* ②③ 1.5 秒粗扫干员栏，找变动点 */
function scanBarChanges(file, info, startSec, opts) {
  const o = Object.assign({}, DEF, opts);
  const dur = Math.max(2, ((info.durationMs || 0) / 1000) - startSec);
  const fps = 1 / o.coarseSec;
  const g = grabBar(file, info, startSec, dur, fps, o.barRect);
  const FB = g.w * g.h * 3;
  const changes = [];
  for (let i = 1; i < g.n; i++) {
    const a = g.buf.slice((i - 1) * FB, i * FB);
    const b = g.buf.slice(i * FB, (i + 1) * FB);
    const d = blockDiff(a, b, g.w, g.h, o.grid, o.blockDelta);
    if (d >= o.changeRatio) {
      changes.push({ fromSec: g.times[i - 1], toSec: g.times[i], ratio: d });
    }
  }
  return { ok: true, samples: g.n, changes, rect: g.rect };
}

/* ④ 在 1.5 秒窗口内逐帧抽，给出"放之前 / 正在放 / 放之后" */
function fineWindow(file, info, fromSec, toSec, opts) {
  const o = Object.assign({}, DEF, opts);
  const span = Math.max(0.2, toSec - fromSec);
  const fps = Math.min(o.fineFps, 60);
  const g = grabBar(file, info, fromSec, span, fps, o.barRect);
  const FB = g.w * g.h * 3;
  /* 用窗口最后一帧当"放之后"的参考，倒推第一处显著变化 = 正在放 */
  if (g.n < 3) return { ok: false, reason: '窗口帧数不足' };
  const first = g.buf.slice(0, FB);
  const last = g.buf.slice((g.n - 1) * FB, g.n * FB);
  const d0 = blockDiff(first, last, g.w, g.h, o.grid, o.blockDelta);
  let during = null;
  for (let i = 1; i < g.n - 1; i++) {
    const f = g.buf.slice(i * FB, (i + 1) * FB);
    const d = blockDiff(first, f, g.w, g.h, o.grid, o.blockDelta);
    if (d >= Math.max(0.10, d0 * 0.45)) { during = g.times[i]; break; }
  }
  return {
    ok: d0 >= o.changeRatio * 0.5,
    span, endDiff: d0,
    beforeSec: g.times[0],
    duringSec: during,
    afterSec: g.times[g.n - 1],
    frames: g.n,
  };
}

module.exports = { DEF, ffmpeg, probe, grabBar, blockDiff, findBattleStart, scanBarChanges, fineWindow };
