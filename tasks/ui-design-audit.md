# UI/UX Design Audit -- RAG Workspace

**Date:** 2026-03-13
**Auditor scope:** Every page, component, and CSS definition in the codebase
**Goal:** Catalogue every visual/UX issue, define a cohesive design system, and propose concrete improvements with implementation-ready design tokens

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Issue Catalogue by Category](#3-issue-catalogue-by-category)
4. [Page-by-Page Audit](#4-page-by-page-audit)
5. [Component-Level Audit](#5-component-level-audit)
6. [Proposed Design System](#6-proposed-design-system)
7. [Improvement Plan by Page](#7-improvement-plan-by-page)
8. [Industry Pattern References](#8-industry-pattern-references)
9. [Implementation Priority Matrix](#9-implementation-priority-matrix)

---

## 1. Executive Summary

The current UI is **functional but generic**. It reads as a developer-built prototype rather than a polished product. The main problems:

- **No brand identity.** "RAG Workspace" is plain text with no logo, icon, or visual mark. The app feels like a template.
- **Inconsistent color language.** The codebase mixes `slate-*` and `zinc-*` grays interchangeably (e.g., `text-slate-900` next to `text-zinc-900`). This creates subtle tonal inconsistencies.
- **Over-engineered admin panel, under-designed main workbench.** The admin Runtime Signals panel has decorative serif fonts and gradient backgrounds (`font-serif`, `bg-[linear-gradient(135deg,#f5f0e8,...)]`) that clash with the rest of the app's minimal aesthetic.
- **Dense, cramped workbench layout.** Both sidebars and the center column lack breathing room. Section headers are tiny (`text-xs`), action buttons are microscopic (`text-[10px]`), and spacing is tight.
- **No dark mode.** The CSS sets `color-scheme: light` with no dark variant. Modern SaaS tools ship dark mode as table stakes.
- **Missing micro-interactions.** No skeleton shimmer on load, no transition on sidebar items, no toast notifications, no progress indicators beyond "Loading..." text.
- **Chat interface lacks ChatGPT/Perplexity polish.** No message avatars, no markdown rendering, no code block styling, no copy-to-clipboard, no typing indicator animation beyond bouncing dots.

### Severity Rating

| Category | Rating | Notes |
|---|---|---|
| Visual consistency | 4/10 | slate/zinc mixing, serif/sans clash on admin |
| Spacing & layout | 5/10 | Functional but cramped; no intentional whitespace system |
| Typography hierarchy | 4/10 | Headers are correct sizes but labels are uniformly tiny |
| Color system | 5/10 | Teal accent is fine but palette feels cold and undifferentiated |
| Loading/empty states | 3/10 | Bare text fallbacks, no illustrations or meaningful empty states |
| Error handling UX | 4/10 | Errors shown but unstyled, no toast system, no retry affordances |
| Micro-interactions | 3/10 | Only `active:scale-[0.98]` and basic hover states |
| Responsiveness | 4/10 | Fixed sidebar widths will break on tablets/small screens |
| Accessibility | 6/10 | Good `aria-live`, labels present, but focus ring is only teal with no visible outline |
| Brand/identity | 2/10 | No logo, no distinctive visual element, indistinguishable from a template |

---

## 2. Current State Analysis

### 2.1 Global Styles (`app/globals.css`)

**What exists:**
- CSS custom properties for a light theme: `--bg-page`, `--bg-surface`, `--accent` (teal)
- Focus ring using `box-shadow` with `--ring` (teal at 35% opacity)
- A single `rise-in` animation for `animate-rise` class
- Basic resets for `box-sizing`, `font`, and `::selection`

**Issues:**
- Custom properties are defined but **almost never used** in components. Components use Tailwind classes like `bg-zinc-50`, `text-slate-900` directly instead of `var(--bg-page)`, `var(--text-primary)`. This defeats the purpose of having a token system.
- No dark mode variables or `prefers-color-scheme` media query.
- The `::selection` color is hardcoded rather than using the CSS variable.
- Only one animation defined. No transition utilities for common patterns (fade, slide, scale).

### 2.2 Layout (`app/layout.tsx`)

- Inter for body, JetBrains Mono for code -- good font choices.
- Both fonts loaded via `next/font/google` with `display: swap` -- correct.
- Body has `text-zinc-900 antialiased` -- fine.
- No skip-to-content link for accessibility.

### 2.3 Color Usage Audit

A grep across all components reveals:

| Token family | Usage count | Problem |
|---|---|---|
| `zinc-*` | ~120+ uses | Primary gray family |
| `slate-*` | ~60+ uses | **Mixed in alongside zinc** |
| `teal-*` | ~20 uses | Accent color |
| `emerald-*` | ~15 uses | Success/approve |
| `rose-*` | ~20 uses | Error/danger |
| `amber-*` | ~10 uses | Warning/pending |
| `purple-*` | 1 use | Admin badge only |
| `blue-*` | ~5 uses | Web sources only |
| `gray-*` | 2 uses | Decline button only |

**Critical finding:** `zinc` and `slate` are used interchangeably for text and backgrounds. In Tailwind, `zinc` is a cooler neutral and `slate` has a blue undertone. Mixing them creates tonal discord. The app should pick ONE gray family and stick to it.

### 2.4 Typography Audit

| Element | Current | Issue |
|---|---|---|
| Page titles (auth) | `text-3xl font-bold` | Slightly large for a card context; no tracking adjustment |
| Section headers (sidebar) | `text-xs font-medium` | Too small; indistinguishable from body text |
| Admin panel title | `font-serif text-2xl` | Serif font is never loaded; falls back to browser serif, clashing with Inter |
| Body text | `text-sm` | Good |
| Micro labels | `text-[10px]` or `text-[11px]` | Too small for readability; below WCAG minimum |
| Button text | `text-sm font-semibold` or `text-xs font-medium` | Inconsistent between pages |

### 2.5 Spacing Audit

- Auth cards: `p-8` -- adequate.
- Sidebar padding: `p-4` with `gap-4` -- functional but tight.
- Chat messages: `p-4` with `space-y-3` -- adequate.
- Form spacing: `space-y-4` and `mt-6` -- fine but could use more air between logical groups.
- The right sidebar crams upload controls, evidence, batch upload, query scope, upload status, and workspace message into a single scrolling column. Too much in one panel.

---

## 3. Issue Catalogue by Category

### 3.1 Visual Consistency Issues

| # | Issue | Location | Severity |
|---|---|---|---|
| VC-1 | `slate-*` and `zinc-*` grays mixed throughout | All components | High |
| VC-2 | Admin panel uses `font-serif` which is never loaded as a web font | `admin-runtime-signals.tsx:49` | Medium |
| VC-3 | Admin panel uses decorative gradient (`linear-gradient(135deg,#f5f0e8,...)`) absent from all other pages | `admin-runtime-signals.tsx:45` | Medium |
| VC-4 | Admin panel uses `rounded-[28px]` border radius, nowhere else in the app | `admin-runtime-signals.tsx:44` | Medium |
| VC-5 | Button styles differ between pages: auth uses `border border-slate-900 bg-zinc-900`, workbench uses `bg-zinc-900` without border, send button uses `bg-teal-600` | Multiple | High |
| VC-6 | Inconsistent label styling: auth uses `text-xs font-medium text-zinc-500`, sidebar uses `text-xs font-medium text-zinc-500` but admin uses `text-[11px] font-semibold uppercase tracking-[0.28em]` | Multiple | Medium |
| VC-7 | Badge/pill styles vary: admin uses `roleBadgeColor` map, chat uses inline conditional classes, batch upload uses yet another pattern | Multiple | Medium |

### 3.2 Layout & Spacing Issues

| # | Issue | Location | Severity |
|---|---|---|---|
| LS-1 | Fixed sidebar widths (`w-[280px]`, `w-[320px]`) with no collapse/responsive behavior | `sidebar-left.tsx`, `sidebar-right.tsx` | High |
| LS-2 | Right sidebar has 7+ sections crammed into one scrollable panel with no visual separation | `sidebar-right.tsx` | High |
| LS-3 | Nav height (`h-14`) is short; modern apps use `h-16` for better touch targets and breathing room | `app-nav.tsx` | Low |
| LS-4 | Chat area has no max-width constraint; on wide screens, messages stretch full width making them hard to read | `chat-view.tsx` | Medium |
| LS-5 | No padding on the main page wrapper (`page.tsx` only has `min-h-screen bg-zinc-50`) | `page.tsx` | Low |
| LS-6 | Pending-approval page duplicates the auth layout inline instead of reusing the `(auth)/layout.tsx` | `pending-approval/page.tsx` | Low |

### 3.3 Empty States & Loading States

| # | Issue | Location | Severity |
|---|---|---|---|
| EL-1 | Chat empty state is just two lines of plain text ("Ask about your documents" / "Responses will appear here") -- no illustration, no suggested prompts, no onboarding guidance | `chat-view.tsx` | High |
| EL-2 | Loading states are plain text ("Loading users...", "Loading runtime signals...") -- no skeleton, no spinner | `admin-users-table.tsx`, `admin-runtime-signals.tsx` | Medium |
| EL-3 | Sidebar skeleton uses basic `animate-pulse` with fixed heights that don't match actual content shape | `sidebar-left.tsx` | Low |
| EL-4 | Empty document list shows "No documents ingested yet." with no action prompt or upload CTA | `sidebar-left.tsx` | Medium |
| EL-5 | Empty citations area shows a dashed border box -- fine but could include a helpful illustration | `sidebar-right.tsx` | Low |
| EL-6 | Suspense fallback for login is "Loading..." plain text | `login-form.tsx:157` | Low |

### 3.4 Error State Issues

| # | Issue | Location | Severity |
|---|---|---|---|
| ER-1 | Errors are inline `<p>` tags with `text-rose-700` -- no toast/notification system | All forms | Medium |
| ER-2 | Admin error has a dismiss button but it's unstyled (just underlined text) | `admin-panel.tsx:148` | Low |
| ER-3 | Workspace status message is a single line at the bottom of the right sidebar -- easily missed | `sidebar-right.tsx:186` | High |
| ER-4 | No retry button on failed chat turns | `chat-message.tsx` | Medium |
| ER-5 | Error boundary fallback is minimal -- no error details, no way to report | `error-boundary.tsx` | Low |

### 3.5 Interaction & Animation Issues

| # | Issue | Location | Severity |
|---|---|---|---|
| IA-1 | Only micro-interaction is `active:scale-[0.98]` on buttons -- no hover elevation, no focus animations | All buttons | Medium |
| IA-2 | No transition on sidebar items when selected/scoped | `sidebar-left.tsx` | Low |
| IA-3 | Chat messages have `transition` but no specific property specified (transitions all properties) | `chat-message.tsx` | Low |
| IA-4 | `StreamingDots` uses default `animate-bounce` which is too aggressive for a typing indicator | `chat-message.tsx:11-18` | Low |
| IA-5 | No scroll-to-bottom behavior when new messages arrive | `chat-view.tsx` | Medium |
| IA-6 | No textarea auto-resize -- fixed at `rows={2}` | `chat-input.tsx:27` | Medium |
| IA-7 | Confirm dialog appears/disappears with no animation (uses native `<dialog>` showModal) | `admin-confirm-dialog.tsx` | Low |

### 3.6 Accessibility Issues

| # | Issue | Location | Severity |
|---|---|---|---|
| A-1 | No skip-to-content link | `layout.tsx` | Medium |
| A-2 | Focus ring is only `box-shadow` with no visible outline -- invisible in Windows high-contrast mode | `globals.css:59` | Medium |
| A-3 | `text-[10px]` and `text-[11px]` labels are below the 12px WCAG minimum for body text | Multiple | Medium |
| A-4 | Delete buttons labeled "Del" -- not screen-reader friendly (though has `title` attribute) | `sidebar-left.tsx:117` | Low |
| A-5 | Color-only status indication on documents (emerald/amber/rose) with no icon or text alternative beyond the word | `sidebar-left.tsx:95` | Low |
| A-6 | Chat messages are clickable `<article>` elements without `role="button"` or `tabIndex` | `chat-message.tsx:23` | Medium |

### 3.7 Responsiveness Issues

| # | Issue | Location | Severity |
|---|---|---|---|
| R-1 | Workbench is a fixed three-column layout with no collapse behavior on small screens | `rag-workbench.tsx:530` | Critical |
| R-2 | Sidebars have hardcoded widths (`w-[280px]`, `w-[320px]`) totaling 600px + center content | `sidebar-left.tsx`, `sidebar-right.tsx` | Critical |
| R-3 | Admin table does not handle overflow on mobile -- columns will compress text | `admin-users-table.tsx` | Medium |
| R-4 | Auth pages handle responsive well (`max-w-md`, `px-4`) -- this is correct | Auth pages | N/A |
| R-5 | Nav hides email on small screens (`hidden sm:inline`) but shows nothing else as identity marker | `app-nav.tsx:48` | Low |

---

## 4. Page-by-Page Audit

### 4.1 Login Page (`/login`)

**Current state:** Centered card with "RAG Workspace" text above it. Two form fields, a submit button, and navigation links.

**Issues:**
- Brand header is just `<p>` with `text-sm font-semibold`. No logo, no icon. Looks like a placeholder.
- Alert banners (confirmed, suspended, rejected) use different background colors but identical layout -- good for differentiation, but they appear without any entrance animation.
- "Sign In" heading at `text-3xl` is proportionally large inside the card.
- No password visibility toggle.
- The card has `shadow-lg` which is heavy for a login card on a `bg-zinc-50` background. Creates a floating effect that feels dated.
- No separator between the form and the navigation links.

**Reference pattern (Linear, Vercel):** Login cards use `shadow-sm` or `shadow-[0_1px_3px_rgba(0,0,0,0.08)]` for subtle elevation. Brand mark is an icon/logomark, not text. Headings are `text-2xl` or `text-xl`. A subtle divider ("or") separates auth methods.

### 4.2 Signup Page (`/signup`)

Same layout as login. Mirrors correctly. The success state is well-handled (switches to confirmation message). No issues beyond the shared auth layout problems.

### 4.3 Reset Password Page (`/reset-password`)

Multi-mode form that handles request, set-password, success-request, and success-set. Logic is sound. Same visual issues as the login page. The `setTimeout(() => router.push("/login"), 2000)` redirect has no visual countdown or progress indicator.

### 4.4 Pending Approval Page (`/pending-approval`)

**Issues:**
- Duplicates the auth card layout inline instead of using the `(auth)/layout.tsx` route group.
- The status check result uses color-only differentiation (emerald/rose/amber) for approved/suspended/pending -- should include an icon.
- "Check Status" button hits the Supabase API but provides no loading animation beyond text change.

### 4.5 Admin Page (`/admin`)

**Issues:**
- The "Runtime Signals" panel (`admin-runtime-signals.tsx`) has a completely different design language from the rest of the app:
  - Uses `font-serif` for the title (which falls back to Times New Roman since no serif font is loaded).
  - Uses a warm gradient background (`#f5f0e8`).
  - Uses `rounded-[28px]` border radius (28px!) while the rest of the app uses `rounded-lg` (8px) or `rounded-xl` (12px) or `rounded-2xl` (16px).
  - Uses `tracking-[0.28em]` and `tracking-[0.18em]` letter-spacing for uppercase labels -- an editorial/magazine aesthetic that clashes with the Inter-based UI.
  - The label "Operations Strip" is jargon that means nothing to users.
- The user management table is functional but dense. No row hover states beyond default. No pagination. No search/filter.
- Delete confirmation dialog has no backdrop blur, only `bg-black/40`.

**This panel reads as if it was designed by a different person or generated by a different AI session.** It should be brought in line with the rest of the app.

### 4.6 Main Workbench (`/`)

**Issues:**
- The three-column layout is unresponsive. On a 1280px screen, the center column gets roughly 680px. On a 1024px screen, it gets 424px. Below 1024px it breaks.
- The left sidebar mixes two unrelated concerns (Query Timeline + Documents) with only a thin section gap between them.
- The right sidebar mixes five concerns (Evidence, Upload, Scope, Batch, Status) with no tabbed/accordion organization.
- The chat empty state is anemic. Compare to ChatGPT's empty state which has suggested prompts, a visual element, and clear onboarding guidance.
- Chat messages render answer text as plain `whitespace-pre-wrap`. No markdown rendering, no code blocks, no bullet point formatting. For a RAG system, answers often contain structured content that would benefit from markdown.
- The "Send" button uses `bg-teal-600` while all other primary buttons use `bg-zinc-900`. Inconsistent.
- Web research toggle is a bare checkbox -- should be a styled toggle switch.
- Scope indicator pill in the chat input area shows a UUID slice -- not human-friendly. Should show the document title.
- OpenAI Key Vault is in a `<details>` element with no visual distinction from the surrounding UI. It's tucked between the chat input and the dev controls.

---

## 5. Component-Level Audit

### 5.1 `AppNav` (components/layout/app-nav.tsx)

- No logo/icon -- just "RAG Workspace" text.
- "Signed in as {role}" shows the raw role string. Should show the user's name or email prominently, with role as a badge.
- Sign out button is small and right-aligned -- fine placement.
- Missing: breadcrumb, page title, keyboard shortcut hints.

### 5.2 `ChatMessage` (components/workbench/chat-message.tsx)

- No visual distinction between user question and AI answer -- they're rendered in the same block. Modern chat UIs separate these into distinct bubbles or rows (user right-aligned or distinct background, AI left-aligned).
- No avatar/icon for user or AI.
- No markdown rendering for the answer.
- No copy-to-clipboard button.
- Report download buttons (DOCX/PDF) are small and easy to miss.
- The entire message is clickable (to select it for the evidence panel) but this is not communicated visually. No cursor indicator beyond `cursor-pointer`.

### 5.3 `ChatInput` (components/workbench/chat-input.tsx)

- Fixed 2-row textarea with no auto-resize.
- No character count or visual constraint indicator.
- No keyboard shortcut hint ("Enter to send, Shift+Enter for new line").
- The send button is detached from the textarea (in a flex row). Modern pattern is to embed the send button inside the textarea's border (like ChatGPT).
- Scope pill shows UUID -- should show document name.

### 5.4 `SidebarLeft` (components/workbench/sidebar-left.tsx)

- "Del" as button text is cryptic. Should use a trash icon or spell out "Delete".
- Scope/Scoped toggle buttons are tiny (`text-[10px]`).
- Document status colors have no icon -- just colored text.
- No search/filter for documents or query history.
- Query history items show `{item.latencyMs}ms` -- too technical for most users.

### 5.5 `SidebarRight` (components/workbench/sidebar-right.tsx)

- Mixes too many concerns in one panel. Should be organized with tabs or an accordion.
- File input uses browser default styling with `file:` variant -- functional but not polished. A drag-and-drop zone would be more inviting.
- "Ingestion Desk" is insider jargon.
- Upload status panel is a dense block of key-value pairs.

### 5.6 `Skeleton` (components/ui/skeleton.tsx)

- Extremely minimal. Only renders a `div` with `animate-pulse` and `bg-zinc-200`. No shimmer effect (the modern standard). Should use a gradient sweep animation.

### 5.7 `ErrorBoundary` (components/ui/error-boundary.tsx)

- Fallback UI is adequate but minimal. Could benefit from an illustration and "contact support" link.

---

## 6. Proposed Design System

### 6.1 Color Palette

Standardize on **zinc** as the neutral family. Drop all `slate-*` usage.

```
/* Neutrals (zinc family only) */
--color-bg-primary:     #fafafa;   /* zinc-50 - page background */
--color-bg-surface:     #ffffff;   /* white - cards, panels */
--color-bg-subtle:      #f4f4f5;   /* zinc-100 - recessed areas, hover states */
--color-bg-muted:       #e4e4e7;   /* zinc-200 - skeleton, dividers */
--color-border-default: #e4e4e7;   /* zinc-200 */
--color-border-hover:   #d4d4d8;   /* zinc-300 */
--color-border-strong:  #a1a1aa;   /* zinc-400 */
--color-text-primary:   #18181b;   /* zinc-900 */
--color-text-secondary: #3f3f46;   /* zinc-700 */
--color-text-tertiary:  #71717a;   /* zinc-500 */
--color-text-disabled:  #a1a1aa;   /* zinc-400 */

/* Accent (teal -- keep, it's distinctive) */
--color-accent:         #0d9488;   /* teal-600 */
--color-accent-hover:   #0f766e;   /* teal-700 */
--color-accent-subtle:  #ccfbf1;   /* teal-100 */
--color-accent-ring:    rgba(13, 148, 136, 0.25);

/* Semantic */
--color-success:        #059669;   /* emerald-600 */
--color-success-subtle: #d1fae5;   /* emerald-100 */
--color-warning:        #d97706;   /* amber-600 */
--color-warning-subtle: #fef3c7;   /* amber-100 */
--color-danger:         #dc2626;   /* red-600 */
--color-danger-subtle:  #fee2e2;   /* red-100 */
--color-info:           #2563eb;   /* blue-600 */
--color-info-subtle:    #dbeafe;   /* blue-100 */
```

### 6.2 Typography Scale

```
/* Type scale (based on Inter) */
--text-xs:    0.75rem / 1rem;      /* 12px -- minimum for labels */
--text-sm:    0.875rem / 1.25rem;  /* 14px -- body, controls */
--text-base:  1rem / 1.5rem;       /* 16px -- primary body */
--text-lg:    1.125rem / 1.75rem;  /* 18px -- section headers */
--text-xl:    1.25rem / 1.75rem;   /* 20px -- page titles */
--text-2xl:   1.5rem / 2rem;       /* 24px -- hero headings */

/* Font weights */
--font-normal:    400;
--font-medium:    500;
--font-semibold:  600;
--font-bold:      700;

/* Letter spacing */
--tracking-tight:  -0.01em;   /* headings */
--tracking-normal:  0;         /* body */
--tracking-wide:    0.025em;   /* uppercase labels */
```

**Rules:**
- NEVER use `text-[10px]` or `text-[11px]`. Minimum is `text-xs` (12px).
- Headings use `tracking-tight` for a professional feel (like Linear).
- Uppercase labels use `tracking-wide` -- NOT `tracking-[0.28em]` (too editorial).
- Kill the `font-serif` usage entirely.

### 6.3 Spacing System

Use Tailwind's default 4px grid. Standardize semantic spacing:

```
/* Component internal */
--space-input-x:   0.875rem;  /* px-3.5 */
--space-input-y:   0.625rem;  /* py-2.5 */
--space-card:      1.5rem;    /* p-6 */
--space-section:   1.5rem;    /* gap between sections */

/* Page layout */
--space-page-x:    1.5rem;    /* px-6, md:px-8 */
--space-page-y:    2rem;      /* py-8 */
--space-sidebar:   1rem;      /* p-4 */
```

### 6.4 Border Radius Scale

```
--radius-sm:    6px;    /* small pills, badges */
--radius-md:    8px;    /* buttons, inputs */
--radius-lg:    12px;   /* cards, panels */
--radius-xl:    16px;   /* modals, feature cards */
--radius-full:  9999px; /* avatars, toggles */
```

**Rule:** Never use `rounded-[28px]` or other arbitrary values. The admin panel's `rounded-[28px]` must become `rounded-xl` (16px).

### 6.5 Shadow Scale

```
--shadow-xs:    0 1px 2px rgba(0, 0, 0, 0.04);
--shadow-sm:    0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
--shadow-md:    0 4px 6px -1px rgba(0, 0, 0, 0.06), 0 2px 4px -2px rgba(0, 0, 0, 0.04);
--shadow-lg:    0 10px 15px -3px rgba(0, 0, 0, 0.06), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
--shadow-ring:  0 0 0 3px var(--color-accent-ring);
```

**Rule:** Auth cards should use `shadow-sm`, not `shadow-lg`. The login card currently floats too prominently. Modern pattern (Vercel, Linear): subtle shadow + strong border.

### 6.6 Animation Standards

```css
/* Transitions */
--duration-fast:     100ms;   /* hover states, toggles */
--duration-normal:   200ms;   /* panel open/close, focus */
--duration-slow:     300ms;   /* page transitions, modals */
--easing-default:    cubic-bezier(0.4, 0, 0.2, 1);  /* ease-out */
--easing-spring:     cubic-bezier(0.34, 1.56, 0.64, 1);  /* overshoot */

/* Standard animations to add */
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slide-down {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes scale-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

/* Typing indicator (replace aggressive bounce) */
@keyframes pulse-dot {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
```

### 6.7 Component Tokens (Buttons)

```
/* Primary button */
bg: zinc-900 -> hover: zinc-800 -> active: zinc-700
text: white
border: none
radius: --radius-md (8px)
padding: px-4 py-2.5
font: text-sm font-medium (NOT font-semibold everywhere)
transition: background 150ms, transform 100ms
active: scale(0.98)

/* Secondary button */
bg: white -> hover: zinc-50
text: zinc-700
border: 1px solid zinc-200 -> hover: zinc-300
radius: --radius-md
padding: px-4 py-2.5
font: text-sm font-medium

/* Accent button (used ONLY for primary actions in the chat input) */
bg: teal-600 -> hover: teal-700 -> active: teal-800
text: white
border: none
radius: --radius-md
padding: px-4 py-2.5

/* Danger button */
bg: red-600 -> hover: red-700
text: white
border: none

/* Ghost button (small inline actions) */
bg: transparent -> hover: zinc-100
text: zinc-500 -> hover: zinc-700
border: none
padding: px-2 py-1
font: text-xs font-medium
```

### 6.8 Component Tokens (Inputs)

```
bg: white
border: 1px solid zinc-300 -> focus: teal-500
radius: --radius-md (8px)
padding: px-3.5 py-2.5
font: text-sm
text: zinc-900
placeholder: zinc-400
focus: ring-2 ring-teal-500/25, border-teal-500
transition: border-color 150ms, box-shadow 150ms
```

### 6.9 Component Tokens (Cards)

```
bg: white
border: 1px solid zinc-200
radius: --radius-lg (12px)
shadow: --shadow-xs
padding: p-6
hover (interactive): border-zinc-300, shadow-sm
```

### 6.10 Component Tokens (Badges/Pills)

```
radius: --radius-full (9999px)
padding: px-2.5 py-0.5
font: text-xs font-medium
border: 1px solid [semantic-color-300]
bg: [semantic-color-50]
text: [semantic-color-700]
```

---

## 7. Improvement Plan by Page

### 7.1 Auth Pages (Login, Signup, Reset Password)

1. **Add a brand mark.** Replace the "RAG Workspace" text with an SVG icon/logomark + wordmark. Even a simple geometric icon (document + magnifying glass) would add identity.

2. **Reduce card shadow.** Change `shadow-lg` to `shadow-sm` for a more grounded, modern feel.

3. **Adjust heading size.** `text-3xl` to `text-xl` or `text-2xl` with `tracking-tight`.

4. **Add password visibility toggle.** Eye icon inside the password field.

5. **Improve alert banners.** Add entrance animation (`animate-slide-down`). Add an icon (checkmark for success, exclamation for error). Add a close/dismiss button.

6. **Add visual separator before footer links.** A thin `border-t` or `<hr>` before "Don't have an account?" with `my-6`.

7. **Improve Suspense fallback.** Replace "Loading..." with a skeleton that matches the form layout.

8. **Add subtle background pattern.** A very faint dot grid or gradient on the `bg-zinc-50` background to add depth (like Clerk's auth pages).

### 7.2 Pending Approval Page

1. **Reuse the `(auth)/layout.tsx`** instead of duplicating the card structure.

2. **Add an illustration.** A simple SVG of a clock or hourglass to visually communicate "waiting."

3. **Add icons to status messages.** Green checkmark for approved, red X for suspended, amber clock for still pending.

### 7.3 Admin Page

1. **Normalize the Runtime Signals panel.** Remove `font-serif`, remove the warm gradient, change `rounded-[28px]` to `rounded-xl`. Use the same `text-xs uppercase tracking-wide font-medium text-zinc-500` pattern for labels as the rest of the app.

2. **Rename "Operations Strip" to "System Status"** and "Runtime Signals" to "Infrastructure Health."

3. **Add table row hover states.** `hover:bg-zinc-50` on table rows.

4. **Add search/filter to the users table.** A simple text input that filters by email.

5. **Add pagination** or virtual scrolling for the users table.

6. **Animate the confirm dialog.** Add `scale-in` animation, add `backdrop-blur-sm`.

7. **Improve the Refresh buttons.** Add a rotate animation on the icon while loading. Use an icon button with a refresh/sync icon.

### 7.4 Main Workbench

This is the most impactful area. Improvements ranked by impact:

**Critical:**

1. **Make the layout responsive.** Add a mobile-first approach:
   - Below 768px: single column, sidebars become slide-in drawers triggered by hamburger/icon buttons.
   - 768-1024px: left sidebar collapses to icons only (40px), right sidebar becomes a drawer.
   - Above 1024px: full three-column layout.

2. **Redesign the empty chat state.** Add:
   - A centered illustration or icon (document + search).
   - 3-4 suggested prompt cards that the user can click to auto-fill.
   - Brief onboarding text: "Upload a document, then ask questions about it."

3. **Add markdown rendering to chat answers.** Use `react-markdown` or similar. Answers from a RAG system commonly include lists, bold text, and code snippets.

**High:**

4. **Separate user questions and AI answers visually.** Two options:
   - **Option A (ChatGPT style):** Full-width rows. User message has a subtle tinted background (zinc-50) with a user icon. AI response is white with an AI icon. Max-width of ~720px centered.
   - **Option B (Bubble style):** User messages right-aligned with zinc-900 bg/white text. AI messages left-aligned with white bg/zinc-900 text.
   Recommend Option A for a RAG/enterprise context.

5. **Redesign the chat input.** Embed the send button inside the textarea border (bottom-right corner). Add auto-resize. Add a keyboard shortcut hint. Style the web research toggle as a proper toggle switch with a label.

6. **Reorganize the right sidebar with tabs.** Three tabs: "Evidence" | "Upload" | "Status". This reduces cognitive load.

7. **Add a toast notification system.** Replace the workspace status message with toasts that appear in the bottom-right or top-right corner. Use `sonner` or a similar lightweight library.

**Medium:**

8. **Add scroll-to-bottom on new messages.** Auto-scroll the chat view when a new turn is added. Show a "scroll to bottom" button when the user has scrolled up.

9. **Replace file input with drag-and-drop zone.** A dashed-border area with "Drop PDF here or click to browse" text and a file icon.

10. **Show document titles instead of UUID slices** in scope indicators and citations.

11. **Add copy-to-clipboard buttons** on chat answers.

12. **Add a typing indicator** that's less aggressive than `animate-bounce`. Use a gentler pulse animation.

13. **Add a collapsible retrieval metadata panel** below each answer (expandable on click) showing cache hit/miss, latency, chunk count, etc.

---

## 8. Industry Pattern References

### 8.1 ChatGPT / Claude.ai (Chat Interface)

- **Message layout:** Full-width rows, max-width ~720px centered. User messages have a small avatar circle. AI messages have a brand avatar.
- **Input:** Textarea with embedded send button. Auto-resizes. Has a stop button during streaming.
- **Empty state:** Centered logo, suggested prompts as clickable cards.
- **Streaming:** Cursor blink animation at the end of streaming text, not bouncing dots.
- **Markdown:** Full markdown rendering with syntax-highlighted code blocks, copy buttons, and formatted lists.

### 8.2 Linear (SaaS Dashboard)

- **Color:** Single neutral family (gray). One accent color (violet). No mixing of neutral families.
- **Typography:** Tight letter-spacing on headings (`tracking-tight`). Medium weight for body, semibold for emphasis only.
- **Sidebar:** Collapsible, with icon-only mode. Smooth 200ms transition. Keyboard shortcut (`Cmd+\`) to toggle.
- **Cards:** Very subtle borders (`border-zinc-200`), minimal shadow (`shadow-xs` or none). Clean whitespace.
- **Tables:** Row hover states. Inline actions appear on hover, hidden otherwise.
- **Animations:** 200ms ease-out for all transitions. No abrupt state changes.

### 8.3 Vercel Dashboard (Admin/Infrastructure)

- **Metrics cards:** Clean number + label. No decorative gradients. Monospace or tabular numbers for values.
- **Status indicators:** Colored dots (green/yellow/red) with text labels. Not color-only.
- **Tables:** Sticky headers. Hover rows. Click-to-expand details.
- **Buttons:** Consistent sizing. Primary/secondary/ghost hierarchy clearly defined.

### 8.4 Notion (Document Management)

- **Sidebar:** Tree structure for documents. Drag-and-drop reordering. Expand/collapse groups.
- **Empty states:** Illustrated with friendly copy. "No items yet" + action CTA.
- **Loading:** Content-shaped skeletons with shimmer animation.

### 8.5 Perplexity (RAG/Search)

- **Citations:** Inline numbered references in the answer text, with a sources panel below. Hover to preview.
- **Sources panel:** Cards with favicon, title, and URL. Not just UUID slices.
- **Follow-up prompts:** Suggested follow-up questions appear below each answer.

---

## 9. Implementation Priority Matrix

### Tier 1 -- High Impact, Lower Effort (Do First)

| # | Change | Effort | Impact |
|---|---|---|---|
| 1 | Standardize all `slate-*` to `zinc-*` across codebase | Low | High |
| 2 | Remove `font-serif`, gradient, and `rounded-[28px]` from admin panel | Low | Medium |
| 3 | Increase minimum text size from `text-[10px]`/`text-[11px]` to `text-xs` | Low | Medium |
| 4 | Standardize button styles (one primary, one secondary, one ghost, one danger) | Medium | High |
| 5 | Reduce auth card shadow from `shadow-lg` to `shadow-sm` | Low | Medium |
| 6 | Add table row hover states to admin | Low | Low |
| 7 | Improve skeleton component with shimmer animation | Low | Medium |
| 8 | Change heading sizes: `text-3xl` to `text-2xl` with `tracking-tight` on auth pages | Low | Low |

### Tier 2 -- High Impact, Medium Effort (Do Second)

| # | Change | Effort | Impact |
|---|---|---|---|
| 9 | Redesign chat empty state with illustration + suggested prompts | Medium | High |
| 10 | Separate user/AI messages visually (distinct rows with icons) | Medium | High |
| 11 | Add toast notification system (replace workspace status message) | Medium | High |
| 12 | Add responsive sidebar collapse (drawer mode on mobile) | High | Critical |
| 13 | Add auto-resize to chat textarea | Low | Medium |
| 14 | Redesign chat input with embedded send button | Medium | Medium |
| 15 | Reorganize right sidebar with tabs | Medium | High |

### Tier 3 -- Medium Impact, Higher Effort (Do Third)

| # | Change | Effort | Impact |
|---|---|---|---|
| 16 | Add markdown rendering to chat answers | Medium | High |
| 17 | Add drag-and-drop upload zone | Medium | Medium |
| 18 | Add brand logomark/icon | Medium | Medium |
| 19 | Add dark mode support | High | Medium |
| 20 | Add scroll-to-bottom behavior | Low | Medium |
| 21 | Add copy-to-clipboard on answers | Low | Medium |
| 22 | Show document titles instead of UUIDs everywhere | Medium | Medium |
| 23 | Add password visibility toggle to auth forms | Low | Low |
| 24 | Add search/filter to admin users table | Medium | Medium |
| 25 | Add skip-to-content link | Low | Low |
| 26 | Add keyboard shortcut hints | Low | Low |
| 27 | Add dialog animations (scale-in + backdrop blur) | Low | Low |

---

## Appendix A: File Reference

| File | Role |
|---|---|
| `app/globals.css` | Global styles, CSS custom properties, animations |
| `app/layout.tsx` | Root layout, font loading |
| `app/page.tsx` | Home page (workbench wrapper) |
| `app/(auth)/layout.tsx` | Auth page shared card layout |
| `app/(auth)/login/login-form.tsx` | Login form |
| `app/(auth)/signup/signup-form.tsx` | Signup form |
| `app/(auth)/reset-password/reset-form.tsx` | Password reset multi-mode form |
| `app/pending-approval/pending-form.tsx` | Pending approval status checker |
| `app/admin/admin-panel.tsx` | Admin page orchestrator |
| `app/admin/admin-users-table.tsx` | User management table |
| `app/admin/admin-runtime-signals.tsx` | Infrastructure health dashboard |
| `app/admin/admin-confirm-dialog.tsx` | Confirmation dialog |
| `components/rag-workbench.tsx` | Main workbench orchestrator (530+ lines) |
| `components/layout/app-nav.tsx` | Top navigation bar |
| `components/workbench/chat-view.tsx` | Chat message list |
| `components/workbench/chat-input.tsx` | Query input area |
| `components/workbench/chat-message.tsx` | Individual chat message |
| `components/workbench/sidebar-left.tsx` | Left sidebar (history + documents) |
| `components/workbench/sidebar-right.tsx` | Right sidebar (evidence + upload + status) |
| `components/workbench/openai-key-vault.tsx` | BYOK key management |
| `components/workbench/dev-session-controls.tsx` | Dev-only session tools |
| `components/ui/skeleton.tsx` | Loading skeleton primitive |
| `components/ui/error-boundary.tsx` | Error boundary |

## Appendix B: Quick Wins Checklist

- [ ] Find-and-replace all `text-slate-*` with equivalent `text-zinc-*`
- [ ] Find-and-replace all `bg-slate-*` with equivalent `bg-zinc-*`
- [ ] Find-and-replace all `border-slate-*` with equivalent `border-zinc-*`
- [ ] Remove `font-serif` from `admin-runtime-signals.tsx`
- [ ] Change `rounded-[28px]` to `rounded-xl` in `admin-runtime-signals.tsx`
- [ ] Remove `bg-[linear-gradient(135deg,#f5f0e8,transparent_55%),...]` from `admin-runtime-signals.tsx`
- [ ] Change `tracking-[0.28em]` to `tracking-wider` in `admin-runtime-signals.tsx`
- [ ] Change all `text-[10px]` to `text-xs` globally
- [ ] Change all `text-[11px]` to `text-xs` globally
- [ ] Change auth card `shadow-lg` to `shadow-sm`
- [ ] Add `hover:bg-zinc-50` to admin table rows
- [ ] Add shimmer keyframe to `globals.css`
- [ ] Add `scroll-smooth` to chat view container
