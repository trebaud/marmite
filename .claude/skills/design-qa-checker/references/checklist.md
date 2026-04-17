# Design System Verification Checklist

Source spec: SHELL-000 — Global Design System Configuration

---

## 1. Color Tokens

Every token below must exist as a CSS custom property on `:root` (or equivalent) with the exact value listed.

| Token | CSS Variable | Required Value |
|-------|-------------|----------------|
| Canvas background | `--bg-canvas` | `#FFFFFF` |
| Surface background | `--bg-surface` | `#F8FAFC` |
| Raised background | `--bg-raised` | `#F1F5F9` |
| Hover background | `--bg-hover` | Must exist, value should be a subtle shift from surface |
| Border | `--border` | `#E2E8F0` |
| Border focus | `--border-focus` | `#002B28` |
| Text primary | `--text-primary` | `#0F172A` |
| Text secondary | `--text-secondary` | `#64748B` |
| Text muted | `--text-muted` | `#94A3B8` |
| Accent | `--accent` | `#002B28` |
| Accent hover | `--accent-hover` | `#003D39` |
| Accent lime | `--accent-lime` | `#C6FF33` |
| Accent subtle | `--accent-subtle` | Must exist, should be a soft tint of accent |
| Success | (any naming) | Must exist |
| Warning | (any naming) | Must exist |
| Danger | (any naming) | Must exist |
| Info | (any naming) | Must exist |

### Checks
- [ ] All 17 token categories have corresponding CSS custom properties
- [ ] Hex values match exactly (case-insensitive is OK)
- [ ] `--bg-hover` exists and is defined
- [ ] `--accent-subtle` exists and is defined
- [ ] Status colors (success, warning, danger, info) are all defined

---

## 2. Data Visualization Palette

A set of 7 series colors plus an overflow gray, defined as CSS custom properties.

| Variable | Purpose |
|----------|---------|
| `--series-1` through `--series-7` | 7 distinct, visually differentiable chart colors |
| Overflow / fallback | `#94A3B8` (gray) for series beyond 7 |

### Checks
- [ ] 7 series color variables are defined
- [ ] An overflow/fallback gray is defined as `#94A3B8`
- [ ] Series colors are visually distinct from each other (no two too similar)
- [ ] Series colors are distinct from the status colors (success, danger, etc.) to avoid semantic confusion

---

## 3. Typography

### Font Loading
- [ ] Inter is imported from Google Fonts
- [ ] Weights loaded: 400, 500, 600, 700
- [ ] `body` has `font-family: 'Inter', [system fallback stack]`

### Type Scale

| Role | Size | Weight | Notes |
|------|------|--------|-------|
| Page title | `20px` | `600` | |
| Section heading | `13px` | `600` | |
| Body | `14px` | `400` | |
| Small | `12px` | `400` | |
| Metric value | `28px` | `700` | |
| Metric label | `12px` | `500` | |
| Code / monospace | `13px` | `400` | Must use monospace font-family |

### Checks
- [ ] Each role has the correct font-size
- [ ] Each role has the correct font-weight
- [ ] Code/monospace elements use a monospace font stack
- [ ] `font-variant-numeric: tabular-nums` is applied globally to numeric elements (`td`, metric values, counters, etc.)

---

## 4. Spacing Scale

All spacing values must be multiples of 4px. The following CSS custom properties must be defined:

| Variable | Value |
|----------|-------|
| `--space-xs` | `4px` |
| `--space-sm` | `8px` |
| `--space-md` | `12px` or `16px` (must be multiple of 4) |
| `--space-lg` | `24px` or `32px` (must be multiple of 4) |
| `--space-xl` | `32px` or `40px` (must be multiple of 4) |
| `--space-2xl` | `48px` (must be multiple of 4) |
| `--space-3xl` | `64px` |

### Checks
- [ ] All spacing variables exist from `--space-xs` through `--space-3xl`
- [ ] Every value is a multiple of 4
- [ ] Scale is monotonically increasing (each step bigger than the last)
- [ ] Spacing values used throughout the UI are multiples of 4px (spot-check paddings, margins, gaps)

---

## 5. Component Styles

### 5a. Cards (`.card`)

| Property | Required Value |
|----------|---------------|
| `border-radius` | `12px` |
| `border` | `1px solid var(--border)` |
| `padding` | `20px` |
| `box-shadow` | `0 1px 3px rgba(0,0,0,0.04)` |

### Checks
- [ ] `border-radius: 12px` exactly
- [ ] Border is 1px solid using the border token
- [ ] Padding is 20px
- [ ] Shadow matches `0 1px 3px rgba(0,0,0,0.04)` (subtle, not heavy)

---

### 5b. Buttons

#### `.btn-primary`

| Property | Required Value |
|----------|---------------|
| `background` | `#002B28` |
| `color` | `#C6FF33` |
| `height` | `36px` |
| `border-radius` | `8px` |
| `font-weight` | `600` |
| `cursor` | `pointer` |

#### `.btn-secondary`

| Property | Required Value |
|----------|---------------|
| `background` | `white` / `#FFFFFF` |
| `border` | `1.5px solid #E2E8F0` |
| `height` | `36px` |
| `cursor` | `pointer` |

#### `.btn-danger`

| Property | Required Value |
|----------|---------------|
| Must exist | Uses danger color token |
| `cursor` | `pointer` |

### Checks
- [ ] Primary button: bg `#002B28`, text `#C6FF33`, height `36px`, radius `8px`, weight `600`
- [ ] Secondary button: white bg, `1.5px` border with `#E2E8F0`, height `36px`
- [ ] Danger button variant exists
- [ ] All buttons have `cursor: pointer`
- [ ] No browser-default button styling visible

