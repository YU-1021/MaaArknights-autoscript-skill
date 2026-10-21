/* 视频分析引擎：从攻略视频里抽出"关键帧"和"倍速时间线"。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【为什么不用固定间隔抽帧】
 *   一段 10 分钟的攻略，真正有信息量的瞬间只有几十个 —— 都是"有人做了一个动作"。
 *   按秒抽帧会得到 600 帧，其中绝大多数是静止画面（白花时间、还会让模型混淆）。
 *   所以按**区域变化**抽：右下角干员栏 / 战场 / 右上角倍速标记，哪个变了就是关键帧。
 *
 * 【解码靠 ffmpeg，分析靠纯 JS】
 *   不引任何图像库：ffmpeg 直接吐 `rawvideo rgb24`，Node 读字节流就能算。
 *   分析在 320x180 上做（原图的 1/4），一帧 172KB，串流处理不吃内存。
 *
 * 【倍速必须先识别（这是第 5 点）】
 *   2 倍速下 **视频 1 秒 = 游戏内 2 秒**。不折算的话算出来的时机全错一半。
 *   而且中途可能切换倍速 → 所以产出是**分段**的，不是一个全局倍速。
 *   `gameTimeAt()` 负责把视频时间换算成游戏内时间。
 *
 * 【缩放：适配 1280 窗口和全屏（第 2 点）】
 *   所有区域坐标都写在 **1280x720 基准空间**里，分析时按实际分辨率等比缩放。
 *   所以 1280x720 / 1920x1080 / 全屏 都走同一套坐标 —— 这正是 MAA 的做法
 *   （它的 roi 也按 1280x720 写）。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

/* ---------------------------------------------------------------- 工具定位 */
let _ff, _ffp;
function which(name) {
  try {
    const out = execFileSync('where.exe', [name], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {}
  return null;
}
function ffmpeg() { if (_ff === undefined) _ff = which('ffmpeg'); return _ff; }
function ffprobe() { if (_ffp === undefined) _ffp = which('ffprobe'); return _ffp; }

/* ---------------------------------------------------------------- 区域定义
 * 全部写在 **1280x720 基准空间**里。下面的值已经用真实视频（BV1cNJ96MEff p06
 * 「昨日海」YW-EX-3 突袭，1920x1080）量过：
 *   量法：ffmpeg 裁切缩放 → 看图定位边界 → ÷1.5 换到 1280 基准。
 *   1920 实测 → 1280 基准：
 *     · 干员头像行   x1420..1920, y890..1010  → {940, 593, 340, 80}
 *     · 战场主区     x440..1430,  y155..830   → {293, 103, 660, 450}
 *     · 1X/2X 倍速   x1620..1720, y30..70     → {1080, 20, 130, 40}
 *     · 费用(DP)     x1760..1900, y780..836   → {1173, 520, 94, 38}
 * ⚠️ 仍然必须每部视频用 calibrate() 核对一遍：不同版本/分辨率/UI 皮肤会挪。
 *
 * 【一个量出来的坑】费用(DP)显示在**右下角**（干员栏上方那个 ◇ 数字），
 * 不是左下角。我第一版按"底部左"写了，等于一直在盯一块跟 DP 无关的画面。 */
const REGIONS = {
  /* 待部署干员头像行（右下）—— 头像消失/变暗 = 一次部署或撤退 */
  operBar: { x: 940, y: 593, w: 340, h: 80 },
  /* 战场主区（中）—— 干员卡出现、召唤物、技能特效都在这里 */
  field: { x: 293, y: 103, w: 660, h: 450 },
  /* 右上角：1X/2X 倍速标记（实测 "1X" 在 1920 下约 x1620..1720 / y30..70） */
  speed: { x: 1080, y: 20, w: 130, h: 40 },
  /* 费用(DP)：右下角、干员头像行正上方（实测 1920 下 x1760..1900 / y780..836） */
  cost: { x: 1173, y: 520, w: 94, h: 38 },
};

const DEF = {
  /* 分析用的降采样尺寸（1280x720 的 1/4） */
  aw: 320, ah: 180,
  /* 从视频里按这个帧率重采样（原始视频多半 30/60fps，10fps 足够抓动作） */
  fps: 10,
  /* 区域变化判定阈值（0~1，越大越不敏感）。0.03 表示 3% 的格子均值变了 */
  changeRatio: 0.03,
  /* 同一区域两次关键帧的最小间隔，避免一个动作刷出十几帧 */
  minGapMs: 400,
  /* 格子签名：把区域切成 SUB x SUB 再求均值 */
  SUB: 8,
  /* ★ 只有这些区域"变了"才算关键帧 ★
   *
   * 为什么必须区分：实跑真实视频（YW-EX-3 152s）发现，
   * 把 cost/field 也当触发器会得到 **181 个关键帧**，几乎每 0.8 秒一个 ——
   *   · cost（DP）在整场里一直在涨，本来就该频繁变化；
   *   · field 在战斗中敌人在动、特效在闪，**永远在变**。
   * 它们不是"发生了什么新操作"，只是"画面在动"。
   *
   * 真正的操作信号是**干员栏**：头像消失/变暗 = 这个干员被用掉了（部署或撤退）。
   * 所以默认只让 operBar 触发；cost/field/speed 改为"采样"（记录在关键帧上，不自己造帧）。 */
  triggers: ['operBar'],
  /* 这些区域每个关键帧都记录签名/数值，但不自己产生关键帧 */
  samplers: ['cost', 'field', 'speed'],
  /* 倍速切换需要连续这么多帧都判定为"变了"才认 —— 防压缩噪声误触发。
     实测不防抖时 1X 画面被判出 33 次切换，全是噪声。 */
  speedStable: 5,
};

/* 1280x720 基准 → 分析分辨率 */
function toAnalysis(rect, baseW, baseH, aw, ah) {
  const sx = aw / (baseW || 1280), sy = ah / (baseH || 720);
  return {
    x: Math.max(0, Math.round(rect.x * sx)),
    y: Math.max(0, Math.round(rect.y * sy)),
    w: Math.max(1, Math.round(rect.w * sx)),
    h: Math.max(1, Math.round(rect.h * sy)),
  };
}

/* ---------------------------------------------------------------- 探针 */
function probe(file) {
  const p = ffprobe();
  if (!p) return { ok: false, reason: '找不到 ffprobe' };
  if (!fs.existsSync(file)) return { ok: false, reason: '文件不存在：' + file };
  try {
    const out = execFileSync(p, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-show_entries', 'format=duration',
      '-of', 'json', file,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    const st = (j.streams && j.streams[0]) || {};
    let fps = 0;
    if (st.r_frame_rate) {
      const [a, b] = String(st.r_frame_rate).split('/').map(Number);
      fps = b ? a / b : a;
    }
    const dur = Number(st.duration) || Number(j.format && j.format.duration) || 0;
    return {
      ok: true, width: Number(st.width) || 0, height: Number(st.height) || 0,
      fps: Number.isFinite(fps) ? fps : 0, durationMs: Math.round(dur * 1000),
    };
  } catch (e) {
    return { ok: false, reason: 'ffprobe 失败：' + ((e && e.message) || e) };
  }
}

/* ---------------------------------------------------------------- 区域签名 */
/* 把一块区域切成 SUB×SUB，算每格的平均亮度（0~255）。
 * 为什么用"均值网格"而不是哈希：哈希对 1 像素抖动就雪崩，
 * 而攻略视频有压缩噪声 —— 均值网格对压缩噪声稳定，对真实变化敏感。 */
function sig(rgb, w, rect, sub) {
  const S = sub || DEF.SUB;
  const out = new Float64Array(S * S);
  const cw = rect.w / S, ch = rect.h / S;
  for (let gy = 0; gy < S; gy++) {
    for (let gx = 0; gx < S; gx++) {
      let sum = 0, n = 0;
      const x0 = Math.floor(rect.x + gx * cw), x1 = Math.min(w, Math.ceil(rect.x + (gx + 1) * cw));
      const y0 = Math.floor(rect.y + gy * ch), y1 = Math.ceil(rect.y + (gy + 1) * ch);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 3;
          /* BT.601 亮度 */
          sum += rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114;
          n++;
        }
      }
      out[gy * S + gx] = n ? sum / n : 0;
    }
  }
  return out;
}

/* 两个签名差多少（0~1，按 255 归一） */
function sigDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / (a.length * 255);
}

