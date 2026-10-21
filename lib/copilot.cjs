/* 明日方舟 MAA 作业（copilot）核心：读格式、校验、生成骨架。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 【格式来源】不是猜的，是照着 MAA 源码抄的：
 *   · src/MaaCore/Common/AsstBattleDef.h 的 battle::copilot::Action / OperUsage
 *   · src/MaaCore/Config/Miscellaneous/CopilotConfig.h 的 parse_* 接口
 *   · resource/copilot/*.json 的现成样例
 *
 * 【为什么"校验"是最值钱的一环】
 *   作业里 location 是**地图格子坐标** [x,y]，不是屏幕像素。
 *   人写作业最容易错的就是这个格子：写到墙里、写到不可部署的地块、
 *   远程干员写到地面格。MAA 要到运行时才会失败，而报错信息很含糊。
 *
 *   而 MAA 自带 resource/Arknights-Tile-Pos/ —— **4269 个关卡**的完整格子数据：
 *     buildableType: 0=不可部署 / 1=近战(地面) / 2=远程(高台) / 3=都可以
 *     （对应 AsstBattleDef.h 的 LocationType: None/Melee/Ranged/All）
 *   有了它就能在**载入前**判定"这个格子能不能放这个职业"，
 *   把"运行到一半才失败"变成"一眼看出第 3 个动作的格子是墙"。
 *
 * 【诚实的边界：Tile-Pos 里没有像素坐标】
 *   我核过那 4269 个文件：只有 tileKey / buildableType / heightType / isStart / isEnd，
 *   **没有任何像素位置**。MAA 是在运行时靠"识别战场四角 + 单应变换"算出
 *   格子↔像素的（见 BattlefieldMatcher）。所以"从视频推格子坐标"这一步
 *   必须自己做角点检测 —— 这是视频转作业的真正难点，不是格式问题。
 * ═══════════════════════════════════════════════════════════════════════
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------------- 常量（照源码） */

/* ActionType（AsstBattleDef.h: enum class ActionType）—— 作业里能写的全部动作 */
const ACTION_TYPES = [
  'Deploy', 'UseSkill', 'Retreat', 'SkillUsage', 'SwitchSpeed', 'BulletTime',
  'Output', 'SkillDaemon', 'ResetStopwatch', 'Click', 'Swipe', 'SetUnitLocation',
  'MoveCamera', 'DrawCard', 'CheckIfStartOver',
];

/* ★ 类型别名表：逐条照抄 CopilotConfig.cpp:204-294 的 ActionTypeMapping ★
 *
 * 为什么必须抄全：MAA 认的是**字符串表**，不是枚举名。真实作业里写的是
 * `{"type":"SpeedUp"}` —— 而枚举里叫 SwitchSpeed。只按枚举名校验，
 * 会把**合法的官方作业判成错误**（我第一版就这样，被真实样例当场打回）。
 * 中文别名也得收：国内作业大量用 `部署`/`技能`/`摆完挂机`。 */
const ACTION_ALIASES = (() => {
  const m = new Map();
  const reg = (canon, aliases) => { for (const a of [canon].concat(aliases || [])) m.set(a, canon); };
  reg('Deploy', ['DEPLOY', 'deploy', '部署']);
  reg('UseSkill', ['Skill', 'SKILL', 'skill', '技能']);
  reg('Retreat', ['RETREAT', 'retreat', '撤退']);
  reg('SwitchSpeed', ['SpeedUp', 'SPEEDUP', 'Speedup', 'speedup', '二倍速']);
  reg('BulletTime', ['BULLETTIME', 'Bullettime', 'bullettime', '子弹时间']);
  reg('SkillUsage', ['SKILLUSAGE', 'Skillusage', 'skillusage', '技能用法']);
  reg('Output', ['OUTPUT', 'output', '输出', '打印']);
  reg('SkillDaemon', ['skilldaemon', 'SKILLDAEMON', 'Skilldaemon', 'DoNothing', '摆完挂机', '开摆']);
  reg('MoveCamera', ['movecamera', 'MOVECAMERA', 'Movecamera', '移动镜头']);
  reg('DrawCard', ['drawcard', 'DRAWCARD', 'Drawcard', '抽卡', '抽牌', '调配', '调配干员']);
  reg('CheckIfStartOver', ['Checkifstartover', 'CHECKIFSTARTOVER', 'checkifstartover', '检查重开']);
  reg('ResetStopwatch', ['RESETSTOPWATCH', 'resetstopwatch', 'Resetstopwatch', '重置全局计时器']);
  reg('Click', ['click', 'CLICK', '点击']);
  reg('Swipe', ['swipe', 'SWIPE', '滑动']);
  reg('SetUnitLocation', ['Setunitlocation', 'setunitlocation', 'SETUNITLOCATION', '设置单位坐标']);
  return m;
})();

