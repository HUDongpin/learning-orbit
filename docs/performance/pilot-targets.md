# Pilot performance targets（engineering evidence only）

這些是受控工程測試目標，不是 production SLA，也不代表端到端即時性或學習成效。標準 fixture 為 10 個同時房間，每房 4 名學生、1 名教師；訊息、media 和 Agent provider 都使用合成資料與 deterministic adapter。

| 路徑 | p50 目標 | p95 目標 | 測量邊界 |
| --- | ---: | ---: | --- |
| command → committed `room_event` | ≤ 150 ms | ≤ 500 ms | 不含瀏覽器網路與 provider |
| outbox publish → WS send | ≤ 100 ms | ≤ 400 ms | 只計 durable outbox 到送出 |
| projection patch commit | ≤ 500 ms | ≤ 2 s | Python extractor／LLM／ASR／OCR 延遲另列 |
| bounded teacher export | ≤ 1 s | ≤ 3 s | 最多 10,000 events；超限需分頁 |

測試報告應同時列事件量、active room、node/edge 數、硬件／容器 image digest、p50/p95/p99、錯誤率、backpressure close 與 replay time。任何 benchmark 結果只支撐該 fixture 與 commit 的工程判斷，不能外推到公開生產。
