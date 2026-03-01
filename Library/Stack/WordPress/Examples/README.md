# Fusion Builder Page Examples

This directory contains real Fusion Builder shortcode extracted from Avada demo sites and client projects. Each example is a complete, working page that can be used as reference or starting material.

## How to Add Examples

### From Avada Demo Sites (Recommended)
1. Set up LocalWP with Avada theme installed
2. Import an Avada demo site (WP Admin → Avada → Websites)
3. Run: `python -m src.cli exec pages.list` from `tools/wp-agent/`
4. For each page: `python -m src.cli exec pages.get page_id=X`
5. Save the `content.rendered` field to a `.md` file here

### From Client Projects
1. Fetch the page content via the WordPress REST API
2. The raw `content` field IS the Fusion Builder shortcode
3. Save with metadata header

### File Format

```markdown
# [Page Title]

- **Source**: Avada Demo / Client Project Name
- **Page Type**: Home / About / Contact / Services / Blog / Shop
- **Industry**: Restaurant / SaaS / Portfolio / E-commerce / etc.
- **Quality Score**: X/100 (from Design Reviewer)
- **Notable Patterns**: Hero with overlay, 3-col cards, testimonial slider
- **Elements Used**: fusion_title, fusion_text, fusion_button, fusion_content_boxes, ...

## Shortcode

```fusion
[fusion_builder_container ...]
...
[/fusion_builder_container]
```
```

## Directory Structure

Organize by source:

```
Examples/
├── avada-demos/
│   ├── cafe/
│   │   ├── home.md
│   │   ├── about.md
│   │   └── menu.md
│   ├── agency/
│   │   ├── home.md
│   │   └── services.md
│   └── ...
├── client-projects/
│   ├── lace-and-pearl/
│   │   ├── home.md
│   │   ├── about.md
│   │   ├── where-to-find-me.md
│   │   └── contact.md
│   └── ...
└── README.md (this file)
```

## Extraction Script

Use `tools/wp-agent/scripts/extract_avada_templates.py` to batch-extract all pages from a WordPress installation.
