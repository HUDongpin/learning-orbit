# 清單：學校授權決策 School authorization checklist

Gate：`external_authorization`（與倫理委員會共用同一份記錄）
決定人：學校有權簽署的人員
本頁不是記錄，也不是同意書；簽署程序見
[external-authorization-record.template.md](external-authorization-record.template.md)。

---

## A. 決定前必須看到的東西 What must be in front of you

| # | 文件／事實 | 來源 | 為什麼 |
| --- | --- | --- | --- |
| A1 | Threat model（威脅模型） | [`docs/security/threat-model.md`](../../security/threat-model.md) | 記錄裡要填它的 SHA-256；文末已寫明「本文件只證明工程控制與測試邊界，不代表正式安全認證、未成年人合規、供應商合約或學習成效證據」 |
| A2 | 資料盤點 Data inventory | [`docs/privacy/data-inventory.md`](../../privacy/data-inventory.md) | 逐類說明哪些資料存在、保留多久、刪除時做什麼 |
| A3 | Retention policy 記錄 | 由 `pnpm governance:import-policy` 匯入的已簽署記錄 | 記錄裡的 `retentionPolicyId` 必須是這一版 |
| A4 | 給家長／學生的資訊單張 | 學校自備 | 記錄裡填它的 SHA-256（`informationSheetSha256`） |
| A5 | Provider manifest 與其 SHA-256 | 部署方提供 | 課堂文字會離開本機送到該 provider；`region` 與 `purpose` 必須是您看過的那一份 |
| A6 | 房間清單、人數上限、時間窗 | 工程提供 room UUID，上限與時窗由您決定 | 沒有萬用字元：清單以外的房間就是未授權 |

## B. 您要決定的事 What you are deciding

- [ ] **B1 範圍**：哪些 `roomIds`、每間最多幾人（`maxStudentsPerRoom`，1–40）、全體最多幾人（`maxStudentsTotal`，1–400）。每間上限不得大於全體上限，否則被拒為 `AUTHORIZATION_SCOPE_UNBOUNDED`。
- [ ] **B2 時間窗**：`sessionsFrom` 到 `sessionsUntil`，兩端都要關上，且不得超過 180 天 —— 超過就不是試點，是常設許可。
- [ ] **B3 同意**：`consentPath` 是家長書面同意，或家長＋學生書面同意；`consentObtainedBy` 不得晚於 `sessionsFrom`，否則被拒為 `AUTHORIZATION_CONSENT_NOT_OBTAINED_BEFORE_SESSIONS`。
- [ ] **B4 開放哪些介面**：`featureAllowlist` 從 `room_chat`、`media_upload`、`agent_nova`、`teacher_analytics`、`teacher_export` 中挑。**學生可見的 ECHO／TRACE 不在這份記錄的詞彙裡**，那是另一份簽署決定。
- [ ] **B5 人**：`supervisingTeacherRef`（現場督導教師）、`rollbackOwnerRef`（誰可以喊停）、`incidentContactRefs`（1–5 位事故聯絡人）。
- [ ] **B6 分析不得用於評分或紀律**：`usedForGradesOrDiscipline` 必須是 `false`；填 `true` 會被拒。

## C. 您**不能**在這份記錄裡決定的事 Out of scope

- 學生能否看到由自己對話產生的分析 →
  [`checklist-promotion-signer.md`](checklist-promotion-signer.md)
- 系統是否已準備好面對學生 →
  [`checklist-shadow-teacher.md`](checklist-shadow-teacher.md)
- provider 憑證與資料處理審查 →
  [`docs/runbooks/model-provider.md`](../../runbooks/model-provider.md)

## D. 請先問清楚的問題 Questions to ask before signing

1. **簽署人是否也在運作這個試點？** 若授權機構本身、或其列名簽署人，同時是督導教師、rollback owner 或事故聯絡人，記錄會被拒為 `AUTHORIZATION_SELF_ISSUED`。這不是技術限制，是「自己批准自己」的定義。
2. **刪除收據代表什麼？** 只代表已核准的線上資料面不可讀。不可見的 immutable backup 不會被宣稱已立即移除（[data-inventory.md](../../privacy/data-inventory.md) 末段）。
3. **Provider 的 copy mode 是哪一個？** 本 build 只實作 `no_persistent_copy_attested`；寫 `delete_and_probe` 的授權可以通過契約檢查，但 worker 會以 `AGENT_PROVIDER_MANIFEST_COPY_MODE_UNIMPLEMENTED` 拒絕該 manifest。
4. **Nova 壞掉會怎樣？** 課堂不依賴 Nova：聊天、事件帳本、投影與刪除都照常，房間會回 503 並說明（[nova-outages.md](../../runbooks/nova-outages.md)）。
5. **這份試點證明了什麼？** 只證明系統可運作。不證明學習成效、多校規模的生產就緒、服務可用性，或任何關於個別學生的結論。

## E. 簽完之後 After you sign

記錄由 release custodian 在 repository 之外以 Ed25519 簽章封裝
（[authority-signing.md](../../runbooks/authority-signing.md)），再由操作者用
`pnpm verify:authority --record … --trust …` 檢查
（[authority-verification.md](../../runbooks/authority-verification.md)）。
擴大範圍——多一間房、多一週、多一個介面——需要**新的**簽署決定，因為這份記錄
沒有可以「讀寬一點」的地方。
