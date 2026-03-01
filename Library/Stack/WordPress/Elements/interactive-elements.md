# Interactive Elements — Fusion Builder

Accordions, tabs, modals, counters, and toggles.

---

## Accordion (`fusion_accordion` + `fusion_toggle`)

Expandable content sections. Ideal for FAQs, service details, product info.

```
[fusion_accordion
  type=""
  boxed_mode="yes"
  border_size="1"
  border_color="#E8E0D8"
  background_color="#FFFFFF"
  hover_color="#FDFBF7"
  title_font_size="18px"
  title_color="#3C3C3C"
  icon_color="#F4C2C2"
  icon_alignment="left"
  toggle_hover_accent_color="#F4C2C2"
]
  [fusion_toggle title="Question or Section Title" open="no"]
  Answer or content goes here. Can contain HTML paragraphs.
  [/fusion_toggle]
  [fusion_toggle title="Second Question" open="no"]
  Second answer content.
  [/fusion_toggle]
  [fusion_toggle title="Third Question" open="no"]
  Third answer content.
  [/fusion_toggle]
[/fusion_accordion]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `boxed_mode` | `yes` / `no` | Boxed = bordered cards, no = minimal |
| `border_size` | `1` | Border thickness |
| `border_color` | `#E8E0D8` | Border color |
| `background_color` | `#FFFFFF` | Panel background |
| `hover_color` | `#FDFBF7` | Hover/active background |
| `title_font_size` | `18px` | Title text size |
| `title_color` | `#3C3C3C` | Title text color |
| `icon_color` | `#F4C2C2` | Toggle icon color |
| `icon_alignment` | `left` / `right` | Icon position |

Child `fusion_toggle`:

| Parameter | Values | Notes |
|-----------|--------|-------|
| `title` | text | Accordion header |
| `open` | `yes` / `no` | Start expanded |

---

## Tabs (`fusion_tabs` + `fusion_tab`)

Tabbed content sections. Good for organizing related content categories.

```
[fusion_tabs
  layout="horizontal"
  justified="yes"
  backgroundcolor="#FFFFFF"
  inactivecolor="#F5F5F5"
  bordercolor="#E8E0D8"
  active_border_color="#F4C2C2"
  title_color="#3C3C3C"
  active_title_color="#F4C2C2"
  icon_position="left"
  icon_color="#3C3C3C"
  active_icon_color="#F4C2C2"
]
  [fusion_tab title="Tab One" icon="fa-info-circle fas"]
  Content for the first tab. HTML supported.
  [/fusion_tab]
  [fusion_tab title="Tab Two" icon="fa-list fas"]
  Content for the second tab.
  [/fusion_tab]
  [fusion_tab title="Tab Three" icon="fa-star fas"]
  Content for the third tab.
  [/fusion_tab]
[/fusion_tabs]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `layout` | `horizontal` / `vertical` | Tab orientation |
| `justified` | `yes` / `no` | Equal-width tabs |
| `backgroundcolor` | `#FFFFFF` | Active tab background |
| `inactivecolor` | `#F5F5F5` | Inactive tab background |
| `bordercolor` | `#E8E0D8` | Border color |
| `active_border_color` | `#F4C2C2` | Active tab accent |

---

## Modal (`fusion_modal` + `fusion_modal_text_link`)

Popup dialog boxes. Useful for additional info, terms, quick forms.

```
[fusion_modal_text_link
  name="my-modal"
  class=""
  id=""
]Click here for details[/fusion_modal_text_link]

[fusion_modal
  name="my-modal"
  title="Modal Title"
  size="large"
  background="#FFFFFF"
  border_color="#E8E0D8"
  show_footer="yes"
  class=""
]
Modal body content goes here. HTML supported.
[/fusion_modal]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `name` | identifier | Must match between trigger and modal |
| `title` | text | Modal heading |
| `size` | `small` / `medium` / `large` / `fit` | Modal width |
| `background` | `#FFFFFF` | Background color |
| `border_color` | `#E8E0D8` | Border color |
| `show_footer` | `yes` / `no` | Show close button footer |

**Trigger options:**
- `fusion_modal_text_link` — text link trigger
- Any button with `link="#"` and `data-toggle="modal" data-target=".modal-name"` — button trigger

---

## Counter Box (`fusion_counters_box` + `fusion_counter_box`)

Animated number counters. Great for statistics, achievements.

