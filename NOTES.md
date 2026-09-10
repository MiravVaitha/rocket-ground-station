# Notes

Every problem hit and how it was solved, newest first.

Format:

```
## YYYY-MM-DD — Title
**Problem:** what broke or blocked progress
**Solution:** what fixed it, and why it worked
```

---

## 2026-09-10 - Map paints background but never loads a tile (UNRESOLVED)
**Problem:** The MapLibre basemap renders as a flat blue-grey field. The style, TileJSON and sprites all fetch 200 on
the main thread, the canvas is correctly sized, WebGL is available - but not one vector tile is ever requested, and
nothing is logged. Identical *symptom* to the Turbopack worker bug carried over from the previous project, but that one
announced itself with a MIME error in the console; this is silent.
**Ruled out, in order:** `react-map-gl` (it also threw "Invalid type: 'container' must be a String or HTMLElement" from
`Maplibre._initialize`, so it was removed entirely and the map is now driven through the MapLibre API directly - one
fewer dependency, and that error is gone); maplibre-gl version (6.4.0 and 6.9.0 have a byte-identical container check
and both fail); React StrictMode double-mount (fails the same in a production build); container sizing (a bare
416x296 map fails too); React itself (constructing a second map by hand in the page, with no React involved at all,
reproduces it exactly); worker file validity (`new Worker(url, {type:"module"})` on the vendored file loads clean -
only a *classic* worker rejects it, with "Cannot use import statement outside a module"); stale vendored copies
(md5 matches `node_modules`).
**Where it actually stops:** `Style.loaded()` returns false, which gates both the `load` event and all tile fetching:

    if (!this._loaded) return false;                                  // true
    if (Object.keys(this._updatedSources).length) return false;       // empty
    for (const id in this.tileManagers) if (!this.tileManagers[id].loaded()) return false;   // <- fails here
    return this.imageManager.isLoaded();                              // true

**Confirmed Turbopack incompatibility (necessary but not sufficient):** maplibre's `defaultWorkerUrl()` starts
`if (!/^https?:/.test(import.meta.url)) return ""`. Turbopack chunk URLs do not satisfy that, so MapLibre is handed an
empty worker URL and does `new Worker("")`, which fails silently. `setWorkerUrl("/maplibre-gl-worker.mjs")` (serving
maplibre's own worker from `public/`) fixes the URL and is kept - but on its own it does not make tiles load.
**Debugging lesson worth more than the bug:** MapLibre 6 renamed `Style.sourceCaches` to `Style.tileManagers`.
Probing for the old name returned `{}` and read as "no source caches were ever created", which sent the investigation
down the wrong path twice. When introspecting a library's internals, confirm the property name against that version's
source before drawing conclusions from its absence.
**Status:** everything else in the dashboard works. Track and marker rendering currently hang off the `load` event, so
they are also blocked; moving them to `styledata` would restore them independently of the basemap.

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
