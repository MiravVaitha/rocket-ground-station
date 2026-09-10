# Notes

Every problem hit and how it was solved, newest first.

Format:

```
## YYYY-MM-DD — Title
**Problem:** what broke or blocked progress
**Solution:** what fixed it, and why it worked
```

---

## 2026-09-10 — Heredoc broke on prose containing apostrophes
**Problem:** Writing `CLAUDE.md` through a `cat > file <<'EOF'` heredoc in the Bash tool failed with `unexpected EOF while looking for matching '`. The quoted delimiter should have suppressed all expansion, so apostrophes in ordinary prose ("MapLibre's", "don't") should have been inert.
**Solution:** Wrote the file with the editor tool instead. Heredocs stay fine for short, code-shaped content; long English prose goes through a file write. Worth remembering before the README and the two walkthrough doc comments, which are the largest prose blocks left in this project.
