# Hero Section Patterns — Fusion Builder

Tested hero section recipes. Choose based on content type and brand aesthetic.

---

## Pattern 1: Full-Image Hero with Overlay

The most common hero. Full-width background image with dark overlay for text contrast.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  hundred_percent_height="min_height_custom"
  min_height="550px"
  background_image="HERO_IMAGE_URL"
  background_position="center center"
  background_repeat="no-repeat"
  fade="no"
  background_parallax="none"
  overlay_color="rgba(0,0,0,0.35)"
  padding_top="120px"
  padding_bottom="120px"
  padding_left="20px"
  padding_right="20px"
  admin_label="Hero — Image with Overlay"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_1" align_content="center"]
      [fusion_title
        heading_size="1"
        content_align="center"
        font_size="46px"
        line_height="1.2"
        text_color="#FFFFFF"
        margin_bottom="15px"
        animation_type="fade"
        animation_speed="0.8"
        animation_delay="0"
      ]
      Page Headline Here
      [/fusion_title]

      [fusion_text
        font_size="18px"
        line_height="1.7"
        text_color="rgba(255,255,255,0.9)"
        content_alignment="center"
        animation_type="fade"
        animation_speed="0.5"
        animation_delay="0.3"
      ]
      <p>Supporting subtitle text that expands on the headline. One to two sentences.</p>
      [/fusion_text]

      [fusion_button
        link="/contact"
        alignment="center"
        size="large"
        type="flat"
        shape="pill"
        color="custom"
        button_gradient_top_color="PRIMARY_ACCENT"
        button_gradient_bottom_color="PRIMARY_ACCENT"
        button_gradient_top_color_hover="PRIMARY_ACCENT_DARKER"
        button_gradient_bottom_color_hover="PRIMARY_ACCENT_DARKER"
        accent_color="#FFFFFF"
        accent_hover_color="#FFFFFF"
        font_size="16px"
        letter_spacing="1px"
        text_transform="uppercase"
        padding_top="16px"
        padding_bottom="16px"
        padding_left="40px"
        padding_right="40px"
        animation_type="fade"
        animation_speed="0.5"
        animation_delay="0.5"
      ]Call to Action[/fusion_button]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

**When to use:** Landing pages, home pages, any page that needs immediate visual impact.

---

## Pattern 2: Split Hero (Text + Image)

Two-column hero with text on one side and image on the other.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="100px"
  padding_bottom="100px"
  padding_left="30px"
  padding_right="30px"
  admin_label="Hero — Split Text+Image"
]
  [fusion_builder_row]
    [fusion_builder_column
      type="1_2"
      align_self="center"
      padding_right="40px"
      animation_type="fade"
      animation_direction="left"
      animation_speed="0.5"
    ]
      [fusion_title
        heading_size="1"
        content_align="left"
        font_size="44px"
        line_height="1.2"
        text_color="TEXT_COLOR"
        margin_bottom="20px"
      ]
      Bold Headline
      [/fusion_title]

      [fusion_text font_size="17px" line_height="1.8" text_color="TEXT_COLOR"]
      <p>One to two paragraphs of supporting text that explains the value proposition.</p>
      [/fusion_text]

      [fusion_button
        link="/services"
        alignment="left"
        size="large"
        type="flat"
        shape="pill"
        color="custom"
        button_gradient_top_color="PRIMARY_ACCENT"
        button_gradient_bottom_color="PRIMARY_ACCENT"
        accent_color="#FFFFFF"
        margin_top="10px"
      ]Learn More[/fusion_button]
    [/fusion_builder_column]

    [fusion_builder_column
      type="1_2"
      animation_type="fade"
      animation_direction="right"
      animation_speed="0.5"
      animation_delay="0.2"
    ]
      [fusion_imageframe
        image="HERO_IMAGE_URL"
        alt="Descriptive alt text"
        style_type="none"
        border_radius="12px"
        box_shadow="yes"
        box_shadow_blur="20"
        box_shadow_color="rgba(0,0,0,0.12)"
      ]HERO_IMAGE_URL[/fusion_imageframe]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

**When to use:** About pages, service pages, product showcases. Works well when you have a strong supporting image.

---

## Pattern 3: Minimal / Text-Only Hero

