# Media Elements — Fusion Builder

Image, gallery, video, and slider elements.

---

## Image Frame (`fusion_imageframe`)

Single images with optional styling and links.

```
[fusion_imageframe
  image="IMAGE_URL"
  image_id=""
  alt="Descriptive alt text"
  link="/about"
  linktarget="_self"
  style_type="none"
  align="center"
  max_width="100%"
  border_radius="8px"
  box_shadow="yes"
  box_shadow_blur="15"
  box_shadow_spread="0"
  box_shadow_color="rgba(0,0,0,0.1)"
  hover_type="liftup"
  animation_type="fade"
  animation_speed="0.5"
]IMAGE_URL[/fusion_imageframe]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `image` | URL | Image source |
| `alt` | text | **Required** for accessibility |
| `link` | URL | Makes image clickable |
| `linktarget` | `_self` / `_blank` | Link target |
| `style_type` | `none` / `dropshadow` / `bottomshadow` / `glow` | Image effect |
| `align` | `left` / `center` / `right` / `none` | Alignment |
| `max_width` | `100%` / `500px` | Maximum width |
| `border_radius` | `8px` / `50%` | Corner rounding (50% = circle) |
| `box_shadow` | `yes` / `no` | Drop shadow |
| `hover_type` | `none` / `liftup` / `zoomin` / `zoomout` | Hover effect |
| `lightbox` | `yes` / `no` | Open full-size on click |

**Rules:**
- Always include `alt` text
- Use `border_radius="50%"` for circular headshots/avatars
- Use `hover_type="liftup"` for clickable images
- Image columns should have `padding="0"` to let the image fill the space

---

## Gallery (`fusion_gallery`)

Image grids and masonry layouts.

```
[fusion_gallery
  layout="grid"
  columns="3"
  column_spacing="20"
  picture_size="auto"
  hover_type="liftup"
  lightbox="yes"
  lightbox_content="titles"
  border_radius="8px"
  hide_on_mobile="small-visibility,medium-visibility,large-visibility"
]
  [fusion_gallery_image image="URL_1" image_id="" alt="Image 1" /]
  [fusion_gallery_image image="URL_2" image_id="" alt="Image 2" /]
  [fusion_gallery_image image="URL_3" image_id="" alt="Image 3" /]
  [fusion_gallery_image image="URL_4" image_id="" alt="Image 4" /]
  [fusion_gallery_image image="URL_5" image_id="" alt="Image 5" /]
  [fusion_gallery_image image="URL_6" image_id="" alt="Image 6" /]
[/fusion_gallery]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `layout` | `grid` / `masonry` | Grid = uniform, masonry = mixed heights |
| `columns` | `1`–`6` | Column count |
| `column_spacing` | `20` | Gap between images (px) |
| `picture_size` | `auto` / `fixed` | Auto = original ratio, fixed = cropped square |
| `hover_type` | `none` / `liftup` / `zoomin` / `zoomout` | Hover effect |
| `lightbox` | `yes` / `no` | Fullscreen popup on click |
| `border_radius` | `8px` | Corner rounding |

---

## Video (`fusion_video`)

Embedded video player.

```
[fusion_video
  video="https://www.youtube.com/watch?v=VIDEO_ID"
  video_webm=""
  width="100%"
  alignment="center"
  autoplay="no"
  mute="no"
  loop="no"
  border_radius="8px"
  box_shadow="yes"
  box_shadow_blur="15"
  box_shadow_color="rgba(0,0,0,0.1)"
]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `video` | YouTube/Vimeo URL | Embed URL |
| `video_webm` | URL | Self-hosted WebM file |
| `width` | `100%` / `800px` | Player width |
| `alignment` | `left` / `center` / `right` | Position |
| `autoplay` | `yes` / `no` | Auto-play (muted required for autoplay) |
| `mute` | `yes` / `no` | Muted audio |
| `loop` | `yes` / `no` | Loop playback |

---

## Slider (`fusion_slider` + `fusion_slide`)

Full-width or contained image/content sliders.

```
[fusion_slider
  hover_type="none"
  width="100%"
  height="500px"
  autoplay="yes"
  autoplay_speed="5000"
]
  [fusion_slide
    type="image"
    image_url="SLIDE_1_URL"
    link=""
    lightbox="no"
  /]
  [fusion_slide
    type="image"
    image_url="SLIDE_2_URL"
    link=""
    lightbox="no"
  /]
[/fusion_slider]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `width` | `100%` | Slider width |
| `height` | `500px` | Slider height |
| `autoplay` | `yes` / `no` | Auto-advance slides |
| `autoplay_speed` | `5000` | Milliseconds between slides |

**Note:** For hero sliders with text overlays, consider using separate containers with background images instead — gives more control over text positioning and responsive behavior.

---

## Person / Team Member (`fusion_person`)

Team member cards with photo, name, title, and social links.

```
[fusion_person
  name="Jane Smith"
  title="Creative Director"
  picture="IMAGE_URL"
  pic_link=""
  pic_style="circle"
  pic_style_color=""
  content_alignment="center"
  icon_position="bottom"
  social_icon_font_size="18px"
  social_icon_color="#3C3C3C"
  social_icon_color_hover="#F4C2C2"
  facebook="https://facebook.com/..."
  instagram="https://instagram.com/..."
  linkedin="https://linkedin.com/..."
  animation_type="fade"
  animation_speed="0.5"
]
Short bio paragraph about this team member.
[/fusion_person]
```

| Parameter | Values | Notes |
|-----------|--------|-------|
| `name` | text | Person's name |
| `title` | text | Job title / role |
| `picture` | URL | Headshot photo |
| `pic_style` | `none` / `circle` / `square` | Photo shape |
| `content_alignment` | `left` / `center` / `right` | Text alignment |
| `icon_position` | `top` / `bottom` | Social icons placement |
| `facebook` / `instagram` / `linkedin` / `twitter` / `email` | URL | Social links |

---

## Social Links (`fusion_social_links` + `fusion_social_link`)

Social media icon set.

```
[fusion_social_links
  icons_boxed="no"
  icon_color="#3C3C3C"
  icon_color_hover="#F4C2C2"
  box_border_color=""
  alignment="center"
  font_size="18px"
]
  [fusion_social_link social_network="facebook" link="URL" /]
  [fusion_social_link social_network="instagram" link="URL" /]
  [fusion_social_link social_network="linkedin" link="URL" /]
  [fusion_social_link social_network="twitter" link="URL" /]
[/fusion_social_links]
```
