/* 干员头像识别 —— 用 MAA 的 resource/template/char_*.png 做模板匹配。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【难点：没有图像解码库】
 *   char_*.png 是 PNG，纯 JS 解不了（不想引第三方库）。
 *   解法：**借 ffmpeg 当解码器** ——
 *     ffmpeg -i char_002_amiya.png -vf scale=32:32 -f rawvideo -pix_fmt rgb24 out.rgb
 *   一次调用就把任意格式的图和缩放一起处理掉。
 *
 * 【匹配算法】
 *   归一化互相关（NCC），对亮度/对比度变化不敏感：
 *     ncc = Σ((a-ā)(b-b̄)) / sqrt(Σ(a-ā)² · Σ(b-b̄)²)
 *   取最高分且超过阈值的模板。
 *
 * 【名字从哪来】
 *   avatar-map.json：文件名 → 干员中文名（现有 139 条精确匹配）。
 *   MAA 的文件名是缩写（kalts / huang / angel），和 name_en 对不上，
 *   所以 462 张里只有 139 张能可靠命名 —— 剩下的能匹配到图但叫不出名，
 *   那就只能放弃命名，比错映射好。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SIZE = 32;   /* 模板统一缩到 32×32×RGB */

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

/* 把所有 char_*.png 转成 32×32 原始 RGB（一次一个文件，结果缓存在内存） */
function loadTemplates(maaResource, opts) {
  const o = Object.assign({ limit: 0, mapFile: path.join(__dirname, 'avatar-map.json') }, opts || {});
  const res = maaResource;
  const tplDir = path.join(res, 'resource', 'template');
  const dir = fs.existsSync(tplDir) ? tplDir : res;
  if (!fs.existsSync(dir)) return { ok: false, reason: '找不到 template 目录: ' + dir };
  const ff = ffmpeg();
  if (!ff) return { ok: false, reason: '找不到 ffmpeg' };

  /* 名字映射 */
  let nameMap = {};
  try {
    const arr = JSON.parse(fs.readFileSync(o.mapFile, 'utf8'));
    for (const x of arr) nameMap[x.file] = x.name;
  } catch {}

  /* 递归找 char_*.png —— MAA 把它们放在 template/ 的子目录里，
   * 用非递归 readdirSync 会一张都找不到（踩过）。 */
  const files = [];
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^char_.*\.png$/i.test(e.name)) files.push(p);
    }
  })(dir);
  const pick = o.limit ? files.slice(0, o.limit) : files;
  const tmp = path.join(os.tmpdir(), 'tpl-' + process.pid + '.rgb');
  const FB = SIZE * SIZE * 3;
  const out = [];
  let failed = 0;
  for (const fp of pick) {
    const f = path.basename(fp);
    try {
      execFileSync(ff, ['-y', '-v', 'error', '-i', fp,
        '-vf', 'scale=' + SIZE + ':' + SIZE, '-f', 'rawvideo', '-pix_fmt', 'rgb24', tmp],
        { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      const b = fs.readFileSync(tmp);
      if (b.length < FB) { failed++; continue; }
      const base = f.replace(/\.png$/i, '');
      out.push({ file: base, path: fp, name: nameMap[base] || null, rgb: b.slice(0, FB) });
    } catch { failed++; }
  }
  try { fs.unlinkSync(tmp); } catch {}
  return { ok: out.length > 0, count: out.length, failed, named: out.filter((x) => x.name).length, templates: out, dir };
}

/* 把一段原始 RGB（任意尺寸）重采样成 32×32 */
function resample(rgb, w, h) {
  const out = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / SIZE));
    for (let x = 0; x < SIZE; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / SIZE));
      const si = (sy * w + sx) * 3, di = (y * SIZE + x) * 3;
      out[di] = rgb[si]; out[di + 1] = rgb[si + 1]; out[di + 2] = rgb[si + 2];
    }
  }
  return out;
}

/* 归一化互相关 */
function ncc(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0, cnt = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; cnt++; }
  const ma = sa / cnt, mb = sb / cnt;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/* 用一段画面区域去匹配所有模板，返回 Top-N */
function match(rgb, w, h, templates, opts) {
  const o = Object.assign({ top: 5, minScore: 0.5 }, opts || {});
  const probe = resample(rgb, w, h);
  const scored = templates.map((t) => ({ file: t.file, name: t.name, score: ncc(probe, t.rgb) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, o.top);
  return { best: top[0] || null, top, ok: !!(top[0] && top[0].score >= o.minScore) };
}

/* ★ 在整条干员栏上滑窗匹配 ★
 * 为什么用滑窗而不是"先切卡片再匹配"：
 *   卡片宽度/间距会随干员被用掉而重排（前面踩过：按等宽切全错位），
 *   而滑窗不需要知道卡片边界 —— 直接在条带上找"最像某张头像的位置"。
 *
 * stripRgb: 干员栏条带的原始 RGB，高度应为 SIZE（32）
 * 返回 每个模板的最高分位置，按分数排序
 */
function matchBar(stripRgb, stripW, stripH, templates, opts) {
  const o = Object.assign({ top: 10, minScore: 0.60 }, opts || {});
  const step = 2;                      /* 滑窗步长：2px（32 宽的窗口足够密） */
  const win = SIZE;                    /* 正方形窗口 */
  const out = [];
  for (const t of templates) {
    let best = -2, bestX = -1;
    for (let x = 0; x + win <= stripW; x += step) {
      /* 取窗口 → 与模板算 NCC（只比 RGB 三通道） */
      const buf = Buffer.alloc(win * win * 3);
      for (let y = 0; y < win; y++) {
        for (let xx = 0; xx < win; xx++) {
          const si = ((y * stripW) + (x + xx)) * 3;
          const di = ((y * win) + xx) * 3;
          buf[di] = stripRgb[si]; buf[di + 1] = stripRgb[si + 1]; buf[di + 2] = stripRgb[si + 2];
        }
      }
      const s = ncc(buf, t.rgb);
      if (s > best) { best = s; bestX = x; }
    }
    out.push({ file: t.file, name: t.name, score: +best.toFixed(4), x: bestX });
  }
  out.sort((a, b) => b.score - a.score);
  /* 同一位置附近只留最高分（避免一个头像被多个模板重复命中） */
  const picked = [];
  for (const c of out) {
    if (picked.some((p) => Math.abs(p.x - c.x) <= SIZE / 2)) continue;
    picked.push(c);
    if (picked.length >= o.top) break;
  }
  return { ok: !!(out[0] && out[0].score >= o.minScore), top: picked, all: out.slice(0, 30) };
}

module.exports = { SIZE, ffmpeg, loadTemplates, resample, ncc, match, matchBar };
