## Summary

## Root cause

What failed, and why this change stops that class of failure.

## Regression test added

The test that fails on the old code. Name the file.

## Invariant or check added or updated

The guard that stays red if this comes back: unit assertion, schema rule, soak invariant, data guard, network guard, or preflight check.

## Test plan

- [ ] `npm test`
- [ ] `npx tsc --noEmit`
- [ ] `npm run test:soak -- --ci` when the ladder client or game records changed
