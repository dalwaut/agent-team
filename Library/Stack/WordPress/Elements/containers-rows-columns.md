# Containers, Rows & Columns — Fusion Builder Layout Structure

The foundation of every Fusion Builder page. Every element MUST live inside this hierarchy:

```
[fusion_builder_container]        ← Section (full-width wrapper)
  [fusion_builder_row]            ← Row (content-width grid)
    [fusion_builder_column]       ← Column (grid cell)
      ...elements here...
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Container (`fusion_builder_container`)

A container = one full-width section of the page.

### Required Parameters

| Parameter | Values | Notes |
|-----------|--------|-------|
| `type` | `flex` | **Always use flex.** Legacy mode omits this but flex is required for modern layouts. |

### Common Parameters

| Parameter | Example | Purpose |
|-----------|---------|---------|
| `hundred_percent` | `no` / `yes` | Full-width content (edge-to-edge) |
| `hundred_percent_height` | `no` / `yes` | Force container to viewport height |
| `background_color` | `#FDFBF7` | Solid background color |
| `background_image` | `URL` | Background image |
| `background_position` | `center center` | Image position |
| `background_repeat` | `no-repeat` | Image repeat |
| `background_parallax` | `none` / `fixed` / `up` / `down` | Parallax effect |
| `overlay_color` | `rgba(0,0,0,0.35)` | Color overlay on background image |
| `overlay_opacity` | `0.35` | Overlay transparency |
| `padding_top` | `80px` | Top padding |
| `padding_bottom` | `80px` | Bottom padding |
| `padding_left` | `30px` | Left padding |
| `padding_right` | `30px` | Right padding |
| `margin_top` | `0px` | Top margin |
| `margin_bottom` | `0px` | Bottom margin |
| `border_color` | `#E8E0D8` | Border color |
| `border_style` | `solid` | Border style |
| `admin_label` | `"Hero Section"` | Label visible in backend editor |
| `hide_on_mobile` | `small-visibility,medium-visibility,large-visibility` | Responsive visibility |

### Section Type Recipes

**Hero Section:**
```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  hundred_percent_height="min_height_custom"
  min_height="500px"
  background_image="IMAGE_URL"
  background_position="center center"
  background_repeat="no-repeat"
  overlay_color="rgba(0,0,0,0.35)"
  padding_top="120px"
  padding_bottom="120px"
  padding_left="20px"
  padding_right="20px"
  admin_label="Hero Section"
]
```

**Standard Content Section:**
```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="#FDFBF7"
  padding_top="80px"
  padding_bottom="80px"
  padding_left="30px"
  padding_right="30px"
  admin_label="Content Section"
]
```

**CTA Banner:**
```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="#3C3C3C"
  padding_top="60px"
  padding_bottom="60px"
  padding_left="20px"
  padding_right="20px"
  admin_label="CTA Banner"
]
```

---

## Row (`fusion_builder_row`)

A row creates the grid that holds columns. Usually needs no parameters.

```
[fusion_builder_row][/fusion_builder_row]
```

### Optional Parameters

| Parameter | Example | Purpose |
|-----------|---------|---------|
| `column_spacing` | `4%` | Gap between columns |

**Rules:**
- One row per container (in most cases)
- Multiple rows are rare but valid for complex layouts
- Never nest rows inside other rows

---

## Column (`fusion_builder_column`)

Columns define the grid layout within a row.

### Required Parameters

| Parameter | Values | Notes |
|-----------|--------|-------|
| `type` | See grid below | **Column widths in a row MUST sum to 1** |

### Column Grid

| Type | Width | Common Use |
|------|-------|-----------|
| `1_1` | 100% | Full-width content |
| `1_2` | 50% | Two-column layouts |
| `1_3` | 33.3% | Three-column cards |
| `2_3` | 66.6% | Wide column + sidebar |
| `1_4` | 25% | Four-column grids |
| `3_4` | 75% | Main content + narrow sidebar |
| `1_5` | 20% | Five-column (rare) |
| `2_5` | 40% | Flexible layouts |
| `3_5` | 60% | Flexible layouts |
| `4_5` | 80% | Wide content |
| `1_6` | 16.6% | Six-column (rare) |
| `5_6` | 83.3% | Very wide + narrow |

