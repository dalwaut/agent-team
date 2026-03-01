# Commerce Elements — Fusion Builder

WooCommerce product displays and pricing tables.

---

## WooCommerce Product Grid (`fusion_woo_product_grid`)

Displays WooCommerce products in a grid layout.

```
[fusion_woo_product_grid
  number_posts="4"
  columns="4"
  column_spacing="30"
  orderby="date"
  order="DESC"
  show_title="yes"
  show_price="yes"
  show_rating="yes"
  show_buttons="yes"
  show_sale="yes"
  show_cats="no"
  grid_box_color="#FFFFFF"
  grid_border_color="#E8E0D8"
  grid_separator_style_type="none"
  grid_separator_color=""
  animation_type="fade"
  animation_speed="0.5"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `number_posts` | `4` / `8` / `12` | Products to display |
| `columns` | `2` / `3` / `4` | Grid columns |
| `column_spacing` | `30` | Gap between cards (px) |
| `orderby` | `date` / `price` / `popularity` / `rating` / `title` / `rand` | Sort method |
| `order` | `ASC` / `DESC` | Sort direction |
| `show_title` | `yes` / `no` | Product name |
| `show_price` | `yes` / `no` | Price display |
| `show_rating` | `yes` / `no` | Star rating |
| `show_buttons` | `yes` / `no` | Add to cart button |
| `show_sale` | `yes` / `no` | Sale badge |
| `show_cats` | `yes` / `no` | Category labels |
| `cat_slug` | `"boards,accessories"` | Filter by category slugs |
| `grid_box_color` | `#FFFFFF` | Card background |
| `grid_border_color` | `#E8E0D8` | Card border |

**Usage patterns:**
- Homepage featured products: `number_posts="4" columns="4"`
- Shop page grid: `number_posts="12" columns="3"`
- Category showcase: `cat_slug="featured" number_posts="3"`
- Related products: `number_posts="4" columns="4" orderby="rand"`

---

## WooCommerce Shortcodes (built-in)

These are native WooCommerce shortcodes that work inside `[fusion_text]`:

```
[fusion_text]
[products limit="4" columns="4" category="featured"]
[/fusion_text]
```

| Shortcode | Purpose |
|-----------|---------|
| `[products limit="4" columns="4"]` | Product grid |
| `[product_page id="123"]` | Single product display |
| `[sale_products limit="4"]` | On-sale products |
| `[best_selling_products limit="4"]` | Best sellers |
| `[top_rated_products limit="4"]` | Top rated |
| `[featured_products limit="4"]` | Featured products |
| `[product_categories number="6"]` | Category grid |
| `[recent_products limit="4"]` | Recently added |

---

## Pricing Table (`fusion_pricing_table` + `fusion_pricing_column`)

Comparison pricing displays.

```
[fusion_pricing_table
  type="1"
  columns="3"
  border_color="#E8E0D8"
  divider_color="#E8E0D8"
]
  [fusion_pricing_column
    title="Basic"
    standout="no"
  ]
    [fusion_pricing_price
      currency="$"
      price="29"
      time="month"
      color="#3C3C3C"
    ][/fusion_pricing_price]
    [fusion_pricing_row]5 Pages[/fusion_pricing_row]
    [fusion_pricing_row]Basic SEO[/fusion_pricing_row]
    [fusion_pricing_row]Email Support[/fusion_pricing_row]
    [fusion_pricing_row]—[/fusion_pricing_row]
    [fusion_pricing_footer]
      [fusion_button
        link="/contact"
        size="medium"
        type="flat"
        shape="pill"
        color="custom"
        button_gradient_top_color="#F4C2C2"
        button_gradient_bottom_color="#F4C2C2"
        accent_color="#FFFFFF"
      ]Get Started[/fusion_button]
    [/fusion_pricing_footer]
  [/fusion_pricing_column]

  [fusion_pricing_column
    title="Professional"
    standout="yes"
  ]
    [fusion_pricing_price
      currency="$"
      price="79"
      time="month"
      color="#F4C2C2"
    ][/fusion_pricing_price]
    [fusion_pricing_row]15 Pages[/fusion_pricing_row]
    [fusion_pricing_row]Advanced SEO[/fusion_pricing_row]
    [fusion_pricing_row]Priority Support[/fusion_pricing_row]
    [fusion_pricing_row]Monthly Reports[/fusion_pricing_row]
    [fusion_pricing_footer]
      [fusion_button
        link="/contact"
        size="large"
        type="flat"
        shape="pill"
        color="custom"
        button_gradient_top_color="#E8C39E"
        button_gradient_bottom_color="#E8C39E"
        accent_color="#FFFFFF"
      ]Get Started[/fusion_button]
    [/fusion_pricing_footer]
  [/fusion_pricing_column]

  [fusion_pricing_column
    title="Enterprise"
    standout="no"
  ]
    [fusion_pricing_price
      currency="$"
      price="149"
      time="month"
      color="#3C3C3C"
    ][/fusion_pricing_price]
    [fusion_pricing_row]Unlimited Pages[/fusion_pricing_row]
    [fusion_pricing_row]Full SEO Suite[/fusion_pricing_row]
    [fusion_pricing_row]24/7 Support[/fusion_pricing_row]
    [fusion_pricing_row]Custom Integrations[/fusion_pricing_row]
    [fusion_pricing_footer]
      [fusion_button
        link="/contact"
        size="medium"
        type="flat"
        shape="pill"
        color="custom"
        button_gradient_top_color="#F4C2C2"
        button_gradient_bottom_color="#F4C2C2"
        accent_color="#FFFFFF"
      ]Contact Us[/fusion_button]
    [/fusion_pricing_footer]
  [/fusion_pricing_column]
[/fusion_pricing_table]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `type` | `1` / `2` | Layout style |
| `columns` | `2` / `3` / `4` | Number of pricing tiers |
| `border_color` | `#E8E0D8` | Table borders |
| `divider_color` | `#E8E0D8` | Row dividers |

Child column:

| Parameter | Values | Notes |
|-----------|--------|-------|
| `title` | text | Plan name |
| `standout` | `yes` / `no` | Highlighted/featured column |

**Design tips:**
- Always highlight one column with `standout="yes"` (the recommended plan)
- Keep features aligned across columns (use "—" for missing features)
- Use a larger button on the standout column
- 3 tiers is the sweet spot; 2 or 4 also work
