# 终末地国服接口核对

核对日期：2026-10-21。实现使用森空岛、鹰角的 HTTPS 接口，不经过第三方代理。

## 核心依据

- [nonebot-plugin-skland / api/login.py](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/api/login.py)：国服授权交换、签名令牌刷新。
- [api/request.py](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/api/request.py)：绑定角色、账号身份、请求签名和终末地卡片接口。
- [schemas/endfield/card.py](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/schemas/endfield/card.py)：体力、时间戳、立绘字段。
- [endfield_card.html.jinja2](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/resources/templates/endfield_card.html.jinja2)：将 `achieve` 展示为“光荣之路”，用于确认该页与成就奖章数据的对应关系。
- [endfield-plugin / apps/achieve.js](https://github.com/Entropy-Increase-Team/endfield-plugin/blob/32167dfd5dbefa0a5ccaeae20ed7f153d59a75f5/apps/achieve.js)：奖章 `achievementData`、`level`、`isPlated` 的实际读取方式。
- [apps/note.js](https://github.com/Entropy-Increase-Team/endfield-plugin/blob/32167dfd5dbefa0a5ccaeae20ed7f153d59a75f5/apps/note.js)：`achieve.display` 的数字展示位、对应奖章 ID 和阶段图案选择。模块只使用明确的展示选择，不采用该项目“最近获得奖章”的回退方式。
- [apps/operator.js](https://github.com/Entropy-Increase-Team/endfield-plugin/blob/32167dfd5dbefa0a5ccaeae20ed7f153d59a75f5/apps/operator.js)：技能关联 `userSkills[skill.id].level` 和装备 `equipData.level.value`。
- [schemas/binding.py](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/schemas/binding.py)：绑定 UID、游戏角色 ID、森空岛账号 ID 是不同身份。
- [skland-auto-sign 的登录说明](https://github.com/xjwwjx/skland-auto-sign)：网页登录后读取通行证 Token 的步骤。

本模块为独立实现，没有复制上述项目源文件。上游社区实现是协议行为的依据，不是官方稳定性承诺。

## 实际使用的请求

1. `POST https://as.hypergryph.com/user/oauth2/v2/grant`，提交 `appCode=4ca99fa6b56cc2ba`、用户输入的 `token`、`type=0`，读取 `data.code`。
2. `POST https://zonai.skland.com/api/v1/user/auth/generate_cred_by_code`，提交 `code` 与 `kind=1`，读取 `data.cred`、`data.token`、可选 `data.userId`。
3. 若登录结果缺少 `userId`，签名请求 `GET /api/v1/user/teenager`，读取 `data.teenager.userId`。
4. 签名请求 `GET /api/v1/game/player/binding`，读取 `data.list` 内 `appCode=endfield` 的 `bindingList[].roles[]`。
5. 后续刷新首先 `GET /api/v1/auth/refresh`，仅发送 `cred` 凭证，取得新签名令牌。
6. 签名请求 `GET /web/v1/game/endfield/card/detail?roleId=...&serverId=...&userId=...`。其中 `userId` 必须是森空岛账号 ID，不能用绑定列表的 UID 替代。

签名：有序 JSON 字段为 `platform,timestamp,dId,vName`；这里三个非时间字段均为空字符串，与核对的国服客户端一致。签名内容依次连接路径、原样编码的查询字符串（无问号）、秒级时间戳、有序 JSON。先做 HMAC-SHA256，再将其十六进制文本做 MD5。

## 数据语义

- `data.detail.dungeon.curStamina` 与 `maxStamina`：数值字符串，0 是有效体力；不能把缺失字段当作 0。
- `data.detail.currentTs`：服务端时间，秒级 Unix 时间戳。
- `data.detail.dungeon.maxTs`：预计回满的秒级 Unix 时间戳。0 或空值不用于倒计时。
- API schema 没有明确的每点恢复间隔，因此 `secondsPerPoint=null`。显示上次同步的实际体力与服务端回满倒计时，不凭猜测逐点增加。
- `data.detail.chars[].charData` 提供 `id,name,illustrationUrl`。客户端仅保留 HTTPS 图片 URL，不随图片下载发送账号凭证。

## 光荣之路与干员养成

新增 `dashboard` 和体力使用同一个 `/web/v1/game/endfield/card/detail` 响应，不额外调用奖章或逐干员资料接口。参考项目的独立 `/api/endfield/achieve` 是其第三方聚合服务接口，不能直接当作森空岛官方路径。本模块未接入该代理，也未向其发送凭据。额外资料缺失或格式异常仍能返回有效体力；蚀刻章图片需要单独从返回的 HTTPS 图片地址加载，不附带账号凭据。

**蚀刻章展示选择的修正**：`achieve.achieveMedals` 是接口提供的已获奖章资料，不能直接当作玩家的展示栏。当前上游 `apps/note.js` 第 323 行起按数字键排序 `achieve.display`，其值是所选 `achievementData.id`；API 文档第 6748 行起给出 `display: {"1":"奖章ID"}` 的响应样例。模块据此按展示位筛选并排序，未选中的章即使已获得也不进入展示快照。选中 ID 缺少对应资料时保留空图案占位，不用其他奖章替补。旧 schema 的 `{type, achieveMedalId}` 单章结构也兼容。

没有返回 `display` 或返回无法识别的结构时 `displayKnown=false`、`displayCount=null`、`medals=[]`；明确返回空对象时为已知未选择，`displayKnown=true`、`displayCount=0`。不能在这两种情况回退到全量或最近获得的章。`glory.count` 仍保留接口总数字段供其它需要使用，不能代替展示数量。

| 背屏字段 | 响应来源 | 语义 |
| --- | --- | --- |
| `dashboard.glory.count` | `detail.achieve.count` | API 返回的已获奖章数；无值为 `null`，不从展示列表推算 |
| `glory.displayKnown/displayCount` | `achieve.display` | 是否取得明确展示配置，以及去重后的选中数量；缺失配置不猜测 |
| `glory.medals[].id/name/category/slot` | 先按 `achieve.display` 数字键排序和筛选，再关联 `achieveMedals[].achievementData` | 仅为玩家在森空岛选中的蚀刻章，保留展示顺序 |
| `glory.medals[].level/isPlated` | 奖章自身的 `level/isPlated` | 不以静态 `initLevel` 代替账号等级；缺失为 `null` |
| `glory.medals[].iconUrl` | `achievementData.reforge3Icon/reforge2Icon/platedIcon/initIcon` | 按实际阶段与镀层选择图案，仅允许长度不超过 2048 的 HTTPS 地址；不附带账号凭据 |
| `dashboard.operatorCount` | `detail.base.charNum` | API 返回的拥有干员数，独立于公开展示列表 |
| `operators[].id/name/rarity` | `detail.chars[].charData.id/name/rarity.value` | 干员模板身份、名称、稀有度文本 |
| `operators[].level/evolvePhase/potentialLevel` | `detail.chars[]` 的同名字段 | 等级、晋升阶段、潜能等级，0 是有效值 |
| `operators[].weapon` | `chars[].weapon.weaponData.name` 及 `weapon.level/refineLevel/breakthroughLevel` | 实际返回的武器名、等级、精炼等级、突破阶段 |
| `operators[].skills` | `charData.skills[].id/name`，按 ID 关联 `chars[].userSkills[id].level` | 仅保存技能名称与实际等级，缺失等级不默认为 1 |
| `operators[].equipment` | `bodyEquip/armEquip/firstAccessory/secondAccessory` 的 `equipData.name/level.value` | 四个装备槽的名称与等级文本，不读取大体积词条、说明 |

`achieve` 未返回时 `glory=null`，无干员展示数据时 `operators=[]`；UI 应显示未同步/未公开资料，而非推断账号没有干员或奖章。`detail.config.charSwitch/charIds` 表明卡片存在展示设置，所以干员列表长度不等于总拥有量。仅展示此次可见的资料，不查询隐藏资料。蚀刻章图案按上游实际选择顺序：等级至少 3 时尝试 `reforge3Icon`，至少 2 时尝试 `reforge2Icon`，已镀层时尝试 `platedIcon`，最后使用 `initIcon`；不安全或缺失的地址跳过，全部无效则为 `null`。

快照只保留列出的公开显示字段，不保留账号实例 ID、获得时间、原始响应、未选中蚀刻章的图片 URL、技能说明和装备词条。最多 64 名干员、32 个展示蚀刻章、每干员 8 个技能，再按序列化 UTF-8 大小将规范化 `dashboard` 元数据（包括选中图案 URL）限制为 24 KiB。达到限制时置 `operatorsTruncated` 或 `medalsTruncated`；总数和选中数仍保留原值。此预算不包括渲染层另外管理的图片缓存；已有独立立绘候选 `characters` 契约保持兼容。

验证包括零值与缺失区分、异常可选资料、无图片干员、中文及 emoji 超长资料的 UTF-8 边界、原始私有字段不进入快照、资料 API 请求数量不增加。图标缓存另行请求所选图案，不携带账号凭据或 Cookie。未持有真实账号；这里验证的是上游源码契约和模拟响应，不代表已验证完整账号数据可见性。

高清立绘在设置页保留最长边 1600 像素，优先高质量 WebP，Data URL 上限 480,000 字符。业务缓存按不超过 150,000 字符的片段顺序读写；完整共享快照保持低于 760,000 字符，供原生卡片同步首帧使用。章图仅在设置或后台 WebView 下载并压缩至最长边 256 像素，全部章图合计不超过 240,000 字符。卡片 QuickJS 不具备浏览器图片编码器，刷新时复用已缓存图案，避免大图片响应经 HostVar 回传。WebView 下载每次最多两个并行任务、总等待预算 12 秒，未完成的图案保留选择并等待后续刷新，不影响体力同步。

## 玩家昵称与短 ID

用户要求顶部显示的“昵称#id”应优先原样使用 `detail.base.name`，不能把 `base.roleId`、绑定 UID 或森空岛 `userId` 拼接成昵称短 ID。

明确依据是固定版本 [endfield-plugin / API.md](https://github.com/Entropy-Increase-Team/endfield-plugin/blob/32167dfd5dbefa0a5ccaeae20ed7f153d59a75f5/API.md)：第 6712–6714 行便签响应的 `base` 同时给出 `name: "玩家名#1234"` 和 `roleId: "123456"`；第 6350 行说明这些便捷端点从 `card/detail` 提取数据；第 3595 行搜索接口将昵称格式称为“名字#短ID”。同一文档第 8138–8139 行的绑定信息也分别给出 `role_id: "123456"` 和 `nickname: "游戏昵称#1234"`。这些是上游文档样例，非本次真实账号请求所得。

因此现有 `profile.name ← base.name` 已经可以携带完整 `#短ID`。缺失详情昵称时可回退所选绑定角色的 `role.nickname`（模块中保存为 `role.name`）。若详情只有不带后缀的昵称，而同一已选角色绑定昵称有 `#短ID`，只能在其 `#` 前昵称与详情昵称完全相同时采用完整绑定昵称；昵称不匹配时保留当前详情昵称，避免显示旧昵称或错误后缀。两处都没有短 ID 时不猜测，不用游戏 UID 替代。显示长度不足时优先对昵称部分作视觉省略，保留真实短 ID；不得重复追加已有后缀。

## Token 获取与验证范围

用户在自己的浏览器登录 [森空岛官网](https://www.skland.com/)，再在同一浏览器打开 [通行证信息页](https://web-api.skland.com/account/info/hg)，复制 `data.content` 或完整 JSON 到模块设置页。模块同时接受这两种输入。不要把 Token 发到聊天中。

本次对信息页作了无 Cookie、无凭据访问：HTTP 401，未返回 Token。已确认端点存在并要求登录；没有验证用户真实登录态。本次没有用户账号，也没有发送任何真实认证材料。接口契约测试均使用本地模拟数据，真账号和真机行为仍需安装后验证。

## 错误与隐私

凭据仅由上层存入模块私有业务存储；适配器不写日志、不持久化、不把服务器错误正文传向 UI。快照只放体力、上述精简资料和图片。请求使用手动重定向，防止凭据头被转发。网络超时不自动重试；仅明确的认证拒绝才允许重新交换通行证。

## 1.1.2 背屏独有的同步故障

用户确认同账号在设置网页能成功刷新，背屏点按同步却长期等待或失败。上游 `BridgeProvider` 将超过 1,000,000 字符的异步结果移除而不返回错误；`LiveCarrierRuntime` 的已确认请求没有完成超时。因此在规范化数据之前，原始 `card/detail` 的体积就可能导致背屏永久等待。现在仅背屏详情请求显式设置 `Accept-Encoding: gzip` 与 `responseType: base64`，经桥接后使用 fflate 解码；身份与认证小请求、设置网页和后台保持文本传输。无压缩的 identity 响应也兼容。

[Android HttpURLConnection 文档](https://developer.android.com/reference/java/net/HttpURLConnection) 的 Performance 说明，显式设置 Accept-Encoding 会关闭平台的自动解压，并将解压责任交给调用方。上游 `ModuleHttp` 透传该请求头，`ModuleBackend` 将响应字节按请求转为 base64。本次无凭据访问返回 401 和小型 identity 响应，未用真实账号验证大响应压缩；测试用超过 2MB 的模拟详情验证压缩传输与规范化。

旧版每个读取器逐段 await 仍可能让并发 reload 与 refresh 的两段图片合到同一个 HostVar 回包。现在同一 service 内所有业务读取共用顺序队列；背屏单次读取等待 12 秒，整体刷新等待 40 秒，UI 另有 45 秒兜底。超时不自动重发，过期任务不能发布迟到结果，也不在超时处理里等待可能挂起的桥调用。

完整高清快照的回写还经过 ContentResolver.call 的 Bundle；[Android Binder 的事务缓冲约为 1MB](https://developer.android.com/reference/android/os/TransactionTooLargeException)。因此快照图片 base64 的两个字符无损合并为一个 U+4000 起的 BMP 字符，带版本、原长度与前缀保存；仅原生快照采用此格式，业务缓存保持普通 JSON。背屏在首个 await 前解包，仍使用完整 Data URL 绘制。测试包含完整桥请求的 UTF-16 字节预算、旧快照兼容、异常输入、图片逐字还原与并发及超时恢复。

## 1.1.3 实机同步卡死定位

2026-10-21 经用户授权连接 ADB 后，实机 `QuickJsBridge` 日志记录 `JS execution exceeded time budget (1500 ms), interrupting`，随后 `InternalError: interrupted`。堆栈为 `$t:2283 → rn:2341 → responseText:3131 → drainAsync → mainLoop`。按 1.1.2 安装包实际脚本顺序与 Promise 包装还原，3131 对应 `return root.fflate.strFromU8(bytes)`，`$t` 是没有原生 TextDecoder 时的逐字符 UTF-8 回退转换；这次中断发生在解压之后。

宿主 `mainLoop` 在最后才登记下一帧。中断发生在前面的 `drainAsync`，因此整个绘制和触摸队列停止，普通 40/45 秒计时器也不能挽救。仅 `await Promise.resolve()` 仍在同一个 drain 队列内完成，不算让出执行。

1.1.3 使用小块 base64 校验/解码、每次 512 字节压缩输入的 Gunzip 和每次 8KiB 输出的 DecodeUTF8，并按时间批次通过 RAF 让出执行；RAF 回调仅 resolve，后续工作在下一次宿主 drain 中继续。字符串合并、JSON.parse 和后续规范化之间也让出执行，保留 8MiB 解码上限。该变更不削减已展示的数据，也不改用第三方接口。修复后的实机复测结果需单独记录。

1.1.3 实机复测反馈：卡片不再卡住，但同步提示超时。完整编译 ZIP 在 QuickJS、真实 CompatiblePromise 与 1500ms 逐帧中断限制下，对 7.72MB 合成 ASCII 详情的旧版首帧 1501ms 中断，堆栈与实机一致；新版成功完成，最长帧约141ms。6.49MB 中文详情新版最长帧约160ms。该桌面引擎测试不替代实机验证。

## 1.1.4 桥接往返与动态数据范围

使用每批桥接返回耗时1秒的测试，719K快照、480K立绘和10枚章图在旧服务中需要63批；同时存在两次页面重载时为68批，40秒截止发生在写新快照之前。问题是频繁校验、小配置请求和整张图片缓存重读累积，并非单个接口等待过久。

卡片现在通过一次 `config.get()` 取得小配置，优先使用 `card.readSnapshot()` 的当前缓存；读取后仍检查会话，发布前后仍保留账号/角色与代际保护。立绘沿用当前快照，卡片同步不读取独立立绘存储，也不更新立绘候选名单；设置页和后台的完整刷新行为保留。旧片段清理合并为安全的小请求批次，大图写入仍串行，避免回包和Binder体积超限。相同慢桥场景降为25批，增加退出登录期间在途响应不得覆盖新账号的验证。整体同步上限60秒为网络超时与分帧处理留出余量，UI兜底65秒；单次业务读取12秒不变。

同版本把快照图片的超长正则改为短前缀匹配与逐字符校验，保持原字符集合和图片字节不变。此前独立QuickJS测试在4MiB限制下的长正则阶段复现OOM；这属于资源改善，不据此声称已定位手机后续无堆栈OOM日志的原因。

## 1.1.6 实机成功验证

1.1.5 实机已完成安装与缓存转换，但仍在 `data.ready` 之后、`cache.write` 之前出现内存不足。1.1.6 移除整份图片快照 JSON 克隆，释放解压与写入缓冲，写后先检查资料时间再决定是否展开图片，并避免绘制入口再次序列化已展开的结果。

仅理智路径在提取独立标量后，清空本次私有解析对象的顶层字段，使仍被异步调用引用的对象不再保留完整详情。完整设置页同步不执行此清理。相同宿主运行时模拟中，估算内存峰值从 6.64 MB 降至 4.66 MB；此数字不包含原生图片内存，也不是手机的堆上限测量。

2026-10-21，实机同步日志完整经过 `detail.parsed → data.ready → cache.write → display.save → display.ready → done`，本次约 8 秒；实机脚本与 1.1.6 安装包一致。用户确认保留原高清立绘时同步时间正常更新、切页正常。背屏与后台刷新仅更新理智，展示章、干员与装备等资料需设置页手动同步；立绘既不下载也不重新编码。设置页另提供手动降低当前本地立绘占用的选项。
