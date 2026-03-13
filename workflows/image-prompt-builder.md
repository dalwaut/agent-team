---
description: Interactively collect structured image prompt fields and produce a ready-to-use JSON prompt for Nano Banana 2 / Gemini Flash Image.
---

# Image Prompt Builder

Walk the user through each field of the structured image prompt format, then output a complete, filled JSON that can be pasted directly into Antigravity for image generation.

## Steps

1. **Greet and set context**
   Tell the user: "Let's build a structured image prompt. I'll ask you about each field one at a time. Skip any field by pressing Enter or saying 'skip'."

2. **Subject**
   Ask: "What is the **main subject** of the image? (e.g. 'a software developer at a standing desk', 'a sleek product on a white surface')"
   - Follow up: "Any specific details about the subject? (clothing, expression, pose, material, count of subjects)"

3. **Angle**
   Ask: "What **camera angle** should be used?"
   Present options:
   ```
   1. eye-level
   2. low-angle (looking up — powerful, dramatic)
   3. high-angle (looking down — overview, vulnerability)
   4. birds-eye (straight down)
   5. worms-eye (straight up)
   6. over-the-shoulder
   7. close-up
   8. extreme-close-up
   9. wide-shot
   10. medium-shot
   11. dutch-angle (tilted — tension, unease)
   ```

4. **Focus / Depth of Field**
   Ask: "What should the **focus style** be?"
   Present options:
   ```
   1. tack-sharp (everything in focus)
   2. shallow-dof (subject sharp, background blurred)
   3. deep-dof (foreground and background both sharp)
   4. soft (overall dreamy softness)
   5. selective (specific element sharp, rest blurred)
   ```
   - Follow up: "What is the **main focal point**? What should be sharpest?"
   - Follow up: "Blur intensity? (none / subtle / moderate / heavy)"

5. **Background**
   Ask: "Describe the **background setting or environment**. (e.g. 'modern home office with city view', 'abstract studio void', 'rainy city street at night')"
   - Follow up: "Any specific **background elements** to include? (props, objects, environmental details — list them)"
   - Follow up: "What is the **atmosphere**? (e.g. clear, foggy, rainy, hazy, smoky, glowing)"

6. **Lighting**
   Ask: "What kind of **lighting** should the image have?"
   Present options:
   ```
   1. natural (daylight, window light)
   2. golden-hour (warm sunset glow)
   3. blue-hour (cool twilight)
   4. studio (controlled, product-style)
   5. dramatic / cinematic (high contrast)
   6. neon (colored light from signs)
   7. backlit (light source behind subject)
   8. rim-light (outline highlight from behind)
   9. high-key (bright, minimal shadows)
   10. low-key (dark, moody shadows)
   11. flat (even, shadowless)
   ```
   - Follow up: "Light **direction**? (front / side / back / top / ambient / three-point)"
   - Follow up: "Intensity? (soft / medium / hard / harsh)"
   - Follow up: "Color temperature? (warm / neutral / cool / mixed)"

7. **Style**
   Ask: "What is the **visual medium**?"
   Present options:
   ```
   1. photograph
   2. cinematic-still
   3. digital-art
   4. 3d-render
   5. illustration
   6. oil-painting
   7. watercolor
   8. pencil-sketch
   9. vector
   ```
   - Follow up: "What **aesthetic** should it have? (photorealistic / hyperrealistic / cinematic / editorial / minimalist / vibrant / moody / retro / futuristic)"
   - Follow up: "Describe the **color palette** or mood. (e.g. 'deep navy and amber', 'muted earth tones', 'neon pink and electric blue')"

8. **Composition**
   Ask: "What **composition rule** should guide the framing?"
   Present options:
   ```
   1. rule-of-thirds
   2. centered / symmetrical
   3. leading-lines
   4. frame-within-frame
   5. golden-ratio
   6. diagonal
   7. negative-space
   ```
   - Follow up: "**Aspect ratio**? (1:1 / 4:3 / 3:2 / 16:9 / 9:16 / 21:9)"
   - Follow up: "**Camera lens**? (wide-angle / standard-50mm / portrait-85mm / telephoto / macro)"

9. **Text Overlay (optional)**
   Ask: "Should the image include **text overlaid** on it? (yes / no)"
   If yes:
   - "What text?"
   - "Font style? (bold-sans / serif / script / monospace / handwritten)"
   - "Position? (top / center / bottom / top-left / bottom-right etc.)"
   - "Text color? (hex or description)"

10. **Mood**
    Ask: "In a few words, what **overall emotional tone** should the image evoke? (e.g. 'focused and aspirational', 'mysterious and premium', 'nostalgic and warm')"

11. **Quality Modifiers (optional)**
    Ask: "Any **quality or style boosters** to add? (e.g. '8k', 'award-winning photography', 'film grain', 'ultra-detailed', 'bokeh')"

12. **Negative Prompt**
    Ask: "Anything to **explicitly exclude** from the image? (e.g. 'no text', 'no people', 'avoid warm tones', 'no cartoon style')"

13. **Assemble and output**
    Compile all answers into a complete JSON object matching the schema in `Templates/image-prompt-template.json`.
    - Omit or set to `false` any fields the user skipped
    - Output the finished JSON in a fenced code block
    - Offer to: (a) generate the image now, (b) save the prompt to `Templates/image-prompt-examples.json`, or (c) refine any field
