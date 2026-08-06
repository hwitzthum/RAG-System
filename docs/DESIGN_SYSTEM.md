# Rautaki Design System — Application Implementation

> Strategy · Advisory · Growth

This document describes how the Rautaki corporate design is implemented in the RAG Workspace
application. It is the reference for anyone adding UI: **read this before writing a component.**

The design language is editorial, rectilinear and restrained — the precision of a consultant's memo.
Everything below exists to serve three qualities: **clarity, decisiveness, weight.**

Nearly the entire system lives in `app/globals.css`. Components consume semantic classes; they do
not invent colours, radii or type sizes.

---

## 1. Palette

These are the only colours in the Rautaki universe. **Never introduce another hue.** They are
declared once as brand constants in `app/globals.css` under `:root`.

| Name       | Hex       | Role                                                 |
| ---------- | --------- | ---------------------------------------------------- |
| Gold       | `#f5a623` | Brand accent — the only warm colour. Used sparingly. |
| Gold Light | `#ffd07a` | Hover states, tints                                  |
| Obsidian   | `#0a0a0a` | Dark surfaces — page ground in the Obsidian theme    |
| Ink        | `#1c1c1c` | Body text on light surfaces; card ground when dark   |
| Cream      | `#f4f2ee` | Default page ground                                  |
| White      | `#fafafa` | Clean surfaces                                       |
| Warm Grey  | `#e8e5df` | Secondary/inset surfaces                             |
| Mid Grey   | `#9a9590` | Captions, meta, labels, muted text                   |

### Themes

The brand is a single identity. `Cream` and `Obsidian` are its light and dark **renderings**, not
alternative palettes — both carry the same gold accent. Defined in `lib/theme.ts`; the ids stay
`light` / `dark` because they drive the `[data-theme=…]` selectors and `color-scheme`.

|                   | Cream (`light`)      | Obsidian (`dark`)       |
| ----------------- | -------------------- | ----------------------- |
| page              | `#f4f2ee`            | `#0a0a0a`               |
| surface           | `#fafafa`            | `#1c1c1c`               |
| surface muted     | `#e8e5df`            | `#0a0a0a`               |
| text primary      | `#1c1c1c`            | `#fafafa`               |
| text secondary    | `rgba(28,28,28,.66)` | `rgba(255,255,255,.45)` |
| text muted        | `#9a9590`            | `rgba(255,255,255,.28)` |
| border / hairline | `rgba(28,28,28,.10)` | `rgba(255,255,255,.10)` |
| accent            | `#f5a623`            | `#f5a623`               |

---

## 2. The Gold Rule — and how the token layer enforces it

**One gold element per visual unit.** Gold is precious because it is rare. Gold is never a
large-area background.

This is the single hardest rule to hold in an application, because a typical UI token layer maps
_everything_ interactive to one accent colour — buttons, links, active tabs, badges, checkboxes,
hover borders. Mapping gold onto that would put eight gold marks in one viewport.

So the tokens split in two:

| Token group   | Value           | Used for                                                                                                     |
| ------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `--accent`    | Gold `#f5a623`  | primary button, active tab underline, active-turn left border, section-label rules, wordmark a/i, focus ring |
| `--emphasis*` | Ink / Warm Grey | hover borders, quiet fills, secondary badges, checkbox accent, link colour, selected-row tints               |

Concretely demoted from gold to ink: `.badge-accent`, `.link-accent` (gold appears only as a hover
underline), `.check-accent`, and `.surface-accent` — which keeps its 3px gold left border but has
**no gold fill**, because a tinted background cannot be rationed.

> `--accent` must keep its name and stay a literal hex. `tests/e2e/auth.spec.ts` reads
> `getComputedStyle(...).getPropertyValue("--accent")` and compares an exact string — no `oklch()`,
> no `color-mix()` on that token.

**A visual unit is a bordered section or panel, not the whole screen.** A left rail containing a
primary button and two sections legitimately shows three gold marks — one per unit.

---

## 3. Typography

| Font                | Role                                              | Weights       |
| ------------------- | ------------------------------------------------- | ------------- |
| **Georgia** (serif) | Headings, wordmark, statistics, pull quotes       | 400 **only**  |
| **DM Sans**         | Body, labels, nav, captions, all UI               | 300, 400, 500 |
| JetBrains Mono      | Chunk IDs, JSON, `<pre>` — _documented exception_ | 400           |

Georgia is a system font and needs no loader; it is declared as `--font-serif`. DM Sans is loaded in
`app/layout.tsx` via `next/font/google`. **Georgia is never bold** — the display classes pin
`font-weight: 400`.

### The Kerning Rule

Georgia was drawn for body-size rendering and reads optically loose at display sizes. Every display
step carries negative tracking. Use the classes — never hand-roll a heading.

| Class              | Size | Tracking | Leading |
| ------------------ | ---- | -------- | ------- |
| `.display-hero`    | 88px | -0.04em  | 1.0     |
| `.display-1`       | 64px | -0.03em  | 1.0     |
| `.display-2` (h1)  | 48px | -0.03em  | 1.15    |
| `.display-3` (h2)  | 36px | -0.02em  | 1.15    |
| `.display-4` (h3)  | 26px | -0.015em | 1.15    |
| `.display-5` (h4)  | 20px | -0.01em  | 1.25    |
| `.display-console` | 17px | -0.01em  | 1.3     |

Body copy is DM Sans 15px / 1.75.

### Gold Italic Emphasis

The brand's signature typographic gesture: **1–2 italic gold words inside a serif heading**, via
`.gold-italic`. Never italicise a whole heading; never use it in body copy.