/* 解析动作类型字符串 → 规范名；不认识返回 null */
function resolveType(str) {
  const s = String(str == null ? '' : str);
  if (ACTION_ALIASES.has(s)) return ACTION_ALIASES.get(s);
  /* 大小写变体兜底（表里只列了源码中出现的写法，用户可能写别的组合） */
  const lower = s.toLowerCase();
  for (const [k, v] of ACTION_ALIASES) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/* DeployDirection —— 部署朝向。None 用于"不需要方向"的动作 */
const DIRECTIONS = ['Right', 'Left', 'Up', 'Down', 'None'];

/* LocationType（buildableType 的映射）
   0=None 不可部署 / 1=Melee 近战(地面) / 2=Ranged 远程(高台) / 3=All 都行 */
const LOCATION_TYPE = { 0: 'None', 1: 'Melee', 2: 'Ranged', 3: 'All' };

/* 职业 → 通常能站的格子类型（照 MAA get_role_usual_location）
   注意：这是"通常"，不是硬规则（有些干员特性/装置会例外），
   所以本模块把它当**警告**而不是错误。 */
const ROLE_LOCATION = {
  Warrior: 'Melee', Pioneer: 'Melee', Tank: 'Melee', Support: 'Melee',
  Specialist: 'Melee', Sword: 'Melee', Fortress: 'Melee',
  Sniper: 'Ranged', Caster: 'Ranged', Medic: 'Ranged',
  Supporter: 'Ranged', Trap: 'Ranged', Token: 'All',
};

/* ---------------------------------------------------------------- 关卡格子数据 */

/* 建一个 code → 文件 的索引。
 * 为什么要索引：文件名是 `<stageId>-<路径>-level_<stageId>.json`（如
 * `main_00-01#f#-obt-main-level_main_00-01.json`），而玩家说的是**关卡代号**（"0-1"、"OF-1"），
 * 对应 JSON 里的 `code` 字段 —— 文件名里查不到。4269 个文件全读一遍约几 MB，
 * 所以**只读每个文件开头**（元数据在最前面），并把结果缓存成 index.json。 */
function buildIndex(tileDir, cacheFile) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && c.files && c.files.length) return c;
    } catch {}
  }
  const files = fs.readdirSync(tileDir).filter((f) => /\.json$/i.test(f));
  const idx = { built: Date.now(), files, byCode: {}, byName: {}, byStage: {} };
  for (const f of files) {
    let head = '';
    try {
      const fd = fs.openSync(path.join(tileDir, f), 'r');
      try {
        const buf = Buffer.alloc(512);
        const n = fs.readSync(fd, buf, 0, 512, 0);
        head = buf.slice(0, n).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    /* 元数据在文件头，用正则从头部抓，不必解析整份 JSON */
    const code = (head.match(/"code"\s*:\s*"([^"]*)"/) || [])[1];
    const stageId = (head.match(/"stageId"\s*:\s*"([^"]*)"/) || [])[1];
    const name = (head.match(/"name"\s*:\s*"([^"]*)"/) || [])[1];
    if (code) idx.byCode[normalizeCode(code)] = f;
    if (stageId) idx.byStage[stageId.toLowerCase()] = f;
    if (name) idx.byName[name] = f;
  }
  if (cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify(idx), 'utf8'); } catch {} }
  return idx;
}

/* 关卡代号归一：OF-1 / of-1 / OF_1 / of 1 都算同一个 */
function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[\s_]+/g, '-').trim();
}

