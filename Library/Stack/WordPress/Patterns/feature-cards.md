# Feature Card Patterns — Fusion Builder

Card-based layouts for features, services, benefits, and offerings.

---

## Pattern 1: Icon + Text Cards (Content Boxes)

Classic feature presentation using Fusion Builder's content_boxes element.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  padding_left="30px"
  padding_right="30px"
  admin_label="Features — Icon Cards"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_title heading_size="2" content_align="center" font_size="32px" text_color="TEXT_COLOR" margin_bottom="10px"]
      What We Offer
      [/fusion_title]

      [fusion_separator style_type="single solid" sep_color="SECONDARY_ACCENT" border_size="2" width="60px" alignment="center" margin_top="10px" margin_bottom="40px"]
    [/fusion_builder_column]
  [/fusion_builder_row]

  [fusion_builder_row]
    [fusion_builder_column type="1_3" padding_top="30px" padding_bottom="30px" padding_left="25px" padding_right="25px" background_color="ALT_BACKGROUND" border_color="BORDER_COLOR" border_style="solid" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="10" box_shadow_color="rgba(0,0,0,0.08)" hover_type="liftup" animation_type="fade" animation_speed="0.5" animation_delay="0"]
      [fusion_fontawesome icon="fa-heart fas" size="36px" iconcolor="PRIMARY_ACCENT" alignment="center" margin_bottom="15px" /]

      [fusion_title heading_size="3" content_align="center" font_size="22px" text_color="TEXT_COLOR" margin_bottom="10px"]
      Feature Title
      [/fusion_title]

      [fusion_text font_size="16px" line_height="1.7" text_color="TEXT_COLOR" content_alignment="center"]
      <p>Short description of this feature. Two to three sentences that explain the benefit to the customer.</p>
      [/fusion_text]
    [/fusion_builder_column]

    [fusion_builder_column type="1_3" padding_top="30px" padding_bottom="30px" padding_left="25px" padding_right="25px" background_color="ALT_BACKGROUND" border_color="BORDER_COLOR" border_style="solid" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="10" box_shadow_color="rgba(0,0,0,0.08)" hover_type="liftup" animation_type="fade" animation_speed="0.5" animation_delay="0.2"]
      [fusion_fontawesome icon="fa-star fas" size="36px" iconcolor="PRIMARY_ACCENT" alignment="center" margin_bottom="15px" /]

      [fusion_title heading_size="3" content_align="center" font_size="22px" text_color="TEXT_COLOR" margin_bottom="10px"]
      Second Feature
      [/fusion_title]

      [fusion_text font_size="16px" line_height="1.7" text_color="TEXT_COLOR" content_alignment="center"]
      <p>Description of the second feature. Focus on benefits, not just features.</p>
      [/fusion_text]
    [/fusion_builder_column]

    [fusion_builder_column type="1_3" padding_top="30px" padding_bottom="30px" padding_left="25px" padding_right="25px" background_color="ALT_BACKGROUND" border_color="BORDER_COLOR" border_style="solid" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="10" box_shadow_color="rgba(0,0,0,0.08)" hover_type="liftup" animation_type="fade" animation_speed="0.5" animation_delay="0.4"]
      [fusion_fontawesome icon="fa-gem fas" size="36px" iconcolor="PRIMARY_ACCENT" alignment="center" margin_bottom="15px" /]

      [fusion_title heading_size="3" content_align="center" font_size="22px" text_color="TEXT_COLOR" margin_bottom="10px"]
      Third Feature
      [/fusion_title]

      [fusion_text font_size="16px" line_height="1.7" text_color="TEXT_COLOR" content_alignment="center"]
      <p>Description of the third feature. Keep all cards roughly the same text length.</p>
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Pattern 2: Image-Top Cards

Cards with image at top, text below. Good for services or portfolio items.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="ALT_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  admin_label="Features — Image Cards"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_title heading_size="2" content_align="center" font_size="32px" text_color="TEXT_COLOR" margin_bottom="40px"]
      Our Services
      [/fusion_title]
    [/fusion_builder_column]
  [/fusion_builder_row]

  [fusion_builder_row]
    [fusion_builder_column type="1_3" background_color="#FFFFFF" border_radius_top_left="8px" border_radius_top_right="8px" border_radius_bottom_left="8px" border_radius_bottom_right="8px" box_shadow="yes" box_shadow_blur="12" box_shadow_color="rgba(0,0,0,0.08)" hover_type="liftup" animation_type="fade" animation_speed="0.5" animation_delay="0"]
      [fusion_imageframe image="SERVICE_IMAGE_1" alt="Service one" border_radius="8px 8px 0 0" hover_type="zoomin"]SERVICE_IMAGE_1[/fusion_imageframe]

      [fusion_builder_column_inner type="1_1" padding_top="25px" padding_bottom="25px" padding_left="20px" padding_right="20px"]
        [fusion_title heading_size="3" content_align="left" font_size="20px" text_color="TEXT_COLOR" margin_bottom="10px"]
        Service Name
        [/fusion_title]

        [fusion_text font_size="15px" line_height="1.7" text_color="TEXT_COLOR"]
        <p>Brief description of this service offering.</p>
        [/fusion_text]

        [fusion_button link="/services/one" alignment="left" size="medium" color="custom" button_gradient_top_color="transparent" button_gradient_bottom_color="transparent" accent_color="PRIMARY_ACCENT" border_width="0" font_size="14px"]Learn More →[/fusion_button]
      [/fusion_builder_column_inner]
    [/fusion_builder_column]

    <!-- Repeat for columns 2 and 3 with animation_delay="0.2" and "0.4" -->
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Pattern 3: Horizontal Feature Rows

