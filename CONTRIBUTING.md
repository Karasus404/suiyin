# Contributing

Issues and pull requests are welcome.

## Ground rules

- Never commit real credentials. `.env` is ignored; copy `.env.example` and fill in your own values locally.
- Keep the runtime dependency-free. The function package is uploaded as-is and must run on a bare
  Node.js 18 runtime without `npm install`.
- Everything must keep working with `APP_STORE=memory` so the test suite stays offline.

## Before opening a PR

```bash
npm test                                  # 149 assertions, no network needed
for f in $(find . -name '*.js' -not -path './node_modules/*'); do node --check "$f"; done
git diff --check                          # no trailing whitespace
```

CI runs the same two commands on Node.js 18 and 20.

## Style

- CommonJS only (`require`), no build step.
- Two-space indent, single quotes, semicolons, 100-column soft limit.
- Comments explain *why*, not *what*. Chinese comments are fine; user-facing strings are Chinese
  because the product is used from WeChat.
- Any behaviour that depends on platform limits (the 5-second reply window, the `isGreater` /
  `isLess` date operators Feishu supports, cold-start cost) should be documented next to the code
  that depends on it.

## Commit messages

Imperative subject under 50 characters, body explaining the reason for the change. If a change
exists because of a non-obvious platform behaviour, put the observation in the body — it is usually
the most valuable part for the next reader.
