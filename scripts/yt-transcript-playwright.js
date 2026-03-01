#!/usr/bin/env node
/**
 * yt-transcript-playwright.js — Fetch YouTube transcripts via Playwright
 *
 * Bypasses YouTube's IP-based API blocking by using a real browser.
 * Opens the video page, clicks "Show transcript", scrapes the panel text.
 *
 * Usage:
 *   node scripts/yt-transcript-playwright.js <youtube-url>
 *   node scripts/yt-transcript-playwright.js <youtube-url> --debug
 *
 * Output: JSON to stdout { title, author, transcript, segments, error }
 *
 * Requires: playwright (npm install playwright)
 */

const { chromium } = require('playwright');

const url = process.argv[2];
const DEBUG = process.argv.includes('--debug');

if (!url || !url.includes('youtu')) {
  console.error('Usage: node yt-transcript-playwright.js <youtube-url> [--debug]');
  process.exit(1);
}

function dbg(msg) {
  if (DEBUG) process.stderr.write(`[debug] ${msg}\n`);
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();

    // Navigate to video
    dbg(`Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });

    // Wait for YouTube's player and description to be ready
    dbg('Waiting for YouTube to initialize...');
    try {
      await page.waitForSelector('ytd-watch-metadata, #above-the-fold', { timeout: 15000 });
    } catch (e) {
      dbg('Metadata container not found, continuing anyway');
    }
    await page.waitForTimeout(3000);

    if (DEBUG) await page.screenshot({ path: '/tmp/yt-debug-1-loaded.png' });

    // Dismiss cookie consent if present
    try {
      const consentBtn = await page.$('button[aria-label="Accept all"]');
      if (consentBtn) {
        dbg('Dismissing cookie consent');
        await consentBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {}

    // Get title
    const meta = await page.evaluate(() => {
      const title = document.title.replace(' - YouTube', '').trim();
      const authorEl = document.querySelector('ytd-channel-name a, #owner-name a, a.yt-simple-endpoint[href*="/@"]');
      const author = authorEl ? authorEl.textContent.trim() : '';
      return { title, author };
    });
    dbg(`Title: ${meta.title}`);

    // Scroll down to reveal description area
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(1500);

    // Expand description ("...more" button)
    const expandResult = await page.evaluate(() => {
      const expand = document.querySelector('tp-yt-paper-button#expand');
      if (expand) { expand.click(); return 'expand-button'; }
      const desc = document.querySelector('#description-inline-expander');
      if (desc) { desc.click(); return 'description-click'; }
      return 'none';
    });
    dbg(`Expand result: ${expandResult}`);
    await page.waitForTimeout(2000);

    if (DEBUG) await page.screenshot({ path: '/tmp/yt-debug-2-expanded.png' });

    // Click "Show transcript" button with retry logic
    // YouTube sometimes opens the panel but fails to load transcript data
    const segSelector = 'transcript-segment-view-model, ytd-transcript-segment-renderer';
    let segmentsReady = false;

    for (let attempt = 1; attempt <= 3 && !segmentsReady; attempt++) {
      dbg(`Transcript click attempt ${attempt}/3`);

      // Close panel if it's already open (retry scenario)
      if (attempt > 1) {
        dbg('Closing panel for retry...');
        await page.evaluate(() => {
          const closeBtn = document.querySelector(
            'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button'
          );
          if (closeBtn) closeBtn.click();
        });
        await page.waitForTimeout(1500);
      }

      // Click the transcript button
      let transcriptClicked = false;
      try {
        await page.click('button[aria-label="Show transcript"]', { timeout: 5000 });
        transcriptClicked = true;
        dbg('Clicked via aria-label');
      } catch (e) {
        dbg(`aria-label click failed: ${e.message}`);
        transcriptClicked = await page.evaluate(() => {
          const section = document.querySelector('ytd-video-description-transcript-section-renderer');
          if (section) {
            const btn = section.querySelector('button');
            if (btn) { btn.click(); return true; }
          }
          return false;
        });
        if (transcriptClicked) dbg('Clicked via JS');
      }

      if (!transcriptClicked) {
        console.log(JSON.stringify({
          ...meta, transcript: '', segments: [],
          error: 'No transcript button found',
        }));
        return;
      }

      // Poll for segments to appear (up to 8 seconds per attempt)
      for (let i = 0; i < 8; i++) {
        const count = await page.$$eval(segSelector, els => els.length).catch(() => 0);
        if (count > 0) {
          dbg(`Found ${count} segments after ${i + 1}s`);
          segmentsReady = true;
          break;
        }
        await page.waitForTimeout(1000);
      }

      if (!segmentsReady) {
        dbg(`Attempt ${attempt}: panel opened but no segments loaded`);
      }
    }

    if (!segmentsReady) {
      dbg('All attempts exhausted');
    }

    if (DEBUG) await page.screenshot({ path: '/tmp/yt-debug-3-panel.png' });

    // Extract transcript segments
    const segments = await page.evaluate(() => {
      const results = [];

      // Strategy 1: transcript-segment-view-model (YouTube 2025+ DOM)
      const viewModels = document.querySelectorAll('transcript-segment-view-model');
      if (viewModels.length > 0) {
        viewModels.forEach(el => {
          const children = el.children;
          if (children.length >= 2) {
            const firstText = children[0].textContent.trim();
            const timeMatch = firstText.match(/^(\d+:\d+(?::\d+)?)/);
            if (timeMatch) {
              // Last non-accessible-label child has the transcript text
              let text = '';
              for (let i = children.length - 1; i >= 1; i--) {
                const ct = children[i].textContent.trim();
                if (ct.length > 0 && !ct.match(/^\d+\s*(second|minute|hour)/i)) {
                  text = ct;
                  break;
                }
              }
              if (text) results.push({ time: timeMatch[1], text });
            }
          }
        });
        if (results.length > 0) return results;
      }

      // Strategy 2: ytd-transcript-segment-renderer (older DOM)
      const renderers = document.querySelectorAll('ytd-transcript-segment-renderer');
      if (renderers.length > 0) {
        renderers.forEach(el => {
          const timeEl = el.querySelector('.segment-timestamp, [class*="timestamp"]');
          const textEl = el.querySelector('.segment-text, [class*="segment-text"], yt-formatted-string');
          if (timeEl && textEl) {
            results.push({ time: timeEl.textContent.trim(), text: textEl.textContent.trim() });
          } else {
            const raw = el.textContent.trim();
            const match = raw.match(/^(\d+:\d+(?::\d+)?)\s+([\s\S]+)/);
            if (match) results.push({ time: match[1].trim(), text: match[2].trim() });
          }
        });
        if (results.length > 0) return results;
      }

      // Strategy 3: Parse full panel text by timestamps
      const panel = document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
      );
      if (panel) {
        const fullText = panel.textContent;
        const parts = fullText.split(/(\d+:\d+(?::\d+)?)/);
        for (let i = 1; i < parts.length; i += 2) {
          const time = parts[i].trim();
          const text = (parts[i + 1] || '').trim();
          if (text.length > 0) results.push({ time, text });
        }
        return results;
      }

      return results;
    });

    // Clean up
    const cleanSegments = segments.map(s => ({
      time: s.time,
      text: s.text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim(),
    })).filter(s =>
      s.text.length > 0 &&
      !s.text.match(/^(Transcript|Search in video|Follow along|English|English \(auto-generated\))$/i)
    );

    const transcript = cleanSegments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();

    console.log(JSON.stringify({
      ...meta,
      transcript,
      segments: cleanSegments,
      error: cleanSegments.length === 0 ? 'Transcript panel opened but no segments extracted' : null,
    }));

  } catch (err) {
    console.log(JSON.stringify({
      title: '', author: '', transcript: '', segments: [],
      error: err.message,
    }));
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
