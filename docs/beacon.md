# Beacon mark layer (leaks that call home)

**Needs legal review before enabling. Disclose it in your employee policy.** It is off by default.

## What it does

Skillyard already marks every delivered copy of a private skill with invisible tags, wording choices and a canary example. The optional `beacon` layer adds one more thing: a single line inside the illustrative Example section of the copy:

    Reference: <vault-base-url>/r/<opaque-token>

The token is derived from the org secret and is meaningless on its own. The vault stores, server-side, which recipient, skill and version it was issued for. The line does not change any instruction, threshold or rule.

If someone opens that link (for example because a leaked copy is posted somewhere and a reader or tool follows it), the vault answers with a neutral text page: "Reference material moved; contact the owner." and records an alert.

## What is collected

For a known token, one alert holding only:

- time of the request
- the token's recipient, skill and version (looked up server-side, not sent by the requester)
- requester IP address as seen by the vault
- User-Agent header
- Referer header

Nothing else: no cookies, no fingerprinting, no scripts, no content from the requester's machine. Unknown tokens record nothing and get the same neutral page. Requests are rate-limited (20 per minute per IP). Alerts and the matching `beacon.hit` audit entry are stored in the vault's data directory. Review the retention you need for IP addresses under your privacy rules.

## What it is not

- It is not proof of who leaked a file. A hit shows that a copy bearing a given token was opened somewhere, possibly by someone other than the recipient. Treat it as a lead, alongside the other mark layers and the pull history (`skillyard evidence`).
- It does not run code on anyone's machine and does not prevent copying.
- It can be stripped or ignored, and some agents will never fetch it.

## Turning it on

    skillyard org settings acme --beacon on --i-have-legal-review

Without `--i-have-legal-review` the command refuses. The vault must know its public base URL: set `SKILLYARD_PUBLIC_URL` (otherwise the request's Host header is used). Copies delivered before enabling carry no beacon. Turn it off with `--beacon off`; tokens already issued keep working so past copies still resolve.

List hits with `skillyard alerts [--org acme]` (run on the vault host, against its data directory).

## Before you enable it

Have counsel confirm that collecting an IP address, User-Agent and Referer from people who open the link is acceptable in every jurisdiction you operate in (for example GDPR and ePrivacy in the EU, state privacy laws in the US), what lawful basis and retention apply, and what the employee policy or contract must say. Tell employees and contractors who receive skills that copies carry per-person marks and a reference link, and what happens when it is fetched. Skillyard does not provide legal advice.
