# Contact Section Patterns — Fusion Builder

Contact pages, forms, and location information layouts.

---

## Pattern 1: Two-Column Contact (Info + Form)

Most common contact layout. Business info left, form right.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  padding_left="30px"
  padding_right="30px"
  admin_label="Contact — Info + Form"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_title heading_size="2" content_align="center" font_size="32px" text_color="TEXT_COLOR" margin_bottom="10px"]
      Get In Touch
      [/fusion_title]

      [fusion_separator style_type="single solid" sep_color="SECONDARY_ACCENT" border_size="2" width="60px" alignment="center" margin_top="10px" margin_bottom="40px"]
    [/fusion_builder_column]
  [/fusion_builder_row]

  [fusion_builder_row]
    [fusion_builder_column type="1_2" padding_right="30px" animation_type="fade" animation_direction="left" animation_speed="0.5"]
      [fusion_title heading_size="3" content_align="left" font_size="22px" text_color="TEXT_COLOR" margin_bottom="20px"]
      Contact Information
      [/fusion_title]

      [fusion_text font_size="16px" line_height="1.8" text_color="TEXT_COLOR"]
      <p>Brief welcoming message about getting in touch. One to two sentences.</p>
      [/fusion_text]

      [fusion_checklist icon="fa-map-marker-alt fas" iconcolor="PRIMARY_ACCENT" size="16px" margin_top="25px"]
        [fusion_li_item]123 Main Street, City, State ZIP[/fusion_li_item]
      [/fusion_checklist]

      [fusion_checklist icon="fa-phone fas" iconcolor="PRIMARY_ACCENT" size="16px" margin_top="10px"]
        [fusion_li_item](555) 123-4567[/fusion_li_item]
      [/fusion_checklist]

      [fusion_checklist icon="fa-envelope fas" iconcolor="PRIMARY_ACCENT" size="16px" margin_top="10px"]
        [fusion_li_item]hello@example.com[/fusion_li_item]
      [/fusion_checklist]

      [fusion_checklist icon="fa-clock fas" iconcolor="PRIMARY_ACCENT" size="16px" margin_top="10px"]
        [fusion_li_item]Mon–Fri: 9am – 5pm[/fusion_li_item]
        [fusion_li_item]Sat: 10am – 2pm[/fusion_li_item]
        [fusion_li_item]Sun: Closed[/fusion_li_item]
      [/fusion_checklist]

      [fusion_social_links icons_boxed="no" icon_color="TEXT_COLOR" icon_color_hover="PRIMARY_ACCENT" alignment="left" font_size="18px" margin_top="25px"]
        [fusion_social_link social_network="facebook" link="FACEBOOK_URL" /]
        [fusion_social_link social_network="instagram" link="INSTAGRAM_URL" /]
      [/fusion_social_links]
    [/fusion_builder_column]

    [fusion_builder_column type="1_2" padding_top="30px" padding_bottom="30px" padding_left="30px" padding_right="30px" background_color="ALT_BACKGROUND" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="12" box_shadow_color="rgba(0,0,0,0.08)" animation_type="fade" animation_direction="right" animation_speed="0.5"]
      [fusion_title heading_size="3" content_align="left" font_size="22px" text_color="TEXT_COLOR" margin_bottom="20px"]
      Send Us a Message
      [/fusion_title]

      [fusion_text]
      <!-- Contact Form 7 or Avada Forms shortcode -->
      [contact-form-7 id="FORM_ID" title="Contact Form"]
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Pattern 2: Full-Width Map + Contact Cards

Map above, contact info cards below.

```
[fusion_builder_container
  type="flex"
  hundred_percent="yes"
  padding_top="0px"
  padding_bottom="0px"
  padding_left="0px"
  padding_right="0px"
  admin_label="Contact — Map"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_map
        api_type="embed"
        embed_address="123 Main Street, City, State"
        embed_map_type="roadmap"
        width="100%"
        height="400px"
        zoom="14"
      ]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]

[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="60px"
  padding_bottom="60px"
  admin_label="Contact — Info Cards"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_3" padding_top="25px" padding_bottom="25px" padding_left="20px" padding_right="20px" background_color="ALT_BACKGROUND" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="8" box_shadow_color="rgba(0,0,0,0.06)" animation_type="fade" animation_delay="0"]
      [fusion_fontawesome icon="fa-map-marker-alt fas" size="28px" iconcolor="PRIMARY_ACCENT" alignment="center" margin_bottom="15px" /]
      [fusion_title heading_size="4" content_align="center" font_size="18px" text_color="TEXT_COLOR" margin_bottom="8px"]Visit Us[/fusion_title]
      [fusion_text font_size="15px" text_color="TEXT_COLOR" content_alignment="center"]
      <p>123 Main Street<br>City, State ZIP</p>
      [/fusion_text]
    [/fusion_builder_column]

    [fusion_builder_column type="1_3" padding_top="25px" padding_bottom="25px" padding_left="20px" padding_right="20px" background_color="ALT_BACKGROUND" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="8" box_shadow_color="rgba(0,0,0,0.06)" animation_type="fade" animation_delay="0.2"]
      [fusion_fontawesome icon="fa-phone fas" size="28px" iconcolor="PRIMARY_ACCENT" alignment="center" margin_bottom="15px" /]
      [fusion_title heading_size="4" content_align="center" font_size="18px" text_color="TEXT_COLOR" margin_bottom="8px"]Call Us[/fusion_title]
      [fusion_text font_size="15px" text_color="TEXT_COLOR" content_alignment="center"]
      <p>(555) 123-4567<br>Mon–Fri 9am–5pm</p>
      [/fusion_text]
    [/fusion_builder_column]

    [fusion_builder_column type="1_3" padding_top="25px" padding_bottom="25px" padding_left="20px" padding_right="20px" background_color="ALT_BACKGROUND" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="8" box_shadow_color="rgba(0,0,0,0.06)" animation_type="fade" animation_delay="0.4"]
      [fusion_fontawesome icon="fa-envelope fas" size="28px" iconcolor="PRIMARY_ACCENT" alignment="center" margin_bottom="15px" /]
      [fusion_title heading_size="4" content_align="center" font_size="18px" text_color="TEXT_COLOR" margin_bottom="8px"]Email Us[/fusion_title]
      [fusion_text font_size="15px" text_color="TEXT_COLOR" content_alignment="center"]
      <p>hello@example.com<br>We reply within 24 hours</p>
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Pattern 3: Minimal Contact (Centered Form)

Simple centered form with minimal surrounding content.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  admin_label="Contact — Centered Form"
]
  [fusion_builder_row]
    [fusion_builder_column type="2_3" center_content="yes" margin_left="auto" margin_right="auto"]
      [fusion_title heading_size="2" content_align="center" font_size="32px" text_color="TEXT_COLOR" margin_bottom="10px"]
      Contact Us
      [/fusion_title]

      [fusion_text font_size="17px" text_color="TEXT_COLOR" content_alignment="center" margin_bottom="30px"]
      <p>Have a question or want to work together? Fill out the form below.</p>
      [/fusion_text]

      [fusion_text]
      [contact-form-7 id="FORM_ID" title="Contact Form"]
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Contact Section Rules

1. **Never animate form fields** — forms should feel stable and trustworthy
2. **Include multiple contact methods** — phone, email, address, social
3. **Business hours** — always include operating hours
4. **Form above fold** — on dedicated contact pages, form should be visible quickly
5. **Response expectation** — tell visitors when to expect a reply
6. **Use real form plugin** — Contact Form 7 or Avada Forms shortcode
7. **Map is optional** — only include for businesses with physical locations
