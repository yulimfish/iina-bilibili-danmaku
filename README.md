# Bili Danmaku for IINA

把哔哩哔哩普通视频或番剧的弹幕映射到 IINA 正在播放的本地视频上。

> 当前版本：`v0.2.0`。插件只加载并渲染弹幕，不播放、下载或代理 B 站视频。

## 功能

- 支持输入 BV 号或 B 站视频链接，自动读取标题、分 P 与对应弹幕。
- 支持搜索 B 站番剧，选择剧集与具体分集。
- 支持直接粘贴番剧 `ep`、`ss`、`md` 链接。
- 可从本地文件名识别可能的番剧/视频来源并展示推荐；可分别开启番剧与视频的高置信度自动加载。
- 支持滚动、逆向滚动、顶部和底部弹幕，过滤高级、代码与 BAS 弹幕。
- 弹幕跟随当前播放位置，支持暂停、恢复、倍速、seek、窗口缩放与页面重新显示。
- 支持显示开关、顶部/底部过滤、字号、透明度、滚动速度、时间偏移和清空弹幕。
- 支持选择本机字体、调整描边宽度与颜色；偏好设置会持久化。
- 设置通过 IINA preferences 持久化，并可在加载后实时调整。
- 大型弹幕 XML 采用 128 KiB 分块和逐块 ACK 背压，避免跨 WebView 消息堆积。
- 支持 Worker 增量解析和渐进渲染；WKWebView `file://` 无法加载 Worker 时自动回退到 16 KiB 时间片解析。
- 使用时间戳最小堆处理乱序数据，活动弹幕上限为 240；切换来源时忽略旧请求响应并取消旧渲染流。
- 播放状态同步支持暂停/恢复、倍速、seek 与时间偏移变化后的弹幕时间轴重建。
- 对 B 站 9 参数及更多参数弹幕记录、64 位 `dbid`、XML 实体和异常记录具有兼容与容错处理。
- 对视频不存在、权限限制、接口风控、网络异常、空弹幕和渲染异常提供明确状态提示。

## 安装

1. 从 [GitHub Releases](https://github.com/Yulimfish/iina-bilibili-danmaku/releases) 下载最新的 `.iinaplgz`。
2. 打开 `IINA → 设置 → 插件 → 本地安装`，选择下载的安装包。
3. 安装完成后重启 IINA。

## 使用

1. 使用 IINA 打开并播放本地视频。
2. 打开 `Plugins → Bili Danmaku → Toggle Danmaku Panel`，播放本地视频后进入“自动识别”查看文件信息与来源推荐。
3. 如需自动加载，在“设置”中分别勾选“自动加载剧集弹幕”或“自动加载视频弹幕”；两项默认关闭，仅唯一、高置信的来源会自动加载，否则请从推荐中手动选择。
4. 手动加载普通视频弹幕：在“手动搜索”切换到“视频/BV”，输入 BV 号、视频链接或关键词；多 P 视频可展开并选择分 P。
5. 手动加载番剧弹幕：切换到“剧集”，输入番剧名称并依次选择剧集、分集；也可以直接粘贴 `ep/ss/md` 链接。
6. 在“设置”中调整弹幕显示、顶部/底部过滤、字号、字体、描边宽度/颜色、透明度、速度与时间偏移；设置会持久化。

## 性能设计

```text
Bilibili XML
    ↓ main.js：128 KiB 分块 + 单块在途 ACK
overlay Worker：流式解析，最多 200 条/批
    ↓ Worker 不可用时：16 KiB setTimeout 时间片回退
时间戳最小堆：只派发当前时间到期弹幕
    ↓
CommentCoreLibrary：渐进渲染，活动上限 240
```

首批有效弹幕解析完成后即可开始显示，不需要等待整份 XML 处理结束。普通播放时间消息最多每 33ms 发送一次，跳转和控制状态即时同步。

## 当前限制

- 只支持本地视频的弹幕映射，不支持 B 站视频播放、拉流或下载。
- 不支持直播弹幕、发送弹幕、账号登录与离线弹幕缓存。
- 不渲染 mode 7/8/9 的高级、代码和 BAS 弹幕。
- B 站会员、地区限制、视频删除和接口风控仍可能导致请求失败。
- 自动加载默认关闭；只有候选来源、剧集/集数或视频分 P 均唯一且高置信时才会自动加载，否则只显示推荐。
- 自动加载逐阶段快速切换文件的完整实机矩阵尚未完成；竞态由自动化 generation/stale 测试覆盖。
- 字体/描边完整视觉实机验收尚未完成；偏好持久化已验证，渲染行为有自动化测试覆盖。
- 已在 IINA 1.4.4 完成一条本地视频到番剧弹幕显示的端到端实机验证，尚未覆盖所有 macOS/IINA 版本与全部媒体组合。

## 本版变化

详见 [v0.2.0 Release Notes](docs/releases/2026-09-25-v0.2.0.md)。

## 开发验证

```bash
node --test tests/*.test.js
node --check main.js
node --check overlay/danmaku.js
node --check overlay/danmaku-parser.js
node --check overlay/parser-worker.js
```

插件运行时文件由 `Info.json`、`main.js`、`global.js`、`sidebar/` 和 `overlay/` 组成，发布包根目录不包含测试、文档或 Git 数据。

## 致谢与许可

弹幕渲染使用 [CommentCoreLibrary](https://github.com/jabbany/CommentCoreLibrary)，其许可证见 `overlay/vendor/LICENSE-CCL`。

本项目使用 [MIT License](LICENSE)。问题反馈请通过 [GitHub Issues](https://github.com/Yulimfish/iina-bilibili-danmaku/issues)，公开联系邮箱：`epeiuss@waterflames.cn`。
