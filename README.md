# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adewahid/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adewahid/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one command-line tool that applies the edits AI models write, in four formats, to a tree of files. It reads a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON, finds the lines each edit names even when the model drifted their whitespace or indentation, and changes every file or none. `SPEC.md` is the whole specification.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone; nothing is installed. `PATCH` is the patch file, or standard input when it is absent or `-`. `--format` is `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects the format). `--check` does everything but write. `--strict` matches lines exactly. `node check.ts` runs the 100 public practice checks against `main.ts`.

---

Entered on [make.fun](https://make.fun/?ref=zsgcm8j7&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
