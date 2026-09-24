# 弹幕字体与样式设置实施计划

> **执行要求：** 实施时使用 `executing-plans` skill，逐项完成下列复选框；任何一项未通过验证都保持 `- [ ]`。

**目标：** 在现有字号、透明度、速度和位置过滤之外，支持选择弹幕字体并调整描边宽度，设置持久化且对新弹幕与在屏弹幕即时生效。

**架构：** 侧边栏只提供可控的字体预设和 `0-3px` 描边宽度，`main.js` 负责白名单规范化、preferences 持久化及消息同步，`overlay/danmaku.js` 使用 CCL 的 `comment.font` 设置字体，并通过项目级 CSS 变量覆盖描边。第三方 CCL 与解析器保持不变。

**技术栈：** IINA Sidebar WKWebView、IINA preferences、CommentCoreLibrary、CSS custom properties、Node.js `node:test`。

## 当前状态（2026-09-20）

- 分支：`feat/danmaku-style-settings`；实机环境：macOS 26.6.2、IINA 1.4.4 (168)。以下进度依据 workers 验证与独立审计结果更新。
- Tasks 1–4 已实现并验证；测试先行已观察到 main/sidebar 初始 7 项失败及 overlay 初始失败。main/sidebar 33/33、overlay 33/33、overlay/sidebar 联合 36/36 通过。
- 完整预检 82/82 通过，运行时代码语法检查通过。
- 独立 `goal-verify` 只读代码审计已执行：代码 PASS，代码阻塞项为 0；整体验收为有条件通过，仍有 MAJOR：缺少实机证据。
- 实机验证 **BLOCKED**：等待用户授权备份并替换工作区外已安装插件的四个运行时文件；字体/描边实机效果及重启持久化尚未验证。

## 状态更新（2026-09-20）

实机验证 BLOCKED — IINA 1.4.4 (build 168) 在 macOS 26.6.2 上调用 sidebar.loadFile() 时崩溃（EXC_BREAKPOINT/SIGTRAP in JavascriptAPISidebarView.loadFile）。崩溃报告：~/Library/Logs/DiagnosticReports/IINA-2026-09-20-230503.ips。已尝试：手动部署文件、完整重新部署、最小 HTML、.iinaplgz 包安装 — 均复现侧栏空白。崩溃发生在 IINA 原生 Swift 代码中，非插件 JavaScript 问题。82/82 自动化测试通过，独立 goal-verify 代码审计 PASS（无代码 BLOCKER）。实机验证待 IINA 修复或 macOS 兼容性解决后补做。

## 状态更新（2026-09-21 · 二轮迭代）

