# Trusted authority configuration

受控試點的 retention policy 與 provider-copy authority 是 immutable、可審核的治理記錄。它們應由指定 release custodian 從 deployment-controlled evidence store 匯入；repository 不保存真實私鑰、provider secret、signed URL 或學校帳號。

`provider-copy-authority-record.v1` 只描述 provider ID、manifest SHA-256、region、purpose、scope hash、lifecycle mode、有效期與 authority identity。唯一可接受的演示模式是 `no_persistent_copy_attested`，且必須有目前有效、未撤銷的 authority；這不是對 provider 真實行為的自動證明。

輪換要求 old/current/next key 的有效期不可有 gap，revoked 或 fixture key 不得進入 pilot trust set；signer key ID 必須存在於 allowlisted verifier set。私鑰只能由 owner-controlled secret file 以 `0600` 提供，不能透過瀏覽器 cookie、環境日誌或 API body 傳遞。測試 fixture 必須同時受 `NODE_ENV=test` 與明確 fixture flag 限制，production startup 應拒絕 fixture issuer／path。

Analytics Worker 另需要 deployment-controlled 的 `LO_ANALYTICS_PSEUDONYM_KEY`。
它只用於 TRACE student bundle 的房間／epoch scoped HMAC 節點代號；缺少或短於
16 個 UTF-8 字節時，Worker 會 fail closed，不會退回公開常量或可逆的 actor ID。
該值不可寫入 Git、日誌、報告、測試 fixture 或瀏覽器 payload，輪換時應建立新的
analysis epoch 並按資料治理流程處理舊投影。

Worker composition root 需要同時設定 `LO_WORKER_ASSERTION_PRIVATE_KEY_FILE`、
`LO_SERVICE_ASSERTION_ISSUER`、`LO_SERVICE_ASSERTION_KEY_ID` 與
`LO_INTERNAL_BASE_ORIGIN`。前者必須指向目前 process owner 所有、非 symlink、
mode `0600` 的 Ed25519 私鑰；issuer 與 key ID 必須對應 Fastify trust file 中的
公開 key record。`LO_INTERNAL_BASE_ORIGIN` 必須是經審查的 HTTPS Origin，或僅在
同機受控環境使用 loopback HTTP Origin；它不能包含 user info、path、query 或
fragment。Fastify 只接收公開 trust file，不能取得 Worker 私鑰路徑。