/* ---------------------------------------------------------------- 解码串流 */
/* 用 ffmpeg 解码成 rawvideo，按帧回调。
 * onFrame({ tMs, rgb }) —— rgb 是 aw*ah 的 RGB24。
 * 返回 Promise，完成时给出实际处理的帧数。 */
function scan(file, o, onFrame) {
  const opt = Object.assign({}, DEF, o || {});
  const exe = ffmpeg();
  if (!exe) return Promise.reject(new Error('找不到 ffmpeg'));
  if (!fs.existsSync(file)) return Promise.reject(new Error('文件不存在：' + file));
  const W = opt.aw, H = opt.ah, frameBytes = W * H * 3;
  const args = [
    '-v', 'error', '-i', file,
    '-vf', 'scale=' + W + ':' + H + ',fps=' + opt.fps,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    let buf = Buffer.alloc(0);
    let frames = 0;
    let err = '';
    const step = 1000 / opt.fps;
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameBytes) {
        const frame = buf.slice(0, frameBytes);
        buf = buf.slice(frameBytes);
        const tMs = Math.round(frames * step);
        frames++;
        try { onFrame({ tMs, rgb: frame }); } catch (e) { /* 回调出错不该中断解码 */ }
      }
    });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && frames === 0) return reject(new Error('ffmpeg 解码失败：' + err.slice(0, 300)));
      resolve({ frames, stderr: err });
    });
  });
}

