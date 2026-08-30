# Trusted authority configuration

受控試點的 retention policy 與 provider-copy authority 是 immutable、可審核的治理記錄。它們應由指定 release custodian 從 deployment-controlled evidence store 匯入；repository 不保存真實私鑰、provider secret、signed URL 或學校帳號。

`provider-copy-authority-record.v1` 只描述 provider ID、manifest SHA-256、region、purpose、scope hash、lifecycle mode、有效期與 authority identity。唯一可接受的演示模式是 `no_persistent_copy_attested`，且必須有目前有效、未撤銷的 authority；這不是對 provider 真實行為的自動證明。

輪換要求 old/current/next key 的有效期不可有 gap，revoked 或 fixture key 不得進入 pilot trust set；signer key ID 必須存在於 allowlisted verifier set。私鑰只能由 owner-controlled secret file 以 `0600` 提供，不能透過瀏覽器 cookie、環境日誌或 API body 傳遞。測試 fixture 必須同時受 `NODE_ENV=test` 與明確 fixture flag 限制，production startup 應拒絕 fixture issuer／path。
