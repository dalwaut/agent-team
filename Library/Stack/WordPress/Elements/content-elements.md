# Content Elements — Fusion Builder

Core text, button, and separator elements.

---

## Title (`fusion_title`)

Section headings and page titles.

```
[fusion_title
  title_type="text"
  heading_size="2"
  content_align="left"
  style_type="default"
  font_size="36px"
  line_height="1.3"
  letter_spacing="0px"
  text_color="#3C3C3C"
  text_transform="none"
  margin_top="0px"
  margin_bottom="20px"
  animation_type="fade"
  animation_speed="0.5"
]
Section Heading Here
[/fusion_title]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `heading_size` | `1`–`6` | HTML heading level (h1–h6) |
| `content_align` | `left` / `center` / `right` | Text alignment |
| `style_type` | `default` / `single solid` / `double solid` / `underline` / `none` | Decorative line style |
| `sep_color` | `#E8C39E` | Color of the decorative line |
| `font_size` | `36px` | Font size |
| `line_height` | `1.3` | Line height ratio |
| `text_color` | `#3C3C3C` | Text color |
| `text_transform` | `none` / `uppercase` / `capitalize` | Text case |
| `margin_top` | `0px` | Top margin |
| `margin_bottom` | `20px` | Bottom margin |

**Rules:**
- One `heading_size="1"` per page (hero only)
- `heading_size="2"` for section headings
- Never skip levels (2 → 4 is wrong)
- Use `style_type="single solid"` with `sep_color` for decorated headings

---

## Text (`fusion_text`)

Body paragraphs and rich text content.

```
[fusion_text
  font_size="17px"
  line_height="1.8"
  letter_spacing="0px"
  text_color="#3C3C3C"
  content_alignment="left"
  animation_type=""
]
<p>Your paragraph text here. Use HTML paragraphs inside fusion_text blocks.</p>
<p>Multiple paragraphs are fine within one fusion_text element.</p>
[/fusion_text]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `font_size` | `17px` | Body text size (minimum 16px) |
| `line_height` | `1.8` | Line height (minimum 1.6 for body) |
| `text_color` | `#3C3C3C` | Text color |
| `content_alignment` | `left` / `center` / `right` | Alignment |
| `columns` | `1` / `2` / `3` | Multi-column text layout |
| `column_spacing` | `30px` | Gap between text columns |

**Rules:**
- Always wrap content in `<p>` tags
- Use Fusion Builder parameters for styling, not inline CSS
- Minimum 16px font size for body text
- Line height minimum 1.6 for readability

---

## Button (`fusion_button`)

Call-to-action buttons and links.

```
[fusion_button
  link="/contact"
  target="_self"
  title="Contact Us"
  alignment="center"
  size="large"
  type="flat"
  shape="pill"
  color="custom"
  button_gradient_top_color="#F4C2C2"
  button_gradient_bottom_color="#F4C2C2"
  button_gradient_top_color_hover="#E0A0A0"
  button_gradient_bottom_color_hover="#E0A0A0"
  accent_color="#FFFFFF"
  accent_hover_color="#FFFFFF"
  border_width="0"
  border_color=""
  font_size="16px"
  letter_spacing="1px"
  text_transform="uppercase"
  padding_top="14px"
  padding_bottom="14px"
  padding_left="35px"
  padding_right="35px"
  animation_type="fade"
  animation_speed="0.5"
]Contact Us[/fusion_button]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `link` | `/contact` | Use relative URLs for internal pages |
| `target` | `_self` / `_blank` | Link target |
| `alignment` | `left` / `center` / `right` | Button position |
| `size` | `small` / `medium` / `large` / `xlarge` | Predefined sizes |
| `type` | `flat` / `3d` | Button depth style |
| `shape` | `square` / `round` / `pill` | Corner style |
| `color` | `custom` / `default` / `green` / `red` / etc. | Use `custom` for brand colors |
| `button_gradient_top_color` | `#F4C2C2` | Normal state top gradient |
| `button_gradient_bottom_color` | `#F4C2C2` | Normal state bottom (same = flat) |
| `button_gradient_top_color_hover` | `#E0A0A0` | Hover state (10-15% darker) |
| `button_gradient_bottom_color_hover` | `#E0A0A0` | Hover state bottom |
| `accent_color` | `#FFFFFF` | Text color |
| `accent_hover_color` | `#FFFFFF` | Text hover color |
| `border_width` | `0` / `1` / `2` | Border thickness |
| `border_color` | `#E8C39E` | Border color |
| `font_size` | `16px` | Button text size |
| `letter_spacing` | `1px` | Character spacing |
| `text_transform` | `uppercase` / `none` | Text case |
| `padding_top/bottom/left/right` | `14px` / `35px` | Custom padding |
| `icon` | `fa-arrow-right fas` | FontAwesome icon |
| `icon_position` | `left` / `right` | Icon placement |

