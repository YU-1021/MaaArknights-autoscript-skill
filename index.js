/* DSH Host 插件：明日方舟 MAA 作业（copilot）工具。
 *
 * 三个工具：
 *   copilot_tiles     —— 看某个关卡的地图格子（哪些格能站人、近战/高台）
 *   copilot_validate  —— 校验一份作业，在载入 MAA 之前抓出错误
 *   copilot_skeleton  —— 生成一份能通过校验的最小作业骨架
 *
 * 设计口径和这个项目一贯一致：**能确定错的报错，只是少见的报警告，绝不静默改数据**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
/* lib/copilot 是 CommonJS（要能被纯 Node 测试直接 require），
   而这个包的 package.json 声明了 "type": "module"，所以它必须是 .cjs —— 
   否则 Node 会按 ESM 解析它，`module.exports` 直接失效。 */
import C from './lib/copilot.cjs';

export const name = 'arknights-copilot';
export const inject = ['tools'];

const DEFAULT_MAA = 'F:\\dspet\\MaaAssistantArknights-dev-v2\\MaaAssistantArknights-dev-v2\\resource';

/** 找 MAA 的 resource 目录：配置优先，其次常见路径。 */
function resolveMaa(config) {
  const cands = [];
  if (config && config.maaResource) cands.push(String(config.maaResource));
  cands.push(DEFAULT_MAA, 'C:\\MaaAssistantArknights\\resource', 'D:\\MaaAssistantArknights\\resource');
  if (process.env.MAA_RESOURCE) cands.unshift(process.env.MAA_RESOURCE);
  for (const c of cands) {
    try { if (c && fs.existsSync(path.join(c, 'Arknights-Tile-Pos'))) return c; } catch {}
  }
  return null;
}

/** 索引缓存放哪：用 MAA resource 旁边不合适（可能只读），放到用户缓存目录。 */
function cachePath() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || '.';
  return path.join(base, 'dsh-arknights-copilot', 'tile-index.json');
}

export function apply(ctx, config) {
  const cfg = config || {};

  function needMaa() {
    const r = resolveMaa(cfg);
    if (!r) throw new Error('找不到 MAA 的 resource 目录。请在插件配置里填 maaResource（应包含 Arknights-Tile-Pos/）。');
    return r;
  }

  const tilesDir = () => path.join(needMaa(), 'Arknights-Tile-Pos');

  /* ---------------- 1) 看地图格子 ---------------- */
  ctx.tools.register(defineTool({
    name: 'copilot_tiles',
    description: '查看明日方舟某个关卡的地图格子数据：尺寸、哪些格可部署（近战地面/高台/不可放）。用于确认作业里的 location 该填什么。参数 stage 是关卡代号，如 "0-1"、"OF-1"。',
    parameters: {
      stage: { type: 'string', required: true, description: '关卡代号，如 "0-1"、"OF-1"、"1-7"。' },
    },
    async execute(args) {
      const r = C.findTile(tilesDir(), args.stage, { cacheFile: cachePath() });
      if (!r.ok) return { error: r.reason };
      const sz = C.gridSize(r.data);
      /* 画一张"能站人"的地图，y 从上往下打印（文件里 y 从下往上数，所以倒序） */
      const rows = [];
      for (let y = sz.h - 1; y >= 0; y--) {
        let line = String(y).padStart(2) + ' ';
        for (let x = 0; x < sz.w; x++) {
          const t = C.tileAt(r.data, x, y);
          const bt = t ? t.buildableType : 0;
          line += bt === 1 ? 'M' : bt === 2 ? 'R' : bt === 3 ? '*' : '.';
        }
        rows.push(line);
      }
      const footer = '    ' + Array.from({ length: sz.w }, (_, x) => (x % 10)).join('');
      return {
        stage: r.data.code || args.stage,
        stageId: r.data.stageId || '',
        size: sz,
        legend: { M: '近战/地面(可部署)', R: '远程/高台(可部署)', '*': '两者皆可', '.': '不可部署' },
        map: rows.concat([footer]).join('\n'),
        usage: '作业里的 location 就是 [x, y]，y 从**下**往上数（0 是最下面一行）。',
      };
    },
  }));

  /* ---------------- 2) 校验作业 ---------------- */
  ctx.tools.register(defineTool({
    name: 'copilot_validate',
    description: '校验一份 MAA 作业（copilot JSON）。用 MAA 自带的 4269 张地图格子数据检查 location 是否可部署、是否越界、动作类型/朝向是否合法，并抓出 MAA 会静默跳过的问题。参数 file 是作业 JSON 的绝对路径。',
    parameters: {
      file: { type: 'string', required: true, description: '作业 JSON 文件的绝对路径。' },
      stage: { type: 'string', description: '关卡代号；不填则用作业里的 stage_name。' },
    },
    async execute(args) {
      const p = String(args.file || '');
      if (!fs.existsSync(p)) return { error: '文件不存在：' + p };
      let script;
      try { script = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch (e) { return { error: '不是合法 JSON：' + (e && e.message || e) }; }

      const stage = String(args.stage || script.stage_name || '');
      let tileData = null, tileNote = '';
      if (stage) {
        const t = C.findTile(tilesDir(), stage, { cacheFile: cachePath() });
        if (t.ok) tileData = t.data;
        else tileNote = t.reason;
      }
      const v = C.validate(script, tileData);
      return {
        ok: v.ok,
        file: p,
        stage: stage || '(未填)',
        tileData: tileData ? (tileData.code || '') : ('未加载：' + (tileNote || '没给关卡')),
        errors: v.errors,
        warnings: v.warnings,
        stats: v.stats,
        note: v.ok ? '结构没问题，可以载入 MAA。' : '有 ' + v.errors.length + ' 个错误，载入 MAA 前先修。',
      };
    },
  }));

  /* ---------------- 3) 生成骨架 ---------------- */
  ctx.tools.register(defineTool({
    name: 'copilot_skeleton',
    description: '生成一份能通过校验的最小 MAA 作业骨架（stage_name + 干员表 + 空 actions）。配合视频攻略整理时先立骨架，再往里填动作。参数 operers 是逗号分隔的干员名。',
    parameters: {
      stage: { type: 'string', required: true, description: '关卡代号，如 "OF-1"。' },
      opers: { type: 'string', description: '逗号分隔的干员名，如 "推进之王,能天使"。' },
      out: { type: 'string', description: '写出的文件绝对路径；不填则只返回内容。' },
      title: { type: 'string', description: '作业标题（doc.title）。' },
    },
    async execute(args) {
      const opers = String(args.opers || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const s = C.skeleton({ stage: args.stage, opers, title: args.title || args.stage });
      /* 先自校验一遍：骨架自己都不过就别给用户 */
      const t = C.findTile(tilesDir(), args.stage, { cacheFile: cachePath() });
      const v = C.validate(s, t.ok ? t.data : null);
      let wrote = '';
      if (args.out) {
        try { fs.writeFileSync(String(args.out), JSON.stringify(s, null, 2), 'utf8'); wrote = String(args.out); }
        catch (e) { return { error: '写文件失败：' + (e && e.message || e) }; }
      }
      return { wrote: wrote || '(仅返回未写盘)', valid: v.ok, errors: v.errors, warnings: v.warnings, script: s };
    },
  }));
}
