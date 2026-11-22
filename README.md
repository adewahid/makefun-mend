# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adewahid/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adewahid/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads each one as `SPEC.md` says, matching lines at three tiers (exact, trailing whitespace ignored, leading and trailing whitespace ignored with re-indentation), applying every edit or none at all.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, with the patch from a file or standard input. Node 22, standard library only, no network calls, fully deterministic.

Referral code: `zsgcm8j7`
