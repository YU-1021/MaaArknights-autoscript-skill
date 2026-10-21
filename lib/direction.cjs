/* 朝向 + 技能就绪 —— 都从"正在放"那一帧的差集里读。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【朝向怎么来】
 *   部署时游戏会画出这个干员的**攻击范围**（高亮格子）。松手后范围消失。
 *   所以：
 *       正在放那一帧  −  放之后那一帧  =  攻击范围的像素集合
 *   再算这块集合的**质心相对格心的偏移** → 哪个轴大就是哪个方向。
 *
 *   为什么用差集而不是直接认颜色：范围高亮在不同 UI 皮肤下颜色不同
 *   （蓝、橙、白都见过），但"松手就消失"这件事是不变的 —— 差集不受颜色影响。
 *
 * 【技能就绪怎么来】
 *   见 skill.cjs 的说明：MAA 用 ONNX（我们没法用），但它自己的
 *   BattleOperCooling 就是数色。这里采用「干员上方搜亮黄块」，
 *   不依赖 UI 皮肤的精确偏移（MAA 的 rectMove 在这个皮肤下对不上，实测采空了）。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIRS = ['Right', 'Left', 'Up', 'Down'];

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

/* 抽一帧的某个矩形（原始像素 RGB） */
function grabRect(file, sec, rect) {
  const ff = ffmpeg(); if (!ff) return null;
  const tmp = path.join(os.tmpdir(), 'dir-' + process.pid + '-' + Date.now() + '-' + Math.round(sec * 1000) + '.rgb');
  try {
    execFileSync(ff, ['-y', '-v', 'error', '-ss', String(sec), '-i', file,
      '-frames:v', '1', '-vf', 'crop=' + rect.w + ':' + rect.h + ':' + rect.x + ':' + rect.y,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', tmp],
      { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const b = fs.readFileSync(tmp);
    if (b.length < rect.w * rect.h * 3) return null;
    return b;
  } catch { return null; } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/* ★ 朝向：单帧内搜「橙色 V 形箭头」★
 *
 * 为什么换成这个（前面两条路都证伪了）：
 *   ① 跨帧差集（正在放 − 放之后）：放干员时**地图会平移**，
 *      差集被位移淹没 —— 实测 300×300 区域差出 104242 像素（比区域本身还大），
 *      质心偏移趋近 0，「哪个轴大」变成纯噪声。
 *   ② 攻击范围高亮：范围只在"悬停某格"的极短瞬间出现，
 *      而且我抓到的帧其实是「所有合法落点」的绿色整片，没有方向性。
 *
 * 实测发现（17.3s 放大 4 倍看清）：干员脚下有一个**橙色 V 形箭头**，
 * 尖端指向 = 朝向。真实像素约 rgb(240,150,20)，非常纯。
 * 所以：单帧内按颜色找橙色块 → 连通域 → 用"两端谁更窄"定尖端方向。
 * 单帧内完成，完全不受地图偏移影响。
 */
const ORANGE = { rMin: 190, gMin: 95, gMax: 175, bMax: 70, rgMin: 55 };

function isOrange(r, g, b, o) {
  const O = o || ORANGE;
  return r >= O.rMin && g >= O.gMin && g <= O.gMax && b <= O.bMax && (r - g) >= O.rgMin;
}

function detectDirection(file, tileCenterBase, duringSec, afterSec, videoW, videoH, opts) {
  const o = Object.assign({ half: 200, minPixels: 120 }, opts || {});
  const sx = videoW / 1280, sy = videoH / 720;
  const cx = Math.round(tileCenterBase.x * sx), cy = Math.round(tileCenterBase.y * sy);
  const half = Math.round(o.half * Math.max(sx, sy));
  const rect = {
    x: Math.max(0, cx - half), y: Math.max(0, cy - half),
    w: Math.min(videoW - Math.max(0, cx - half), half * 2),
    h: Math.min(videoH - Math.max(0, cy - half), half * 2),
  };
  const rgb = grabRect(file, duringSec, rect);
  if (!rgb) return { ok: false, reason: '抽帧失败', rect };
  const W = rect.w, H = rect.h;

  /* 找橙色连通域，取最大的一块 */
  const mask = new Uint8Array(W * H);
  let total = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (isOrange(rgb[i], rgb[i + 1], rgb[i + 2], o.orange)) { mask[y * W + x] = 1; total++; }
    }
  }
  if (total < o.minPixels) return { ok: false, reason: '橙色像素太少（' + total + '），这帧可能没有朝向箭头', rect, orangePixels: total };

  const seen = new Uint8Array(W * H);
  const comps = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (!mask[k] || seen[k]) continue;
      const q = [k]; seen[k] = 1;
      let x0 = x, x1 = x, y0 = y, y1 = y, n = 0;
      const cols = new Map(), rows = new Map();
      while (q.length) {
        const c = q.pop(); const cy2 = Math.floor(c / W), cx2 = c % W;
        x0 = Math.min(x0, cx2); x1 = Math.max(x1, cx2);
        y0 = Math.min(y0, cy2); y1 = Math.max(y1, cy2);
        n++;
        cols.set(cx2, (cols.get(cx2) || 0) + 1);
        rows.set(cy2, (rows.get(cy2) || 0) + 1);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nx = cx2 + dx, ny = cy2 + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nk = ny * W + nx;
          if (mask[nk] && !seen[nk]) { seen[nk] = 1; q.push(nk); }
        }
      }
      if (n >= o.minPixels) comps.push({ n, x0, x1, y0, y1, cols, rows });
    }
  }
  if (!comps.length) return { ok: false, reason: '橙色块都太小（总橙像素 ' + total + '）', rect, orangePixels: total };

  /* ★ 取"离格心最近"的那块，不是最大的那块。
   * 实测教训：地图上有多处橙色（别的干员的部署箭头、血条、装饰）。
   * 按面积取最大 → 17.3s 抓到了 245px 外的一个橙块，判成 Down（错）；
   * 按"离格心最近"取 → 17.1s 抓到 8px 内的那块，判成 Left（与放大目视一致）。
   * 朝向箭头就贴在干员脚下，所以"最近"是最可靠的判据。 */
  const halfW = W / 2, halfH = H / 2;
  for (const c of comps) {
    c.cxDist = Math.hypot((c.x0 + c.x1) / 2 - halfW, (c.y0 + c.y1) / 2 - halfH);
  }
  comps.sort((a, b) => a.cxDist - b.cxDist);
  const best = comps[0];
  if (best.cxDist > Math.max(W, H) * 0.35) {
    return { ok: false, reason: '最近的橙色块也离格心 ' + best.cxDist.toFixed(0) + 'px，不像朝向箭头', rect, orangePixels: total };
  }

  /* ★ 朝向判定用「质心相对外接矩形中心的偏移」，不用"两端宽度比"。
   * 实测教训：宽度比在混进血条时会被拉平（同一秒内相邻帧给出 Right/Left/Down 三个答案）。
   * 而 V 形箭头的**质量集中在底部**（两个叉），尖端只有一个点：
   *   质心偏在哪一侧 → 那一侧是底部 → **朝向是相反侧**。
   * 这对少量杂质的容忍度比宽度剖面高得多。 */
  const bw = best.x1 - best.x0 + 1, bh = best.y1 - best.y0 + 1;
  let sumX = 0, sumY = 0, cnt = 0;
  for (const [x, c] of best.cols) { sumX += x * c; cnt += c; }
  for (const [y, c] of best.rows) { sumY += y * c; }
  const mx = cnt ? sumX / cnt : 0;
  const my = cnt ? sumY / cnt : 0;
  const bcx = (best.x0 + best.x1) / 2, bcy = (best.y0 + best.y1) / 2;
  /* 归一化偏移，抵消块大小差异 */
  const ox = bw ? (mx - bcx) / bw : 0;
  const oy = bh ? (my - bcy) / bh : 0;
  const horizontal = Math.abs(ox) >= Math.abs(oy);
  let dir;
  if (horizontal) dir = ox > 0 ? 'Left' : 'Right';   /* 质心偏右 → 底部在右 → 朝左 */
  else dir = oy > 0 ? 'Up' : 'Down';
  return {
    ok: true, dir, n: best.n, rect, cxDist: +best.cxDist.toFixed(1),
    bbox: { x: best.x0 + rect.x, y: best.y0 + rect.y, w: bw, h: bh },
    centroidOffset: { x: +ox.toFixed(3), y: +oy.toFixed(3) },
    axis: horizontal ? 'h' : 'v',
  };
}

