# stats

This branch holds the generated repository-statistics card required by
criterion [`P09`](https://github.com/trsdn/.github/blob/v1.21.0/docs/repository-quality-standard.md#p09).
It is written only by [`.github/workflows/stats.yml`](https://github.com/trsdn/agent-trestle/blob/main/.github/workflows/stats.yml)
on `main`, on a schedule. Do not edit this branch by hand.

Bootstrapped empty on 2026-09-22 because the workflow's checkout step cannot
create a target branch that does not exist yet; the first scheduled or
dispatched run after this commit populates `.github/stats/`.