Clean, text-centered hero with solid background. Elegant and fast-loading.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="100px"
  padding_bottom="80px"
  padding_left="20px"
  padding_right="20px"
  admin_label="Hero — Minimal Text"
]
  [fusion_builder_row]
    [fusion_builder_column type="2_3" center_content="yes" align_self="center" margin_left="auto" margin_right="auto"]
      [fusion_text font_size="13px" letter_spacing="2px" text_color="SECONDARY_ACCENT" content_alignment="center" text_transform="uppercase"]
      <p>CATEGORY OR OVERLINE</p>
      [/fusion_text]

      [fusion_title
        heading_size="1"
        content_align="center"
        font_size="48px"
        line_height="1.2"
        text_color="TEXT_COLOR"
        margin_bottom="20px"
        animation_type="fade"
        animation_speed="0.8"
      ]
      The Main Headline
      [/fusion_title]

      [fusion_separator style_type="single solid" sep_color="SECONDARY_ACCENT" border_size="2" width="60px" alignment="center" margin_top="10px" margin_bottom="25px"]

      [fusion_text font_size="18px" line_height="1.8" text_color="TEXT_COLOR" content_alignment="center"]
      <p>A short, compelling description that frames the page content. Keep it to two or three sentences maximum.</p>
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

**When to use:** Blog landing pages, informational pages, pages where the content IS the hero.

---

## Pattern 4: Video Background Hero

Background video with text overlay. High impact but heavier load.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  hundred_percent_height="min_height_custom"
  min_height="500px"
  video_url="VIDEO_URL"
  video_loop="yes"
  video_mute="yes"
  overlay_color="rgba(0,0,0,0.45)"
  padding_top="120px"
  padding_bottom="120px"
  admin_label="Hero — Video Background"
]
  [fusion_builder_row]
    [fusion_builder_column type="2_3" center_content="yes" align_self="center" margin_left="auto" margin_right="auto"]
      [fusion_title heading_size="1" content_align="center" font_size="46px" text_color="#FFFFFF" animation_type="fade" animation_speed="0.8"]
      Impactful Headline
      [/fusion_title]

      [fusion_text font_size="18px" text_color="rgba(255,255,255,0.9)" content_alignment="center"]
      <p>Brief supporting text.</p>
      [/fusion_text]

      [fusion_button link="/contact" alignment="center" size="large" color="custom" button_gradient_top_color="PRIMARY_ACCENT" button_gradient_bottom_color="PRIMARY_ACCENT" accent_color="#FFFFFF" shape="pill"]Get Started[/fusion_button]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

**When to use:** Home pages for creative agencies, restaurants, event venues. Use sparingly — one per site maximum.

---

## Pattern 5: Hero with Background Gradient

Gradient background instead of image. Modern, lightweight, no image dependency.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  gradient_start_color="DARK_BACKGROUND"
  gradient_end_color="PRIMARY_ACCENT"
  gradient_type="linear"
  gradient_direction="135deg"
  padding_top="120px"
  padding_bottom="120px"
  padding_left="20px"
  padding_right="20px"
  admin_label="Hero — Gradient"
]
  [fusion_builder_row]
    [fusion_builder_column type="2_3" center_content="yes" align_self="center" margin_left="auto" margin_right="auto"]
      [fusion_title heading_size="1" content_align="center" font_size="46px" text_color="#FFFFFF" animation_type="fade"]
      Modern Headline
      [/fusion_title]

      [fusion_text font_size="18px" text_color="rgba(255,255,255,0.9)" content_alignment="center"]
      <p>Supporting text on gradient background.</p>
      [/fusion_text]

      [fusion_button link="/signup" alignment="center" size="large" color="custom" button_gradient_top_color="#FFFFFF" button_gradient_bottom_color="#FFFFFF" accent_color="DARK_BACKGROUND" shape="pill" font_size="16px" letter_spacing="1px"]Get Started[/fusion_button]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

**When to use:** SaaS, tech companies, modern brands. The inverted button (white bg, dark text) stands out well against gradients.

---

## Hero Design Rules

1. **One hero per page** — always the first container
2. **One H1 per page** — always in the hero
3. **Maximum 3 animated elements** — title, subtitle, button
4. **CTA above the fold** — button visible without scrolling
5. **Minimum overlay opacity 0.3** — for readable text on images
6. **Test on mobile** — hero text must be legible on small screens
7. **Stagger animations** — title (0s) → text (0.3s) → button (0.5s)
