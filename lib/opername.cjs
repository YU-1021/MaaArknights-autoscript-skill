/* 干员名字识别 —— 渲染闭集 + NCC 匹配。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么这条路可行（已实测）】
 *   作战详情面板左上角显示干员名（白字黑底，字形约 26×30 px @1920）。
 *   把 1384 个干员名用 msyh 渲染成图，和观测字形做归一化互相关：
 *
 *     观测「山」 →  山  NCC=0.653   ← 第 1
 *                   阿  NCC=0.184   ← 第 2
 *                   陈  NCC=0.159
 *
 *   **8 倍差距。** 虽然游戏字体和 msyh 不同，但中文字形结构区分度极高，
 *   归一化到 32×32 后依然能可靠区分。
 *
 * 【为什么不用真 OCR】
 *   没有中文 OCR 引擎，加依赖代价大。而名字是**闭集**（1384 个），
 *   闭集匹配比开放集识别更可靠，也不需要模型文件。
 *
 * 【关键设计】
 *   ① 按"外接框归一化到 N×N"比较 —— 消除字号/位置差异
 *   ② 名字整体渲染（不是逐字），字数不同天然被排除（1字 vs 2字形状差很大）
 *   ③ 返回 margin（第1名 - 第2名），margin 小就报"不确定"，不冒认
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const N = 32;                        /* 归一化尺寸 */
const NPIX = N * N;

/* 名字区（**1280×720 基准**）：作战详情面板左上角，白字。
 *
 * 实测（1920×1080）：名字「山」占 x 28..54, y 281..308。
 * 上方 y250..262 是**攻击范围图的残留**，必须排除，否则外接框会被拉大
 * （踩过：用 y270 起的大区域 + Otsu 自适应阈值，框出 124×46 的假字形）。
 *
 * 换算到 1280 基准：x 15/1.5=10, y 277/1.5≈185, 宽 190/1.5≈127, 高 33/1.5≈22
 * 宽度留到 127 是为了容纳最长 5 字名（浊心斯卡蒂 / 耀骑士临光 / 假日威龙陈）。
 */
const NAME_REGION = { x: 10, y: 185, w: 127, h: 22 };

/* 面板是暗底白字，用**固定高阈值**，不要用 Otsu。
 * 踩过的坑：区域内大部分是暗像素时，Otsu 会选出一个很低的阈值，
 * 把背景渐变也当文字，外接框直接撑到整块区域。 */
const MIN_LUM = 150;   /* 白字亮度下限 */
const REL_LUM = 80;    /* 相对中位数的下限差 */

const FONTS = [
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\msyhbd.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\simsun.ttc',
];

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
function pickFont(preferred) {
  if (preferred && fs.existsSync(preferred)) return preferred;
  for (const f of FONTS) if (fs.existsSync(f)) return f;
  return null;
}

/* Otsu 阈值（对面板的暗底白字很稳） */
function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  return best;
}

/* 把二值图按外接框归一化到 N×N（保持长宽比，居中） */
function normalize(bin, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bin[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const S = Math.max(bw, bh);
  const out = new Float32Array(NPIX);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const sx = x0 + Math.floor((x + 0.5) * S / N);
      const sy = y0 + Math.floor((y + 0.5) * S / N);
      out[y * N + x] = (sx >= 0 && sy >= 0 && sx < w && sy < h && bin[sy * w + sx]) ? 1 : 0;
    }
  }
  return { v: out, bw, bh };
}

function ncc(a, b) {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let nu = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; nu += x * y; da += x * x; db += y * y; }
  const d = Math.sqrt(da * db);
  return d > 0 ? nu / d : 0;
}

/* 从一帧里取出名字区的归一化字形。
 * frameRgb: Buffer(RGB)，videoW/videoH 为视频尺寸 */
function readGlyph(frameRgb, videoW, videoH, opts) {
  const o = Object.assign({ region: NAME_REGION }, opts || {});
  const sx = videoW / 1280, sy = videoH / 720;
  const x0 = Math.max(0, Math.round(o.region.x * sx));
  const y0 = Math.max(0, Math.round(o.region.y * sy));
  const w = Math.min(videoW - x0, Math.round(o.region.w * sx));
  const h = Math.min(videoH - y0, Math.round(o.region.h * sy));
  if (w <= 2 || h <= 2) return { ok: false, reason: '区域无效' };
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * videoW + (x0 + x)) * 3;
      lum[y * w + x] = frameRgb[i] * 0.299 + frameRgb[i + 1] * 0.587 + frameRgb[i + 2] * 0.114;
    }
  }
  /* 固定高阈值（见 MIN_LUM 的注释：不能用 Otsu） */
  const sortedLum = Array.from(lum).sort((a, b) => a - b);
  const med = sortedLum[Math.floor(sortedLum.length / 2)] || 0;
  const th = Math.max(MIN_LUM, med + REL_LUM);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) bin[i] = lum[i] > th ? 1 : 0;
  let on = 0;
  for (let i = 0; i < bin.length; i++) on += bin[i];
  const ratio = on / bin.length;
  /* 白像素太少 → 面板没显示；太多 → 整块都亮（战场画面），不是文字 */
  if (ratio < 0.004 || ratio > 0.45) {
    return { ok: false, reason: '不像文字（白像素占比 ' + (ratio * 100).toFixed(2) + '%）', ratio };
  }
  const n = normalize(bin, w, h);
  if (!n) return { ok: false, reason: '无外接框' };
  return { ok: true, v: n.v, bw: n.bw, bh: n.bh, threshold: th, inkRatio: ratio, rect: { x: x0, y: y0, w, h } };
}