---

### 5c. Inputs & Selects (`.input`, `.select`)

| Property | Required Value |
|----------|---------------|
| `height` | `36px` |
| `border-radius` | `8px` |
| Focus state | `#002B28` border + shadow ring |
| `cursor` | `pointer` (for selects and clickable inputs) |

### Checks
- [ ] Height is `36px`
- [ ] Border radius is `8px`
- [ ] Focus state shows `#002B28` border color
- [ ] Focus state has a shadow ring (not just a border change)
- [ ] No browser-default input/select appearance visible
- [ ] `cursor: pointer` on select elements

---

### 5d. Tables (`.table`)

#### Table Header (`th`)

| Property | Required Value |
|----------|---------------|
| `background` | `#F1F5F9` (bg-raised) |
| `font-size` | `12px` |
| `text-transform` | `uppercase` |
| `letter-spacing` | `0.5px` |

#### Table Body (`td`)

| Property | Required Value |
|----------|---------------|
| `font-variant-numeric` | `tabular-nums` |
| Row hover | `rgba(0,43,40,0.04)` |

### Checks
- [ ] `th` has raised background
- [ ] `th` is 12px, uppercase, with 0.5px letter-spacing
- [ ] `td` has `tabular-nums`
- [ ] Rows have hover effect using `rgba(0,43,40,0.04)`
- [ ] Numeric columns are right-aligned

---

### 5e. Badges (`.badge`)

Must have variants for: **success**, **danger**, **info**, **neutral**, **brand**

### Checks
- [ ] All 5 variants exist
- [ ] Each variant uses appropriate background and text colors
- [ ] Badge text is legible against its background (sufficient contrast)

---

### 5f. Skeleton Loading (`.skeleton`)

| Property | Required Value |
|----------|---------------|
| `background` | `#F1F5F9` (bg-raised) |
| `border-radius` | `6px` |
| Animation | `1.5s` pulse |

### Checks
- [ ] Background is `#F1F5F9`
- [ ] Border radius is `6px`
- [ ] Pulse animation runs at `1.5s` cycle
- [ ] Animation is a CSS keyframe pulse (opacity or background shift), not a shimmer/slide unless specified

---

## 6. App Shell Layout

### Sidebar

| Property | Required Value |
|----------|---------------|
| Width | `220px` |
| Position | `fixed` |
| Background | `var(--bg-surface)` / `#F8FAFC` |
| Border | `border-right` (1px solid border token) |

### Main Content

| Property | Required Value |
|----------|---------------|
| `margin-left` | `220px` |
| Background | `var(--bg-canvas)` / `#FFFFFF` |
| Padding | `24px` |

### Navigation Items

| Property | Required Value |
|----------|---------------|
| Font size | `14px` |
| Default color | `var(--text-secondary)` |
| Hover | Rounded `10px`, bg-hover background |
| Active | `accent-subtle` background |
| Left-border indicator | **MUST NOT EXIST** |
| `cursor` | `pointer` |

### Checks
- [ ] Sidebar is exactly 220px wide
- [ ] Sidebar is `position: fixed`
- [ ] Sidebar uses bg-surface background
- [ ] Sidebar has a `border-right`
- [ ] Main content has `margin-left: 220px`
- [ ] Main content uses bg-canvas background
- [ ] Main content has `24px` padding
- [ ] Main content area scrolls independently (sidebar stays fixed)
- [ ] Nav items are 14px, text-secondary by default
- [ ] Nav hover: rounded 10px with bg-hover
- [ ] Nav active: accent-subtle background
- [ ] Nav items do NOT have a left-border indicator (no left colored bar/stripe)
- [ ] All nav items have `cursor: pointer`

---

## 7. Interaction & Accessibility

### The Lime Rule 🚨

`#C6FF33` (accent-lime) must **NEVER** be used as `color` (text) on any light or white background. Acceptable uses:
- `background-color` on dark backgrounds
- `color` ONLY on dark backgrounds (e.g., inside `.btn-primary` which has `#002B28` bg)
- `border-color`
- SVG `fill` / `stroke`

### Checks
- [ ] Search all instances of `#C6FF33`, `accent-lime`, `--accent-lime` — none used as text on light bg
- [ ] All interactive elements have `cursor: pointer`: buttons, links, dropdowns, tabs, nav items, toggles, checkboxes, date pickers
- [ ] Minimum clickable target height is `32px` on all interactive elements
- [ ] No browser-default styled inputs, selects, or buttons are visible

---

## 8. Date Pickers

| Rule | Required Behavior |
|------|-------------------|
| "To" date | Must never be earlier than "from" date |
| Disabled dates | Dates before "from" value are disabled and unselectable |
| Default range | Must be logically valid (from < to) |
| Placeholder range | Must be logically valid |
| `cursor` | `pointer` |

### Checks
- [ ] "To" date cannot be set before "from" date
- [ ] Dates earlier than "from" are disabled in the "to" picker
- [ ] Default date range is valid
- [ ] Placeholder date range is valid
- [ ] Date picker elements have `cursor: pointer`

---

## 9. Dropdowns & Selects

| Rule | Required Behavior |
|------|-------------------|
| Click target | The **entire trigger area** (label, value, chevron, padding) must be clickable |
| `cursor` | `pointer` on the full trigger area |

### Checks
- [ ] Clicking anywhere on the dropdown trigger opens it (not just the text)
- [ ] `cursor: pointer` on the full trigger area
- [ ] Chevron/arrow icon is present and part of the clickable area
- [ ] Dropdown appearance is custom-styled (no browser default)