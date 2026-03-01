# Color Application Guide for Fusion Builder

How to apply brand colors consistently across page sections. Each project defines its colors in `design-specs.md`.

## Color Role Mapping

Every brand should define these roles:

| Role | Usage |
|------|-------|
| **Primary Accent** | Buttons, CTA backgrounds, highlights, hover states |
| **Secondary Accent** | Borders, subtle backgrounds, decorative elements, gold/copper tones |
| **Base Background** | Page background, clean sections (usually off-white/ivory) |
| **Alt Background** | Alternating sections (usually white or very light variant) |
| **Dark Background** | Footer CTAs, dramatic sections (charcoal/navy/dark) |
| **Text Color** | Body text, headings (usually charcoal/dark gray, never pure black) |
| **Light Text** | Text on dark backgrounds (usually white) |
| **Border/Divider** | Section separators, card borders, decorative lines |

## Section Color Patterns

### Hero Section
```
Background: Full-bleed image with dark overlay (rgba(0,0,0,0.3-0.5))
  OR Base Background color
Text: Light Text (white) on image, Text Color on solid background
Button: Primary Accent background, white text
```

### Content Sections (Alternating)
```
Section A: Base Background → Text Color text
Section B: Alt Background (white) → Text Color text
Section C: Base Background → Text Color text
(repeat pattern)
```

### CTA Banner
```
Option 1: Primary Accent background → Text Color or white text
Option 2: Dark Background → Light Text + Primary Accent button
Option 3: Secondary Accent background → Text Color text
```

### Card Sections
```
Cards: Alt Background (white) → Text Color text
Card borders: Border/Divider color, 1px solid
Card hover: liftup effect (shadow appears)
Card icons: Primary or Secondary Accent color
```

### Footer / Final CTA
```
Dark Background → Light Text
Button: Primary Accent background, white or dark text
```

## Fusion Builder Color Parameters

### Container backgrounds
```
background_color="#FDFBF7"    ← Solid color
background_image="URL"        ← Image
overlay_color="rgba(0,0,0,0.35)"  ← Overlay on image
overlay_opacity="0.35"
```

### Button colors
```
button_gradient_top_color="#F4C2C2"       ← Normal state
button_gradient_bottom_color="#F4C2C2"
button_gradient_top_color_hover="#E0A0A0"  ← Hover state (10-15% darker)
button_gradient_bottom_color_hover="#E0A0A0"
accent_color="#FFFFFF"                     ← Text color
accent_hover_color="#FFFFFF"               ← Text hover color
```

### Separator colors
```
sep_color="#F2D8D5"      ← Decorative dividers
border_size="1-2px"
```

## Accessibility

- Body text on light background: minimum 4.5:1 contrast ratio
- Large text (24px+) on light background: minimum 3:1
- Button text on accent background: minimum 4.5:1
- White text on dark overlay: verify overlay opacity provides enough contrast
- Tool: https://webaim.org/resources/contrastchecker/
