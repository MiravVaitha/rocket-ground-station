# Notes

Every problem hit and how it was solved, newest first.

Format:

```
## YYYY-MM-DD — Title
**Problem:** what broke or blocked progress
**Solution:** what fixed it, and why it worked
```

---

## 2026-09-10 - Apogee detector never fired: `map` cannot see its own output
**Problem:** `detectApogee` returned null on all six fixtures. The walk that tracks arming and the consecutive-descent
run was built with `.map()`, reading the previous element as `smoothedInput[i - 1]` - the smoothed *input* array, whose
elements are only `{t_s, alt_m}`. So `prev.count` was `undefined`, `undefined + 1` was `NaN`, and `NaN >= confirmRun` is
false forever. `prev.armed` was `undefined` too, which quietly reduced arming to "is this sample above the threshold
right now" instead of "has it ever been", so it would also have disarmed on the way back down.
**Solution:** a `for` loop carrying `armed` and `run` as local state. `.map()` builds a new array but every callback
sees only the input, so any running accumulator has to be a loop or a fold, never a map. `tsc --noEmit` flagged both
lines as TS2339 - worth running before the harness, since a type error here presents as a silent wrong answer.

## 2026-09-10 — Heredoc broke on prose containing apostrophes
**Problem:** Writing `CLAUDE.md` through a `cat > file <<'EOF'` heredoc in the Bash tool failed with `unexpected EOF while looking for matching '`. The quoted delimiter should have suppressed all expansion, so apostrophes in ordinary prose ("MapLibre's", "don't") should have been inert.
**Solution:** Wrote the file with the editor tool instead. Heredocs stay fine for short, code-shaped content; long English prose goes through a file write. Worth remembering before the README and the two walkthrough doc comments, which are the largest prose blocks left in this project.