**Button Styles:**

| Style | Use Case |
|-------|----------|
| Primary (brand accent bg) | Main CTA — "Book Now", "Shop Now" |
| Secondary (outline/border) | Secondary action — "Learn More" |
| Ghost (transparent + border) | On dark backgrounds |
| Text link (no bg) | Tertiary actions |

---

## Separator (`fusion_separator`)

Decorative dividers between elements or sections.

```
[fusion_separator
  style_type="single solid"
  sep_color="#E8C39E"
  border_size="1"
  width="60px"
  alignment="center"
  margin_top="20px"
  margin_bottom="25px"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `style_type` | `none` / `single solid` / `double solid` / `dashed` / `dotted` / `shadow` | Line style |
| `sep_color` | `#E8C39E` | Line color |
| `border_size` | `1` / `2` | Line thickness (px) |
| `width` | `60px` / `100%` | Line width |
| `alignment` | `center` / `left` / `right` | Position |
| `margin_top` | `20px` | Space above |
| `margin_bottom` | `25px` | Space below |

**Rules:**
- Short decorative separators: `width="60px"` with accent color
- Full-width dividers: `width="100%"` with border/divider color
- Don't animate separators
- Don't overuse — if every section has one, it becomes noise

---

## Content Box / Icon Box (`fusion_content_boxes` + `fusion_content_box`)

Feature cards with icon, title, and description.

```
[fusion_content_boxes
  layout="icon-on-top"
  columns="3"
  icon_align="left"
  animation_type="fade"
  animation_speed="0.5"
  animation_delay="0"
]
  [fusion_content_box
    title="Feature Title"
    icon="fa-heart fas"
    iconcolor="#F4C2C2"
    iconcolor_hover="#E0A0A0"
    circlecolor=""
    circlebordercolor=""
    backgroundcolor=""
    link="/services"
    linktext="Learn More"
    animation_type=""
  ]
  Description text for this feature card.
  [/fusion_content_box]
  [fusion_content_box
    title="Second Feature"
    icon="fa-star fas"
    ...
  ]
  Second feature description.
  [/fusion_content_box]
[/fusion_content_boxes]
```

| Parameter (parent) | Values | Notes |
|--------------------|--------|-------|
| `layout` | `icon-on-top` / `icon-on-side` / `icon-with-title` / `icon-boxed` / `clean-vertical` / `clean-horizontal` | Layout style |
| `columns` | `1`–`6` | Number of columns |
| `icon_align` | `left` / `right` / `center` | Icon alignment |

| Parameter (child) | Values | Notes |
|-------------------|--------|-------|
| `title` | `"Feature Title"` | Card heading |
| `icon` | `fa-heart fas` | FontAwesome icon class |
| `iconcolor` | `#F4C2C2` | Icon color |
| `circlecolor` | `#FDFBF7` | Circle background behind icon |
| `circlebordercolor` | `#E8C39E` | Circle border |
| `backgroundcolor` | `#FFFFFF` | Card background |
| `link` | `/services` | Card link |
| `linktext` | `"Learn More"` | Link text |

---

## Checklist (`fusion_checklist` + `fusion_li_item`)

Bulleted lists with custom icons.

```
[fusion_checklist
  icon="fa-check fas"
  iconcolor="#F4C2C2"
  circle="no"
  size="16px"
]
  [fusion_li_item icon=""]Feature or benefit one[/fusion_li_item]
  [fusion_li_item icon=""]Feature or benefit two[/fusion_li_item]
  [fusion_li_item icon=""]Feature or benefit three[/fusion_li_item]
[/fusion_checklist]
```

Use for: feature lists, benefits, included items, service details.
