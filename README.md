# arknights-copilot-plugin

从明日方舟**攻略视频**自动生成 MAA copilot（作业）脚本，并**用 MAA 自己的地图格子数据**校验它。

---

## 一条命令

> **本机没有 `node` 在 PATH 里**，所以做了 `.bat` 包装（内部用 `ELECTRON_RUN_AS_NODE=1` + electron.exe）。
> 如果你的机器有 node，把 `.bat` 里的 `"%ELECTRON%"` 换成 `node` 即可。

```bat
:: 完整跑流水线（2~3 分钟）
build.bat --video="F:\dspet\video\YW-1.mp4" --stage=YW-1

:: 只校验一份作业（1 秒，手改完用它验）
validate.bat "out\YW-1.json"

:: 跑单元测试
test.bat
```

等价的 node 命令：

```bash
node bin/build2.cjs --video="F:\dspet\video\YW-1.mp4" --stage=YW-1 --out="out\YW-1.json"
node bin/validate.cjs out/YW-1.json
node test/copilot.test.cjs
```

`--stage` 用 **stageId**（`act52side_01` / `main_00-01`）或**关卡代号**（`YW-1`）都行——
MAA 是 `Tile.find(stage_name)` 再用 `map_data->first.code` 作导航名，两种写法都能解析。

可选：`--speed=1`（默认按攻略惯例开局切二倍速）、`--stripe-step=0.2`。

---

## 实测输出（YW-1）

```
① 关卡 YW-1 10x7
② 干员 1384，技能表 433，范围 34
③ 视频 1920x1080 127s  战斗起点 12s
④ 干员栏变动 8 次: 15.0 16.5 18.0 19.5 21.0 22.5 24.0 114.0
⑤ 放置事件 4 个（同格去重 2 条）（丢弃低占比 112.7s(22.8%),115.5s(16.8%)）
   面板 episode 2 个: 山@17.3s(3帧)  娜仁图亚@21.1s(5帧)
   面板命中 2/4
   交叉验证: 山:ok ?:no-name ?:no-name 娜仁图亚:ok

  @17     [6,5] 山        技能2「横扫架势」[手动] 朝向Right✔  ok  NCC=0.661
  @20.2   [5,4] ?         技能-                  朝向Right✔  no-name  ⚠占位名
  @21.3   [6,3] ?         技能-                  朝向Up✔     no-name  ⚠占位名
  @24.7   [7,3] 娜仁图亚  技能1「旋刃」[手动]     朝向Left✔   ok  NCC=0.795

⑪ 校验 ok=true errors=0
🎯 山 MANUAL 技能就绪 @18.25s、娜仁图亚 MANUAL 技能就绪 @24.95s → 发 UseSkill(location)
```

产出：

```jsonc
{ "stage_name": "YW-1",
  "opers": [
    { "name": "山",       "skill": 2, "skill_usage": 1 },
    { "name": "娜仁图亚", "skill": 1, "skill_usage": 1 },
    { "name": "待填_01" }, { "name": "待填_02" }   // ← 视频里没开详情面板，读不到名字
  ],
  "actions": [
    { "type": "SpeedUp" },
    { "type": "Deploy", "name": "山",       "location": [6,5], "direction": "Right", "doc": "视频 17s 技能2「横扫架势」手动" },
    { "type": "Deploy", "name": "待填_01", "location": [5,4], "direction": "Right", "pre_delay": 3200, "doc": "★待填干员名" },
    { "type": "Deploy", "name": "待填_02", "location": [6,3], "direction": "Up",    "pre_delay": 1100, "doc": "★待填干员名" },
    { "type": "Deploy", "name": "娜仁图亚", "location": [7,3], "direction": "Left",  "pre_delay": 3400 },
    { "type": "UseSkill", "location": [6,5], "doc": "山 技能2 就绪 @18.25s" },
    { "type": "UseSkill", "location": [7,3], "doc": "娜仁图亚 技能1 就绪 @24.95s" }
  ] }
```

### 关于 `待填_xx`

没识别出名字的部署**不会编一个假干员名**填进去（早期版本这么干过，看起来像识别成功、其实是假的）。
现在统一写成 `待填_01` / `待填_02`，并在控制台末尾列出来：

```
★ 需要你填的干员名（2 个）
   待填_01  视频 20.2s  放在 [5,4]（地面 → 必须是近战干员）
   待填_02  视频 21.3s  放在 [6,3]（地面 → 必须是近战干员）
```

改法：编辑输出 JSON 里的 `opers[].name` 和 `actions[].name`，再跑 `validate.bat` 复查。
**不改完这些名字，MAA 编队阶段会因「干员缺失」停下。**

---

## 各环节判据（全部来自实测，不是猜）

