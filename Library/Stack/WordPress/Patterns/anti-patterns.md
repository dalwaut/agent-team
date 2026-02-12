# Fusion Builder Anti-Patterns

Common mistakes to avoid when generating Fusion Builder pages.

## Structural Errors

### Columns don't sum to 1
```
BAD:  [fusion_builder_column type="1_3"] + [fusion_builder_column type="1_3"]
      (sums to 2/3, missing 1/3 of the row)

GOOD: [fusion_builder_column type="1_3"] × 3 (sums to 1)
      [fusion_builder_column type="1_2"] × 2 (sums to 1)
```

### Elements outside columns
```
BAD:
[fusion_builder_container]
[fusion_builder_row]
[fusion_title ...]  ← Element directly in row!
[/fusion_builder_row]
[/fusion_builder_container]

GOOD:
[fusion_builder_container]
[fusion_builder_row]
[fusion_builder_column type="1_1"]
[fusion_title ...]  ← Element inside column
[/fusion_builder_column]
[/fusion_builder_row]
[/fusion_builder_container]
```

### Missing type="flex"
```
BAD:  [fusion_builder_container padding_top="80px" ...]
GOOD: [fusion_builder_container type="flex" padding_top="80px" ...]
```

### Missing admin_label
Not an error, but makes backend editing painful:
```
GOOD: [fusion_builder_container ... admin_label="Hero Section"]
```

## Design Errors

### Every element animated
Animating every single element creates visual chaos. Animate at the column level, not element level.

### Inconsistent padding
```
BAD:  Section 1: padding_top="60px", Section 2: padding_top="45px", Section 3: padding_top="80px"
GOOD: All content sections: padding_top="60px" padding_bottom="60px"
```

### Dark text on dark background
Always verify contrast when using overlay_color on images.

### All sections same background color
Creates a flat, unbroken page. Alternate between 2-3 background colors.

### Buttons with no visual distinction
CTAs should stand out from surrounding content. Use contrasting colors, larger sizes.

### Tiny body text
Never below 16px for body content. 14px only for captions/metadata.

## Performance Issues

### Nested containers
Never nest `[fusion_builder_container]` inside another container. Each section is one container.

### Excessive inline HTML styles
Use Fusion Builder parameters instead of inline CSS where possible:
```
BAD:  [fusion_text]<p style="font-size:20px; color:#333; text-align:center;">...[/fusion_text]
GOOD: [fusion_text font_size="20px" text_color="#333" content_alignment="center"]<p>...[/fusion_text]
```

### Duplicated separator patterns
If you use the same separator in every section, it stops being a design element and becomes noise.

## Content Errors

### Lorem ipsum in production
Always use real content from design-specs.md. Mark missing content with `[PLACEHOLDER: description]`.

### Dead links
Buttons should link to real pages. Use relative URLs (`/contact`) not `#` unless it's a modal trigger.

### Missing image alt text
Every `[fusion_imageframe]` should have an `alt` attribute.
