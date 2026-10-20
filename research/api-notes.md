# 终末地国服接口核对

核对日期：2026-10-21。实现使用森空岛、鹰角的 HTTPS 接口，不经过第三方代理。

## 核心依据

- [nonebot-plugin-skland / api/login.py](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/api/login.py)：国服授权交换、签名令牌刷新。
- [api/request.py](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/api/request.py)：绑定角色、账号身份、请求签名和终末地卡片接口。
- [schemas/endfield/card.py](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/schemas/endfield/card.py)：体力、时间戳、立绘字段。
- [endfield_card.html.jinja2](https://github.com/FrostN0v0/nonebot-plugin-skland/blob/ac28d353277b4b68f13e3562558c0c5f29c2817e/nonebot_plugin_skland/resources/templates/endfield_card.html.jinja2)：将 `achieve` 展示为“光荣之路”，用于确认该页与成就奖章数据的对应关系。
- [endfield-plugin / apps/achieve.js](https://github.com/Entropy-Increase-Team/endfield-plugin/blob/32167dfd5dbefa0a5ccaeae20ed7f153d59a75f5/apps/achieve.js)：奖章 `achievementData`、`level`、`isPlated` 的实际读取方式。
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

新增 `dashboard` 和体力使用同一个 `/web/v1/game/endfield/card/detail` 响应，不额外调用奖章或逐干员接口。参考项目的独立 `/api/endfield/achieve` 是其第三方聚合服务接口，不能直接当作森空岛官方路径。本模块未接入该代理，也未向其发送凭据。这样不会增加背景任务的请求数量；额外资料缺失或格式异常仍能返回有效体力。

| 背屏字段 | 响应来源 | 语义 |
| --- | --- | --- |
| `dashboard.glory.count` | `detail.achieve.count` | API 返回的已获奖章数；无值为 `null`，不从展示列表推算 |
| `glory.medals[].id/name/category` | `achieve.achieveMedals[].achievementData.id/name/cateName` | 此次接口提供的奖章，不宣称完整成就图鉴 |
| `glory.medals[].level/isPlated` | 奖章自身的 `level/isPlated` | 不以静态 `initLevel` 代替账号等级；缺失为 `null` |
| `dashboard.operatorCount` | `detail.base.charNum` | API 返回的拥有干员数，独立于公开展示列表 |
| `operators[].id/name/rarity` | `detail.chars[].charData.id/name/rarity.value` | 干员模板身份、名称、稀有度文本 |
| `operators[].level/evolvePhase/potentialLevel` | `detail.chars[]` 的同名字段 | 等级、精英化阶段、潜能等级，0 是有效值 |
| `operators[].weapon` | `chars[].weapon.weaponData.name` 及 `weapon.level/refineLevel/breakthroughLevel` | 实际返回的武器名、等级、精炼等级、突破阶段 |
| `operators[].skills` | `charData.skills[].id/name`，按 ID 关联 `chars[].userSkills[id].level` | 仅保存技能名称与实际等级，缺失等级不默认为 1 |
| `operators[].equipment` | `bodyEquip/armEquip/firstAccessory/secondAccessory` 的 `equipData.name/level.value` | 四个装备槽的名称与等级文本，不读取大体积词条、说明 |

`achieve` 未返回时 `glory=null`，无干员展示数据时 `operators=[]`；UI 应显示未同步/未公开资料，而非推断账号没有干员或奖章。`detail.config.charSwitch/charIds` 表明卡片存在展示设置，所以干员列表长度不等于总拥有量。仅展示此次可见的资料，不查询隐藏资料。

快照只保留列出的公开显示字段，不保留账号实例 ID、获得时间、原始响应、图片 URL、技能说明和装备词条。最多 64 名干员、32 个奖章、每干员 8 个技能，再按序列化 UTF-8 大小将整个 `dashboard` 限制为 24 KiB，给立绘留出空间。达到限制时置 `operatorsTruncated` 或 `medalsTruncated`；总数仍保留 API 原值。该限制只对快照新增的 `dashboard` 生效，已有独立立绘候选 `characters` 契约保持兼容。

验证包括零值与缺失区分、异常可选资料、无图片干员、中文及 emoji 超长资料的 UTF-8 边界、原始私有字段不进入快照、同步请求数量不增加。未持有真实账号；这里验证的是上游源码契约和模拟响应，不代表已验证完整账号数据可见性。

## 玩家昵称与短 ID

用户要求顶部显示的“昵称#id”应优先原样使用 `detail.base.name`，不能把 `base.roleId`、绑定 UID 或森空岛 `userId` 拼接成昵称短 ID。

明确依据是固定版本 [endfield-plugin / API.md](https://github.com/Entropy-Increase-Team/endfield-plugin/blob/32167dfd5dbefa0a5ccaeae20ed7f153d59a75f5/API.md)：第 6712–6714 行便签响应的 `base` 同时给出 `name: "玩家名#1234"` 和 `roleId: "123456"`；第 6350 行说明这些便捷端点从 `card/detail` 提取数据；第 3595 行搜索接口将昵称格式称为“名字#短ID”。同一文档第 8138–8139 行的绑定信息也分别给出 `role_id: "123456"` 和 `nickname: "游戏昵称#1234"`。这些是上游文档样例，非本次真实账号请求所得。

因此现有 `profile.name ← base.name` 已经可以携带完整 `#短ID`。缺失详情昵称时可回退所选绑定角色的 `role.nickname`（模块中保存为 `role.name`）。若详情只有不带后缀的昵称，而同一已选角色绑定昵称有 `#短ID`，只能在其 `#` 前昵称与详情昵称完全相同时采用完整绑定昵称；昵称不匹配时保留当前详情昵称，避免显示旧昵称或错误后缀。两处都没有短 ID 时不猜测，不用游戏 UID 替代。显示长度不足时优先对昵称部分作视觉省略，保留真实短 ID；不得重复追加已有后缀。

## Token 获取与验证范围

用户在自己的浏览器登录 [森空岛官网](https://www.skland.com/)，再在同一浏览器打开 [通行证信息页](https://web-api.skland.com/account/info/hg)，复制 `data.content` 或完整 JSON 到模块设置页。模块同时接受这两种输入。不要把 Token 发到聊天中。

本次对信息页作了无 Cookie、无凭据访问：HTTP 401，未返回 Token。已确认端点存在并要求登录；没有验证用户真实登录态。本次没有用户账号，也没有发送任何真实认证材料。接口契约测试均使用本地模拟数据，真账号和真机行为仍需安装后验证。

## 错误与隐私

凭据仅由上层存入模块私有业务存储；适配器不写日志、不持久化、不把服务器错误正文传向 UI。快照只放体力、上述精简资料和图片。请求使用手动重定向，防止凭据头被转发。网络超时不自动重试；仅明确的认证拒绝才允许重新交换通行证。
