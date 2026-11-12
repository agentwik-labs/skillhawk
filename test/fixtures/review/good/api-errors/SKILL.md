---
name: api-errors
description: Shapes HTTP API error responses as problem+json. Use when adding or reviewing an endpoint's error handling, or when the user says "return an error" or "fix the 400 response".
license: MIT
---

# API errors

Return `application/problem+json` for every non-2xx response. The body has `type`, `title`, `status` and `detail`.

## Rules

- Use 422 for validation failures and 409 for version conflicts; never use 200 with an error body.
- Put field errors in an `errors` array of `{pointer, message}`.
- Keep `detail` free of stack traces and internal hostnames.

## Example

```json
{"type": "https://example.com/errors/validation", "title": "Invalid email", "status": 422, "detail": "email must contain @", "errors": [{"pointer": "/email", "message": "missing @"}]}
```

See [the status table](references/status.md) for the full list.
