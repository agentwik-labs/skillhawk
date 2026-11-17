# The public index

Every Monday a GitHub Actions job (`.github/workflows/index.yml`) clones each repository in
`sources/community.json` at its latest commit, grades every skill with `skillhawk review` and checks it with
`skillhawk secure`, and commits the result to `data/index/`:

- `data/index/<date>.json`: that week's snapshot (each skill's repository, path, commit, grade, score, token
  estimate, and finding counts and rule names from both checks).
- `data/index/latest.json`: the newest snapshot.
- `data/index/CHANGES.md`: what changed each week (grade changes, new security findings, skills added or removed).

It is deterministic and makes no model calls. Only Skillhawk's own findings and public metadata are recorded; no
skill text is copied. Because each snapshot is a commit, the repository's git history dates every result.

Run it yourself: `node tools/index-snapshot.mjs --out /tmp/index`.