/* 按关卡代号称找格子文件 */
function findTile(tileDir, stage, opts) {
  const o = opts || {};
  const idx = buildIndex(tileDir, o.cacheFile);
  const key = normalizeCode(stage);
  let file = idx.byCode[key] || null;
  if (!file) {
    /* 退化：按 stageId 或名字精确找 */
    const sk = String(stage || '').toLowerCase();
    file = idx.byStage[sk] || idx.byName[String(stage || '')] || null;
  }
  if (!file) {
    /* 再退一步：前缀匹配（用户可能只写了 "OF" 或写了完整活动名） */
    const cands = Object.keys(idx.byCode).filter((c) => c.startsWith(key));
    if (cands.length === 1) file = idx.byCode[cands[0]];
    else if (cands.length > 1) {
      return { ok: false, reason: '「' + stage + '」匹配到多个关卡：' + cands.slice(0, 8).join(' / ') + '，请写完整代号', ambiguous: cands };
    }
  }
  if (!file) return { ok: false, reason: 'Tile-Pos 里没有关卡「' + stage + '」（共索引 ' + Object.keys(idx.byCode).length + ' 个代号）' };
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(tileDir, file), 'utf8')); }
  catch (e) { return { ok: false, reason: '读格子数据失败：' + (e.message || e) }; }
  return { ok: true, file, data: j };
}

/* 取某格子的可部署类型。坐标是 [x, y]，y 从**下**往上数（Arknights 的约定）。 */
function tileAt(tileData, x, y) {
  const rows = tileData && tileData.tiles;
  if (!Array.isArray(rows)) return null;
  /* MAA 的 tiles 是 [y][x] 还是 [x][y]？按 height/width 和实际数据判：
     tiles.length 应该等于 height，每行长度等于 width。 */
  const h = Number(tileData.height) || rows.length;
  const w = Number(tileData.width) || (rows[0] ? rows[0].length : 0);
  if (rows.length === h) { const row = rows[y]; return row ? (row[x] || null) : null; }
  /* 万一顺序相反（[x][y]），也兼容一下 */
  const col = rows[x];
  return col ? (col[y] || null) : null;
}

function gridSize(tileData) {
  const rows = (tileData && tileData.tiles) || [];
  return {
    w: Number(tileData && tileData.width) || (rows[0] ? rows[0].length : 0),
    h: Number(tileData && tileData.height) || rows.length,
  };
}

/* ---------------------------------------------------------------- 校验 */

/* MAA 的 skill_usage 语义（AsstBattleDef.h: enum class SkillUsage）
   0 = NotUse（不开）, 1 = Once（开一次）, 2 = Times（按次数）, 3 = Auto（自动） */
const SKILL_USAGES = [0, 1, 2, 3];

/* 校验一份作业。返回 { ok, errors[], warnings[], stats }。
 * 设计原则（和这个项目一贯的口径一致）：
 *   · **能确定错的 → error**（格子越界、不可部署、动作类型拼错、结构缺失）
 *   · **只是少见/可能有意为之 → warning**（远程放到地面格、朝向 None 但动作需要方向）
 *   · 绝不静默修数据 —— 只报告，改不改由人决定。 */

/* 不是"干员"但可以 Deploy 的名字。
 * PRTSPlus 真实作业里就有 `{"name":"障碍物","type":"Deploy","direction":"None"}` ——
 * 那是技能召唤的阻挡物/装置。把它当"干员名打错字"报就是误报。 */
const NON_OPER_NAMES = new Set(['障碍物', '障碍', '召唤物', '装置', '箱子', '夹子', '地雷', '屏障', '箱子2']);