/* ---------------------------------------------------------------- 主分析 */
/* 产出：
 *   { ok, video, base, regions, keyframes:[{atMs, gameMs, reasons[]}], speed:[{fromMs,toMs,value}] }
 *
 * speed 检测说明（第 5 点的诚实版）：
 *   我现在只能可靠地判断"右上角那块**变了**"（= 倍速切换发生了）。
 *   具体是 1x 还是 2x 需要看那块区域的图案 —— 由 `opts.classifySpeed(sig)` 注入。
 *   没注入时，speed 段只标"值未知"，并在 warnings 里说明。
 *   为什么不在这里硬编一个阈值：不同版本/语言下 1x/2x 图标像素不一样，
 *   瞎猜出来的分类器会让整条时间轴错一半，比"未知"更糟。
 */
async function analyze(file, o) {
  const opt = Object.assign({}, DEF, o || {});
  const info = probe(file);
  if (!info.ok) return { ok: false, reason: info.reason };

  /* 区域先换算到分析分辨率 */
  const baseW = 1280, baseH = 720;
  const regions = {};
  for (const k of Object.keys(REGIONS)) {
    regions[k] = toAnalysis(REGIONS[k], baseW, baseH, opt.aw, opt.ah);
  }

  const last = {};                    // 每个区域"最近一次接受的签名"
  const lastAt = {};                  // 每个区域最近一次关键帧的时间
  const keyframes = [];
  const speedSegs = [];
  let curSpeed = { value: null, fromMs: 0 };
  const warnings = [];
  const classify = typeof opt.classifySpeed === 'function' ? opt.classifySpeed : null;
  if (!classify) warnings.push('没提供 classifySpeed —— 只能检测"倍速被切换了"，无法分辨是 1x 还是 2x');

  let first = true;
  let frames = 0;
  /* 倍速防抖：连续 N 帧都"变了"才认一次切换 */
  let speedPending = 0;
  const triggers = Array.isArray(opt.triggers) ? opt.triggers : DEF.triggers;

  const res = await scan(file, opt, ({ tMs, rgb }) => {
    frames++;
    const reasons = [];
    for (const k of Object.keys(regions)) {
      const s = sig(rgb, opt.aw, regions[k], opt.SUB);
      if (first || !last[k]) { last[k] = s; lastAt[k] = tMs; continue; }
      const d = sigDiff(s, last[k]);
      if (d < opt.changeRatio) { speedPending = (k === 'speed') ? 0 : speedPending; continue; }

      /* ---- 倍速：单独走防抖，且不算"关键帧触发器" ---- */
      if (k === 'speed') {
        speedPending++;
        if (speedPending >= (opt.speedStable || 5)) {
          speedPending = 0;
          let v = null;
          if (classify) { try { v = classify(s, rgb, regions[k]); } catch (e) { v = null; } }
          speedSegs.push({ fromMs: curSpeed.fromMs, toMs: tMs, value: curSpeed.value });
          curSpeed = { value: v, fromMs: tMs };
          last[k] = s;
        }
        continue;
      }

      /* ---- 其余区域：只有 triggers 里的才造关键帧 ---- */
      if (triggers.indexOf(k) < 0) { last[k] = s; continue; }

      const gap = tMs - (lastAt[k] || 0);
      if (gap >= opt.minGapMs) {
        reasons.push(k);
        last[k] = s;
        lastAt[k] = tMs;
      } else {
        /* 间隔太短：更新签名但不单独成帧（否则动作会碎成一堆） */
        last[k] = s;
      }
    }
    if (reasons.length) {
      /* 采样区：把当时的签名摘要挂上，方便后面按 DP/倍速过滤 */
      const sample = {};
      for (const k of (opt.samplers || [])) {
        if (regions[k]) sample[k] = { sig: Array.from(last[k] || []), atMs: lastAt[k] || tMs };
      }
      keyframes.push({ atMs: tMs, reasons, speedAtMs: curSpeed.value, sample });
    }
    first = false;
  });

  speedSegs.push({ fromMs: curSpeed.fromMs, toMs: info.durationMs || null, value: curSpeed.value });

  return {
    ok: true,
    video: info,
    base: baseW + 'x' + baseH,
    analysis: { w: opt.aw, h: opt.ah, fps: opt.fps, framesScanned: frames },
    regions,
    keyframes,
    speed: speedSegs,
    warnings,
  };
}

