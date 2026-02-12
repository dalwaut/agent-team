# Typography System for Fusion Builder

Standard type scales for professional page layouts.

## Heading Scale

| Level | Font Size | Line Height | Use Case |
|-------|-----------|-------------|----------|
| H1 | 40-48px | 1.2-1.3 | Page hero title (one per page) |
| H2 | 28-36px | 1.3-1.4 | Section headings |
| H3 | 22-28px | 1.4-1.5 | Subsection headings, card titles |
| H4 | 18-22px | 1.4-1.5 | Minor headings, labels |
| H5 | 16-18px | 1.5 | Small headings, metadata |
| H6 | 14-16px | 1.5 | Overlines, category labels |

## Body Text

| Context | Font Size | Line Height | Letter Spacing |
|---------|-----------|-------------|----------------|
| Body paragraphs | 16-18px | 1.6-1.8 | normal |
| Large body (intro) | 18-20px | 1.7-1.9 | normal |
| Small body (captions) | 14px | 1.5 | normal |
| Button text | 14-16px | 1 | 1-2px |
| Overline text | 12-14px | 1.5 | 2-3px (uppercase) |

## Font Pairing Recommendations

| Heading Font | Body Font | Vibe |
|-------------|-----------|------|
| Playfair Display | Lato | Elegant, editorial |
| Cormorant Garamond | Montserrat | Classic luxury |
| Poppins | Open Sans | Modern, clean |
| Merriweather | Source Sans Pro | Traditional, trustworthy |
| Raleway | Roboto | Minimal, contemporary |
| DM Serif Display | DM Sans | Sophisticated, balanced |

## Fusion Builder Typography Parameters

```
[fusion_title
  font_size="36px"      ← Heading size
  line_height="1.3"     ← Heading line height
  letter_spacing="0px"  ← Normal for headings
  text_color="#3C3C3C"  ← Dark text color
  text_transform="none" ← none|uppercase|capitalize
]
```

```
[fusion_text
  font_size="17px"      ← Body size
  line_height="1.8"     ← Body line height
  letter_spacing="0px"
  text_color="#3C3C3C"
]
```

## Rules

1. One H1 per page (in the hero section)
2. H2 for each major section
3. Never skip heading levels (H1 → H3 is wrong)
4. Body text: minimum 16px for readability
5. Line height: minimum 1.6 for body text
6. Color contrast: minimum 4.5:1 ratio (WCAG AA)
