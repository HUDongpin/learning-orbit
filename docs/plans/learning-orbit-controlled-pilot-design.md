# Learning Orbit｜共学星球：受控课堂试点系统设计

**状态：** 已由用户于 2026-08-29 批准进入正式实施计划编写  
**原型基线：** `outputs/learning-orbit-demo.html`  
**算法基线：** `work/learning_orbit_algorithms.py`  
**证据边界：** ECHO-CM 与 TRACE-AI 是尚未同行评议的 original engineering synthesis / research proposal；原型的本地规则、固定指标和 92 项算法／HTML 回归测试不等于真实抽取准确率、课堂有效性或生产安全性。

## 1. 目标与范围

为一个学校或经批准的研究试点实现真实可用的 45 分钟小组探究系统：一名教师创建房间，四名学生以课堂化名进入，Nova Agent 作为可禁用的苏格拉底式促进者；文字、图片和录音可持久保存并跨设备同步；ECHO-CM 与 TRACE-AI 从同一事件账本生成可追溯、可重放的概念图和观测互动网络；教师拥有复核、纠错、导出与删除能力。

首轮不包含多学校运营后台、SIS／LTI 名册同步、跨区域多活、大规模灾难恢复、个人排名、自动纪律处分、心理／情绪／能力推断或未经研究支持的学习成效主张。

## 2. 已批准的架构决策

采用“模块化单体＋持久事件账本＋异步 Worker”，不采用首日微服务。

```text
学生响应式 Web／教师控制台
        │
        ├── REST：身份、快照、历史、媒体、导出、删除
        └── WebSocket：命令确认、事件、投影、降级状态
                         │
                  Fastify API／WS
                         │
          Identity · Room · Chat · Safety · Audit
                         │ 单一事务
           PostgreSQL room_event + outbox_event + worker_job
                         │
            Python Worker：Media · Agent · ECHO · TRACE
                         │
       私有对象存储／版本化 projection／analysis_projection_outbox
```

三个部署单元为：Next.js 响应式 Web、Fastify API/WS、Python 3.12 Worker。PostgreSQL 是事实源；`outbox_event` 只发布已提交的 RoomEvent，`analysis_projection_outbox` 只发布已提交投影的指针，两者不得互相递归写入。`LISTEN/NOTIFY` 只作唤醒，消费者仍从持久表读取；队列、缓存和 WebSocket 广播不能代替事件账本或投影快照。

## 3. 身份和房间

- 教师通过一次性邮件登录链接获得可撤销的 opaque session。
- 教师创建一间 45 分钟房间，系统生成短期房间码和四个席位码。
- 学生不提供永久邮箱，以教师分配的课堂化名和席位码进入。
- 每个房间由服务端生成独立的 Nova actor；学生只能提及本房间 bootstrap 返回的 Nova actor，不能提交或伪造 Agent 身份。
- `actorId`、`actorKind` 和角色由服务端会话推导；客户端不能冒充教师、其他学生或 Agent。
- 教师可以 open、pause、resume、close 房间，并可禁用或取消 Nova Agent；pause 只暂停新的人类/Agent 命令，不延长固定的 45 分钟 wall-clock，旧 Agent 请求也不会在暂停期间发布。
- 房间关闭后拒绝新命令，但授权教师可以读取、导出或删除。

## 4. 事实事件和实时协议

每个持久 `RoomEvent` 包含服务端生成的 `eventId`、房间内单调递增的 `roomSeq`、`schemaVersion`、服务端身份、`revision/operation`、客户端 `eventTime`、服务端 `ingestTime`、稳定 `causationId`、服务端 `correlationId` 和 payload。每个持久 WorkerJob 也必须保存非空 correlation ID；从事件派生的任务原样继承，重试不得换号，避免仅靠进程内 trace 造成断链。

核心不变量：

- 同一 `commandId` 重试只产生一个事实事件。
- 服务端只广播已提交事件。
- WebSocket 是至少一次传输；客户端以 `eventId/roomSeq` 去重。
- 修订与撤回创建新事件，不覆盖历史。
- `eventTime` 只保留捕获时间；排序、恢复和完成度以 `roomSeq` 为准。
- presence／typing 是短时信号，不进入永久账本。
- 连接恢复携带 `lastServerSeq`；版本缺口不能用“当前画面看似一致”掩盖。

客户端命令为 `hello/resume`、`command`、`presence`、`typing`、`heartbeat`；服务端消息为 `ack`、`reject`、`event`、`projection`、`snapshot_required`、`degraded`、`heartbeat`。

## 5. 消息与媒体

