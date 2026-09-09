# FM-PS-LYNX-011 item A — triage of #19, #20, #21

Status: ready-for-human (paste comments; none of the three closes)

Surveyed `main` @ `442ec6f` (post-#32). The GitHub Issues API returns 403 for the
agent integration on this repo (read and write), so the comments below are
paste-ready files instead of posted comments. Issue bodies were reconstructed
from their titles plus the FM-PS-LYNX-007 / -010 scratch notes that cross-link
them (`.scratch/architecture-review/issue-18-comment.md` on
`drkz/fm-ps-lynx-007-arch-review-edab`, PR #33).

| Issue | Verdict | Close? | Paste file |
|---|---|---|---|
| #19 `hasSynced` / sync status UX | partially done | no | `issue-19-comment.md` |
| #20 `waitForReady` vs first-sync helpers | partially done | no | `issue-20-comment.md` |
| #21 `streamingId` regression + README | partially done | no | `issue-21-comment.md` |

Verified on the surveyed tree (Node 22.22): `pnpm test` 92/92, `pnpm typecheck`
clean, `pnpm lint` clean, Linux `make test` green (ps_sql + NDJSON fixture replay).
