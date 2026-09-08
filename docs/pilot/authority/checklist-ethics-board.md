# 清單：研究倫理委員會 Research ethics board checklist

Gate：`external_authorization`（與學校共用同一份記錄；`bodyKind` 可以是
`research_ethics_board`，或與學校聯名的 `school_and_research_ethics_board`）
決定人：委員會有權簽署的委員
本頁不是記錄。欄位定義見
[external-authorization-record.template.md](external-authorization-record.template.md)。

---

## A. 受試者是未成年人 The participants are minors

這是一個真實課堂的受控試點，參與者是學生。以下三件事在記錄裡是**硬性欄位**，
不是政策宣示：

- [ ] `usedForGradesOrDiscipline` 必須為 `false`。填 `true` 會被
  `AUTHORIZATION_USED_FOR_GRADES_OR_DISCIPLINE` 拒絕。
- [ ] `consentObtainedBy` 不得晚於 `sessionsFrom`。同意必須在第一次 session
  之前就已取得。
- [ ] `scope` 的每一個維度都要寫死：房間逐一列出、人數上限有數字、時間窗兩端
  都關上、且不超過 180 天。

## B. 委員會需要看到的文件（記錄以 SHA-256 綁定）

| # | 文件 | `documentKind` | 備註 |
| --- | --- | --- | --- |
| B1 | [Threat model](../../security/threat-model.md) | `threat_model` | 明列信任邊界與六類威脅的控制；文末自陳不代表安全認證或未成年人合規 |
| B2 | [資料盤點](../../privacy/data-inventory.md) | `data_inventory` | 逐類資料的目的、擁有者、保留與刪除行為 |
| B3 | Retention policy 記錄 | `retention_policy` | 與 `retentionPolicyId` 指向同一版本 |

三種 kind 各**恰好一筆**，多一筆少一筆都會被
`AUTHORIZATION_REVIEWED_DOCUMENTS_INCOMPLETE` 拒絕；每筆的 `reviewedAt` 不得
晚於 `decidedAt`（先讀，後決定，再執行），否則 `AUTHORIZATION_DECISION_OUT_OF_ORDER`。

> 摘要不能取代原件：`documentSha256` 綁的是委員會實際讀過的那一版位元組。
> 這幾份文件在 repository 裡會隨 commit 變動，請在委員會自己的存檔上同時記下
> commit sha。

## C. 資料最小化與去識別 Data minimisation

- [ ] **記錄裡沒有姓名。** 每個 `*Ref` 欄位都是加鹽 SHA-256 摘要（64 個小寫
  十六進位字元）。身分與摘要的對照表由授權機構自己保管，不進 repository。
- [ ] **分析與日誌不含內容。** 稽核日誌以加鹽 room reference 表示房間，不寫
  原文、IP、cookie、URL 或 provider payload。
- [ ] **教師匯出是 bounded 的**，且只限本人房間；學生與跨房間教師一律收到
  一致的 `404`，避免資源存在性洩漏。

## D. 資料離開本機的那一段 The provider hop

- [ ] `providerScope` 指名 provider ID、manifest SHA-256、`region` 與
  `purpose`，且不含任何 URL、endpoint 或密鑰。
- [ ] 本 build 僅實作 `no_persistent_copy_attested`；它是**帶有效期的證明**，
  不是對 provider 真實行為的自動驗證（[trusted-authority-configuration.md](../trusted-authority-configuration.md)）。
- [ ] 該證明的 `copyAuthorityExpiresAt` 不得早於 `sessionsUntil`，否則最後幾次
  session 等於在沒有任何證明的情況下執行（`AUTHORIZATION_PROVIDER_SCOPE_MISMATCH`）。

## E. 刪除承諾的邊界 What deletion actually promises

刪除收據只表示「已核准的 storage／provider manifest 覆蓋的線上資料面不可讀」。
不可見的 immutable backup **不會**被宣稱已立即移除，收據也不能用來回復房間內容。
請把這句話當成研究參與者資訊單張的一部分，而不是工程細節。

## F. 主張上限 Claim ceiling

委員會應把以下寫進決議，因為系統自己也是這樣宣稱的
（[Completion Plan](../../plans/Learning%20Orbit%20Completion%20Plan.md)）：

- 完成全部工程任務只證明系統可運作；**不**證明學習成效、多校規模的生產就緒或
  服務可用性。
- ECHO-CM 與 TRACE-AI 是原創工程綜合，**尚未經同行評審**。
- 任何投影都不構成對個別學生的能力、人格、心理狀態或成績的推論。
- 沒有任何合成排演、也沒有任何綠色測試輸出，可以取代 Gate 6 的三份人類簽署記錄。

## G. 簽署前的獨立性檢查 Independence

若委員會本身、或其列名簽署人，同時是督導教師、rollback owner 或事故聯絡人，
記錄會被拒為 `AUTHORIZATION_SELF_ISSUED`。這條檢查只比對摘要是否相等，
因此**整個試點必須使用同一套加鹽與同一種輸入格式**；否則同一個人會產生兩個
不同摘要，而這條檢查就永遠不會觸發（見
[範本 §3](external-authorization-record.template.md#3-the-salted-digests-and-the-trap-in-them)）。