/* 技能就绪：在干员上方一个"宽范围"里找亮黄块。
 * 不用 MAA 的固定 rectMove —— 实测这个 UI 皮肤对不上（采空了）。 */
const GOLD = { rMin: 165, gMin: 130, bMax: 110, rbDiff: 70, gbDiff: 30 };

function goldRatioAt(rgb, W, H, y0, y1) {
  let gold = 0, tot = 0;
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      tot++;
      if (r >= GOLD.rMin && g >= GOLD.gMin && b <= GOLD.bMax && (r - b) >= GOLD.rbDiff && (g - b) >= GOLD.gbDiff) gold++;
    }
  }
  return tot ? gold / tot : 0;
}

/* 扫描一个干员"上方区域"的金色占比时间线，找绿→金就绪点 */
function scanGold(file, tileCenterBase, videoW, videoH, fromSec, durSec, opts) {
  const o = Object.assign({ fps: 4, above: 130, width: 120, goldMin: 0.012, stable: 2 }, opts || {});
  const ff = ffmpeg(); if (!ff) return { ok: false, reason: '找不到 ffmpeg' };
  const sx = videoW / 1280, sy = videoH / 720;
  const cx = Math.round(tileCenterBase.x * sx), cy = Math.round(tileCenterBase.y * sy);
  const w = Math.round(o.width * sx);
  const h = Math.round(o.above * sy);
  const rect = { x: Math.max(0, cx - Math.round(w / 2)), y: Math.max(0, cy - h - Math.round(20 * sy)), w, h };
  const tmp = path.join(os.tmpdir(), 'gold-' + process.pid + '-' + Date.now() + '.rgb');
  try {
    execFileSync(ff, ['-y', '-v', 'error', '-ss', String(fromSec), '-t', String(durSec), '-i', file,
      '-vf', 'crop=' + rect.w + ':' + rect.h + ':' + rect.x + ':' + rect.y + ',fps=' + o.fps,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', tmp],
      { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const buf = fs.readFileSync(tmp);
    const FB = rect.w * rect.h * 3;
    const n = Math.floor(buf.length / FB);
    const tl = [];
    for (let i = 0; i < n; i++) {
      const f = buf.slice(i * FB, (i + 1) * FB);
      tl.push({ t: fromSec + i / o.fps, gr: goldRatioAt(f, rect.w, rect.h, 0, rect.h) });
    }
    /* 金色占比突然抬升且维持 → 就绪 */
    const ready = [];
    let run = 0, last = -1e9;
    for (let i = 0; i < tl.length; i++) {
      if (tl[i].gr >= o.goldMin) {
        run++;
        if (run === o.stable && tl[i].t - last > 1.5) { ready.push(+tl[i].t.toFixed(2)); last = tl[i].t; }
      } else run = 0;
    }
    return { ok: true, rect, samples: n, timeline: tl, readyAt: ready, peak: Math.max(...tl.map((x) => x.gr)) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

module.exports = { DIRS, ffmpeg, grabRect, detectDirection, scanGold, goldRatioAt, GOLD };
