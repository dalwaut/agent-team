# Layout Elements — Fusion Builder

Section separators, maps, menu anchors, and structural utilities.

---

## Section Separator (`fusion_section_separator`)

Decorative shape dividers between sections.

```
[fusion_section_separator
  divider_type="triangle"
  divider_position="center"
  divider_candy="bottom"
  bordersize="0"
  bordercolor=""
  backgroundcolor="#FDFBF7"
  hide_on_mobile="small-visibility,medium-visibility,large-visibility"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `divider_type` | `triangle` / `slant` / `bigtriangle` / `curved` / `clouds` / `horizon` | Shape type |
| `divider_position` | `left` / `center` / `right` | Shape alignment |
| `divider_candy` | `top` / `bottom` | Which edge the shape appears on |
| `backgroundcolor` | `#FDFBF7` | Color of the shape (match adjacent section) |
| `bordersize` | `0` / `1` | Outline on the shape |
| `bordercolor` | `#E8E0D8` | Outline color |

**Usage:**
- Place in its own container between content sections
- The `backgroundcolor` should match the NEXT section's background
- The container holding the separator should have the PREVIOUS section's background
- Use sparingly — one or two per page maximum

**Example: Triangle between ivory and white sections:**
```
[fusion_builder_container type="flex" background_color="#FDFBF7" padding_top="0px" padding_bottom="0px"]
  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_section_separator divider_type="triangle" divider_position="center" divider_candy="bottom" backgroundcolor="#FFFFFF"]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Google Map (`fusion_map`)

Embedded Google Map for location pages.

```
[fusion_map
  api_type="embed"
  embed_address="123 Main Street, Naples, FL"
  embed_map_type="roadmap"
  width="100%"
  height="400px"
  zoom="14"
  border_radius="8px"
  box_shadow="yes"
  box_shadow_blur="15"
  box_shadow_color="rgba(0,0,0,0.1)"
  animation_type="fade"
  animation_speed="0.5"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `api_type` | `embed` / `js` | Embed = no API key needed, JS = full features |
| `embed_address` | address string | Location to display |
| `embed_map_type` | `roadmap` / `satellite` | Map style |
| `width` | `100%` | Map width |
| `height` | `400px` | Map height |
| `zoom` | `14` | Zoom level (1-20) |
| `scrollwheel` | `yes` / `no` | Scroll to zoom |
| `border_radius` | `8px` | Corner rounding |

**For full-width maps (no padding):**
```
[fusion_builder_container type="flex" hundred_percent="yes" padding_top="0px" padding_bottom="0px" padding_left="0px" padding_right="0px"]
```

---

## Menu Anchor (`fusion_menu_anchor`)

Invisible anchor point for smooth-scroll navigation.

```
[fusion_menu_anchor name="services" class="" /]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `name` | `services` | Anchor ID (link with `#services`) |

**Usage:**
- Place at the top of each major section
- Link from navigation or buttons: `link="#services"`
- Use lowercase, hyphenated names: `about-us`, `our-services`, `contact`
- Place inside the first column of the section's container

---

## Blog (`fusion_blog`)

Displays blog posts in grid, timeline, or list format.

```
[fusion_blog
  layout="grid"
  blog_grid_columns="3"
  blog_grid_column_spacing="30"
  number_posts="6"
  orderby="date"
  order="DESC"
  cat_slug=""
  show_title="yes"
  title_link="yes"
  excerpt="yes"
  excerpt_length="25"
  strip_html="yes"
  meta_all="yes"
  meta_author="no"
  meta_categories="yes"
  meta_date="yes"
  meta_tags="no"
  scrolling="pagination"
  thumbnail="yes"
  grid_box_color="#FFFFFF"
  grid_element_color="#E8E0D8"
  grid_separator_style_type="none"
  content_alignment="left"
  animation_type="fade"
  animation_speed="0.5"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `layout` | `grid` / `timeline` / `large` / `large-alternate` / `medium` / `medium-alternate` | Blog layout |
| `blog_grid_columns` | `2` / `3` / `4` | Columns for grid layout |
| `blog_grid_column_spacing` | `30` | Gap between posts |
| `number_posts` | `6` | Posts to show |
| `orderby` | `date` / `title` / `rand` | Sort method |
| `cat_slug` | `"news,updates"` | Filter by category |
| `excerpt` | `yes` / `no` | Show excerpt |
| `excerpt_length` | `25` | Words in excerpt |
| `scrolling` | `pagination` / `infinite` / `load-more-button` | Pagination type |
| `thumbnail` | `yes` / `no` | Show featured image |
| `grid_box_color` | `#FFFFFF` | Card background (grid) |

---

## Portfolio (`fusion_portfolio`)

Displays portfolio/project items.

```
[fusion_portfolio
  layout="grid"
  columns="3"
  column_spacing="30"
  number_posts="6"
  portfolio_title_display="all"
  portfolio_text_alignment="left"
  filters="yes"
  pull_by="category"
  cat_slug=""
  content_length="excerpt"
  excerpt_length="25"
  picture_size="auto"
  boxed_text="yes"
  grid_box_color="#FFFFFF"
  grid_element_color="#E8E0D8"
  animation_type="fade"
  animation_speed="0.5"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `layout` | `grid` / `masonry` / `grid-with-text` / `masonry-with-text` | Portfolio layout |
| `columns` | `2` / `3` / `4` | Grid columns |
| `filters` | `yes` / `no` | Show category filter tabs |
| `portfolio_title_display` | `all` / `title` / `cats` / `none` | Title display options |
| `boxed_text` | `yes` / `no` | Text in boxed card |
| `content_length` | `excerpt` / `full_content` / `no_text` | Content display |

---

## Testimonials (`fusion_testimonials` + `fusion_testimonial`)

Customer review carousel/slider.

```
[fusion_testimonials
  design="classic"
  backgroundcolor="#FFFFFF"
  textcolor="#3C3C3C"
  speed="5000"
  random="no"
]
  [fusion_testimonial
    name="Customer Name"
    avatar="image"
    image="AVATAR_URL"
    image_border_radius="50%"
    company="Company Name"
    link="https://example.com"
    target="_blank"
  ]
  "This is the testimonial quote text. Keep it genuine and specific."
  [/fusion_testimonial]
  [fusion_testimonial
    name="Second Customer"
    avatar="image"
    image="AVATAR_URL_2"
    image_border_radius="50%"
    company="Their Company"
  ]
  "Another testimonial with specific praise and results."
  [/fusion_testimonial]
[/fusion_testimonials]
```

| Parameter (parent) | Values | Notes |
|--------------------|--------|-------|
| `design` | `classic` / `clean` | Testimonial style |
| `backgroundcolor` | `#FFFFFF` | Background |
| `textcolor` | `#3C3C3C` | Quote text color |
| `speed` | `5000` | Auto-rotate speed (ms), 0 = no auto |
| `random` | `yes` / `no` | Randomize order |

| Parameter (child) | Values | Notes |
|-------------------|--------|-------|
| `name` | text | Customer name |
| `avatar` | `image` / `none` | Show avatar |
| `image` | URL | Avatar image |
| `image_border_radius` | `50%` | Circular avatar |
| `company` | text | Company/title |
| `link` | URL | Link to source |
