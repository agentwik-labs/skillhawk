---
name: commit-style-a
description: Writes git commit messages in conventional commit format. Use when the user says "write a commit message" or "commit these changes".
license: MIT
---

# Commit style

Write the subject line in the imperative mood, at most 50 characters, with a type prefix such as feat, fix or docs. Separate the subject from the body with a blank line. Explain why the change was made in the body, wrapped at 72 characters. Reference the issue number in the footer when one exists.

```
fix(auth): reject expired refresh tokens

Expired tokens were accepted for up to a minute because the clock check used the wrong field.
```
