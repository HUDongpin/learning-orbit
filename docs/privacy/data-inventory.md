# Learning Orbit 資料盤點（受控試點）

本盤點描述本地受控試點的資料責任邊界。所有學生、訊息、媒體與時間戳均為合成演示或經批准的試點資料；分析資料不得用於評分、紀律或推斷友誼、能力、人格、心理狀態與學習成績。

| 類別 | 目的與擁有者 | 保留／輸出 | 刪除行為 |
| --- | --- | --- | --- |
| `room_event`、`outbox_event` | Server；聊天室與可恢復投遞 | 依綁定的 `pilot_retention_policy`；教師匯出只限本人房間 | 刪除 saga 的 `events` surface；不把原文寫入治理收據 |
| `media_asset`、grant、write fence、derivative | Media service；本地圖片／語音 | 原始檔、衍生檔各自受政策約束；不輸出簽名 URL | 先凍結寫入，再刪本地物件和衍生物；provider copy 另行證明 |
| `agent_run`、derived text、analysis projections | Worker／教師 review；可追溯的研究工程資料 | 只匯出已批准的 artifact、provenance、教師影子投影 | 依 `agent_runs`、`derivatives`、`projections` surface 有序刪除 |
| `deletion_job`、surface manifest、`provider_copy_closure` | Governance；無內容的刪除證據 | 只回傳狀態與線上資料面收據；不回傳 locator、token、hash token | 受 `audit_metadata_days` 約束；不得用收據恢復房間內容 |
| `security_audit_event` | Security；決策結果與房間 salted reference | 僅安全 allowlist 欄位；不含文字、IP、cookie、URL、provider payload | 依 audit metadata policy 清理 |
| 日誌／trace／metrics | Operations；端到端 correlation | 只保留 `roomId`、`eventId`、`roomSeq`、版本等安全欄位 | redaction first；telemetry 失效不可阻塞寫入 |

教師匯出是 bounded、`no-store` 的 JSON/CSV；學生與跨房間教師收到一致的 `404`，避免資源存在性洩漏。刪除收據只表示核准 storage/provider manifest 覆蓋的線上資料面不可讀；不可見的 immutable backup 不被錯誤宣稱已立即移除。
