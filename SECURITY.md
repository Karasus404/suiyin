# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities)
("Report a vulnerability" on the repository's Security tab) instead of opening a public issue.

Expect an initial reply within a few days. Please include the affected version, the request or
configuration needed to reproduce it, and what an attacker gains.

## What this project handles

- Message envelopes containing user chat text (`Content`) and platform identifiers.
- AES-256-CBC secrets (`AESKey`), signature tokens, and Feishu app credentials, all supplied through
  environment variables.

## Deployment responsibilities

The code verifies the platform signature on every request and compares it in constant time, but the
operator is responsible for:

- Keeping `.env` out of version control and out of any uploaded artefact.
- Treating the function URL as public surface: signature verification is the only access control.
- Restricting the Feishu app to the minimum table it needs, and rotating `App Secret` if it leaks.
- Not logging message bodies into third-party services beyond the platform's own log retention.

The reply body is generated from user input and sent back through the platform XML envelope; the
`Content` field is CDATA-escaped, so a message containing `<`, `>`, `&` cannot break the envelope.