```
[fusion_counters_box
  columns="4"
  color="#F4C2C2"
  title_size="14px"
  icon_size="40"
  body_color="#3C3C3C"
  body_size="14px"
  border_color="#E8E0D8"
  animation_offset="top-into-view"
]
  [fusion_counter_box
    value="500"
    delimiter="+"
    unit=""
    unit_pos="suffix"
    icon="fa-heart fas"
    direction="up"
  ]
  Happy Clients
  [/fusion_counter_box]
  [fusion_counter_box
    value="12"
    delimiter=""
    unit=""
    icon="fa-trophy fas"
    direction="up"
  ]
  Years Experience
  [/fusion_counter_box]
  [fusion_counter_box
    value="1000"
    delimiter="+"
    unit=""
    icon="fa-star fas"
    direction="up"
  ]
  Products Sold
  [/fusion_counter_box]
  [fusion_counter_box
    value="98"
    delimiter=""
    unit="%"
    unit_pos="suffix"
    icon="fa-smile fas"
    direction="up"
  ]
  Satisfaction Rate
  [/fusion_counter_box]
[/fusion_counters_box]
```

| Parameter (parent) | Values | Notes |
|--------------------|--------|-------|
| `columns` | `1`–`6` | Number of counter columns |
| `color` | `#F4C2C2` | Counter number color |
| `title_size` | `14px` | Label text size |
| `icon_size` | `40` | Icon size |
| `border_color` | `#E8E0D8` | Divider between counters |

| Parameter (child) | Values | Notes |
|-------------------|--------|-------|
| `value` | `500` | Target number (animates up to this) |
| `delimiter` | `+` / `,` / `` | Suffix/thousand separator |
| `unit` | `%` / `$` / `` | Unit symbol |
| `unit_pos` | `prefix` / `suffix` | Unit position |
| `icon` | `fa-heart fas` | FontAwesome icon |
| `direction` | `up` | Animation direction |

---

## Countdown (`fusion_countdown`)

Event countdown timer.

```
[fusion_countdown
  countdown_end="2026-06-15 18:00:00"
  timezone="America/New_York"
  layout="stacked"
  show_weeks="no"
  label_position="bottom"
  background_color="#3C3C3C"
  counter_text_color="#FFFFFF"
  label_color="#E8C39E"
  counter_font_size="48px"
  label_font_size="14px"
  border_radius="8px"
  dash_border_color="#555555"
  dash_border_size="2"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `countdown_end` | `YYYY-MM-DD HH:MM:SS` | Target date/time |
| `timezone` | `America/New_York` | PHP timezone |
| `layout` | `stacked` / `floated` | Days/hours/mins arrangement |
| `show_weeks` | `yes` / `no` | Show weeks counter |
| `background_color` | `#3C3C3C` | Container background |
| `counter_text_color` | `#FFFFFF` | Number color |
| `label_color` | `#E8C39E` | "Days"/"Hours" label color |
| `counter_font_size` | `48px` | Number size |
| `label_font_size` | `14px` | Label size |

---

## Progress Bar (`fusion_progress`)

Visual progress indicator.

```
[fusion_progress
  percentage="85"
  unit="%"
  filledcolor="#F4C2C2"
  unfilledcolor="#E8E0D8"
  textcolor="#3C3C3C"
  striped="no"
  animated_stripes="no"
  height="30px"
  border_radius="15px"
]Skill Name[/fusion_progress]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `percentage` | `0`–`100` | Fill amount |
| `unit` | `%` / `` | Display unit |
| `filledcolor` | `#F4C2C2` | Filled bar color |
| `unfilledcolor` | `#E8E0D8` | Empty bar color |
| `height` | `30px` | Bar height |
| `border_radius` | `15px` | Corner rounding |

---

## Alert (`fusion_alert`)

Notification boxes for messages, warnings, tips.

```
[fusion_alert
  type="notice"
  accent_color="#E8C39E"
  background_color="#FFF8F0"
  border_size="1"
  icon="fa-info-circle fas"
  box_shadow="yes"
]
Important message or notification text here.
[/fusion_alert]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `type` | `general` / `error` / `success` / `notice` / `custom` | Alert style |
| `accent_color` | `#E8C39E` | Icon and border accent |
| `background_color` | `#FFF8F0` | Alert background |
| `border_size` | `1` | Border width |
| `icon` | `fa-info-circle fas` | FontAwesome icon |
| `box_shadow` | `yes` / `no` | Drop shadow |
