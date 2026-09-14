# 播放状态跟随优化实施计划

> **执行要求：** 实施时使用 `executing-plans` skill，逐项完成下列复选框；任何一项未通过验证都保持 `- [ ]`。

**目标：** 让弹幕准确跟随 IINA 的播放倍速、暂停、恢复和前后跳转，并在时间轴发生不连续变化后只显示最新目标时间附近的弹幕。

**架构：** `main.js` 将分散的时间与暂停消息收敛成带 `revision` 的 `playback-state` 协议，显式监听 `mpv.speed.changed` 和 `mpv.seeking.changed`。`overlay/danmaku.js` 以 `revision` 识别 seek/偏移等时间轴不连续变化，清空旧在屏弹幕并从 `commentHistory` 重建待显示最小堆；播放器倍速与用户设置的弹幕基础速度保持为两个独立维度。

**技术栈：** IINA Plugin JavaScript、mpv property events、CommentCoreLibrary、Web Animations API、Node.js `node:test`。

## 全局约束

- 目标环境以已验证的 IINA 1.4.4 / macOS WKWebView 为基线。
- 普通播放状态 IPC 仍按 `33ms` 节流；暂停、恢复、倍速变化、seek 开始/结束和偏移变化必须立即发送。
- `settings.speed` 继续表示弹幕基础横移速度；播放器倍速使用 `rate`，禁止混用或双重缩放。
- seek 期间冻结弹幕；seek 结束只按最终 `time-pos` 重建一次，不回放拖动经过位置的弹幕。
- 保留 `128 KiB` ACK 流式传输、Worker 回退、活动弹幕上限 `240` 和最近 `1000ms` 补显窗口。
- 不新增依赖，不修改 `overlay/vendor/*`。

## 文件映射

- 修改：`main.js`，维护并发送统一播放状态。
- 修改：`overlay/danmaku.js`，应用播放状态、显式重建和动画倍速。
- 修改：`tests/main-stream.test.js`，验证 IINA 事件到 overlay 协议。
- 修改：`tests/danmaku-overlay.test.js`，验证倍速、暂停、seek 和历史重建。

---

## 当前交接状态（2026-09-14）

### 全局状态

- 播放状态同步实现已完成：`main.js` 与 `overlay/danmaku.js` 已切换到统一 `playback-state` 协议。
- 自动化验证已通过：`node --test tests/*.test.js`，共 `63/63` 通过。
- 静态验证已通过：四个运行时 JavaScript 文件均通过 `node --check`，`git diff --check` 通过。
- 独立 `goal-verify` 终审为 `PASS`，无 BLOCKER 或 MAJOR 问题。
- IINA 1.4.4 已确认可加载插件并显示 Bili Danmaku 侧栏；完整实机播放矩阵尚未完成。
- 本次实现不新增依赖、不修改 `overlay/vendor/*`；本机已安装插件已恢复为原 `0.1.4`。

### 子任务状态

- Task 1：已完成。统一协议包含 `time`、`paused`、`rate`、`seeking`、`revision`；普通时间消息保持 `33ms` 节流，状态变化立即发送。
- Task 2：已完成。seek 开始冻结，seek 结束读取最终 `time-pos` 并递增 revision；offset 变化也递增 revision。
- Task 3：已完成。显式 revision、暂停中 seek 和 seeking 事件漏发时的时间跳变均触发清屏重建；过期 revision 被忽略。
- Task 4：已完成。播放器 `rate` 与 `settings.speed` 解耦；CCL 定时器、在屏 CSS animation 及下一帧新建动画统一跟随 `0.5x/1x/2x`。
- Task 5：自动化验证与独立审计已完成；IINA 实机矩阵仍保持未完成，不得将该项标记为已验证。

### 下一 Agent 入口

- 首先运行 `node --test tests/*.test.js`，确认交接基线仍为 `63/63`。
- 仅需在 IINA 1.4.4 完成 `0.5x / 1x / 2x` × `播放 / 暂停 / 前跳 / 后跳 / 拖动后释放` 实机矩阵，并记录旧弹幕消失、最终位置重建和视频无卡顿结果。
- 实机验证通过后，才可勾选 Task 5 的最后一个复选框；若环境仍无法稳定操作 IINA，继续保留未勾选并记录阻塞原因。
- 当前工作区另有未跟踪的 `docs/superpowers/.DS_Store`，它与本任务无关，不应纳入提交。

---

### Task 1：定义统一播放状态协议

**接口：**

```js
// main.js -> overlay/danmaku.js
{
    time: 12.5,
    paused: false,
    rate: 2,
    seeking: false,
    revision: 3
}
```

- [x] 在 `tests/main-stream.test.js` 的 fixture 中补齐 `core.status.position`、`core.status.paused`、`core.status.speed`、`mpv.getNumber()` 和 `mpv.getFlag()`。
- [x] 添加失败测试：`stream-start.playbackState` 使用主动读取的当前位置、暂停状态和倍速，而不是依赖事件是否提前触发。
- [x] 添加失败测试：`mpv.speed.changed`、`mpv.pause.changed`、`mpv.seeking.changed` 都立即发送 `playback-state`；普通 `time-pos` 仍保持 33ms 节流。
- [x] 在 `main.js` 新增以下状态和函数，移除 `playbackPaused` 及独立 `time`/`pause` 发送路径：