Feature on left, description on right. Good for detailed service pages.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="BASE_BACKGROUND"
  padding_top="80px"
  padding_bottom="80px"
  admin_label="Features — Horizontal Rows"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_4" align_self="center" animation_type="fade" animation_direction="left"]
      [fusion_fontawesome icon="fa-palette fas" size="48px" iconcolor="PRIMARY_ACCENT" alignment="center" /]
    [/fusion_builder_column]

    [fusion_builder_column type="3_4" align_self="center" padding_left="20px"]
      [fusion_title heading_size="3" content_align="left" font_size="22px" text_color="TEXT_COLOR" margin_bottom="8px"]
      Custom Design
      [/fusion_title]

      [fusion_text font_size="16px" line_height="1.7" text_color="TEXT_COLOR"]
      <p>Detailed description of this feature. This layout allows more text than a card and reads naturally left-to-right.</p>
      [/fusion_text]
    [/fusion_builder_column]
  [/fusion_builder_row]

  [fusion_builder_row]
    [fusion_builder_column type="1_1"]
      [fusion_separator style_type="single solid" sep_color="BORDER_COLOR" border_size="1" margin_top="30px" margin_bottom="30px" /]
    [/fusion_builder_column]
  [/fusion_builder_row]

  <!-- Repeat for additional features -->
[/fusion_builder_container]
```

---

## Pattern 4: Stats / Numbers Row

Numeric highlights in a single row. Good for credibility.

```
[fusion_builder_container
  type="flex"
  hundred_percent="no"
  background_color="DARK_BACKGROUND"
  padding_top="50px"
  padding_bottom="50px"
  admin_label="Stats Row"
]
  [fusion_builder_row]
    [fusion_builder_column type="1_4" animation_type="fade" animation_delay="0"]
      [fusion_counters_box columns="1" color="PRIMARY_ACCENT" title_size="14px" body_color="#FFFFFF" border_color="transparent"]
        [fusion_counter_box value="500" delimiter="+" unit="" icon="" direction="up"]Happy Clients[/fusion_counter_box]
      [/fusion_counters_box]
    [/fusion_builder_column]

    [fusion_builder_column type="1_4" animation_type="fade" animation_delay="0.15"]
      [fusion_counters_box columns="1" color="PRIMARY_ACCENT" title_size="14px" body_color="#FFFFFF" border_color="transparent"]
        [fusion_counter_box value="12" unit="" icon="" direction="up"]Years Experience[/fusion_counter_box]
      [/fusion_counters_box]
    [/fusion_builder_column]

    [fusion_builder_column type="1_4" animation_type="fade" animation_delay="0.3"]
      [fusion_counters_box columns="1" color="PRIMARY_ACCENT" title_size="14px" body_color="#FFFFFF" border_color="transparent"]
        [fusion_counter_box value="1000" delimiter="+" unit="" icon="" direction="up"]Products[/fusion_counter_box]
      [/fusion_counters_box]
    [/fusion_builder_column]

    [fusion_builder_column type="1_4" animation_type="fade" animation_delay="0.45"]
      [fusion_counters_box columns="1" color="PRIMARY_ACCENT" title_size="14px" body_color="#FFFFFF" border_color="transparent"]
        [fusion_counter_box value="98" unit="%" unit_pos="suffix" icon="" direction="up"]Satisfaction[/fusion_counter_box]
      [/fusion_counters_box]
    [/fusion_builder_column]
  [/fusion_builder_row]
[/fusion_builder_container]
```

---

## Card Design Rules

1. **Equal content length** — all cards in a row should have similar text volume
2. **Consistent styling** — same border radius, shadow, padding across all cards
3. **3 or 4 per row** — odd numbers (3) feel balanced; 4 for data-heavy displays
4. **Stagger animations** — 0.2s delay between each card
5. **One interaction type** — either `liftup` hover OR link, not competing effects
6. **Icon consistency** — same icon set, size, and color across all cards
7. **Section heading** — always introduce cards with a section title
