# Gate 6 authority paperwork（範本與清單，不是記錄）

Gate 6 需要三份由人簽署的治理記錄：school／research ethics authorization、完成的
teacher shadow、以及獨立簽署的 student visibility promotion。工程只能提供格式、
檢查器與說明；三份記錄本身必須由有權限的人在 repository 之外決定並簽署。

**本目錄不含任何記錄。** 這裡的檔案是 Markdown 範本與清單。範本裡的每個值都是
`<<像這樣的佔位符>>`，任何一個都不符合 schema 的 pattern，所以一份未填的範本被
提交時會被拒絕，而不是被當成記錄接受（見
[verification walkthrough](../../runbooks/authority-verification.md#3-a-template-is-refused-as-a-record)）。

| 檔案 | 內容 | 語言 |
| --- | --- | --- |
| [`external-authorization-record.template.md`](external-authorization-record.template.md) | `external_authorization` 逐欄範本與拒絕碼 | English |
| [`human-shadow-record.template.md`](human-shadow-record.template.md) | `human_shadow_completed` 逐欄範本與拒絕碼 | English |
| [`student-visible-promotion-record.template.md`](student-visible-promotion-record.template.md) | `student_visible_promotion` 逐欄範本與拒絕碼 | English |
| [`checklist-school.md`](checklist-school.md) | 學校決策者需要看到與決定的事 | 中文／English |
| [`checklist-ethics-board.md`](checklist-ethics-board.md) | 研究倫理委員會需要看到與決定的事 | 中文／English |
| [`checklist-shadow-teacher.md`](checklist-shadow-teacher.md) | 執行 shadow 的教師需要看到與決定的事 | 中文／English |
| [`checklist-promotion-signer.md`](checklist-promotion-signer.md) | 學生可見性簽署人需要看到與決定的事 | 中文／English |
| [`../../runbooks/authority-signing.md`](../../runbooks/authority-signing.md) | Release custodian 的金鑰、trust set 與簽章程序 | English |
| [`../../runbooks/authority-verification.md`](../../runbooks/authority-verification.md) | 檢查一份已完成記錄、以及送進 release chain 的指令與失敗碼 | English |

範本與 signing／verification runbook 用英文寫，因為它們逐欄對應
`packages/contracts/schemas/*.json` 的英文欄位名與 `packages/contracts/src/governance.ts`
的英文拒絕碼，中英混排只會讓對照更難；四份決策清單用中文為主、英文術語並列，因為
讀它們的是學校、倫理委員會與教師。

## 三份記錄之間的關係

```
external_authorization        →  誰被允許進入哪些房間、多久、看得到哪些 surface
        │                        （沒有它，任何真實學生的 session 都不被允許）
        ├── human_shadow_completed   →  一位教師在沒有學生的房間裡實際觀察過 Nova
        │                                （沒有它，Gate 6 不放行）
        └── student_visible_promotion →  學生可否看到由自己對話產生的分析
                                          （沒有它，ECHO／TRACE 對學生永遠關閉）
```

三者不是三個階段，而是三個獨立決定。promotion 明確不得從 shadow 推導
（`derivedFromShadowRecord: true` 被拒），也不得由執行 shadow 的同一人簽署
（`PROMOTION_DECIDED_BY_SHADOW_TEACHER`）。

## 目前狀態

三份記錄一份都不存在。`pnpm verify:pilot` 在沒有 `--trust`／`--authority` 時，
會把三份都印成 `NOT HELD`，並把 release 標為
`PASS (engineering evidence only)` —— 這正是一個不持有任何人類授權的 release
應該說的話（`scripts/verify-release-evidence.mjs:98-118`）。

工程不能替任何一份簽名，也不能加上跳過驗證的旗標。