/* ---------------------------------------------------------------- 倍速 → 游戏时间 */
/* 把视频时间换算成**游戏内时间**。
 * 2 倍速时 视频 1s = 游戏 2s，所以累加时按段乘倍速。
 * value 为 null 的段按 1x 处理（保守），并可由调用方传 fallback。 */
function gameTimeAt(segments, atMs, fallbackSpeed) {
  const fb = Number(fallbackSpeed) > 0 ? Number(fallbackSpeed) : 1;
  const t = Number(atMs) || 0;
  const segs = Array.isArray(segments) ? segments : [];
  /* ⚠️ 没有分段表时必须**原样返回**（按 1x 直通），不能返回 0 ——
     返回 0 会把所有时间戳静默清零，而那种错误在时间轴上看起来"很正常"，
     只是全部压在 0 秒，极难发现。 */
  if (!segs.length) return Math.round(t);
  let game = 0;
  for (const s of segs) {
    const from = Number(s.fromMs) || 0;
    const to = (s.toMs == null) ? Infinity : Number(s.toMs);
    if (atMs <= from) break;
    const end = Math.min(atMs, to);
    if (end > from) {
      const sp = Number(s.value) > 0 ? Number(s.value) : fb;
      game += (end - from) * sp;
    }
    if (atMs <= to) break;
  }
  return Math.round(game);
}

/* ---------------------------------------------------------------- 校准 */
/* 导出一张带网格的帧，用来核对 REGIONS 对不对。
 * 没有它，区域坐标只能靠猜 —— 而猜偏 20 像素就足以让"干员栏"框到战场上去。 */
function calibrate(file, atMs, outPng) {
  const exe = ffmpeg();
  if (!exe) return { ok: false, reason: '找不到 ffmpeg' };
  const ss = Math.max(0, (Number(atMs) || 0) / 1000);
  const out = outPng || path.join(process.cwd(), 'calibrate-' + Math.round(ss) + 's.png');
  /* 画 1280x720 基准下的 100 像素网格 + 四个关键区域的边框 */
  const r = REGIONS;
  const vf = [
    'scale=1280:720',
    'drawgrid=w=100:h=100:t=1:c=white@0.35',
    'drawbox=x=' + r.operBar.x + ':y=' + r.operBar.y + ':w=' + r.operBar.w + ':h=' + r.operBar.h + ':color=red@0.9:t=3',
    'drawbox=x=' + r.field.x + ':y=' + r.field.y + ':w=' + r.field.w + ':h=' + r.field.h + ':color=lime@0.9:t=3',
    'drawbox=x=' + r.speed.x + ':y=' + r.speed.y + ':w=' + r.speed.w + ':h=' + r.speed.h + ':color=yellow@0.9:t=3',
    'drawbox=x=' + r.cost.x + ':y=' + r.cost.y + ':w=' + r.cost.w + ':h=' + r.cost.h + ':color=cyan@0.9:t=3',
  ].join(',');
  try {
    execFileSync(exe, ['-y', '-v', 'error', '-ss', String(ss), '-i', file, '-frames:v', '1', '-vf', vf, out],
      { timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: fs.existsSync(out), path: out, regions: REGIONS };
  } catch (e) {
    return { ok: false, reason: '导出失败：' + ((e && e.message) || e) };
  }
}

module.exports = {
  DEF, REGIONS, toAnalysis, sig, sigDiff, probe, scan, analyze, gameTimeAt, calibrate,
  ffmpeg, ffprobe,
};
