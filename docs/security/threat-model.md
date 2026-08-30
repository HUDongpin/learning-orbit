# Learning Orbit 受控試點 Threat Model

## 資產與信任邊界

瀏覽器是不可信客戶端；它不能決定 `actorId`、`actorKind`、room ownership、Agent role、retention policy 或 deletion job。Server 由目前 session、資料庫 membership 和 room owner 派生身份。Worker 透過短生命週期 service assertion 呼叫 internal route，provider authority 是另一種長期治理記錄，兩者不能互換。

## 主要威脅與控制

| 威脅 | 控制與可觀測證據 |
| --- | --- |
| forged actor／cross-room IDOR | 每一個 room-scoped action 先查現行 session／membership，再在寫鎖內重查；拒絕回 `404`，不建立 event |
| replay、duplicate、lost response | command／deletion 以 durable idempotency key 和 partial unique index 收斂；outbox／worker claim 可重試 |
| provider copy 泄漏 | authority record 只允許 `no_persistent_copy_attested`；signed URL、secret、locator 不進 API、log、export、receipt |
| deletion race | room lock、寫入 fence、manifest freeze；刪除期間一般讀寫 fail closed，只有 owner 的 content-free status 可用 |
| prompt／content injection | UI 將 learner、Agent、OCR、provider output 當不可信資料渲染；不可執行 HTML、SVG script 或 hidden reasoning |
| audit/log exfiltration | allowlist-first redaction；trace 不放訊息原文、transcript、prompt、media URL 或 provider payload |

本文件只證明工程控制與測試邊界，不代表正式安全認證、未成年人合規、供應商合約或學習成效證據。