| 步 | 做什么 | 判据 | 实测 |
|---|---|---|---|
| ① | 关卡格子 | MAA `Arknights-Tile-Pos/*.json` | YW-1 10×7 |
| ② | 格子↔像素 | 移植 MAA `TileCalc2.hpp`（`lib/tileproj.cjs`） | 点点落格心 |
| ③ | 进入战斗那一帧 | 干员栏**色彩饱和度 + 连续 8 帧持续** | t=12s |
| ④ | 部署窗口 | 右下角干员栏**每 1.5s 色块比对** | 8 次变动 |
| ⑤ | 放置格 | **橙色斜纹格**（整格斜条） | 40.8~57.2% vs 背景 10% |
| ⑥ | 朝向 | 近战→**邻格唯一非零**；远程→**34 种范围形状 × 4 向匹配** | 4/4 确定 |
| ⑦ | 干员身份 | 详情面板**名字区二值化 → 433 个名字渲染模板 NCC 闭集匹配** | 山 0.661 / 娜仁图亚 0.795 |
| ⑦b | 技能序号 | 详情面板**技能名** → 与该干员 3 个技能名比对 | 山 slot2 0.538 |
| ⑧ | 技能触发类型 | **游戏数据 `skillType`（AUTO/MANUAL）**，不从视频猜 | 山 MANUAL |
| ⑨ | 站位类型 | 放置格 `buildableType`：1→MELEE，2→RANGED | 作身份交叉验证 |
| ⑩ | 技能时刻 | MANUAL 技能：干员上方搜**亮黄菱形** | 山 @18.25s 峰值金 25.3% |
| ⑪ | 校验 | `copilot.validate()`，逐格检查能不能站这个干员 | 0 error |

---

## 模块

```
lib/tileproj.cjs   MAA 投影公式（TileCalc2.hpp 移植）—— 格子↔像素的核心
lib/copilot.cjs    作业格式 + 校验（57 项测试）
lib/operdb.cjs     1384 干员（MAA battle_data.json）
lib/skills.json    433 干员 × 3 技能：名字 / skillType(AUTO|MANUAL) / spType / spCost
                   由 character_table.json + skill_table.json 生成
lib/rangefit.cjs   73 种攻击范围形状（取 chars[].rangeId 用到的 34 种）+ 4 向旋转
lib/posmask.cjs    绿掩膜 / 橙色斜纹格 / 朝向
lib/deploy.cjs     战斗起点 / 1.5s 粗扫 / 30fps 细扫 / 色块差异度
lib/opername.cjs   干员名渲染闭集 + NCC 匹配（Otsu / 外接框归一化）
lib/nametpl.bin    433 个名字的 32×32 位图模板（缓存）
lib/detail.cjs     详情面板：名字区 / 技能名区 / 触发方式区
lib/direction.cjs  橙色箭头 + 亮黄菱形（scanGold）
lib/video.cjs      关键帧 + 倍速时间换算（analyze 已被 deploy.cjs 取代）
bin/build2.cjs     ★ 最终流水线（与 build3.cjs 相同）
bin/build.cjs      早期版本（保留）
docs/干员识别方案.md 干员识别方案与字段定义
```

### 重新生成 skills.json

数据来源（公开游戏数据仓库）：

```
https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/character_table.json
https://cdn.jsdelivr.net/gh/Kengxxiao/ArknightsGameData@master/zh_CN/gamedata/excel/skill_table.json
```

取 `chars[].skills[].skillId` → `skill_table[].levels[0]` 的
`name` / `skillType`(AUTO|MANUAL) / `spData.spType` / `spData.spCost`。

---

## 测试

```
node test/copilot.test.cjs   → 57 / 57   （作业格式+校验，跑 MAA 真实数据）
node test/video.test.cjs     → 31 / 35   （4 项失败见下，如实保留）
```

`video.test.cjs` 的 4 项失败**没有为了让它们变绿去放宽断言**：
它们断言的是 `video.cjs` 的**全画面差分法**，那个方法被 196 个噪声事件证伪后已被
`deploy.cjs` 的分区法取代，主流程已不调用 `video.cjs` 的 `analyze()`。

---

## 踩过的坑（代码注释里都有）