function validate(script, tileData, opts) {
  const o = opts || {};
  const errors = [], warnings = [];
  const E = (m) => errors.push(m);
  const W = (m) => warnings.push(m);

  if (!script || typeof script !== 'object') return { ok: false, errors: ['作业不是对象'], warnings, stats: {} };

  /* --- 顶层字段 --- */
  if (!script.stage_name) W('缺 stage_name —— MAA 不知道要打哪一关');
  else if (tileData) {
    /* 关卡名和格子数据对不上是常见的手误 */
    const tdCode = normalizeCode(tileData.code || '');
    const sn = normalizeCode(script.stage_name);
    if (tdCode && sn && tdCode !== sn && String(tileData.stageId || '').toLowerCase() !== sn.toLowerCase()) {
      W('stage_name「' + script.stage_name + '」和格子数据（code=' + tileData.code + '）看起来不是同一关，请确认');
    }
  }
  if (!Array.isArray(script.actions)) E('缺 actions 数组（MAA 必须有它，哪怕是空数组）');
  if (!Array.isArray(script.opers)) W('缺 opers 数组（可以是空数组；用 groups 也行）');
  if (script.groups && !Array.isArray(script.groups)) E('groups 必须是数组');
  if (!script.minimum_required) W('缺 minimum_required（建议写 "v4.0.0"）');

  /* --- 干员名表：用来交叉核对动作里的 name --- */
  const knownNames = new Set();
  for (const op of (script.opers || [])) if (op && op.name) knownNames.add(String(op.name));
  for (const g of (script.groups || [])) {
    if (!g) continue;
    if (!g.name) W('有个 groups 条目缺 name');
    for (const op of (g.opers || [])) if (op && op.name) knownNames.add(String(op.name));
  }

  const size = tileData ? gridSize(tileData) : null;
  const actions = Array.isArray(script.actions) ? script.actions : [];
  const counts = {};
  let deploys = 0, skills = 0, retreats = 0, noCondDeploys = 0;

  actions.forEach((a, i) => {
    const at = '第 ' + (i + 1) + ' 个动作';
    if (!a || typeof a !== 'object') { E(at + '不是对象'); return; }

    /* ★ type 缺省时 MAA **默认按 Deploy 处理** ★
       （CopilotConfig.cpp:296 `action_info.get("type", "Deploy")`）
       所以这里不能报"缺 type"当错误 —— 但必须提醒，因为"忘了写 type"
       和"故意写 Deploy"在文件里长得一样，而后果完全不同。 */
    const rawType = a.type;
    let type;
    if (rawType == null || String(rawType).trim() === '') {
      type = 'Deploy';
      W(at + '没写 type —— MAA **会默认按 Deploy 处理**。如果这条本来是别的动作，现在会被当成部署');
    } else {
      type = resolveType(rawType);
      if (!type) {
        /* ★★★ 这是本模块最值钱的一条检查 ★★★
           MAA 遇到不认识的 type 只 `Log.warn` 然后 **continue 跳过这条动作**
           （CopilotConfig.cpp:301-304）—— 作业照样跑，但那一步**静默消失**。
           表现是"作业能载入、能打通、但就是漏了某个干员/某次技能"，
           极难查。所以在载入前就把它当**错误**报出来。 */
        E(at + '的 type「' + rawType + '」不认识。★注意：MAA 遇到不认识的 type 只会警告并**跳过这条动作**，'
          + '不是报错退出 —— 于是那一步会静默消失。★ 可用：' + ACTION_TYPES.join(' / ')
          + '（常见别名：SpeedUp=两倍速、Skill=UseSkill、DoNothing=SkillDaemon、部署/技能/摆完挂机 也认）');
        return;
      }
      /* 用了别名就提示一下规范名，方便统一风格（不算错） */
      if (String(rawType) !== type) { /* 别名合法，不告警 —— 官方作业就在用 SpeedUp */ }
    }
    counts[type] = (counts[type] || 0) + 1;

    /* --- Deploy / Retreat / UseSkill / SetUnitLocation 需要 location --- */
    const needLoc = ['Deploy', 'Retreat', 'UseSkill', 'SetUnitLocation'].indexOf(type) >= 0;
    if (needLoc) {
      const loc = a.location;
      if (!Array.isArray(loc) || loc.length < 2) {
        E(at + '（' + type + '）缺 location: [x, y]（地图**格子**坐标，不是屏幕像素）');
      } else {
        const x = Number(loc[0]), y = Number(loc[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) E(at + '的 location 不是数字：' + JSON.stringify(loc));
        else if (x < 0 || y < 0 || (x % 1 !== 0) || (y % 1 !== 0)) E(at + '的 location 必须是非负整数格子，给的是 [' + x + ',' + y + ']');
        else if (size && (x >= size.w || y >= size.h)) {
          E(at + '的 location [' + x + ',' + y + '] 越界——' + (tileData.code || '该关') + ' 的格子范围是 x 0~' + (size.w - 1) + '、y 0~' + (size.h - 1));
        } else if (tileData) {
          /* ★ 核心检查：这个格子能不能部署 ★ */
          const t = tileAt(tileData, x, y);
          if (!t) E(at + '的 location [' + x + ',' + y + '] 在格子数据里取不到（可能是行列顺序或关卡不对）');
          else {
            const lt = LOCATION_TYPE[t.buildableType];
            const tk = String(t.tileKey || '');
            if (t.buildableType === 0 || /forbidden|wall|void|empty|road/i.test(tk) && t.buildableType === 0) {
              E(at + '的 location [' + x + ',' + y + '] **不可部署**（tileKey=' + tk + '，buildableType=0）——这是墙/障碍/不可放地块');
            } else if (t.buildableType === 1 || t.buildableType === 2) {
              /* 近战格 vs 远程格：和动作里的职业/干员交叉核对。
                 查不到职业时只给"位于高台/地面"这种提示性警告。 */
              const role = a.role || '';
              const want = ROLE_LOCATION[role];
              if (want && want !== 'All' && lt !== want) {
                W(at + '的 ' + (a.name || role) + ' 是 ' + role + '（通常站 ' + want + '），但 [' + x + ',' + y + '] 是 ' + lt + ' 格 —— 确认一下（有些干员/装置是例外）');
              }
            }
          }
        }
      }
      if (needLoc && type === 'Deploy') deploys++;
    }

    /* --- Skill 类 --- */
    if (a.skill_usage != null) {
      const su = Number(a.skill_usage);
      if (SKILL_USAGES.indexOf(su) < 0) W(at + '的 skill_usage=' + a.skill_usage + '（常见取值 0/1/2/3）');
    }
    if (type === 'UseSkill') {
      skills++;
      if (a.skill_usage == null) W(at + '（UseSkill）没写 skill_usage，MAA 会用默认值，确认是否符合预期');
    }
    if (type === 'Retreat') retreats++;

    /* --- Deploy 需要方向 --- */
    if (type === 'Deploy') {
      const dir = a.direction;
      if (dir == null) W(at + '（Deploy）没写 direction，MAA 默认 Right');
      else if (DIRECTIONS.indexOf(String(dir)) < 0) E(at + '的 direction「' + dir + '」不认识。可用：' + DIRECTIONS.join(' / '));
    }

    /* --- Click / Swipe 用的是 720p 基准像素矩形，不是格子 ---
       MAA 的规则（CopilotConfig.cpp:306-313）：Click 的 rect 和 location
       **二选一**，两个都给时**以 rect 为准**。 */
    if (type === 'Click') {
      if (!a.rect && !a.location) {
        W(at + '（Click）rect 和 location 都没给 —— MAA 要求二选一。'
          + 'Click 的 rect 是 **720p 基准像素矩形**；想点格子请改用 location');
      } else if (a.rect && a.location) {
        W(at + '（Click）同时给了 rect 和 location —— MAA **以 rect 为准**，location 会被忽略');
      }
    }
    if (type === 'Swipe' && (!a.begin || !a.end)) W(at + '（Swipe）缺 begin/end 像素矩形');

    /* --- 触发条件：kills / costs / cost_changes / cooling --- */
    for (const k of ['kills', 'costs', 'cost_changes', 'cooling']) {
      if (a[k] != null && !Number.isFinite(Number(a[k]))) E(at + '的 ' + k + ' 不是数字：' + a[k]);
    }
    /* 一个动作既没 kills 也没 costs 时，MAA 会在"上一个动作完成后立刻"执行。
       对 Deploy 来说这通常**不是**本意 —— 但 PRTSPlus 的"一摆到底"流派就是
       故意不写条件（按顺序立刻摆完）。所以**汇总成一条**警告，不逐条刷屏：
       5 条部署刷 5 遍会把真正重要的警告淹掉。 */
    if (type === 'Deploy' && a.kills == null && a.costs == null && a.cost_changes == null) noCondDeploys++;

    /* --- 名字交叉核对 ---
       跳过两类：
         · NON_OPER_NAMES（障碍物/召唤物这类非干员部署）；
         · direction: "None" 的部署 —— 那本来就不是干员（干员必须有朝向）。 */
    if (a.name && knownNames.size && !knownNames.has(String(a.name))
      && !NON_OPER_NAMES.has(String(a.name)) && String(a.direction || '') !== 'None') {
      W(at + '的 name「' + a.name + '」不在 opers/groups 的名单里 —— 可能是打错字，或你用的是代号而作业里用的是组名');
    }
  });

  /* --- 全局合理性 --- */
  if (noCondDeploys > 0) {
    W(noCondDeploys + ' 条 Deploy 没写触发条件（kills/costs），会按顺序**立刻**摆完。'
      + '"一摆到底"流派就是这样，正常；但如果你想让某个干员等费用/等击杀，必须写 kills 或 costs');
  }
  const allNames = knownNames;
  if (deploys === 0 && actions.length > 0) W('一个 Deploy 都没有 —— 这份作业不会部署任何干员');
  if (deploys > 0 && allNames.size === 0) W('有 Deploy 但 opers/groups 都是空的 —— MAA 需要知道用哪些干员');
  if (!actions.some((a) => a && a.type === 'SkillDaemon') && skills === 0) {
    W('既没有 UseSkill 也没有 SkillDaemon —— 技能不会自动开。只想自动开技能的话加一条 {"type":"SkillDaemon"}');
  }

  return {
    ok: errors.length === 0,
    errors, warnings,
    stats: {
      actions: actions.length, deploys, skills, retreats,
      opers: allNames.size, stage: script.stage_name || '',
      byType: counts,
      grid: size || null,
      tileCode: tileData ? (tileData.code || '') : '',
    },
  };
}

/* ---------------------------------------------------------------- 生成骨架 */

/* 造一份**能通过校验**的最小作业骨架。
 * 用途：从视频/攻略整理时先立骨架，再往里填动作 —— 避免"结构写错被 MAA 拒"。 */
function skeleton(o) {
  const opts = o || {};
  const opers = (opts.opers || []).map((n) => (typeof n === 'string' ? { name: n } : n));
  return {
    minimum_required: 'v4.0.0',
    stage_name: String(opts.stage || ''),
    opers,
    groups: [],
    actions: [],
    doc: {
      title: String(opts.title || opts.stage || ''),
      details: String(opts.details || ''),
    },
  };
}

/* 把一条部署追加进作业（带上触发条件）
 * ⚠️ role 必须一起带上：校验器靠 role + 格子类型判断"近战干员是不是放到了高台"。
 *    第一版漏了这个字段，校验结果就是"看起来没问题"—— 又一个静默失败。 */
function addDeploy(script, d) {
  const o = d || {};
  const a = { type: 'Deploy' };
  if (o.name) a.name = String(o.name);
  if (o.role) a.role = String(o.role);
  if (Array.isArray(o.location)) a.location = [Number(o.location[0]), Number(o.location[1])];
  a.direction = String(o.direction || 'Right');
  if (Number.isFinite(o.kills)) a.kills = Number(o.kills);
  if (Number.isFinite(o.costs)) a.costs = Number(o.costs);
  if (Number.isFinite(o.cost_changes)) a.cost_changes = Number(o.cost_changes);
  if (Number.isFinite(o.skill)) a.skill = Number(o.skill);
  if (Number.isFinite(o.skill_usage)) a.skill_usage = Number(o.skill_usage);
  if (o.doc) a.doc = String(o.doc);
  script.actions = script.actions || [];
  script.actions.push(a);
  return a;
}

/* 按 kills 升序排动作（很多视频攻略是按击杀数给时序的）。
   注意：**SkillDaemon / SwitchSpeed 这类无条件动作保持在最前**，
   否则会被排到中间导致语义变化。 */
function sortByKills(script) {
  const acts = script.actions || [];
  const front = [], timed = [];
  for (const a of acts) {
    if (['SkillDaemon', 'SwitchSpeed', 'SpeedUp', 'BulletTime', 'Output'].indexOf(String(a.type)) >= 0) front.push(a);
    else timed.push(a);
  }
  timed.sort((x, y) => (Number(x.kills) || 0) - (Number(y.kills) || 0));
  script.actions = front.concat(timed);
  return script;
}

module.exports = {
  ACTION_TYPES, ACTION_ALIASES, resolveType, DIRECTIONS, LOCATION_TYPE, SKILL_USAGES, ROLE_LOCATION,
  normalizeCode, buildIndex, findTile, tileAt, gridSize,
  validate, skeleton, addDeploy, sortByKills,
};