文字、回复、提及、修订和撤回共享同一命令路径。客户端可乐观显示，但必须呈现 pending／accepted／rejected；房间关闭后的离线草稿只能复制或删除，不能伪装成已发送。

图片和录音通过短期签名 URL 上传到私有对象存储。浏览器先在 25 MiB 上限内计算 SHA-256：hex 值进入授权请求，服务器返回绑定同一 digest 的强校验 header，浏览器逐字用于 PUT；存储 HEAD、条件复制和不可覆写 original key 必须返回并验证同一强校验和，不能把 ETag 或自报 metadata 当内容证据。每个已签发或可能已签发的 PUT 都先进入无 URL 的持久 grant ledger，其期限以 presigner 返回的真实签名／到期时间为准；浏览器只写 staging key，之后重复 PUT 只能改变待清理的 staging。一个媒体 ID 永久绑定一个逻辑消息／来源事件；修订或撤回不释放它给另一条消息，避免多模态 provenance 漂移。删除开始时冻结并撤销应用层授权，若存储签名不能即时撤销，则等待其最长有效期与有证据的最大上传时长，再做最终 exact-key／prefix sweep。Finalize 与媒体 Worker 的每次 derivative 写入也使用同一个房间删除锁，因此写入要么先于最终 sweep，要么被 deletion tombstone 拒绝。服务端核验哈希、真实 MIME、大小与权限；媒体 Worker 做病毒扫描、图片去 EXIF／缩略、音频转码。媒体失败不阻塞文字聊天；未通过扫描的媒体不得广播。原始媒体、派生产物、ASR／OCR 和消息引用分别记录，并接受依赖有序删除。任何外部模型／多模态调用必须在网络请求前持久记录其资料生命周期：会保留远端副本的提供商必须具备幂等删除与不可读探测端口；声明不保留副本的提供商必须有可验证、限定范围且未过期的签署依据。保留任务或教师删除任务首先完成远端证明的一方，必须在移除 locator-bearing processing row 的同一事务写入无内容、身份绑定的 `provider_copy_closure`，供另一方幂等消费；未知探测、失效依据或仅仅“记录已不存在”不能生成删除成功回执。

所有房间写入都使用 PostgreSQL 内唯一的 UUID→advisory-key 函数；Node 与 Python 只执行同一组 canonical SQL。全局锁序固定为房间 advisory lock、房间 row、按主键排序的 domain rows、最后才是当前 Worker job。跨外部 I/O 的有界操作使用同一 key 的 dedicated session lock。Worker→Server 内部请求由一个 Ed25519 signer/client 对完整持久 claim tuple 和 closed body 签名，Server 由一个 verifier 校验后仍须在事务中执行统一 `JobClaimAuthority` CAS；签名本身不是当前 lease 的证明。

## 6. Nova Agent

首版只允许学生明确 `@Nova Agent` 或教师触发；同一房间最多一个活动 Agent Run，Agent 消息不递归触发 Agent。运行状态为 queued、running、streaming、completed、blocked_by_policy、cancelled、failed。

Agent 只读取当前房间授权上下文；最终回复必须通过 Room Command API 提交；保存输入序号范围、模型／提示词／策略版本、来源事件、延迟与成本，不保存隐藏思维过程。受控试点只流式呈现 `queued/running/streaming/held` 状态，不把供应商 token/chunk 发送到浏览器；完整文本在 Worker 内聚合并通过安全检查后，才作为一个最终持久事件发布。这样牺牲逐 token 动画，换取可审计的安全边界。Agent 或供应商失败不得阻断人类聊天。

## 7. ECHO-CM 与 TRACE-AI

HTML wire contract 与 Python internal dataclass 之间必须有显式 adapter。原始媒体事件和 `DerivedTextArtifact` 分开；`sourceFidelityConfidence`、`extractionConfidenceCalibrated`、`evidenceWeight`、`reviewStatus` 不合并成单一 confidence。

ECHO-CM 投影区分：

- `evidenceStatus`：supported／challenged／uncertain／disputed；
- `reviewStatus`：unreviewed／approved／rejected／corrected；
- `displayStatus`：confirmed／provisional／disputed／inactive。

投影顶层的访问范围由 `projectionKey` 与 envelope scope（teacher shadow／student approved）表达；不得把访问范围塞进元素 `displayStatus`。因此 UI 可直接用这四个元素状态绘制实线／虚线／双态／淡化，同时仍由服务端权限决定谁能取得哪一份投影。

TRACE-AI 区分 communication 与 uptake 的方向；广播使用 actor→ROOM；多目标分配总权重；positive／challenge／uncertain 不互相抵消；Agent 转述保留来源谱系；学生真正采用后才产生来源信用。

