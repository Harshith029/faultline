## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem this solves. -->

## Verification

- [ ] `npm test` passes
- [ ] `npm run verify:engine` passes
- [ ] Added or updated tests for the behaviour change

## Detection changes only

Delete this section if the change does not affect what fires.

- [ ] `npm run benchmark` numbers included below, before and after
- [ ] Compared at **matched alert volume** (a more sensitive detector is not a better one)
- [ ] Reported **per machine**, not only aggregate

```
before:
after:
```

## Invariant

- [ ] Detection remains deterministic and reproducible by hand. AI explains; it never decides.