```tsx
<p className="display-3">
  Ask about your <span className="gold-italic">documents</span>
</p>
```

### Labels

Every section label, tag, nav item and caption shares one pattern — `.label-caps`:
DM Sans 500 / 11px / `letter-spacing: 0.20em` / uppercase / Mid Grey.

---

## 4. Sharp edges

**Zero border-radius on everything.** The brand is rectilinear. `--radius-sm/md/lg/xl` are all `0`,
and no component uses a `rounded-*` utility. Badges are sharp tracked-caps tags, not pills.

Depth comes from **hairlines and surface value — never shadow**. There are no `box-shadow`s and no
`backdrop-filter: blur()` anywhere in the application.

Spacing runs on a 4px grid.

---

## 5. Pattern library

All defined in `app/globals.css`.

| Class                                          | What it is                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `.section-label`                               | 28px gold rule + 14px gap + tracked caps. **One per bordered section.**  |
| `.section-label-sub`                           | Same, with a 16px grey rule. Every nested heading, so gold stays rare.   |
| `.rule-gold`                                   | 3px gold→transparent gradient. Section boundaries.                       |
| `.rule-hair`                                   | 1px `--border`. Within sections.                                         |
| `.stat-accent` / `.stat-value`                 | 2px gold left border + Georgia numeral. Statistics.                      |
| `.seam-grid`                                   | The distinctive 2px "seam" card grid.                                    |
| `.card-hover-accent`                           | 3px gold left border revealing top→bottom over 400ms.                    |
| `.gold-italic`                                 | The emphasis gesture.                                                    |
| `.callout` + `-success/-warning/-danger/-info` | Left-bordered notice block. Replaces tinted banners.                     |
| `.badge-active`                                | Filled gold. **Selection state only** — "this item is currently chosen". |
| `.btn-solid`                                   | Filled ink/white primary for secondary regions — see below.              |
| `.disclosure-summary`                          | `<details>` row with a sharp chevron, for collapsed advanced settings.   |

### Two primaries

`.btn-primary` is gold and marks the **view's** leading action — one per view, not one per panel.
A sub-panel that also needs a leading action (advanced settings, a BYOK vault, a nested form) uses
`.btn-solid`: filled ink on Cream, filled white on Obsidian — both approved pairings, a strong
affordance, and no competition with the gold. Three gold "Save" buttons stacked in a settings rail
is the failure this prevents.

Button labels are tracked caps and set `white-space: nowrap`. Tracked caps are wide; a two-word label
wrapping to a second line breaks the button box out of narrow containers. Size the container to the
label, or shorten the label — never let it wrap.

Focus is a 2px solid gold outline at 2px offset — sharp, transient, and the one place gold is never
rationed, because only one element is focused at a time.

---

## 6. The wordmark

`components/brand/rautaki-wordmark.tsx`. "Rautaki" in Georgia Regular; the **second `a`
(position 5)** and the **`i` (position 7)** are gold. Sizes: `xl` 56px, `md` 36px, `sm` 24px,
`xs` 18px — never smaller. The `STRATEGY · ADVISORY · GROWTH` tagline renders at `md` and above only.

On gold surfaces the relationship inverts — accent letters become _more_ muted
(`rgba(0,0,0,0.28)`) than the base (`rgba(0,0,0,0.65)`). Pass `onGold`. That reversal is intentional.

**Never**: recolour it, add shadows, change which letters get gold, set it bold or all-caps, or place
it on a busy image without a solid backing.

---

## 7. Documented exceptions

Two deliberate departures, both justified by this being an operational console rather than client
collateral:

1. **Functional status colours.** The brand palette has no green/red/blue, but this tool signals
   ingestion states, failures and cache behaviour. A desaturated, ink-adjacent set is retained,
   tuned to recede beside gold. **State only — never decorative, never on marketing surfaces.**

   |         | Cream     | Obsidian  |
   | ------- | --------- | --------- |
   | success | `#3f6b52` | `#6f9c82` |
   | warning | `#8a6a1f` | `#c9a24a` |
   | danger  | `#8e3b3b` | `#c97a7a` |
   | info    | `#3d5a73` | `#7d9ab3` |

2. **JetBrains Mono** for chunk IDs, JSON and `<pre>`. The two-font system governs collateral; a
   retrieval console needs a monospace.

Dense console regions (sidebars, tables, badges) also run below the 15px body standard — 13px/11px —
because 15px body in a 280px rail is unusable. The type _relationships_ are preserved.

---

## 8. Adding a component — checklist

- [ ] No colour that is not a palette token. No `rounded-*`. No `shadow-*`. No `blur`.
- [ ] Headings use a `.display-*` class (never a raw `text-3xl font-bold`).
- [ ] Georgia is weight 400. DM Sans is 300/400/500 — never 700.
- [ ] Section headings use `.section-label`; nested ones use `.section-label-sub`.
- [ ] Count the gold in your section. If it is more than one mark, demote to `--emphasis*`.
- [ ] A sub-panel's leading action is `.btn-solid`, not `.btn-primary`.
- [ ] Spacing is a multiple of 4px.
- [ ] Both themes checked — Cream and Obsidian.
- [ ] **Narrow containers checked.** The 280px/320px rails are where layout breaks first.
      Verify with a long document title, not a short one, and confirm the container's
      `scrollWidth === clientWidth`. Two shipped regressions came from this: a `.seam-grid`
      column sizing to its widest item and pushing row controls out of the rail, and tracked-caps
      button labels wrapping out of their tile. Neither was caught by `toBeVisible()`.
