# Agent Team Template: Content Repurposing Engine

> **Pattern:** Parallel specialists → synthesizer
> **Agents:** 4 (Blog, LinkedIn, Newsletter, Twitter/X)
> **Execution:** All agents work simultaneously, then cross-review for consistency

---

## When to Use

- Repurposing a blog post, video transcript, or keynote into multi-platform content
- Creating consistent messaging across channels from a single source
- Batch content production from research or event notes

---

## Team Composition

| Role | Responsibility | Output |
|------|---------------|--------|
| Blog Writer | Long-form article (800-1500 words) | Blog post in markdown |
| LinkedIn Writer | Professional post (1300 char max) | LinkedIn post with hooks |
| Newsletter Writer | Email-format digest (300-500 words) | Newsletter draft with subject line |
| Twitter/X Writer | Thread of 3-7 tweets (280 char each) | Tweet thread with hashtags |

---

## Prompt Template

```
Create an agent team to repurpose the following content into multi-platform assets.

Source content:
"""
[PASTE SOURCE CONTENT HERE — article, transcript, notes, etc.]
"""

Target audience: [DESCRIBE TARGET AUDIENCE]
Brand voice: [DESCRIBE TONE — professional, casual, technical, etc.]

Spawn 4 teammates:

1. **Blog Writer**: Create a long-form blog post (800-1500 words). Structure with
   compelling headline, introduction hook, 3-5 key sections with subheadings, and
   a clear call-to-action. Optimize for SEO with natural keyword placement.
   Save output to: [OUTPUT_DIR]/blog-post.md

2. **LinkedIn Writer**: Create a professional LinkedIn post (max 1300 characters).
   Open with a hook line. Use line breaks for readability. Include 1-2 relevant
   hashtags. End with a question or CTA to drive engagement.
   Save output to: [OUTPUT_DIR]/linkedin-post.md

3. **Newsletter Writer**: Create an email newsletter (300-500 words). Write a
   compelling subject line. Structure as: greeting → key insight → supporting
   points → CTA → sign-off. Keep paragraphs short (2-3 sentences).
   Save output to: [OUTPUT_DIR]/newsletter.md

4. **Twitter/X Writer**: Create a thread of 3-7 tweets (280 chars each). First
   tweet must hook and be self-contained. Number each tweet. Include 2-3 relevant
   hashtags in the final tweet only.
   Save output to: [OUTPUT_DIR]/twitter-thread.md

Coordination rules:
- Each teammate should identify 3 key insights from the source before writing
- Share your key insights with the team to ensure all platforms cover the core message
- Maintain consistent facts and figures across all platforms
- Adapt tone and depth to each platform's conventions

After all teammates finish, synthesize a brief comparison:
- Confirm messaging consistency across all 4 platforms
- Flag any contradictions or missing key points
- Save synthesis to: [OUTPUT_DIR]/content-audit.md
```

---

## Customization Options

- **Add platforms**: YouTube description, Reddit post, Instagram caption
- **Change team size**: Combine roles (e.g., LinkedIn + Twitter → Social Writer) for smaller teams
- **Add reviewer**: Spawn a 5th agent as Brand Consistency Reviewer who cross-checks all outputs
- **Source types**: Works with articles, transcripts, meeting notes, research papers, product docs

---

## Expected Output

```
[OUTPUT_DIR]/
├── blog-post.md          # Long-form article
├── linkedin-post.md      # Professional social post
├── newsletter.md         # Email digest
├── twitter-thread.md     # Tweet thread
└── content-audit.md      # Cross-platform consistency check
```