/* 渲染一批名字成 N×N 模板，返回 { names:[], bits: Float32Array(count*NPIX) }
 *
 * 【踩过的坑：画布必须按字数算宽】
 *   最初用固定 140×140 画布 + fontsize 100，结果 1 个字放得下、**4 个字被裁掉**，
 *   导致「山」NCC=0.65 正常，而「娜仁图亚」NCC 只有 0.059（模板只剩前 1 个字）。
 *   现在画布宽 = 字数 × 字号 × 1.05 + 边距，高度 = 字号 × 1.6。
 */
function renderTemplates(names, opts) {
  const o = Object.assign({ font: null, size: 100, cacheFile: null }, opts || {});
  if (o.cacheFile && fs.existsSync(o.cacheFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(o.cacheFile, 'utf8'));
      if (j.count === names.length && j.names.join('\u0001') === names.join('\u0001') && j.ver === 2) {
        const buf = fs.readFileSync(o.cacheFile + '.bin');
        return { names: j.names, bits: new Float32Array(buf.buffer, buf.byteOffset, j.count * NPIX), cached: true };
      }
    } catch {}
  }
  const ff = ffmpeg();
  const font = pickFont(o.font);
  if (!ff || !font) return { ok: false, reason: 'ffmpeg 或中文字体不可用' };
  const tmp = path.join(os.tmpdir(), 'nametpl-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  const pngPath = path.join(tmp, 'r.png'), grayPath = path.join(tmp, 'r.gray');
  const bits = new Float32Array(names.length * NPIX);
  const kept = [];
  const F = o.size;
  const fontArg = font.replace(/\\/g, '/').replace(':', '\\:');
  for (const name of names) {
    try {
      const chars = [...String(name)].length;
      /* 画布宽要装下所有字；高度留足上下边 */
      let CW = Math.ceil(chars * F * 1.08) + 40;
      let CH = Math.ceil(F * 1.7) + 20;
      CW += CW % 2; CH += CH % 2;
      execFileSync(ff, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=' + CW + 'x' + CH,
        '-vf', "drawtext=fontfile='" + fontArg + "':text='" + name + "'"
          + ':fontsize=' + F + ':fontcolor=white:x=10:y=10',
        '-frames:v', '1', pngPath], { stdio: 'ignore' });
      execFileSync(ff, ['-y', '-v', 'error', '-i', pngPath, '-f', 'rawvideo', '-pix_fmt', 'gray', grayPath], { stdio: 'ignore' });
      const g = fs.readFileSync(grayPath);
      const gb = new Uint8Array(CW * CH);
      for (let i = 0; i < CW * CH && i < g.length; i++) gb[i] = g[i] >= 110 ? 1 : 0;
      const n = normalize(gb, CW, CH);
      if (!n) continue;
      const idx = kept.length;
      bits.set(n.v, idx * NPIX);
      kept.push(name);
    } catch {}
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const out = { names: kept, bits: bits.subarray(0, kept.length * NPIX) };
  if (o.cacheFile) {
    try {
      fs.writeFileSync(o.cacheFile, JSON.stringify({ ver: 2, count: kept.length, n: N, names: kept }), 'utf8');
      fs.writeFileSync(o.cacheFile + '.bin', Buffer.from(out.bits.buffer, out.bits.byteOffset, out.bits.byteLength));
    } catch {}
  }
  return out;
}

/* 把 readGlyph 的结果和模板库比对，返回 { ok, name, score, margin, top[] } */
function identify(glyph, tmpl, opts) {
  const o = Object.assign({ minScore: 0.40, minMargin: 0.12, top: 8 }, opts || {});
  if (!glyph || !glyph.ok || !tmpl || !tmpl.names || !tmpl.names.length) {
    return { ok: false, reason: (glyph && glyph.reason) || '无模板', top: [] };
  }
  const M = tmpl.bits, cnt = tmpl.names.length;
  const scored = new Array(cnt);
  for (let k = 0; k < cnt; k++) {
    const off = k * NPIX;
    /* 内联 NCC，避免每项 slicing 的开销 */
    let sa = 0, sb = 0;
    for (let i = 0; i < NPIX; i++) { sa += glyph.v[i]; sb += M[off + i]; }
    const ma = sa / NPIX, mb = sb / NPIX;
    let nu = 0, da = 0, db = 0;
    for (let i = 0; i < NPIX; i++) { const x = glyph.v[i] - ma, y = M[off + i] - mb; nu += x * y; da += x * x; db += y * y; }
    const d = Math.sqrt(da * db);
    scored[k] = { name: tmpl.names[k], s: d > 0 ? nu / d : 0 };
  }
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0], second = scored[1] || { s: 0 };
  const margin = best.s - second.s;
  const strong = best.s >= o.minScore && margin >= o.minMargin;
  return {
    ok: strong, name: best.name, score: +best.s.toFixed(4), margin: +margin.toFixed(4),
    reason: strong ? '' : (best.s < o.minScore ? '最高分过低' : '第1与第2太接近'),
    top: scored.slice(0, o.top).map((x) => x.name + ':' + x.s.toFixed(3)),
    ambiguous: !strong && margin < o.minMargin,
  };
}

module.exports = { N, NPIX, NAME_REGION, FONTS, ffmpeg, pickFont, otsu, normalize, ncc, readGlyph, renderTemplates, identify };
