# Animation Guidelines for Fusion Builder

When and how to use animations for professional results.

## Core Principle

**Animations should enhance, never distract.** Use them to guide attention and create a sense of polish, not to show off technical capability.

## Recommended Animations

| Type | When to Use | Speed |
|------|------------|-------|
| `fade` | Default for most elements | 0.5s |
| `fade` (slow) | Hero section elements | 0.8s |
| `slide` | Image reveals, secondary elements | 0.5s |
| `none` | Navigation elements, forms, repeated items | — |

## Avoid These
- `bounce` — Feels childish in most professional contexts
- `zoom` — Can be jarring
- `flash` — Too attention-grabbing
- Any animation faster than 0.3s (feels glitchy)
- Any animation slower than 1.2s (feels sluggish)

## Staggering Pattern

For sequential elements (e.g., 3 cards in a row):

```
Column 1: animation_delay="0"
Column 2: animation_delay="0.2"
Column 3: animation_delay="0.4"
```

For hero section elements (title → text → button):
```
Title: animation_delay="0"    speed="0.8"
Text:  animation_delay="0.3"  speed="0.5"
Button: animation_delay="0.5" speed="0.5"
```

## Direction Guidelines

| Element Position | Direction |
|-----------------|-----------|
| Center content | `static` or no direction (pure fade) |
| Left column | `left` |
| Right column | `right` |
| Top element in section | `down` |
| Bottom element | `up` |
| Cards in a row | `left`, `down`, `right` (or all `static`) |

## Animation Offset

Controls when animation triggers:

| Value | When It Fires |
|-------|--------------|
| `top-into-view` | As soon as element enters viewport (default) |
| `top-mid-of-view` | When element reaches middle of viewport |
| `bottom-in-view` | When element is fully visible |

**Recommendation**: Use `top-into-view` for most elements. Use `top-mid-of-view` for CTA sections you want to feel more intentional.

## Rules

1. Maximum 3-4 animated elements visible at once
2. Hero section: animate title, subtitle, and CTA button only
3. Card sections: animate the columns, not individual elements inside them
4. Never animate the same element type differently across the page
5. CTA banners: single fade for the whole column, not per-element
6. Forms: never animate form fields
7. Separators and decorative elements: no animation needed
