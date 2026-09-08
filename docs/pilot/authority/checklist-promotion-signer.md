# 清單：學生可見性簽署人 Promotion signer checklist

Gate：`student_visible_promotion`
決定人：`school_authority`、`research_ethics_board`，或
`designated_release_custodian` —— 但**不得**是執行 shadow 的那位教師
欄位定義：[`student-visible-promotion-record.template.md`](student-visible-promotion-record.template.md)

---

## A. 您在回答的是第二個問題 The second question

- 第一個問題：「在只有一位成人的房間裡，Agent 表現得可以接受嗎？」→ shadow
- 第二個問題：「學生可以看到由自己對話產生的分析嗎？」→ 這份記錄

兩者不同。契約以兩條規則把它們分開：

- [ ] **A1** `derivedFromShadowRecord` 必須是 `false`。記錄自陳是從 shadow
  推導而來就會被拒（`PROMOTION_INFERRED_FROM_SHADOW`）。
- [ ] **A2** `decidedBy.deciderRef` 不得等於 `shadowTeacherRef`
  （`PROMOTION_DECIDED_BY_SHADOW_TEACHER`）。一個人同時回答兩個問題時，
  第二個往往是被慣性回答的。

> 這兩條只比對摘要是否相等。整個試點必須使用同一套加鹽與同一種輸入格式，
> 否則同一個人會產生兩個不同摘要，A2 就永遠不會觸發。

## B. 您要看到的東西 What must be in front of you

- [ ] **B1 已驗證的 external authorization**（不是它的重述）。您要親自核對
  `authorizedFrom`／`authorizedUntil` 與該記錄的 `scope.sessionsFrom`／
  `sessionsUntil` 相同，且本記錄的 `roomId` 出現在它的 `scope.roomIds` 裡。
- [ ] **B2 已驗證的 shadow 記錄**，以及它的 `verdict`、`conditions` 全文。
- [ ] **B3 兩份記錄檔案的 SHA-256**，用來填 `externalAuthorizationRecordSha256`
  與 `shadowRecordSha256`：

  ```bash
  shasum -a 256 /secure/authority/external-authorization.json
  shasum -a 256 /secure/authority/human-shadow.json
  ```

  **沒有任何程式會替您核對這兩個摘要。** 契約只檢查格式是 64 個小寫十六進位
  字元；repository 裡沒有任何地方重算或比對它們。這一步只有人做得到。

## C. 您要決定的事：學生會看到什麼 What the student will see

`studentProjectionKeys` 明文列出，零個、一個或兩個都要寫出來 ——
空陣列是「維持只有聊天」的決定，而沒有這個欄位不是決定。

| key | 學生看到什麼 |
| --- | --- |
| `echo.student_approved` | 房間的概念圖，且僅限教師已核可的版本。學生版的 patch 只有數量與變動分數，**沒有 `evidenceRefs`** —— 學生視圖無法回指是誰說了哪一段 |
| `trace.student_bundle` | 兩個時間窗（最近 10 分鐘、45 分鐘 session）的互動聚合，三種視圖（`observed`、`human_only`、`lineage_adjusted`），並固定附上一句說明：此圖不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果 |

- [ ] **C1** 兩個都給，比只給一個是更大的決定。
- [ ] **C2** `usedForGradesOrDiscipline` 必須是 `false`
  （`PROMOTION_USED_FOR_GRADES_OR_DISCIPLINE`）。
- [ ] **C3** 若 shadow 的 `verdict` 是 `not_ready`，`studentProjectionKeys`
  必須是空的（`PROMOTION_CONTRADICTS_SHADOW_VERDICT`）。

## D. 時間窗 The window

- [ ] **D1** `startsAt` 不早於 `authorizedFrom`，`expiresAt` 不晚於
  `authorizedUntil`（`PROMOTION_SCOPE_EXCEEDS_AUTHORIZATION`）。
- [ ] **D2** `decidedBy.decidedAt` 不晚於 `startsAt`
  （`PROMOTION_DECISION_OUT_OF_ORDER`）。
- [ ] **D3** 這是**單一房間**的決定。要涵蓋另一間房，就是另一份簽署記錄。

## E. 撤回路徑必須是真的能動的 The revocation path

`revocation.maxLatencyMinutes`（1–1440）不得長於 `startsAt`→`expiresAt` 這段
窗本身，否則被拒為 `PROMOTION_REVOCATION_PATH_INEFFECTIVE` ——
比它所撤回的授權還慢的撤回，是承諾，不是路徑。

在寫下這個數字之前，請確認機制存在：

- 持久化的授予與撤回在
  `apps/server/src/modules/lifecycle/student-analytics-promotion.ts`
  （`grant` 在 `:101`，`revoke` 在 `:134`）。撤回是加上 revision 的墓碑而非刪除，
  所以遲到的通知不會被誤認成新的授予。
- **本 repository 沒有任何 HTTP route 或 CLI 會呼叫它們。** 服務目前只被接上
  讀取路徑（`apps/server/src/app.ts:247-251`）。若您選 `operator_revoke_command`，
  請要求部署方指出具體機制，並實測一次所需時間。

契約只會檢查那個數字比窗小。**簽下一個部署做不到的延遲，是這份記錄唯一抓不到的
錯誤。**

## F. 預設是拒絕 Default deny

沒有這份記錄、或它已過期、已撤回，學生就什麼分析都看不到 ——
房間沒有有效列時，允許清單是空集合。所以「不簽」是一個安全、完整、隨時可以
維持的狀態，而不是待辦事項。