所有派生输出带 `projectionVersion`、`baseVersion`、`completeThroughRoomSeq`、`analysisEpoch`、`algorithmVersion`、`parameterHash`、`evidenceRefs`、`warnings`、`requiresReplay`。版本缺口时客户端停止应用 patch 并拉取快照；晚到、修订或撤回触发 last-good＋rebuilding，而不是静默改史。

## 8. 权限分层与可争议性

学生使用课堂化名，可看图结构和群体层指标，但看不到个人中心性、strength、排名、风险标签或其他学生的受限原始证据。所有学生 SNA 视图与指标旁固定显示：“此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果。”首轮系统不收集学生法定姓名，因此教师只查看席位／课堂化名与房间内 actor 的授权映射、证据片段、模型／算法版本、置信度分量、watermark、active／retracted／corrected 状态，并执行 approve、reject、split、merge、correct、retract；不得把课堂化名写成“实名”。

所有人工修正是不可变 correction event，并触发下游撤回与 replay。自动模型只提供证据，不能处罚学生；`challenge` 不解释为人际负面。真实未成年人数据禁止用于人脸、声纹、情绪、心理、人格、能力或纪律风险推断。

## 9. 失败与降级

- WebSocket 断开：保留待发状态，以同一 commandId 重试并补序号缺口。
- Session 撤销或房间删除：每个入站 command／presence／typing／heartbeat 与每个出站 durable frame 都重新授权，写事务内再检查一次；session 失效关闭 4401、成员移除关闭 4403、房间关闭／删除关闭 4410，排队中的 RoomEvent 不再送达。
- Analytics 停止：聊天继续，面板显示 stale／unavailable 和最后完成序号。
- Patch 缺口：停止 reducer，拉取完整 snapshot。
- Replay：展示 last-good＋重建中，完成后以新版本替换。
- Agent 安全检查失败：不发布，进入教师复核。
- 媒体扫描失败：保持隔离，不影响文字聊天。
- ASR／OCR 低置信：明确标记机器生成并 abstain。
- 删除部分失败：持久重试和运维告警；全部清除前不生成成功回执。
- 审核服务不可用：人类文字进入有教师在场的明确降级模式；Agent 与未扫描媒体失败关闭。

## 10. 前端边界

原型被拆为 AppShell、IdentityAndRoom、EventLedger、RealtimeSessionClient、ChatFeature、MediaFeature、AgentRunState、ConceptProjection、SnaProjection、ProjectionCoordinator、TeacherConsole、ResponsiveA11yState 和 DemoFixturesAdapter。生产构建绝不在后端故障时偷偷回退到演示数据。

视觉方向继续采用已批准的 “Playful Research Lab”：圆润、清晰、积极反馈、适度游戏化的教育科技质感，可吸收语言学习产品的友好层级，但不复制多邻国或其他产品的商标、吉祥物、图标、文案或高度近似外观。唯一实现真相是 Plan 05 冻结的七色 token、系统圆体字栈、8px spacing、18–24px 圆角、低阴影和 authored SVG 图标。

图形和列表必须语义等价；聊天、概念图和所有获准分析面板只有到达共同 `completeThroughRoomSeq` 才显示同步完成，未获 student-visible promotion 的面板显示“本次课堂未开放”且不伪造空图或游标。SNA 的 `recent_10m` 与 `session_45m` 均由服务器在同一 bundle 中生成并带精确边界，浏览器只切换、不重算；“暂停更新”只冻结 SNA 呈现，后台仍验证新 bundle，恢复时切到最新已验证状态，不影响聊天或概念图。SNA 保留独立 node port、互惠双轨、自环双端口、短 fan-out 和最终屏幕像素验收。

## 11. 放行顺序

1. 契约、安全、身份、留存和威胁模型。
2. 真实文字课堂、事件账本、WebSocket 与教师基础控制。
3. 私有图片和录音。
4. Deterministic ECHO／TRACE 端到端与 replay parity。
5. Nova、ASR／OCR／图像理解的教师 shadow 模式。
6. 学生安全投影、教师复核、纠错、导出和删除。
7. 故障注入、安全、人因和无障碍工程门；synthetic rehearsal 只能证明工程准备度。
8. 独立签署的学校／伦理／供应商授权 → 实际教师 shadow → 独立签署的学生可见功能 promotion → 有限学生试点。

任何一层不过门均不得进入下一层。自动化、Agent 或 synthetic fixture 都不能代替后三项人类权威记录。只有独立研究完成后才能主张学习成效。
