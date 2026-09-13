# 弹幕源自动识别与自动加载实施计划

> **执行要求：** 实施时使用 `executing-plans` skill，逐项完成下列复选框；任何一项未通过验证都保持 `- [ ]`。

**目标：** 将“弹幕源”改为“自动识别 + 手动搜索”两个板块，根据本地文件名在后台匹配 B 站剧集或普通视频；剧集和视频各有独立自动加载开关，关闭时展示推荐，开启时仅对唯一高置信结果静默加载并在 HUD 报告最终状态。

**架构：** `iina.file-loaded` 只同步提取文件上下文并立即返回，异步搜索、详情和弹幕请求继续走 `iina.http`。识别层输出标准候选，决策层区分剧集/视频和置信度，应用层复用现有 `loadSeasonById()`、`loadBvid()`、`loadPart()` 与流式 overlay。用 `fileGeneration`、`searchGeneration`、`loadToken` 三代状态隔离文件切换、后台推荐和真正加载，确保旧响应不抢占新播放会话。

**技术栈：** IINA Plugin JavaScript、Bilibili Web API、IINA Sidebar/HUD、IINA preferences、Node.js `node:test`。

## 全局约束

- 两个独立偏好：`autoLoadBangumi: false`、`autoLoadVideo: false`，升级后默认关闭。
- 自动识别只处理本地文件；`core.status.idle` 或 `core.status.isNetworkResource` 时不搜索。
- 自动加载只允许“唯一高置信候选 + 唯一目标集/P”；任何歧义都转为推荐，不默认猜 P1。
- 不使用会阻塞文件加载的异步 `mpv.addHook("on_load")`；`iina.file-loaded` handler 内不得 `await`。
- 后台搜索不能调用会清空当前弹幕的 `invalidateCurrentLoad()`，也不能影响视频正常播放。
- 保留现有 128 KiB ACK、Worker/fallback、搜索 stale guard；不缓存弹幕 XML。
- 成功 HUD 必须等当前流 `stream-state.phase === "complete"`，下载完成或首批可见时不能提前宣告。

## 文件映射

- 修改：`main.js`，文件名解析、两类搜索、候选决策、代际隔离、HUD 与偏好。
- 修改：`sidebar/index.html`，自动识别/手动搜索板块、两个复选框、推荐结果与分 P/分集选择。
- 修改：`tests/main-stream.test.js`，文件事件、API、竞态、自动加载和 HUD 行为。
- 新增：`tests/sidebar-source.test.js`，验证板块切换、推荐渲染与用户选择消息。
- 不修改：`overlay/*`，自动识别最终复用现有 cid → XML → overlay 链路。

---

### Task 1：解析本地文件上下文

**接口：**

```js
function parseMediaFilename(filename) {
    return {
        filename: filename,
        title: "鬼灭之刃",
        seasonNumber: 2,
        episodeNumber: 3,
        partNumber: null,
        bvid: null,
        kindHint: "bangumi",
        confidence: "high"
    };
}
```

- [ ] 在 `tests/main-stream.test.js` 添加表驱动失败测试：

```text
[ANi] 葬送的芙莉莲 - 12 [1080P][WEB-DL].mp4 -> title=葬送的芙莉莲, episode=12
鬼灭之刃.S02E03.1080p.mkv                 -> season=2, episode=3
凡人修仙传 年番 第45集.mp4                -> episode=45
纪录片.P03.2160p.mp4                      -> part=3，2160p 不是分P
Movie.2024.2160p.WEB-DL.mkv               -> 无集号、无分P
BV1xx411c7mD-P2.mp4                       -> 精确 BV + part=2
01.mp4 / NCOP.mkv / OVA.mp4               -> low，禁止自动加载
```

- [ ] 在 `main.js` 新增 `normalizeMediaTitle()`、`parseMediaFilename()` 和 `currentFileContext(url)`；文件名优先从 `mpv.getString("filename")` 取得，事件 URL 与 `core.status.url` 只作回退并安全 decode。
- [ ] 识别顺序固定为 BV、`SxxExx`、中文集号、标题尾部集号、显式 `Pxx/Part xx/分Pxx`；先去扩展名、发布组、分辨率、编码与音轨标签。
- [ ] 运行 `node --test tests/main-stream.test.js`，预期全部纯函数样例通过。

### Task 2：分离文件、搜索与加载代际

- [ ] 添加失败测试：切换文件发生在搜索、详情或 XML 任一阶段时，旧响应都不能更新 sidebar、HUD 或 overlay。
- [ ] 添加失败测试：后台推荐搜索不清空当前弹幕；自动搜索未完成时的手动选择立即获得优先权。
- [ ] 在 `main.js` 引入：

```js
let fileGeneration = 0;
let searchGeneration = 0;
let loadToken = 0;
let currentFileIdentity = null;

function isCurrentFile(generation) {
    return generation === fileGeneration;
}
```

- [ ] 将后台搜索从 `invalidateCurrentLoad()` 解耦；`loadToken` 只在用户或自动决策真正采用来源时递增并清空旧渲染流。
- [ ] `iina.file-loaded` 中同步生成 identity、递增 `fileGeneration`、发布文件上下文，然后以未 await 的 Promise 启动 `recognizeCurrentFile(context, generation)` 并捕获错误。
- [ ] 对重复 file-loaded identity 去重；`mpv.end-file` 递增 `fileGeneration` 使所有旧请求失效。
- [ ] 运行 `node --test tests/main-stream.test.js`，预期所有竞态测试通过。

