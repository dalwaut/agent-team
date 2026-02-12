# Fusion Builder Review Checklist

Quick pre-flight checklist before deploying any generated page.

## Structure
- [ ] Every container has `type="flex"`
- [ ] Every container has a matching `[/fusion_builder_container]`
- [ ] Every row is inside a container
- [ ] Every column is inside a row
- [ ] Column widths sum to exactly 1 per row
- [ ] Elements are inside columns only (never in rows or containers)
- [ ] Every container has an `admin_label` for backend organization

## Design
- [ ] Brand colors from design-specs.md are applied correctly
- [ ] At least one CTA button above the fold
- [ ] Heading hierarchy: H1 → H2 → H3 (no skipped levels)
- [ ] Consistent section padding (60-80px top/bottom standard)
- [ ] Alternating backgrounds create visual rhythm
- [ ] Decorative separators between contrasting sections
- [ ] Images have alt text

## Typography
- [ ] Body text: 16-18px, line-height 1.6-1.8
- [ ] Headings use designated heading font
- [ ] No more than 3 font size variations per page
- [ ] Sufficient color contrast (dark text on light, white text on dark/overlay)

## Mobile
- [ ] Multi-column layouts will stack on mobile
- [ ] Buttons are large enough for touch (44x44px minimum)
- [ ] No hardcoded pixel widths that prevent scaling
- [ ] `hide_on_mobile` used for purely decorative elements where appropriate

## Animation
- [ ] Animations are `fade` type (not bounce/zoom unless intentional)
- [ ] Speed is 0.3-0.8 seconds
- [ ] Staggered delays (0, 0.2, 0.4) for sequential elements
- [ ] Hero section animations slightly slower (0.8s) for drama
- [ ] No more than 3-4 animated elements visible at once

## Content
- [ ] Placeholder images marked with `[IMAGE_PLACEHOLDER]`
- [ ] Real content from design-specs.md is used where available
- [ ] Buttons link to correct pages
- [ ] Menu anchors have proper `name` values
- [ ] No lorem ipsum in production pages

## Performance
- [ ] Images use URLs (not base64 embedded)
- [ ] No unnecessarily nested containers
- [ ] Shortcode is clean (no excessive empty attributes)
