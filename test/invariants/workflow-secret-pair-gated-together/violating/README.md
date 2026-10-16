# violating fixture — the real thing

`.github/workflows/cache.yml` is copied verbatim from
`file-explorer@e85802280f8957849e6ecd4a63e2f9d9974ce856` (the parent of the
R3-635 fix), one of the repos named on the 34 escaped findings-log rows
dated 2026-09-15 (escape-classification record E01). Its line 100 —
`if: ${{ env.DEPLOY_APP_ID != '' }}` — gates the Pages-token mint on the id
alone, which is exactly the defect this invariant exists to catch.