### Valid Combinations (must sum to 1)

```
1_1                          → 1 column, full width
1_2 + 1_2                   → 2 equal columns
1_3 + 1_3 + 1_3             → 3 equal columns
1_4 + 1_4 + 1_4 + 1_4       → 4 equal columns
2_3 + 1_3                   → Wide + narrow
3_4 + 1_4                   → Main + sidebar
1_6 + 1_6 + 1_6 + 1_6 + 1_6 + 1_6  → 6 columns
1_5 + 1_5 + 1_5 + 1_5 + 1_5 → 5 columns
```

### Common Parameters

| Parameter | Example | Purpose |
|-----------|---------|---------|
| `spacing` | `yes` / `no` | Column internal spacing |
| `padding_top` | `25px` | Internal padding |
| `padding_bottom` | `25px` | Internal padding |
| `padding_left` | `25px` | Internal padding |
| `padding_right` | `25px` | Internal padding |
| `background_color` | `#FFFFFF` | Column background (for cards) |
| `border_color` | `#E8E0D8` | Border color |
| `border_style` | `solid` | Border style |
| `border_radius_top_left` | `8px` | Rounded corners |
| `border_radius_top_right` | `8px` | Rounded corners |
| `border_radius_bottom_left` | `8px` | Rounded corners |
| `border_radius_bottom_right` | `8px` | Rounded corners |
| `box_shadow` | `yes` / `no` | Drop shadow |
| `box_shadow_blur` | `10` | Shadow blur amount |
| `box_shadow_spread` | `0` | Shadow spread |
| `box_shadow_color` | `rgba(0,0,0,0.1)` | Shadow color |
| `animation_type` | `fade` / `slide` / `none` | Entrance animation |
| `animation_direction` | `left` / `right` / `up` / `down` / `static` | Animation direction |
| `animation_speed` | `0.5` | Animation duration (seconds) |
| `animation_delay` | `0` | Delay before animation |
| `animation_offset` | `top-into-view` | When animation triggers |
| `hover_type` | `none` / `liftup` / `zoomin` | Hover effect |
| `link` | `/services` | Make entire column clickable |
| `min_height` | `300px` | Minimum column height |
| `align_self` | `auto` / `flex-start` / `center` / `flex-end` / `stretch` | Vertical alignment |
| `align_content` | `flex-start` / `center` / `flex-end` / `space-between` | Content alignment within column |

### Card Column Example

```
[fusion_builder_column
  type="1_3"
  padding_top="30px"
  padding_bottom="30px"
  padding_left="25px"
  padding_right="25px"
  background_color="#FFFFFF"
  border_color="#E8E0D8"
  border_style="solid"
  border_radius_top_left="8px"
  border_radius_top_right="8px"
  border_radius_bottom_left="8px"
  border_radius_bottom_right="8px"
  box_shadow="yes"
  box_shadow_blur="10"
  box_shadow_spread="0"
  box_shadow_color="rgba(0,0,0,0.08)"
  hover_type="liftup"
  animation_type="fade"
  animation_speed="0.5"
  animation_offset="top-into-view"
]
```

---

## Critical Rules

1. **Columns must sum to 1** — `1_3 + 1_3` = 2/3, which leaves a gap. Always check the math.
2. **Every element inside a column** — Never place elements directly in a row or container.
3. **Always use `type="flex"`** on containers — Omitting it uses legacy mode with different behavior.
4. **One H1 per page** — Only the hero container should have an H1 heading.
5. **admin_label every container** — Makes backend editing manageable.
6. **Never nest containers** — Each section is exactly one container. No containers inside containers.