```js
let playbackState = {
    time: null,
    paused: false,
    rate: 1,
    seeking: false,
    revision: 0
};

function readPlaybackState() {
    const position = Number(core.status.position);
    const rate = Number(core.status.speed);
    playbackState.time = Number.isFinite(position) ? position : playbackState.time;
    playbackState.paused = Boolean(core.status.paused);
    playbackState.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
}

function playbackStatePayload() {
    return {
        time: (playbackState.time === null ? 0 : playbackState.time) + settings.offset,
        paused: playbackState.paused,
        rate: playbackState.rate,
        seeking: playbackState.seeking,
        revision: playbackState.revision
    };
}
```

- [x] 让 `stream-start` 携带 `playbackState: playbackStatePayload()`；让后续更新统一使用 `overlay.postMessage("playback-state", playbackStatePayload())`。
- [x] 运行 `node --test tests/main-stream.test.js`，预期新增协议测试与原有主入口测试全部通过。

### Task 2：显式处理 seek 与偏移跳变

- [x] 添加失败测试：`seeking=true` 立即冻结，连续时间事件不触发多次重建；`seeking=false` 读取最终位置、递增 `revision` 并强制发送一次。
- [x] 添加失败测试：修改 `settings.offset` 会递增 `revision`，即使只变化 1 秒也要求 overlay 重建。
- [x] 在 `main.js` 监听以下事件：

```js
event.on("mpv.time-pos.changed", updatePlaybackTime);
event.on("mpv.pause.changed", updatePlaybackPause);
event.on("mpv.speed.changed", updatePlaybackRate);
event.on("mpv.seeking.changed", updateSeekingState);
```

- [x] `updateSeekingState(true)` 只标记并发送冻结状态；`updateSeekingState(false)` 通过 `mpv.getNumber("time-pos")` 读取最终时间、递增 `revision`、清除时间节流基线并强制发送。
- [x] 将 offset 更新视作时间轴不连续变化：递增 `revision` 并强制发送，不再依赖 overlay 的 `5.5s` 猜测阈值。
- [x] 运行 `node --test tests/main-stream.test.js`，预期 seek、偏移、暂停与节流组合测试全部通过。

### Task 3：按最新时间重建弹幕

- [x] 在 `tests/danmaku-overlay.test.js` 添加失败测试：前跳 2 秒、后跳、连续 seek 和暂停中 seek 都会清空旧 `runline`，最终只发送目标时间最近 1000ms 内符合条件的弹幕。
- [x] 添加失败测试：seek 后解析到的新批次仍按最新 `currentTime` 过滤，不会把旧历史弹幕灌入屏幕。
- [x] 在 `overlay/danmaku.js` 新增并复用：

```js
function rebuildAtTime(time) {
    currentTime = time;
    hasTime = true;
    cm.clear();
    rebuildPendingComments(time);
    if (!paused && !seeking) {
        flushDueComments(time);
    }
}
```

- [x] 新增 `applyPlaybackState(data)`：校验 `time/rate/revision`；`revision` 变化时调用 `rebuildAtTime()`；`paused || seeking` 时 `cm.stop()`，恢复时先校准时间再 `cm.start()` 和 `flushDueComments()`。
- [x] 删除旧 `time` 与 `pause` handler，避免新旧两套状态通道竞争；保留大时间差检测作为事件缺失时的兜底，但显式 `revision` 优先。
- [x] 运行 `node --test tests/danmaku-overlay.test.js`，预期新增重建测试及原有渐进解析测试全部通过。

### Task 4：让在屏动画跟随播放器倍速

- [x] 扩展 overlay fixture，使滚动弹幕 DOM 暴露 `getAnimations()`，记录每个动画的 `playbackRate`。
- [x] 添加失败测试：`0.5x`、`1x`、`2x` 会更新所有在屏 CSS animation；恢复播放后保留当前倍速；新弹幕发送后立即继承当前倍速。
- [x] 在 `ensureCM()` 创建 manager 后包装实例的 `cm.onTimerEvent`，将传给所有 `runline` comment 的时间统一缩放为 `timePassed * playbackRate`；滚动、顶部和底部弹幕的 TTL 都必须跟随播放器倍速，禁止只调整 CSS animation。
- [x] 新增 `applyPlaybackRate(rate)`，保存独立 `playbackRate`，遍历 `cm.runline` 的 `dom.getAnimations()` 并设置 `animation.playbackRate = rate`；CSS animation 与 CCL TTL 必须使用同一个 rate。
- [x] 在 `flushDueComments()` 调用 `cm.send(due)` 后再次应用倍速，覆盖刚创建的动画。
- [x] 添加断言：`0.5x` 下滚动动画时长与 CCL TTL 同步延长，`2x` 下同步缩短，任何模式都不会在动画完成前被 manager 提前移除。
- [x] 运行 `node --test tests/main-stream.test.js tests/danmaku-overlay.test.js`，预期所有播放同步测试通过。

### Task 5：完整验证

- [x] 运行 `node --test tests/*.test.js`，预期 0 失败。
- [x] 运行 `node --check main.js && node --check overlay/danmaku.js && node --check overlay/danmaku-parser.js && node --check overlay/parser-worker.js`，预期全部退出码为 0。
- [ ] 在 IINA 1.4.4 实机完成 `0.5x / 1x / 2x` × `播放 / 暂停 / 前跳 / 后跳 / 拖动后释放` 矩阵；每次确认旧弹幕立即消失、恢复后只出现最终时间对应弹幕、视频播放无卡顿。
- [x] 运行全新 `goal-verify` 只读审计，覆盖需求、逻辑、边界、代码质量、测试有效性和实机结果；BLOCKER 与低成本 MAJOR 修复后重新审计。
