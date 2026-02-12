# Testimonial Section Patterns — Fusion Builder

Social proof sections that build trust and credibility.

---

## Pattern 1: Carousel Testimonials (Slider)

Auto-rotating testimonial carousel. Compact and engaging.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="ALT_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  padding_left="30px"
  padding_right="30px"
  admin_label="Testimonials — Carousel"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_title heading_size="2" content_align="center" font_size="32px" text_color="TEXT_COLOR" margin_bottom="10px"]
      What Our Clients Say
      [/fusion_title]

      [fusion_separator style_type="single solid" sep_color="SECONDARY_ACCENT" border_size="2" width="60px" alignment="center" margin_top="10px" margin_bottom="40px"]
    [/fusion_builder_column]
  [/fusion_builder_row]

  [fusion_builder_row]
    [fusion_builder_column type="2_3" center_content="yes" margin_left="auto" margin_right="auto"]
      [fusion_testimonials
        design="classic"
        backgroundcolor="transparent"
        textcolor="TEXT_COLOR"
        speed="6000"
        random="no"
      ]
        [fusion_testimonial
          name="Customer Name"
          avatar="image"
          image="AVATAR_1_URL"
          image_border_radius="50%"
          company="Their Business"
        ]
        "Specific, genuine testimonial quote. Mentions concrete results or experiences. Two to three sentences maximum."
        [/fusion_testimonial]
        [fusion_testimonial
          name="Second Customer"
          avatar="image"
          image="AVATAR_2_URL"
          image_border_radius="50%"
          company="Company Name"
        ]
        "Another genuine testimonial. Each should highlight a different aspect of your service."
        [/fusion_testimonial]
        [fusion_testimonial
          name="Third Customer"
          avatar="image"
          image="AVATAR_3_URL"
          image_border_radius="50%"
          company="Their Company"
        ]
        "Third testimonial focusing on yet another benefit or quality."
        [/fusion_testimonial]
      [/fusion_testimonials]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Pattern 2: Static Testimonial Cards

Three testimonial cards displayed simultaneously. No carousel.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  admin_label="Testimonials — Static Cards"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_title heading_size="2" content_align="center" font_size="32px" text_color="TEXT_COLOR" margin_bottom="40px"]
      Client Reviews
      [/fusion_title]
    [/fusion_builder_column]
  [/fusion_builder_row]

  [fusion_builder_row]
    [fusion_builder_column type="1_3" padding_top="30px" padding_bottom="30px" padding_left="25px" padding_right="25px" background_color="ALT_BACKGROUND" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="10" box_shadow_color="rgba(0,0,0,0.06)" animation_type="fade" animation_delay="0"]
      [fusion_fontawesome icon="fa-quote-left fas" size="24px" iconcolor="SECONDARY_ACCENT" alignment="left" margin_bottom="15px" /]

      [fusion_text font_size="16px" line_height="1.7" text_color="TEXT_COLOR" font_style="italic"]
      <p>"Testimonial quote text goes here. Keep it concise and impactful."</p>
      [/fusion_text]

      [fusion_separator style_type="single solid" sep_color="BORDER_COLOR" border_size="1" margin_top="15px" margin_bottom="15px" /]

      [fusion_text font_size="15px" text_color="TEXT_COLOR"]
      <p><strong>Customer Name</strong><br><span style="color: SECONDARY_ACCENT;">Company / Title</span></p>
      [/fusion_text]
    [/fusion_builder_column]

    [fusion_builder_column type="1_3" padding_top="30px" padding_bottom="30px" padding_left="25px" padding_right="25px" background_color="ALT_BACKGROUND" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="10" box_shadow_color="rgba(0,0,0,0.06)" animation_type="fade" animation_delay="0.2"]
      [fusion_fontawesome icon="fa-quote-left fas" size="24px" iconcolor="SECONDARY_ACCENT" alignment="left" margin_bottom="15px" /]

      [fusion_text font_size="16px" line_height="1.7" text_color="TEXT_COLOR" font_style="italic"]
      <p>"Second testimonial quote. Different angle on the experience."</p>
      [/fusion_text]

      [fusion_separator style_type="single solid" sep_color="BORDER_COLOR" border_size="1" margin_top="15px" margin_bottom="15px" /]

      [fusion_text font_size="15px" text_color="TEXT_COLOR"]
      <p><strong>Second Customer</strong><br><span style="color: SECONDARY_ACCENT;">Their Company</span></p>
      [/fusion_text]
    [/fusion_builder_column]

    [fusion_builder_column type="1_3" padding_top="30px" padding_bottom="30px" padding_left="25px" padding_right="25px" background_color="ALT_BACKGROUND" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="10" box_shadow_color="rgba(0,0,0,0.06)" animation_type="fade" animation_delay="0.4"]
      [fusion_fontawesome icon="fa-quote-left fas" size="24px" iconcolor="SECONDARY_ACCENT" alignment="left" margin_bottom="15px" /]

      [fusion_text font_size="16px" line_height="1.7" text_color="TEXT_COLOR" font_style="italic"]
      <p>"Third testimonial. Highlights a specific outcome or result."</p>
      [/fusion_text]

      [fusion_separator style_type="single solid" sep_color="BORDER_COLOR" border_size="1" margin_top="15px" margin_bottom="15px" /]

      [fusion_text font_size="15px" text_color="TEXT_COLOR"]
      <p><strong>Third Customer</strong><br><span style="color: SECONDARY_ACCENT;">Company Name</span></p>
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Pattern 3: Featured Testimonial (Single, Large)

One prominent testimonial. High impact, minimal.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="DARK_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  admin_label="Testimonial — Featured Single"
]
  [fusion_builder_row]
    [fusion_builder_column type="2_3" center_content="yes" margin_left="auto" margin_right="auto" animation_type="fade"]
      [fusion_fontawesome icon="fa-quote-left fas" size="36px" iconcolor="SECONDARY_ACCENT" alignment="center" margin_bottom="25px" /]

      [fusion_text font_size="22px" line_height="1.8" text_color="#FFFFFF" content_alignment="center" font_style="italic"]
      <p>"A powerful, memorable testimonial that captures the essence of your brand. This should be your best quote — the one that would convince a skeptic."</p>
      [/fusion_text]

      [fusion_separator style_type="single solid" sep_color="SECONDARY_ACCENT" border_size="2" width="40px" alignment="center" margin_top="25px" margin_bottom="20px"]

      [fusion_text font_size="16px" text_color="rgba(255,255,255,0.85)" content_alignment="center"]
      <p><strong>Customer Name</strong> — Company / Title</p>
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Testimonial Design Rules

1. **Real quotes only** — never fabricate testimonials; use `[PLACEHOLDER: testimonial]` if none provided
2. **Specific > generic** — "Sales increased 40%" beats "Great service!"
3. **3 testimonials minimum** — establishes a pattern of satisfaction
4. **Include credentials** — name, company, and photo build trust
5. **Circular avatars** — `image_border_radius="50%"` for professional look
6. **Vary the focus** — each testimonial should highlight a different benefit
7. **Quote marks** — use `fa-quote-left` icon or `"curly quotes"` for visual distinction