| # | 错误判据 | 教训 |
|---|---|---|
| 1 | 区域方差找战斗起点 | **高对比 ≠ 战斗**：片头 logo 方差 46，战斗 HUD 只有 7 |
| 2 | 按等宽切干员栏卡片 | 卡片会随干员用掉而**重排** |
| 3 | 连通域找绿色高亮块 | 相邻格糊成一块 → 改**逐格检查** |
| 4 | 跨帧差集判朝向 | 放干员时**地图会平移**，差集比区域本身还大 |
| 5 | 最大/最近橙块判朝向 | 混进血条、抓到别处橙物，质心近乎对称 |
| 6 | 亮度判据找范围覆盖 | 29/70 格误判（只是地图本来亮的区域） |
| 7 | 上限 0.52 砍橙色 | 把**远程干员**的真部署一起砍了（远程范围覆盖 10 格，邻格全橙是正常的） |
| 8 | 遍历全部 73 种范围 | 匹配到 `y-7`/`y-8` 非法键 → 只取 `chars[].rangeId` 的并集（34 种） |
| 9 | 名字模板画布固定 140×140 | **多字名被裁掉**：山（1字）NCC 0.65 正常，娜仁图亚（4字）只有 0.059 |
| 10 | 名字区用 Otsu 自适应阈值 | 暗区里阈值选太低，背景渐变当文字，外接框撑到 124×46 |
| 11 | 「手动触发/自动触发」整串 NCC | 只差第一个字，相同的后三字主导 → 0.451 vs 0.351 判错；改**只比第一个字** |
| 12 | 面板扫描窗口给 4 秒 | 读到**上一个干员**的面板，RANGED 被匹配到 bt=1 地面格 → 改「先扫 episode 再分配」 |
| 13 | 每个窗口 `break` 只取首个斜纹 | 一个窗口里两处部署会漏 → 收集全部再按格去重 |
| 14 | 用 PowerShell 改源码 | `Set-Content -Encoding UTF8` 加 BOM，把 shebang 弄坏 |

**唯一可行的范式**：
> 从已知结构（格子坐标、范围数据、技能表）**反查像素**，而不是从像素统计量去猜语义。

---

## 已知边界（诚实清单）

| 项 | 状态 |
|---|---|
| **干员身份识别** | 只在视频**出现详情面板**时能认（本次 2/4）。玩家直接拖放不放面板 → 只能给占位名，并在 `doc` 里标注「名字未识别(占位)」 |
| **部署覆盖率** | 干员栏变动 8 次，检出 4 个放置格。栏变动**不等于**部署（费用够了头像会亮，也是变化） |
| 模组 / 技能等级 / 潜能 | 作战面板不可见；且 copilot 的 `requirements` 是**最低要求**，写死会降低通用性 → 省略 |
| `potentiality` | 这个 MAA 版本**根本不读**（`CopilotConfig.cpp:112` 被注释掉） |
| 撤退 | 未实现（用户指定最后做） |
| 召唤物 / 装置 | 未实现（用户指定最后做） |
| 关卡自动识别 | 未实现（需人工 `--stage`） |
| 真机验证 | 只做了 schema + 格子校验，未在 MAA + 模拟器实跑 |

### 只能处理 MAA 有格子数据的关卡

`Arknights-Tile-Pos` 里没有的关卡（例如 `act52side_ex03`，MAA v6.19.0 和 dev 版都没有）
**无法处理**——MAA 自己也跑不了。这类关卡需要先补 JSON。

另外：**格子行列数在几何上不可观测**（奇偶退化：`tile_x - (width-1)/2` 使 w±2 时像素位置完全不变），
所以行列数必须来自数据文件，不能从画面反解。

---

## 关于 MAA 自己怎么认干员（供对照）

MAA 在**作战期间**的识别链路（`BattlefieldMatcher.cpp` + `BattleHelper.cpp`）：

1. 找干员栏卡片旗标 → 每张卡偏移取 6 个区域
   （职业 `31×25`、头像 `60×60`、可用 `10×10`、冷却 `114×4`、费用 `30×17`）
2. **职业图标匹配** 9 选 1（`BattleOperRole`，阈值 0.65），认不出就跳过这张卡
3. **头像匹配** Ccoeff 阈值 **0.8**：先比上一帧同职业已识别的，再退到 `AvatarCache`（按职业分桶）
4. 匹配不上 → **点开卡片 → OCR 详情页名字**（`OperNameAnalyzer` 二值化预处理 → `RegionOCRer`）
   → `AvatarCache.set_avatar()` 存盘 `cache/avatars/{oper_id}.png`（**60×60**）

**关键**：MAA 用的头像模板是**编队界面/运行时截下来的 60×60**，不是 `resource/template/avatar/char_*.png`
（后者是 **120×120** 立绘头像，`AvatarCacheManager::_load` 里 `cols!=60||rows!=60` 直接丢弃）。
这就是为什么拿 `char_*.png` 去匹配战斗栏最高只有 0.46 分——**图像源不同**。

本插件走的是 MAA 第 4 步的等价路线（读详情面板文字），但用**渲染闭集 + NCC** 代替 OCR 引擎。

---

## 安装为 DSH 插件

插件要经 `plugin_manager` 的 `install_bundle` 安装，那一步**需要批准**。

```jsonc
{ "action": "install_bundle", "target": "C:\\Users\\lenovo\\Desktop\\NTE插件\\arknights-copilot-plugin" }
```

安装后配置 `maaResource` 指向 MAA 的 `resource` 目录（含 `Arknights-Tile-Pos/`）。
插件提供三个工具：`copilot_tiles` / `copilot_validate` / `copilot_skeleton`。
