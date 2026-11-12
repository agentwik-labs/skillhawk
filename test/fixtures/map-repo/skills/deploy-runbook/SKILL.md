---
name: deploy-runbook
description: Deploys the shop to production with a rollback plan. Use when shipping a release.
---

# Deploy runbook

## Preflight
Check CI is green.

## Rollback
Revert the release tag and redeploy.

```
## not a heading
```

## Notify
Post in the channel.
