# Fusion Builder Quality Scoring Rubric

Used by the Design Reviewer agent (`Templates/prompt_design_reviewer.txt`) to score generated pages.

## 10 Criteria (1-10 each, 100 total)

| # | Criterion | Weight | What It Measures |
|---|-----------|--------|------------------|
| 1 | Visual Hierarchy | 10 | Eye flow, heading sizes, focal point |
| 2 | Spacing Consistency | 10 | Uniform padding/margins, breathing room |
| 3 | Color Usage | 10 | Brand adherence, contrast, accessibility |
| 4 | Mobile Responsiveness | 10 | Stacking, touch targets, readable sizes |
| 5 | CTA Prominence | 10 | Above-fold CTA, visual distinction, placement |
| 6 | Typography Rhythm | 10 | Size hierarchy, readability, consistency |
| 7 | Shortcode Validity | 10 | Proper nesting, closed tags, column math |
| 8 | Animation Restraint | 10 | Subtle, purposeful, not overdone |
| 9 | Content Density | 10 | Whitespace, scannability, focus |
| 10 | Professional Polish | 10 | Overall impression, agency-quality feel |

## Grade Scale

| Grade | Score Range | Meaning |
|-------|------------|---------|
| **A** | 90-100 | Production-ready. Ship without changes. |
| **B** | 80-89 | Good. Minor tweaks improve it. |
| **C** | 70-79 | Acceptable. Notable improvements possible. |
| **D** | 60-69 | Below standard. Significant rework. |
| **F** | <60 | Unacceptable. Rebuild required. |

## Score Anchors

### Visual Hierarchy
- **10**: Crystal-clear hierarchy, impossible to get lost
- **7**: Good flow, minor competition between sections
- **5**: Adequate but some sections fight for attention
- **3**: Confused hierarchy, unclear where to look
- **1**: Flat, everything same size/weight

### Spacing Consistency
- **10**: Pixel-perfect rhythm, consistent scale
- **7**: Mostly consistent, one or two anomalies
- **5**: Some random padding values
- **3**: Notably uneven, cramped areas
- **1**: No consistent spacing system

### Color Usage
- **10**: Perfect brand adherence, accessible, intentional
- **7**: On-brand with minor deviations
- **5**: Mostly correct but some off-palette elements
- **3**: Inconsistent color application
- **1**: Wrong colors, poor contrast, brand violations

### Mobile Responsiveness
- **10**: Fully responsive, graceful stacking
- **7**: Will work on mobile with minor quirks
- **5**: Stacks but some elements look odd
- **3**: Significant layout issues on mobile
- **1**: Will break on mobile

### CTA Prominence
- **10**: Clear, compelling CTAs everywhere needed
- **7**: Good CTA placement, could be more prominent
- **5**: CTAs exist but don't stand out
- **3**: CTAs buried or unclear
- **1**: No CTAs or completely hidden

### Shortcode Validity
- **10**: Zero syntax errors, perfect nesting
- **7**: All tags closed, minor attribute issues
- **5**: One column math error or nesting issue
- **3**: Multiple syntax problems
- **1**: Broken nesting, unclosed tags

### Animation Restraint
- **10**: Elegant, subtle, enhances experience
- **7**: Appropriate animations, slightly frequent
- **5**: Acceptable but some overuse
- **3**: Too many animations, distracting
- **1**: Everything animated, seizure risk

### Content Density
- **10**: Luxurious whitespace, scannable, focused
- **7**: Good density, one cramped section
- **5**: Adequate but some walls of text
- **3**: Notably cramped or text-heavy
- **1**: No breathing room, wall-to-wall text

### Professional Polish
- **10**: Indistinguishable from $5K agency build
- **7**: Professional, minor rough edges
- **5**: Decent but clearly template-y
- **3**: Amateurish elements present
- **1**: Looks broken or unfinished