### Task 3：实现剧集与视频两类候选搜索

**搜索接口：**

```text
GET /x/web-interface/search/type?search_type=media_bangumi&keyword=<title>
GET /x/web-interface/search/type?search_type=video&keyword=<title>
GET /pgc/view/web/season?season_id=<id>
GET /x/web-interface/view?bvid=<bvid>
```

- [ ] 将现有 `searchBangumi()` 的结果转换提取为无 UI 副作用的 `fetchSearchCandidates(kind, keyword, isStale)`；手动搜索与自动识别复用它。
- [ ] pending search key 使用 `kind + normalizedKeyword`，避免同关键词的剧集与视频请求错误合并。
- [ ] 新增 `rankCandidates(context, candidates)`：规范化标题相似度优先，其次匹配季数、集号或分 P；只取前 1-3 个候选请求详情。
- [ ] 新增 `chooseAutoTarget(context, candidates)`，只返回以下之一：

```js
{ decision: "load", kind, candidate, partIndex, confidence: "high" }
{ decision: "recommend", kind, candidates, reason }
{ decision: "none", kind, reason }
```

- [ ] 多 P 视频只有文件名明确 P 且详情存在该 P 时可自动加载；无 P 提示时即使标题唯一也返回推荐。剧集必须 season 与 episode 都唯一匹配。
- [ ] 增加内存搜索缓存，key 为 `kind + normalizedKeyword`、TTL 10 分钟；不缓存详情错误和弹幕 XML。
- [ ] 运行 `node --test tests/main-stream.test.js`，预期剧集、视频、多候选、多 P 和缓存测试全部通过。

### Task 4：增加独立自动加载偏好与 HUD

- [ ] 在 `DEFAULT_SETTINGS` 增加 `autoLoadBangumi: false`、`autoLoadVideo: false`，沿用 settings 的 preferences 持久化。
- [ ] 添加行为测试：只开剧集时高置信剧集加载、视频推荐；只开视频时反向；两个都关时仅推荐；两个都开时仍按 `kindHint` 只走一个主频道。
- [ ] 自动决策采用来源时构造不可变流元数据：

```js
{
    origin: "auto",
    fileGeneration: generation,
    title: target.title,
    partLabel: target.partLabel
}
```

- [ ] “正在自动匹配”和“正在自动加载”只更新 sidebar，不调用 HUD；`core.osd()` 仅在同一 `fileGeneration`、同一 streamId 的 `complete` 阶段显示“已自动加载”，或在失败、存在歧义且确实需要用户操作时给出一次简短提示。
- [ ] 自动流程错误不得暂停播放或弹阻塞对话框；sidebar 显示可重试错误，HUD 仅给简短状态。
- [ ] 运行 `node --test tests/main-stream.test.js`，预期两个开关、HUD 时机和 stale stream 测试全部通过。

### Task 5：重组弹幕源面板并展示推荐

实施前按项目 UI 规则先提交 ASCII 线框并获得用户确认，目标结构如下：

```text
┌─────────────────────────────┐
│ 弹幕源              设置     │
├─────────────────────────────┤
│ 自动识别                     │
│ 文件：鬼灭之刃 S02E03.mkv    │
│ [x] 自动加载剧集弹幕          │
│ [ ] 自动加载视频弹幕          │
│ 推荐：鬼灭之刃 游郭篇         │
│   第 3 集  [加载]             │
├─────────────────────────────┤
│ 手动搜索                     │
│ [剧集] [视频/BV]              │
│ [关键词、BV 或链接________]    │
│ [搜索/加载]                   │
│ 候选及分集/分P列表            │
└─────────────────────────────┘
```

- [ ] 新建 `tests/sidebar-source.test.js` fixture，先测试自动上下文、推荐列表、两个独立复选框和手动搜索消息。
- [ ] 在 `sidebar/index.html` 将 source tab 内部拆成语义上的 `auto-source` 与 `manual-source` 两个 section，保留现有设置 tab。
- [ ] 自动开关发送 `update-settings` 单键 patch；接收 `file-context` 和 `suggestions` 消息后显示识别内容、候选、集/P与加载按钮。
- [ ] 手动区同时支持番剧关键词、视频关键词、BV 和 ep/ss/md 链接；视频搜索候选点击后单 P 直接加载，多 P 展开供选择。
- [ ] sidebar 只渲染主入口提供的数据，不自行请求 B 站 API。
- [ ] 运行 `node --test tests/sidebar-source.test.js tests/main-stream.test.js`，预期 UI 消息协议测试全部通过。

### Task 6：完整验证与性能验收

- [ ] 运行 `node --test tests/*.test.js`，预期 0 失败。
- [ ] 运行 `node --check main.js`，预期退出码为 0。
- [ ] 用至少 8 类文件名实机验证：标准番剧、季度番剧、中文集号、普通单 P、多 P 明确 P、多 P 无 P、BV 文件名、低置信特殊篇。
- [ ] 在搜索、详情、XML 下载和解析阶段分别快速切换本地文件，确认视频播放不中断、旧结果不闪现、旧弹幕不覆盖新文件。
- [ ] 使用性能面板或时间记录确认 `file-loaded` 同步 handler 无网络等待；Worker 可用时解析在 Worker，file:// 回退时每片仍不超过 `16 KiB`。
- [ ] 运行全新 `goal-verify` 只读审计，覆盖需求、逻辑、竞态、边界、代码质量、测试有效性和实机结果。