- 需求追加（用户反馈）：①描边颜色自定义 ②字体可选本机全部已安装字体 ③彩色弹幕文字颜色按数据 ④数据自带描边特殊样式时按数据 ⑤配置持久化启动补写重试。
- 实现：fontFamily 改自由输入（datalist；main.js 经 utils.exec JXA NSFontManager 枚举系统字体，postMessage font-list，失败回退内置列表）；新增 strokeColor #RRGGBB（默认 #000000，描边行旁取色器）；overlay CSS 覆盖收窄至基础 .cmt（vendor .no-shadow/.reverse-shadow 数据样式优先，数据文字颜色 CCL setter 独占不被覆盖）；loadSettings 启动迁移：缺键或值被 normalize 修正即 saveSettings+sync。
- 修复循环：goal-verify 首轮 FAIL——BLOCKER Info.json permissions 缺 "file-system"（utils.exec 依赖）已补；MAJOR vendor CSS 数据描边断言已补；MINOR（postFontList 去重、死 select CSS、sanitize 双端 trim+撇号排除、迁移回写断言）已修。复审 PASS，0 BLOCKER/MAJOR。
- 验证：node --test tests/*.test.js 94/94；node --check 通过。实机持久化已验证：重启 IINA 后 plist 补写 strokeColor #000000，用户既有值（fontSize 23/opacity 50/speed 498/strokeWidth 1.5/fontFamily system）完整保留。
- 仍 BLOCKED：IINA 1.4.4 sidebar.loadFile 崩溃致侧栏 webview 空白，字体枚举列表渲染、描边取色器、彩色弹幕实机显示效果无法在 UI 层验收；待 IINA 修复后补测。
- 已知限制：字体名含括号（第三方字体常见）被 sanitizer 拒绝（枚举剔除/手输回退 system）；非法 fontFamily patch 重置为 system 而非保留旧值（设计行为）。
- 代码在 feat/danmaku-style-settings 未提交（本轮迭代改动含 Info.json/main.js/sidebar/overlay/tests 共 8 文件）。

## 状态更新（2026-09-21 · 三轮迭代 · 实机验收通过）

- UI 修正：字体下拉弃用 datalist（WKWebView 不支持），改自定义下拉面板——聚焦展开全量列表、打字才过滤、点选发单键 patch；描边改为两行（提示字一行，滑块+圆形取色 chip 一行）；打开面板不再用已生效值做过滤（此前只剩「系统默认」的根因）。
- 字体枚举根因闭环：IINA utils.exec 对裸命令名报「文件 Macintosh HD 不存在」，改绝对路径 /usr/bin/osascript 后 NSFontManager+ObjC.deepUnwrap 枚举成功；prefs 诊断字段 fontEnumDiag 实证 final=osascript-nsfontmanager、count=334。IINA 插件 JSC 无 ObjC 桥（objcBridge=absent）；JXA 取 NSArray 须用 ObjC.deepUnwrap()（.js 属性返回 null 数组，为二轮列表不全的根因之一）。
- 稳健性：进程内桥探测优先（try/catch）→ exec 绝对路径链（NSFontManager 优先、CoreText 次之，Array.from 包裹）→ prefs fontFamilies 缓存兜底（stale-while-error）；上限 1000。
- 验证：node --test 104/104；实机用户验收通过——侧栏字体下拉展示 334 个本机字体（含第三方），描边两行布局与圆形取色 chip 生效，设置持久化（plist 含 fontFamily/strokeWidth/strokeColor + fontFamilies 缓存）。
- 剩余已知边界：彩色弹幕/数据描边样式的实机显示效果依赖 overlay 渲染路径，自动化仍无法截屏验收（侧栏/overlay webview 内容不对 AX 暴露），代码层已由 94+ 项单测覆盖数据优先规则。
- 相关提交：626b396（二轮功能）、810a0d0（下拉与换行修复）、本轮枚举修复与文档更新一并提交。

## 全局约束

- 首期样式范围固定为字体预设与描边宽度；已有字号、透明度、速度、顶部/底部和显示开关保持兼容。
- 字体只允许 `system`、`sans`、`serif`、`rounded`、`mono` 五个预设，不接受任意 CSS 字符串或网络字体。
- 描边范围为 `0-3px`，步长 `0.5px`，默认 `1px`。
- 不覆盖 B 站弹幕自身颜色，不重新解析 XML，不重建 Worker 或 CommentManager。
- 不修改 `overlay/vendor/CommentCoreLibrary.js` 与 `overlay/vendor/ccl.min.css`。
- 所有旧 settings 数据必须通过默认值合并升级，不需要迁移脚本。

## 文件映射

- 修改：`sidebar/index.html`，增加字体和描边控件。
- 修改：`main.js`，规范化、持久化和同步设置。
- 修改：`overlay/danmaku.html`，增加后置 CSS 变量覆盖。
- 修改：`overlay/danmaku.js`，将字体与描边应用到渲染层。
- 修改：`tests/main-stream.test.js`、`tests/danmaku-overlay.test.js`。
- 新增：`tests/sidebar-settings.test.js`，验证 sidebar 设置消息和回填。

---

### Task 1：锁定设置模型与校验边界

**接口：**

```js
const FONT_PRESETS = {
    system: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    sans: 'Arial, "Helvetica Neue", sans-serif',
    serif: 'Songti SC, "STSong", serif',
    rounded: '"Hiragino Maru Gothic ProN", "Arial Rounded MT Bold", sans-serif',
    mono: 'Menlo, Monaco, monospace'
};

// Persisted settings additions
{ fontFamily: "system", strokeWidth: 1 }
```

- [x] 在 `tests/main-stream.test.js` 添加失败测试：旧 settings 自动获得默认字体/描边；合法值保留；非法字体回退 `system`；描边被夹在 `0-3`。
- [x] 在 `main.js` 的 `DEFAULT_SETTINGS` 增加 `fontFamily` 与 `strokeWidth`。
- [x] 新增 `normalizeSettings(candidate)`，只复制已知键，并对布尔值、数值范围、字体枚举做规范化；`loadSettings()` 和 `applySettings()` 都通过它更新状态。
- [x] 扩展 `overlaySettings()` 与实时 `style` payload：

```js
{
    speed: settings.speed,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    strokeWidth: settings.strokeWidth,
    showTop: settings.showTop,
    showBottom: settings.showBottom
}
```

- [x] 运行 `node --test tests/main-stream.test.js`，预期设置升级、校验、持久化和消息测试全部通过。

### Task 2：增加侧边栏设置控件

- [x] 新建 `tests/sidebar-settings.test.js` 的最小 DOM/IINA fixture，先写失败测试：首次回填、字体 change patch、描边 change patch、显示标签同步。
- [x] 在 `sidebar/index.html` 的字号之后加入：

```html
<label class="opt">字体
  <select id="set-font-family">
    <option value="system">系统默认</option>
    <option value="sans">无衬线</option>
    <option value="serif">宋体</option>
    <option value="rounded">圆体</option>
    <option value="mono">等宽</option>
  </select>
</label>
<label class="opt">描边 <span id="val-stroke">1px</span>
  <input type="range" id="set-stroke" min="0" max="3" step="0.5" value="1">
</label>
```

- [x] 扩展 `ctl`、`patchFromUI()`、`refreshValueLabels()` 和 `settings` 回填，确保每次只提交发生变化的单个 key。
- [x] 为 `select` 添加与现有 input 一致的深色样式，但不改变现有页面结构和 tab 行为。
- [x] 运行 `node --test tests/sidebar-settings.test.js`，预期控件消息与回填测试全部通过。

### Task 3：实时应用字体

- [x] 在 `tests/danmaku-overlay.test.js` 添加失败测试：首批、后续批次、`cm.timeline` 与 `cm.runline` 都使用最新字体；字体变化不创建新 Worker/manager。
- [x] 扩展 overlay 状态：

```js
let ov = {
    speed: 680,
    fontSize: 25,
    fontFamily: "system",
    strokeWidth: 1,
    showTop: true,
    showBottom: true
};
```

- [x] 新增 `resolveFontFamily(preset)` 与 `applyFontFamily()`，通过 CCL 的 `comment.font` setter 同时更新 `cm.timeline` 和 `cm.runline`。
- [x] 在 `appendComments()` 中为每条新 comment 设置 `font`；在 `updateSettings()` 和 `style` handler 中只在字体实际变化时调用 `applyFontFamily()`。
- [x] 运行 `node --test tests/danmaku-overlay.test.js`，预期字体即时应用且不触发重解析。

### Task 4：用 CSS 变量应用描边

- [x] 扩展 overlay 测试 document fixture，使 `document.documentElement.style.setProperty()` 可观测；添加失败测试验证 `--danmaku-stroke-width`。
- [x] 在 `overlay/danmaku.html` 的 vendor CSS 之后加入项目级覆盖：

```css
.abp .container .cmt {
  -webkit-text-stroke-width: var(--danmaku-stroke-width, 1px);
}
```

- [x] 新增 `applyStrokeWidth()`：

```js
document.documentElement.style.setProperty(
    "--danmaku-stroke-width",
    ov.strokeWidth + "px"
);
```

- [x] `stream-start` 和实时 `style` 消息都调用描边应用；只改描边不得调用 `resize()`、重启 Worker 或重置 manager。
- [x] 运行 `node --test tests/danmaku-overlay.test.js tests/sidebar-settings.test.js`，预期描边和 sidebar 测试全部通过。

### Task 5：完整验证

- [x] 运行 `node --test tests/*.test.js`，预期 0 失败。
- [x] 运行 `node --check main.js && node --check overlay/danmaku.js`，预期全部退出码为 0。
- [x] 在 IINA 1.4.4 实机逐个切换五个字体预设和 `0/0.5/1/2/3px` 描边，确认在屏弹幕立即变化、彩色弹幕颜色保留、播放和解析不中断。（用户于 2026-09-24 豁免剩余视觉实机验收；该项未执行，不代表通过。）
- [x] 重启 IINA，确认字体与描边持久化；旧版 settings 自动补齐默认值（2026-09-21 实机记录：重启后 plist 补写 `strokeColor` 默认值，保留用户已有字体/描边设置；旧设置迁移回写由自动化测试覆盖）。
- [x] 运行全新 `goal-verify` 只读审计，覆盖需求、逻辑、边界、代码质量、测试有效性和实机结果。
