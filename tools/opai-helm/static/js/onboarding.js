/**
 * HELM -- Autonomous Business Runner -- Onboarding Wizard
 * 8-step wizard: Document/Form -> AI Parse -> Profile -> Website -> Social -> Stripe -> AI Gen -> Launch
 */

'use strict';

// ── Onboarding State ─────────────────────────────────────────────────────────
var onboardingState = {
    step: 1,
    totalSteps: 8,
    businessId: null,
    onboardingId: null,
    inputMode: 'upload',
    data: {},
    parsedFields: [],
    socialPlatforms: {},
    websiteChoice: null,
    stripeChoice: null,
    genChecklist: [],
};

var SOCIAL_PLATFORMS = [
    { key: 'twitter',   name: 'Twitter / X',  icon: 'X' },
    { key: 'linkedin',  name: 'LinkedIn',      icon: 'in' },
    { key: 'facebook',  name: 'Facebook',      icon: 'f' },
    { key: 'instagram', name: 'Instagram',     icon: 'IG' },
    { key: 'tiktok',    name: 'TikTok',        icon: 'TT' },
    { key: 'youtube',   name: 'YouTube',       icon: 'YT' },
    { key: 'pinterest', name: 'Pinterest',     icon: 'P' },
];

// Per-platform credential configs — updated 2025/2026
// Each entry describes EXACTLY what the developer portal provides and which fields are needed for POSTING.
var PLATFORM_CONFIGS = {
    twitter: {
        name: 'Twitter / X',
        signupUrl: 'https://x.com/i/flow/signup',
        devPortalUrl: 'https://developer.x.com/en/portal/dashboard',
        apiGuideUrl: 'https://developer.x.com/en/docs/authentication/oauth-1-0a',
        // The X portal shows 3 sections: App-Only Auth (Bearer Token), OAuth 1.0a Keys, and OAuth 2.0 Keys.
        // Only OAuth 1.0a can POST content. Bearer Token = read-only. OAuth 2.0 = not needed here.
        credGuide: 'X needs 4 OAuth 1.0a keys to post. In the Developer Portal open your App \u2192 Keys and Tokens. You will see three sections \u2014 use ONLY the "OAuth 1.0a Keys" section. Ignore the Bearer Token and OAuth 2.0 Client ID/Secret.',
        fields: [
            { id: 'consumer_key',        label: 'Consumer Key (API Key)',        type: 'text',     placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Developer Portal \u2192 App \u2192 Keys and Tokens \u2192 OAuth 1.0a Keys \u2192 Consumer Key. Labelled "Consumer Key" on the portal.' },
            { id: 'consumer_secret',     label: 'Consumer Secret (API Key Secret)', type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Same section \u2014 click Show next to Consumer Key. Labelled "Consumer Secret".' },
            { id: 'access_token',        label: 'Access Token',                  type: 'text',     placeholder: '1234567890-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Same page, "Access Token" section. Shows the date it was generated and which account it is for (@yourhandle). Click Show or Regenerate if needed.' },
            { id: 'access_token_secret', label: 'Access Token Secret',           type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Generated alongside the Access Token. Click Show to reveal it. Copy it immediately \u2014 if you regenerate the token you must save the new secret.' },
        ],
        setupSteps: [
            { text: 'Sign up for an X account (if needed)', url: 'https://x.com/i/flow/signup' },
            { text: 'Sign up for an X Developer account (free Basic tier is enough)', url: 'https://developer.x.com/en/apply-for-access' },
            { text: 'Create a Project and App in the Developer Portal', url: 'https://developer.x.com/en/portal/projects-and-apps' },
            { text: 'In App Settings \u2192 User Authentication Settings, set permissions to "Read and Write"', url: null },
            { text: 'Open Keys and Tokens \u2192 OAuth 1.0a Keys \u2192 copy Consumer Key and Consumer Secret', url: null },
            { text: 'Scroll to Access Token section \u2192 copy Access Token and Access Token Secret', url: null },
        ],
    },
    linkedin: {
        name: 'LinkedIn',
        signupUrl: 'https://www.linkedin.com/signup',
        devPortalUrl: 'https://www.linkedin.com/developers/apps',
        apiGuideUrl: 'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow',
        credGuide: 'LinkedIn uses OAuth 2.0. You need a Client ID, Client Secret, and an Access Token. Access tokens expire after 60 days and must be refreshed.',
        fields: [
            { id: 'client_id',     label: 'Client ID',     type: 'text',     placeholder: '86xxxxxxxxxxxxx',
              help: 'LinkedIn Developer Portal \u2192 Your App \u2192 Auth tab \u2192 "Client ID" (shown in plain text).' },
            { id: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'xxxxxxxxxxxxxxxx',
              help: 'Same Auth tab \u2014 click the eye icon next to "Primary Client Secret" to reveal it.' },
            { id: 'access_token',  label: 'Access Token',  type: 'password', placeholder: 'AQXxxxxxxxx...',
              help: 'Auth tab \u2192 OAuth 2.0 Tools \u2192 Request access token with scopes: w_member_social + rw_organization_admin. Token lasts 60 days \u2014 regenerate it here when it expires.' },
            { id: 'organization_id', label: 'Company Page ID (optional)', type: 'text', placeholder: '12345678',
              help: 'Go to your LinkedIn Company Page \u2192 copy the number from the URL: linkedin.com/company/{NUMBER}/admin. Leave blank to post as your personal profile.' },
        ],
        setupSteps: [
            { text: 'Create a LinkedIn account (if needed)', url: 'https://www.linkedin.com/signup' },
            { text: 'Create a LinkedIn Company Page for your business', url: 'https://www.linkedin.com/company/setup/new/' },
            { text: 'Create a LinkedIn Developer App and link it to your Company Page', url: 'https://www.linkedin.com/developers/apps/new' },
            { text: 'Request "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect" products on your App', url: null },
            { text: 'Copy Client ID and Client Secret from the Auth tab', url: 'https://www.linkedin.com/developers/apps' },
            { text: 'Generate Access Token via OAuth 2.0 Tools with w_member_social scope', url: 'https://www.linkedin.com/developers/tools/oauth' },
        ],
    },
    facebook: {
        name: 'Facebook',
        signupUrl: 'https://www.facebook.com/r.php',
        devPortalUrl: 'https://developers.facebook.com/apps/',
        apiGuideUrl: 'https://developers.facebook.com/docs/pages/access-tokens',
        credGuide: 'Facebook posting requires a long-lived Page Access Token (~60 days). Get it from the Graph API Explorer using your App ID and App Secret.',
        fields: [
            { id: 'page_id',           label: 'Facebook Page ID',        type: 'text',     placeholder: '123456789012345',
              help: 'Your Facebook Page \u2192 About \u2192 scroll to the bottom to find "Page ID". Or: Meta Business Suite \u2192 Settings \u2192 Page Info.' },
            { id: 'page_access_token', label: 'Page Access Token',        type: 'password', placeholder: 'EAAxxxxxxx...',
              help: 'Graph API Explorer \u2192 select your App \u2192 change token type to "Page Access Token" \u2192 select your Page \u2192 add permissions pages_manage_posts + pages_read_engagement \u2192 Generate. Then exchange for a long-lived token (good ~60 days).' },
            { id: 'app_id',            label: 'App ID (for token refresh)', type: 'text',   placeholder: '123456789012345',
              help: 'Meta Developer Portal \u2192 your App \u2192 App ID shown at the top of the dashboard. Needed to refresh your Page Access Token when it expires.' },
            { id: 'app_secret',        label: 'App Secret (for token refresh)', type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Meta Developer Portal \u2192 your App \u2192 Settings \u2192 Basic \u2192 App Secret \u2192 click Show.' },
        ],
        setupSteps: [
            { text: 'Create a Facebook Business Page (if needed)', url: 'https://www.facebook.com/pages/create' },
            { text: 'Create a Meta Developer App (type: Business)', url: 'https://developers.facebook.com/apps/create/' },
            { text: 'Add the "Pages API" product to your App in the dashboard', url: null },
            { text: 'Open Graph API Explorer, select your App, switch to Page Access Token', url: 'https://developers.facebook.com/tools/explorer/' },
            { text: 'Add permissions: pages_manage_posts + pages_read_engagement, then Generate Token', url: null },
            { text: 'Exchange the short-lived token for a long-lived one (~60 days) using the Access Token Debugger', url: 'https://developers.facebook.com/tools/accesstoken/' },
        ],
    },
    instagram: {
        name: 'Instagram',
        signupUrl: 'https://www.instagram.com/accounts/signup/',
        devPortalUrl: 'https://developers.facebook.com/apps/',
        apiGuideUrl: 'https://developers.facebook.com/docs/instagram-platform',
        // As of July 2024, Instagram Platform supports Direct Login — no Facebook Page required.
        // Old method (via Facebook Graph API) still works but requires a connected Facebook Page.
        credGuide: 'Instagram posting uses the Instagram Platform API (via Meta). You need an App ID, App Secret, and an Instagram User Access Token. As of 2024 you no longer need a Facebook Page \u2014 use Instagram Direct Login.',
        fields: [
            { id: 'app_id',              label: 'App ID',                        type: 'text',     placeholder: '123456789012345',
              help: 'Meta Developer Portal \u2192 Your App \u2192 App ID shown at the top. Use the same app for Instagram and Facebook if you have both.' },
            { id: 'app_secret',          label: 'App Secret',                    type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Meta Developer Portal \u2192 App \u2192 Settings \u2192 Basic \u2192 click Show next to App Secret.' },
            { id: 'access_token',        label: 'Instagram User Access Token',   type: 'password', placeholder: 'IGAAxxxxxxx...',
              help: 'Get this via the Instagram Direct Login OAuth flow or via Graph API Explorer. Add scopes: instagram_basic + instagram_content_publish. Long-lived tokens last ~60 days.' },
            { id: 'instagram_user_id',   label: 'Instagram Business Account ID', type: 'text',     placeholder: '17841400000000000',
              help: 'Graph API Explorer: GET /me?fields=id,username with your Instagram token \u2014 the "id" is your Instagram User ID. Or: GET /{facebook-page-id}?fields=instagram_business_account if using the Facebook Page method.' },
        ],
        setupSteps: [
            { text: 'Switch your Instagram account to Professional (Business or Creator)', url: 'https://www.instagram.com/accounts/convert_to_business/' },
            { text: 'Create a Meta Developer App at Meta for Developers', url: 'https://developers.facebook.com/apps/create/' },
            { text: 'Add the "Instagram Platform" product to your App', url: null },
            { text: 'Under Instagram \u2192 API setup, generate a long-lived User Access Token with instagram_content_publish scope', url: 'https://developers.facebook.com/tools/explorer/' },
            { text: 'Use GET /me?fields=id,username with your token to find your Instagram User ID', url: null },
        ],
    },
    tiktok: {
        name: 'TikTok',
        signupUrl: 'https://www.tiktok.com/signup',
        devPortalUrl: 'https://developers.tiktok.com/',
        apiGuideUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
        credGuide: 'TikTok uses OAuth 2.0. You need a Client Key and Client Secret from the Developer Portal, plus an Access Token and Refresh Token obtained after a user authorizes your app. Apply for the Content Posting API product first (approval 1-3 days).',
        fields: [
            { id: 'client_key',     label: 'Client Key',     type: 'text',     placeholder: 'aw7xxxxxxxxxxxxxxxxxxxx',
              help: 'TikTok Developer Portal \u2192 Manage Apps \u2192 Your App \u2192 App Details \u2192 Client Key.' },
            { id: 'client_secret',  label: 'Client Secret',  type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Same App Details page \u2014 listed as "Client Secret" next to Client Key. Keep this private.' },
            { id: 'access_token',   label: 'Access Token',   type: 'password', placeholder: 'act.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...',
              help: 'Obtained after the user completes the OAuth 2.0 authorization flow. HELM will guide through this after saving the Client Key and Secret.' },
            { id: 'refresh_token',  label: 'Refresh Token',  type: 'password', placeholder: 'rft.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...',
              help: 'Returned alongside the Access Token during OAuth. Used to get new Access Tokens when they expire. Store it securely.' },
        ],
        setupSteps: [
            { text: 'Create a TikTok Business/Creator account (if needed)', url: 'https://www.tiktok.com/signup' },
            { text: 'Register as a TikTok Developer and create an App', url: 'https://developers.tiktok.com/' },
            { text: 'Apply for the "Content Posting API" product inside your App settings', url: null },
            { text: 'Wait for product approval (usually 1-3 business days)', url: null },
            { text: 'Copy Client Key and Client Secret from App Details', url: 'https://developers.tiktok.com/' },
            { text: 'Complete the OAuth authorization flow to obtain your Access Token and Refresh Token', url: null },
        ],
    },
    youtube: {
        name: 'YouTube',
        signupUrl: 'https://accounts.google.com/signup',
        devPortalUrl: 'https://console.cloud.google.com/',
        apiGuideUrl: 'https://developers.google.com/youtube/v3/guides/authentication',
        // IMPORTANT: YouTube API Keys are READ-ONLY for public data. Posting requires OAuth 2.0.
        credGuide: 'YouTube posting requires OAuth 2.0 credentials \u2014 NOT an API Key. An API Key is read-only and cannot upload or post. You need a Client ID, Client Secret, and a Refresh Token from Google Cloud Console.',
        fields: [
            { id: 'client_id',     label: 'OAuth 2.0 Client ID',     type: 'text',     placeholder: 'xxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com',
              help: 'Google Cloud Console \u2192 APIs & Services \u2192 Credentials \u2192 Create Credentials \u2192 OAuth client ID. Choose "Web application" or "Desktop app" type.' },
            { id: 'client_secret', label: 'OAuth 2.0 Client Secret', type: 'password', placeholder: 'GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Shown alongside your Client ID in Google Cloud Console \u2192 Credentials. Download the JSON file to see both values.' },
            { id: 'refresh_token', label: 'Refresh Token',           type: 'password', placeholder: '1//xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Obtained after you complete the Google OAuth consent flow. HELM will guide you through this after saving Client ID and Secret. Refresh tokens are permanent until revoked.' },
            { id: 'channel_id',    label: 'Channel ID',              type: 'text',     placeholder: 'UCxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'YouTube Studio \u2192 Settings \u2192 Channel \u2192 Advanced settings \u2192 Channel ID. Starts with "UC".' },
        ],
        setupSteps: [
            { text: 'Open Google Cloud Console and create a project (or use existing)', url: 'https://console.cloud.google.com/projectcreate' },
            { text: 'Enable "YouTube Data API v3" under APIs & Services \u2192 Library', url: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' },
            { text: 'Create OAuth 2.0 credentials: APIs & Services \u2192 Credentials \u2192 Create \u2192 OAuth client ID', url: 'https://console.cloud.google.com/apis/credentials' },
            { text: 'Configure OAuth consent screen with scope: .../auth/youtube.upload', url: null },
            { text: 'Complete the authorization flow to get your Refresh Token (permanent)', url: null },
            { text: 'Find your Channel ID in YouTube Studio \u2192 Settings \u2192 Channel \u2192 Advanced', url: 'https://studio.youtube.com/' },
        ],
    },
    pinterest: {
        name: 'Pinterest',
        signupUrl: 'https://business.pinterest.com/en/',
        devPortalUrl: 'https://developers.pinterest.com/apps/',
        apiGuideUrl: 'https://developers.pinterest.com/docs/api/v5/oauth-token/',
        credGuide: 'Pinterest uses OAuth 2.0 (API v5). You need App ID, App Secret, an Access Token, and a Refresh Token. Access tokens expire after 30 days \u2014 HELM uses the Refresh Token to renew automatically.',
        fields: [
            { id: 'app_id',        label: 'App ID',        type: 'text',     placeholder: '1234567',
              help: 'Pinterest Developer Portal \u2192 My Apps \u2192 Your App \u2192 App ID shown at the top.' },
            { id: 'app_secret',    label: 'App Secret',    type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Same page as App ID \u2014 click the eye icon to reveal your App Secret.' },
            { id: 'access_token',  label: 'Access Token',  type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Pinterest Developer Portal \u2192 Your App \u2192 click "Generate access token" \u2192 select scopes: boards:read, boards:write, pins:read, pins:write. Expires after 30 days.' },
            { id: 'refresh_token', label: 'Refresh Token', type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              help: 'Returned alongside the Access Token when you generate it. HELM uses this to automatically renew your Access Token every 30 days.' },
            { id: 'board_id',      label: 'Default Board ID (optional)', type: 'text', placeholder: '1234567890123456789',
              help: 'Optional: numeric ID of your main Pinterest board. Found in the board URL: pinterest.com/{user}/{board-name}/ \u2192 get the ID via GET /v5/boards. Leave blank to post without a default board.' },
        ],
        setupSteps: [
            { text: 'Create a Pinterest Business account', url: 'https://business.pinterest.com/en/' },
            { text: 'Go to Pinterest Developer Portal and create an App', url: 'https://developers.pinterest.com/apps/' },
            { text: 'Add a redirect URI to your App (required for token generation, e.g. https://localhost)', url: null },
            { text: 'Click "Generate access token" \u2192 select boards:read, boards:write, pins:read, pins:write', url: 'https://developers.pinterest.com/apps/' },
            { text: 'Copy both Access Token AND Refresh Token \u2014 you need both', url: null },
        ],
    },
};

// ── Entry Point ──────────────────────────────────────────────────────────────
function initOnboarding() {
    onboardingState = {
        step: 1,
        totalSteps: 8,
        businessId: null,
        onboardingId: null,
        inputMode: 'upload',
        data: {},
        parsedFields: [],
        socialPlatforms: {},
        websiteChoice: null,
        stripeChoice: null,
        genChecklist: [],
    };
    renderOnboarding();
}

function renderOnboarding() {
    var el = document.getElementById('view-onboarding');
    el.innerHTML =
        '<div class="onboarding-wizard">' +
            renderStepProgress(onboardingState.step, onboardingState.totalSteps) +
            '<div id="onboarding-content"></div>' +
        '</div>';
    showStep(onboardingState.step);
}

// ── Step Progress Bar ────────────────────────────────────────────────────────
function renderStepProgress(current, total) {
    var html = '<div class="step-progress">';
    for (var i = 1; i <= total; i++) {
        var cls = 'step-dot';
        if (i < current) cls += ' done';
        else if (i === current) cls += ' active';
        html += '<div class="' + cls + '"></div>';
        if (i < total) {
            html += '<div class="step-connector' + (i < current ? ' done' : '') + '"></div>';
        }
    }
    html += '</div>';
    return html;
}

// ── Step Router ──────────────────────────────────────────────────────────────
function showStep(n) {
    onboardingState.step = n;
    // Re-render progress
    var wizard = document.querySelector('.onboarding-wizard');
    if (wizard) {
        var progressEl = wizard.querySelector('.step-progress');
        if (progressEl) {
            progressEl.outerHTML = renderStepProgress(n, onboardingState.totalSteps);
        }
    }

    var container = document.getElementById('onboarding-content');
    if (!container) return;

    switch (n) {
        case 1: container.innerHTML = renderStep1(); initStep1(); break;
        case 2: container.innerHTML = renderStep2(); startParsing(); break;
        case 3: container.innerHTML = renderStep3(); initAutonomySlider(); break;
        case 4:
            container.innerHTML = renderStep4();
            // If returning from Stripe, trigger builder confirmation
            (function() {
                var urlParams = new URLSearchParams(window.location.search);
                var wsSession = urlParams.get('ws_session');
                if (wsSession && typeof initWebsiteBuilder === 'function') {
                    onboardingState.websiteChoice = 'build';
                    initWebsiteBuilder(onboardingState.onboardingId, onboardingState.data);
                }
            })();
            break;
        case 5: container.innerHTML = renderStep5(); break;
        case 6: container.innerHTML = renderStep6(); break;
        case 7: container.innerHTML = renderStep7(); startGeneration(); break;
        case 8: container.innerHTML = renderStep8(); break;
    }
}

function nextStep() {
    if (onboardingState.step < onboardingState.totalSteps) {
        showStep(onboardingState.step + 1);
    }
}

function prevStep() {
    if (onboardingState.step > 1) {
        showStep(onboardingState.step - 1);
    }
}

// ── Step 1: Business Info (Upload or Form) ───────────────────────────────────
function renderStep1() {
    return '<div class="onboarding-step">' +
        '<h2>Tell us about your business</h2>' +
        '<div class="tab-toggle">' +
            '<button class="tab-btn active" id="mode-upload" onclick="setInputMode(\'upload\')">Upload Document</button>' +
            '<button class="tab-btn" id="mode-form" onclick="setInputMode(\'form\')">Fill Form</button>' +
        '</div>' +
        '<div id="upload-mode">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
                '<p style="font-size:13px;color:var(--text-muted);margin:0;">Upload your business plan, or paste a description below.</p>' +
                '<a href="/helm/api/onboarding/template" download="HELM-Business-Brief-Template.md" class="btn btn-sm" title="Download our pre-built template to fill out">' +
                    '&#8659; Download Template' +
                '</a>' +
            '</div>' +
            '<div class="drop-zone" id="drop-zone">' +
                'Drop your business plan here<br>' +
                '<small>PDF, DOCX, MD, TXT &mdash; max 50MB</small>' +
                '<input type="file" id="file-input" accept=".pdf,.docx,.md,.txt" style="display:none">' +
                '<br><button class="btn" onclick="document.getElementById(\'file-input\').click()">Browse Files</button>' +
            '</div>' +
            '<div id="file-info" style="margin-top:10px;font-size:13px;color:var(--success);display:none;"></div>' +
            '<p class="or-divider">OR paste text directly:</p>' +
            '<textarea id="paste-content" placeholder="Paste your business plan, pitch deck text, or description..." rows="8"></textarea>' +
        '</div>' +
        '<div id="form-mode" style="display:none;">' +
            '<label>Business name <span style="color:var(--accent)">*</span><input type="text" id="f-name" placeholder="BoutaCare"></label>' +
            '<label>Industry' +
                '<select id="f-industry">' +
                    '<option value="">Select industry...</option>' +
                    '<option>SaaS / Software</option>' +
                    '<option>E-commerce</option>' +
                    '<option>Consulting</option>' +
                    '<option>Health &amp; Wellness</option>' +
                    '<option>Education / EdTech</option>' +
                    '<option>Real Estate</option>' +
                    '<option>Food &amp; Beverage</option>' +
                    '<option>Agency / Creative</option>' +
                    '<option>Finance</option>' +
                    '<option>Non-profit</option>' +
                    '<option>Other</option>' +
                '</select>' +
            '</label>' +
            '<label>Business type' +
                '<div class="radio-group">' +
                    '<label><input type="radio" name="btype" value="service"> Service</label>' +
                    '<label><input type="radio" name="btype" value="product"> Product</label>' +
                    '<label><input type="radio" name="btype" value="saas"> SaaS</label>' +
                    '<label><input type="radio" name="btype" value="content"> Content / Media</label>' +
                '</div>' +
            '</label>' +
            '<label>Elevator pitch<textarea id="f-pitch" rows="3" placeholder="2-3 sentences: what you do and who you serve."></textarea></label>' +
            '<label>Target audience<input type="text" id="f-audience" placeholder="e.g. Freelance designers making $50k+"></label>' +
            '<label>Value proposition<input type="text" id="f-value-prop" placeholder="What makes you different from competitors?"></label>' +
            '<label>Revenue model' +
                '<select id="f-revenue">' +
                    '<option value="">Select revenue model...</option>' +
                    '<option value="subscription">Subscription / SaaS</option>' +
                    '<option value="one_time">One-time sales</option>' +
                    '<option value="freemium">Freemium</option>' +
                    '<option value="ads">Advertising</option>' +
                    '<option value="services">Services / Consulting</option>' +
                    '<option value="marketplace">Marketplace / Commission</option>' +
                    '<option value="hybrid">Hybrid</option>' +
                    '<option value="other">Other</option>' +
                '</select>' +
            '</label>' +
            '<label>Brand tone' +
                '<select id="f-tone">' +
                    '<option value="professional">Professional</option>' +
                    '<option value="friendly">Friendly &amp; approachable</option>' +
                    '<option value="casual">Casual</option>' +
                    '<option value="bold">Bold &amp; direct</option>' +
                    '<option value="educational">Educational / thought-leader</option>' +
                    '<option value="inspiring">Inspiring</option>' +
                '</select>' +
            '</label>' +
            '<label>Primary 90-day goal<textarea id="f-goal" rows="2" placeholder="e.g. Generate 50 qualified leads, launch MVP, reach $5k MRR"></textarea></label>' +
        '</div>' +
        '<div class="step-nav">' +
            '<div></div>' +
            '<button class="btn btn-primary" onclick="submitStep1()">Next</button>' +
        '</div>' +
    '</div>';
}

function initStep1() {
    // Set up drag and drop
    setTimeout(function() {
        var dropZone = document.getElementById('drop-zone');
        var fileInput = document.getElementById('file-input');
        if (!dropZone || !fileInput) return;

        dropZone.addEventListener('dragover', function(e) {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', function() {
            dropZone.classList.remove('dragover');
        });
        dropZone.addEventListener('drop', function(e) {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });
        fileInput.addEventListener('change', function(e) {
            handleFiles(e.target.files);
        });
    }, 50);
}

function setInputMode(mode) {
    onboardingState.inputMode = mode;
    document.getElementById('upload-mode').style.display = mode === 'upload' ? '' : 'none';
    document.getElementById('form-mode').style.display = mode === 'form' ? '' : 'none';
    document.getElementById('mode-upload').classList.toggle('active', mode === 'upload');
    document.getElementById('mode-form').classList.toggle('active', mode === 'form');
}

function handleFiles(files) {
    if (!files || files.length === 0) return;
    var file = files[0];
    if (file.size > 50 * 1024 * 1024) {
        showToast('File too large. Maximum is 50MB.', 'error');
        return;
    }
    onboardingState.data.file = file;
    var info = document.getElementById('file-info');
    if (info) {
        info.style.display = '';
        info.textContent = 'Selected: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    }
}

async function submitStep1() {
    try {
        var payload;

        if (onboardingState.inputMode === 'upload') {
            var pasteContent = document.getElementById('paste-content').value.trim();
            var file = onboardingState.data.file;

            if (!file && !pasteContent) {
                showToast('Please upload a document or paste your business description.', 'error');
                return;
            }

            var formData = new FormData();
            if (file) {
                formData.append('file', file);
            }
            if (pasteContent) {
                formData.append('text_content', pasteContent);
            }

            var resp = await fetch('/helm/api/onboarding', {
                method: 'POST',
                headers: HELM.token ? { 'Authorization': 'Bearer ' + HELM.token } : {},
                body: formData,
            });

            if (!resp.ok) {
                var err = await resp.json().catch(function() { return { detail: resp.statusText }; });
                throw new Error(err.detail || 'Upload failed');
            }
            payload = await resp.json();
            onboardingState.onboardingId = payload.onboarding_id || payload.id;
            onboardingState.businessId = payload.business_id;
            // Upload mode → go to Step 2 (AI Parse)
            showStep(2);

        } else {
            // Form mode — data is already structured, skip Step 2 entirely
            var name = document.getElementById('f-name').value.trim();
            if (!name) {
                showToast('Please enter a business name.', 'error');
                return;
            }

            var btypeEl = document.querySelector('input[name="btype"]:checked');
            var formBody = {
                name: name,
                industry: document.getElementById('f-industry').value,
                business_type: btypeEl ? btypeEl.value : '',
                pitch: document.getElementById('f-pitch').value.trim(),
                target_audience: document.getElementById('f-audience').value.trim(),
                value_proposition: document.getElementById('f-value-prop').value.trim(),
                revenue_model: document.getElementById('f-revenue').value,
                tone_of_voice: document.getElementById('f-tone').value,
                goal_90_day: document.getElementById('f-goal').value.trim(),
            };

            payload = await apiFetch('/helm/api/onboarding/form', {
                method: 'POST',
                body: formBody,
            });

            onboardingState.onboardingId = payload.onboarding_id || payload.id;
            onboardingState.businessId = payload.business_id;

            // Pre-populate onboardingState.data so Step 3 renders correctly
            onboardingState.data = Object.assign({}, formBody);

            // Form mode → skip Step 2, jump directly to Step 3 (Profile Confirmation)
            showStep(3);
        }

    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Step 2: AI Parse (SSE stream) ────────────────────────────────────────────
function renderStep2() {
    return '<div class="onboarding-step">' +
        '<h2>Analyzing your business...</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px;">HELM is reading your document and extracting key information.</p>' +
        '<div class="stream-display" id="parse-stream"></div>' +
        '<div id="parsed-fields" style="margin-top:20px;display:none;"></div>' +
        '<div class="step-nav">' +
            '<button class="btn" onclick="prevStep()">Back</button>' +
            '<button class="btn btn-primary" id="step2-next" onclick="submitStep2()" disabled>Next</button>' +
        '</div>' +
    '</div>';
}

async function startParsing() {
    var stream = document.getElementById('parse-stream');
    var fieldsContainer = document.getElementById('parsed-fields');
    stream.innerHTML = '<div class="stream-line"><span class="spin">\u21BB</span> Starting analysis...</div>';

    try {
        var url = '/helm/api/onboarding/' + onboardingState.onboardingId + '/parse';
        var resp = await fetch(url, {
            headers: HELM.token ? { 'Authorization': 'Bearer ' + HELM.token } : {},
        });

        if (!resp.ok) {
            var errBody = await resp.json().catch(function() { return {}; });
            throw new Error(errBody.detail || 'Parse failed');
        }

        var contentType = resp.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream')) {
            // SSE stream
            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            while (true) {
                var result = await reader.read();
                if (result.done) break;
                buffer += decoder.decode(result.value, { stream: true });

                var lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line in buffer

                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (line.startsWith('data:')) {
                        var jsonStr = line.substring(5).trim();
                        if (jsonStr === '[DONE]') continue;
                        try {
                            var evt = JSON.parse(jsonStr);
                            handleParseEvent(evt, stream);
                        } catch (_) { /* skip bad JSON */ }
                    }
                }
            }
        } else {
            // Non-streaming response (JSON)
            var data = await resp.json();
            onboardingState.parsedFields = data.fields || [];
            stream.innerHTML = '<div class="stream-line"><span class="check">\u2713</span> Analysis complete</div>';
        }

        // Render parsed fields
        renderParsedFields(fieldsContainer);
        fieldsContainer.style.display = '';
        document.getElementById('step2-next').disabled = false;

    } catch (err) {
        stream.innerHTML = '<div class="stream-line" style="color:var(--error);">\u2717 ' + esc(err.message) + '</div>';
        showToast(err.message, 'error');
    }
}

function handleParseEvent(evt, stream) {
    if (evt.type === 'progress') {
        stream.innerHTML += '<div class="stream-line"><span class="spin">\u21BB</span> ' + esc(evt.message) + '</div>';
    } else if (evt.type === 'field') {
        onboardingState.parsedFields.push(evt);
        // Replace last spinner with check
        var spins = stream.querySelectorAll('.spin');
        if (spins.length > 0) {
            var last = spins[spins.length - 1];
            last.className = 'check';
            last.textContent = '\u2713';
        }
        stream.innerHTML += '<div class="stream-line"><span class="check">\u2713</span> Extracted: ' + esc(evt.field_name) + '</div>';
    } else if (evt.type === 'complete') {
        if (evt.fields) onboardingState.parsedFields = evt.fields;
        var spins = stream.querySelectorAll('.spin');
        spins.forEach(function(s) { s.className = 'check'; s.textContent = '\u2713'; });
        stream.innerHTML += '<div class="stream-line"><span class="check">\u2713</span> Analysis complete \u2014 ' + (onboardingState.parsedFields.length) + ' fields found</div>';
    } else if (evt.type === 'result') {
        // Fallback: convert result.data dict to fields array
        if (evt.data && typeof evt.data === 'object') {
            onboardingState.parsedFields = Object.entries(evt.data)
                .filter(function(e) { return e[1] && !String(e[1]).startsWith('['); })
                .map(function(e) {
                    return { field_name: e[0].replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }), key: e[0], value: String(e[1]), confidence: 0.7 };
                });
        }
        var spins = stream.querySelectorAll('.spin');
        spins.forEach(function(s) { s.className = 'check'; s.textContent = '\u2713'; });
        stream.innerHTML += '<div class="stream-line"><span class="check">\u2713</span> Analysis complete</div>';
    }
    // Auto-scroll
    stream.scrollTop = stream.scrollHeight;
}

function renderParsedFields(container) {
    var fields = onboardingState.parsedFields;
    if (!fields || fields.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);">No fields were extracted. You can proceed and fill in details manually.</p>';
        document.getElementById('step2-next').disabled = false;
        return;
    }

    var html = '<h3>Extracted Information</h3><p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">Click any field to edit. Amber fields have lower confidence.</p>';

    fields.forEach(function(f, idx) {
        var conf = (f.confidence || 1);
        var confClass = conf >= 0.8 ? 'confidence-high' : (conf >= 0.5 ? 'confidence-medium' : 'confidence-low');
        var confLabel = conf >= 0.8 ? 'High' : (conf >= 0.5 ? 'Medium' : 'Low');

        html +=
            '<div class="editable-field" id="pf-' + idx + '" onclick="editParsedField(' + idx + ')">' +
                '<div class="field-label">' + esc(f.field_name || f.key) + ' <span class="' + confClass + '" style="font-size:10px;">(' + confLabel + ')</span></div>' +
                '<div class="field-value" id="pf-val-' + idx + '">' + esc(f.value) + '</div>' +
                (f.source_excerpt ? '<div class="field-excerpt" title="Source: ' + esc(f.source_excerpt) + '">Source: "' + esc(f.source_excerpt.substring(0, 80)) + (f.source_excerpt.length > 80 ? '...' : '') + '"</div>' : '') +
            '</div>';
    });

    container.innerHTML = html;
}

function editParsedField(idx) {
    var field = onboardingState.parsedFields[idx];
    var el = document.getElementById('pf-' + idx);
    var valEl = document.getElementById('pf-val-' + idx);
    if (!el || !valEl || el.classList.contains('editing')) return;

    el.classList.add('editing');
    var currentVal = field.value || '';
    valEl.innerHTML = '<input type="text" value="' + esc(currentVal) + '" id="pf-edit-' + idx + '" onblur="saveParsedField(' + idx + ')" onkeydown="if(event.key===\'Enter\')this.blur()">';
    var input = document.getElementById('pf-edit-' + idx);
    if (input) input.focus();
}

function saveParsedField(idx) {
    var input = document.getElementById('pf-edit-' + idx);
    if (!input) return;
    onboardingState.parsedFields[idx].value = input.value;
    var el = document.getElementById('pf-' + idx);
    var valEl = document.getElementById('pf-val-' + idx);
    if (el) el.classList.remove('editing');
    if (valEl) valEl.textContent = input.value;
}

async function submitStep2() {
    // Pre-populate step 3 data from parsed fields
    onboardingState.parsedFields.forEach(function(f) {
        var key = f.key || (f.field_name || '').toLowerCase().replace(/\s+/g, '_');
        onboardingState.data[key] = f.value;
    });

    // Best-effort save to server — don't block navigation on failure
    apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/fields', {
        method: 'PUT',
        body: { fields: onboardingState.parsedFields },
    }).catch(function() { /* non-blocking */ });

    nextStep();
}

// ── Step 3: Business Profile Confirmation ────────────────────────────────────
function renderStep3() {
    var d = onboardingState.data;
    var nameVal = d.name || d.business_name || '';
    var slugVal = d.slug || nameVal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    return '<div class="onboarding-step">' +
        '<h2>Confirm Your Business Profile</h2>' +
        '<label>Business Name<input type="text" id="bp-name" value="' + esc(nameVal) + '"></label>' +
        '<label>Slug (URL-friendly)<input type="text" id="bp-slug" value="' + esc(slugVal) + '"></label>' +
        '<label>Brand Colors' +
            '<div style="display:flex;gap:16px;">' +
                '<div><small>Primary</small><div class="color-picker-row"><input type="color" id="bp-color1" value="' + esc(d.brand_color_primary || '#e11d48') + '"><input type="text" id="bp-color1t" value="' + esc(d.brand_color_primary || '#e11d48') + '"></div></div>' +
                '<div><small>Secondary</small><div class="color-picker-row"><input type="color" id="bp-color2" value="' + esc(d.brand_color_secondary || '#1a1a1a') + '"><input type="text" id="bp-color2t" value="' + esc(d.brand_color_secondary || '#1a1a1a') + '"></div></div>' +
            '</div>' +
        '</label>' +
        '<label>Tone of Voice' +
            '<select id="bp-tone">' +
                ['professional','friendly','casual','authoritative','playful'].map(function(t) {
                    return '<option value="' + t + '"' + (d.tone_of_voice === t ? ' selected' : '') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>';
                }).join('') +
            '</select>' +
        '</label>' +
        '<label>Target Audience<input type="text" id="bp-audience" value="' + esc(d.target_audience || '') + '"></label>' +
        '<label>Autonomy Level' +
            '<div class="autonomy-slider-wrap">' +
                '<input type="range" id="bp-autonomy" class="autonomy-slider" min="1" max="10" value="' + (d.autonomy_level || 8) + '" oninput="updateAutonomySlider(this.value)">' +
                '<div class="autonomy-tooltip" id="auto-tooltip"></div>' +
            '</div>' +
            '<div class="range-labels"><span>1 — Full approval</span><span id="bp-auto-val">' + (d.autonomy_level || 8) + '</span><span>10 — Full autopilot</span></div>' +
            '<div class="autonomy-desc" id="auto-desc"></div>' +
        '</label>' +
        '<div class="step-nav">' +
            '<button class="btn" onclick="onboardingState.inputMode===\'form\' ? showStep(1) : prevStep()">Back</button>' +
            '<button class="btn btn-primary" onclick="submitStep3()">Next</button>' +
        '</div>' +
    '</div>';
}

var AUTONOMY_LABELS = {
    1:  'Asks for approval on every single action before doing anything.',
    2:  'Asks before posting or sending anything externally.',
    3:  'Drafts all content for your review — nothing goes live without approval.',
    4:  'Handles research and planning autonomously; you approve before publishing.',
    5:  'Publishes routine content independently, escalates anything new or unusual.',
    6:  'Manages content and social autonomously, flags edge cases for review.',
    7:  'Runs daily operations independently — only escalates errors and conflicts.',
    8:  'Full daily operations plus proactive outreach — CEO-gate for financial decisions only.',
    9:  'Near-full autopilot — contacts you only for major financial moves.',
    10: 'Complete autopilot — acts on all decisions, reports outcomes to you.',
};

function updateAutonomySlider(val) {
    val = parseInt(val, 10);
    // Keep onboardingState in sync so step 8 always reflects the user's choice
    if (typeof onboardingState !== 'undefined') {
        onboardingState.data = onboardingState.data || {};
        onboardingState.data.autonomy_level = val;
    }
    document.getElementById('bp-auto-val').textContent = val;

    // Update desc text below the slider
    var desc = document.getElementById('auto-desc');
    if (desc) desc.textContent = AUTONOMY_LABELS[val] || '';

    // Update gradient fill via CSS custom property
    var slider = document.getElementById('bp-autonomy');
    var tooltip = document.getElementById('auto-tooltip');
    if (!slider || !tooltip) return;
    slider.style.setProperty('--val', val);

    // Position the tooltip bubble above the thumb
    var pct = (val - 1) / 9; // 0..1
    var thumbW = 20;
    var trackW = slider.offsetWidth - thumbW;
    var left = pct * trackW + thumbW / 2;
    tooltip.style.left = left + 'px';
    tooltip.textContent = val;
    tooltip.style.opacity = '1';
}

function initAutonomySlider() {
    // Wait one frame for the DOM to paint so offsetWidth is accurate
    requestAnimationFrame(function() {
        var slider = document.getElementById('bp-autonomy');
        if (slider) updateAutonomySlider(slider.value);
    });
}

async function submitStep3() {
    try {
        var profile = {
            name: document.getElementById('bp-name').value.trim(),
            slug: document.getElementById('bp-slug').value.trim(),
            tone_of_voice: document.getElementById('bp-tone').value,
            target_audience: document.getElementById('bp-audience').value.trim(),
            autonomy_level: parseInt(document.getElementById('bp-autonomy').value, 10),
        };

        if (!profile.name) {
            showToast('Business name is required.', 'error');
            return;
        }

        await apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/confirm', {
            method: 'POST',
            body: { profile: profile },
        });

        Object.assign(onboardingState.data, profile);
        nextStep();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Step 4: Website Platform Selection ───────────────────────────────────────
function renderStep4() {
    // Check if returning from Stripe checkout (ws_session param)
    var urlParams = new URLSearchParams(window.location.search);
    var wsSession = urlParams.get('ws_session');
    var obParam = urlParams.get('ob');
    // Safety: seed onboardingId from URL in case of fresh page load after Stripe redirect
    if (obParam && !onboardingState.onboardingId) onboardingState.onboardingId = obParam;
    if (wsSession && obParam) {
        // Returning from Stripe — hand off to builder confirmation
        onboardingState.websiteChoice = 'build';
        return '<div class="onboarding-step">' +
            '<h2>Website Setup</h2>' +
            '<div id="website-subform"></div>' +
            '<div class="step-nav">' +
                '<button class="btn" onclick="prevStep()">Back</button>' +
                '<button class="btn btn-primary" id="step4-next" onclick="submitStep4()" style="display:none;">Next</button>' +
            '</div>' +
        '</div>';
    }

    return '<div class="onboarding-step">' +
        '<h2>Website Setup</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px;">Choose how HELM should handle your website. You can always connect more later.</p>' +
        '<div class="choice-grid" id="website-choices">' +
            '<div class="choice-card" data-choice="build" onclick="selectWebsite(\'build\')">' +
                '<h4>&#10024; I need a website</h4>' +
                '<p>Build one for me — HELM searches domains, picks hosting, and sets everything up.</p>' +
            '</div>' +
            '<div class="choice-card recommended" data-choice="wordpress" onclick="selectWebsite(\'wordpress\')">' +
                '<h4>&#128295; WordPress + Hostinger</h4>' +
                '<p>Full CMS, e-commerce, plugins. HELM manages publishing, updates, and backups via REST API.</p>' +
            '</div>' +
            '<div class="choice-card" data-choice="netlify" onclick="selectWebsite(\'netlify\')">' +
                '<h4>&#9729; Netlify</h4>' +
                '<p>Connect an existing Netlify site or deploy a new one. HELM triggers builds and manages your site via your PAT.</p>' +
            '</div>' +
            '<div class="choice-card" data-choice="existing" onclick="selectWebsite(\'existing\')">' +
                '<h4>&#127758; Other / Existing Site</h4>' +
                '<p>Already have a site elsewhere? Connect it by URL. HELM monitors uptime and links content to it.</p>' +
            '</div>' +
        '</div>' +
        '<div style="margin-bottom:16px;">' +
            '<button class="btn btn-ghost btn-sm" onclick="selectWebsite(\'skip\')">Skip for Now</button>' +
        '</div>' +
        '<div id="website-subform" style="display:none;"></div>' +
        '<div class="step-nav">' +
            '<button class="btn" onclick="prevStep()">Back</button>' +
            '<button class="btn btn-primary" id="step4-next" onclick="submitStep4()">Next</button>' +
        '</div>' +
    '</div>';
}

function selectWebsite(choice) {
    onboardingState.websiteChoice = choice;

    document.querySelectorAll('#website-choices .choice-card').forEach(function(el) {
        el.classList.toggle('selected', el.dataset.choice === choice);
    });

    var subform = document.getElementById('website-subform');

    if (choice === 'build') {
        // Launch the website builder sub-wizard
        subform.style.display = '';
        subform.innerHTML = '';
        if (typeof initWebsiteBuilder === 'function') {
            initWebsiteBuilder(onboardingState.onboardingId, onboardingState.data);
        } else {
            subform.innerHTML = '<p style="color:var(--error);">Website builder script not loaded.</p>';
        }
        return;
    }

    if (choice === 'wordpress') {
        subform.style.display = '';
        subform.innerHTML =
            '<div class="card" style="margin-top:12px;">' +
                '<h3 style="margin-bottom:4px;">WordPress Connection</h3>' +
                '<p style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">HELM uses the WordPress REST API with Application Passwords. <a href="https://wordpress.org/documentation/article/application-passwords/" target="_blank">How to create one &rarr;</a></p>' +
                '<label>Site URL<input type="url" id="ws-domain" placeholder="https://mybusiness.com"></label>' +
                '<label>Admin Username<input type="text" id="ws-username" placeholder="admin"></label>' +
                '<label>Application Password<input type="password" id="ws-apppass" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"><small style="color:var(--text-faint);">Generate in WordPress &rarr; Users &rarr; Profile &rarr; Application Passwords</small></label>' +
            '</div>';
    } else if (choice === 'netlify') {
        subform.style.display = '';
        subform.innerHTML =
            '<div class="card" style="margin-top:12px;">' +
                '<h3 style="margin-bottom:4px;">Netlify Connection</h3>' +
                '<p style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">HELM uses your Personal Access Token (PAT) to manage deployments and site settings. Your PAT is encrypted and stored securely in the vault.</p>' +
                '<label>Personal Access Token (PAT)<input type="password" id="ws-netlify-pat" placeholder="nfp_..."><small style="color:var(--text-faint);">Netlify &rarr; User Settings &rarr; Applications &rarr; Personal access tokens</small></label>' +
                '<label>Site Name or ID<input type="text" id="ws-netlify-site" placeholder="boutacare or abc123de-..."><small style="color:var(--text-faint);">Found in Netlify &rarr; Site Settings &rarr; General. Use the site name (e.g. boutacare) or the API ID.</small></label>' +
                '<label>Production URL<input type="url" id="ws-netlify-url" placeholder="https://boutacare.netlify.app"><small style="color:var(--text-faint);">Your live site URL (custom domain or .netlify.app)</small></label>' +
            '</div>';
    } else if (choice === 'existing') {
        subform.style.display = '';
        subform.innerHTML =
            '<div class="card" style="margin-top:12px;">' +
                '<h3 style="margin-bottom:4px;">Connect Existing Site</h3>' +
                '<p style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">HELM will monitor this site for uptime and link content to it. Add API credentials if your platform supports them.</p>' +
                '<label>Site URL<input type="url" id="ws-url" placeholder="https://mybusiness.com"></label>' +
                '<label>Platform (optional)<input type="text" id="ws-platform-name" placeholder="e.g. Squarespace, Wix, Shopify, custom..."></label>' +
                '<label>API Key (optional)<input type="text" id="ws-apikey" placeholder="For platforms that support API access"></label>' +
            '</div>';
    } else {
        subform.style.display = 'none';
        subform.innerHTML = '';
    }
}

async function submitStep4() {
    try {
        var choice = onboardingState.websiteChoice || 'skip';
        var body = { platform: choice === 'skip' ? 'none' : choice };

        if (choice === 'wordpress') {
            var siteUrl = (document.getElementById('ws-domain') || {}).value || '';
            var username = (document.getElementById('ws-username') || {}).value || '';
            var appPass = (document.getElementById('ws-apppass') || {}).value || '';
            if (siteUrl) body.site_url = siteUrl;
            if (username) body.username = username;
            if (appPass) body.app_password = appPass;

        } else if (choice === 'netlify') {
            var pat = (document.getElementById('ws-netlify-pat') || {}).value || '';
            var siteId = (document.getElementById('ws-netlify-site') || {}).value || '';
            var netlifyUrl = (document.getElementById('ws-netlify-url') || {}).value || '';
            if (!pat) { showToast('Netlify PAT is required.', 'error'); return; }
            body.site_url = netlifyUrl || siteId;
            body.username = siteId;        // site name/ID stored in username slot
            body.app_password = pat;       // PAT stored securely in vault

        } else if (choice === 'existing') {
            var existUrl = (document.getElementById('ws-url') || {}).value || '';
            var platName = (document.getElementById('ws-platform-name') || {}).value || '';
            var apiKey = (document.getElementById('ws-apikey') || {}).value || '';
            if (existUrl) body.site_url = existUrl;
            if (platName) body.platform = platName;
            if (apiKey) body.app_password = apiKey;
        }

        await apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/website', {
            method: 'POST',
            body: body,
        });

        Object.assign(onboardingState.data, { websiteChoice: choice, site_url: body.site_url });
        nextStep();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Step 5: Social Accounts ──────────────────────────────────────────────────
function renderStep5() {
    var bizName = onboardingState.data.name || 'your business';

    var html = '<div class="onboarding-step">' +
        '<h2>Social Media Accounts</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px;">Connect or set up social accounts for ' + esc(bizName) + '. You can skip any platform and connect later.</p>' +
        '<div class="platform-list" id="platform-list">';

    SOCIAL_PLATFORMS.forEach(function(plat) {
        var state = onboardingState.socialPlatforms[plat.key] || 'pending';
        html += renderPlatformCard(plat, state);
    });

    html += '</div>' +
        '<div class="step-nav">' +
            '<button class="btn" onclick="prevStep()">Back</button>' +
            '<button class="btn btn-primary" onclick="submitStep5()">Next</button>' +
        '</div>' +
    '</div>';

    return html;
}

function renderPlatformCard(plat, state) {
    var statusText = state === 'connected' ? 'Connected' : (state === 'skipped' ? 'Skipped' : 'Not connected');
    var statusClass = state === 'connected' ? 'connected' : (state === 'skipped' ? 'inactive' : 'pending');

    var actionsHtml = '';
    if (state === 'pending') {
        actionsHtml =
            '<button class="btn btn-sm" onclick="showPlatformConnect(\'' + plat.key + '\')">Yes, connect it</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="showPlatformSetup(\'' + plat.key + '\')">No, set one up</button>' +
            '<button class="btn btn-sm btn-ghost" onclick="skipPlatform(\'' + plat.key + '\')">Skip</button>';
    } else if (state === 'connecting') {
        actionsHtml = '<div id="plat-sub-' + plat.key + '"></div>';
    } else if (state === 'setting_up') {
        actionsHtml = '<div id="plat-sub-' + plat.key + '"></div>';
    } else if (state === 'connected') {
        actionsHtml = '<span class="badge badge-success">Connected</span>';
    } else if (state === 'skipped') {
        actionsHtml = '<button class="btn btn-sm btn-ghost" onclick="resetPlatform(\'' + plat.key + '\')">Set up later</button>';
    }

    return '<div class="platform-card" id="plat-card-' + plat.key + '">' +
        '<div class="platform-icon ' + plat.key + '">' + plat.icon + '</div>' +
        '<div class="platform-info">' +
            '<div class="plat-name">' + esc(plat.name) + '</div>' +
            '<div class="plat-status"><span class="status-dot ' + statusClass + '"></span>' + statusText + '</div>' +
        '</div>' +
        '<div class="platform-actions">' + actionsHtml + '</div>' +
    '</div>';
}

function showPlatformConnect(key) {
    onboardingState.socialPlatforms[key] = 'connecting';
    refreshPlatformCard(key);

    setTimeout(function() {
        var sub = document.getElementById('plat-sub-' + key);
        if (!sub) return;

        var cfg = PLATFORM_CONFIGS[key] || null;
        if (!cfg) {
            // Fallback for unknown platforms
            sub.innerHTML =
                '<div style="display:flex;flex-direction:column;gap:8px;width:100%;">' +
                    '<input type="text" id="plat-handle-' + key + '" placeholder="Username / handle">' +
                    '<input type="text" id="plat-token-' + key + '" placeholder="API token (optional)">' +
                    '<div style="display:flex;gap:6px;">' +
                        '<button class="btn btn-sm btn-primary" onclick="connectPlatform(\'' + key + '\')">Connect</button>' +
                        '<button class="btn btn-sm btn-ghost" onclick="resetPlatform(\'' + key + '\')">Cancel</button>' +
                    '</div>' +
                '</div>';
            return;
        }

        var fieldsHtml = '';
        cfg.fields.forEach(function(f) {
            fieldsHtml +=
                '<div style="margin-bottom:10px;">' +
                    '<label style="font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:3px;">' + esc(f.label) + '</label>' +
                    '<input type="' + f.type + '" id="plat-' + key + '-' + f.id + '" placeholder="' + esc(f.placeholder) + '" style="width:100%;max-width:360px;">' +
                    '<div style="font-size:11px;color:var(--text-faint);margin-top:3px;">' + esc(f.help) + '</div>' +
                '</div>';
        });

        sub.innerHTML =
            '<div style="width:100%;padding:12px;background:var(--bg3);border-radius:8px;border:1px solid var(--border);">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
                    '<span style="font-size:12px;font-weight:600;color:var(--text2);">Connect ' + esc(cfg.name) + '</span>' +
                    '<div style="display:flex;gap:8px;">' +
                        '<a href="' + esc(cfg.devPortalUrl) + '" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;" title="Open Developer Portal">&#128279; Dev Portal</a>' +
                        '<a href="' + esc(cfg.apiGuideUrl) + '" target="_blank" style="font-size:11px;color:var(--text-muted);text-decoration:none;" title="API Guide">Guide &rarr;</a>' +
                    '</div>' +
                '</div>' +
                '<p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">' + esc(cfg.credGuide) + '</p>' +
                fieldsHtml +
                '<div style="display:flex;gap:6px;margin-top:4px;">' +
                    '<button class="btn btn-sm btn-primary" onclick="connectPlatform(\'' + key + '\')">Save & Connect</button>' +
                    '<button class="btn btn-sm btn-ghost" onclick="resetPlatform(\'' + key + '\')">Cancel</button>' +
                '</div>' +
            '</div>';
    }, 50);
}

function showPlatformSetup(key) {
    onboardingState.socialPlatforms[key] = 'setting_up';
    refreshPlatformCard(key);

    var plat = SOCIAL_PLATFORMS.find(function(p) { return p.key === key; });
    var platName = plat ? plat.name : key;
    var cfg = PLATFORM_CONFIGS[key] || null;

    setTimeout(function() {
        var sub = document.getElementById('plat-sub-' + key);
        if (!sub) return;

        var stepsHtml = '';
        if (cfg && cfg.setupSteps) {
            stepsHtml = '<ol style="font-size:12px;color:var(--text2);padding-left:16px;margin-bottom:10px;line-height:1.7;">';
            cfg.setupSteps.forEach(function(step) {
                if (step.url) {
                    stepsHtml += '<li><a href="' + esc(step.url) + '" target="_blank" style="color:var(--accent);text-decoration:none;">' + esc(step.text) + ' &rarr;</a></li>';
                } else {
                    stepsHtml += '<li>' + esc(step.text) + '</li>';
                }
            });
            stepsHtml += '</ol>';
        } else {
            stepsHtml =
                '<ol style="font-size:12px;color:var(--text2);padding-left:16px;margin-bottom:10px;">' +
                    '<li>Go to ' + esc(platName) + ' and sign up</li>' +
                    '<li>Use your business name and branding</li>' +
                    '<li>Complete profile setup</li>' +
                    '<li>Come back here and connect it</li>' +
                '</ol>';
        }

        var signupLink = cfg && cfg.signupUrl
            ? '<a href="' + esc(cfg.signupUrl) + '" target="_blank" class="btn btn-sm btn-primary" style="text-decoration:none;">Create ' + esc(platName) + ' Account &rarr;</a>'
            : '';

        sub.innerHTML =
            '<div style="width:100%;padding:12px;background:var(--bg3);border-radius:8px;border:1px solid var(--border);">' +
                '<p style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:8px;">How to set up ' + esc(platName) + ':</p>' +
                stepsHtml +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                    signupLink +
                    '<button class="btn btn-sm" onclick="showPlatformConnect(\'' + key + '\')">I have an account, connect it</button>' +
                    '<button class="btn btn-sm btn-ghost" onclick="skipPlatform(\'' + key + '\')">Skip for now</button>' +
                '</div>' +
            '</div>';
    }, 50);
}

async function connectPlatform(key) {
    var cfg = PLATFORM_CONFIGS[key] || null;
    var credentials = {};
    var hasRequired = false;

    if (cfg) {
        // Collect all platform-specific fields
        cfg.fields.forEach(function(f, idx) {
            var el = document.getElementById('plat-' + key + '-' + f.id);
            var val = el ? el.value.trim() : '';
            credentials[f.id] = val;
            // First field is always required
            if (idx === 0 && val) hasRequired = true;
        });

        if (!hasRequired) {
            var firstField = cfg.fields[0];
            showToast('Please enter your ' + (firstField ? firstField.label : 'credentials') + '.', 'error');
            return;
        }
    } else {
        // Fallback: legacy generic fields
        var handle = (document.getElementById('plat-handle-' + key) || {}).value || '';
        var token = (document.getElementById('plat-token-' + key) || {}).value || '';
        if (!handle) {
            showToast('Please enter your username or handle.', 'error');
            return;
        }
        credentials = { handle: handle, token: token };
    }

    try {
        await apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/social', {
            method: 'POST',
            body: { platform: key, credentials: credentials },
        });
        onboardingState.socialPlatforms[key] = 'connected';
        refreshPlatformCard(key);
        var platName = cfg ? cfg.name : key;
        showToast(platName + ' connected!', 'success');
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function skipPlatform(key) {
    onboardingState.socialPlatforms[key] = 'skipped';
    refreshPlatformCard(key);
}

function resetPlatform(key) {
    onboardingState.socialPlatforms[key] = 'pending';
    refreshPlatformCard(key);
}

function refreshPlatformCard(key) {
    var plat = SOCIAL_PLATFORMS.find(function(p) { return p.key === key; });
    if (!plat) return;
    var cardEl = document.getElementById('plat-card-' + key);
    if (!cardEl) return;
    var state = onboardingState.socialPlatforms[key] || 'pending';
    cardEl.outerHTML = renderPlatformCard(plat, state);
}

async function submitStep5() {
    // Individual platform saves already happened in connectPlatform().
    // Save progress so a refresh will land on step 5 (not re-do step 4).
    if (onboardingState.onboardingId) {
        try {
            await apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/step', {
                method: 'PATCH', body: { step: 5 },
            });
        } catch (e) { /* non-fatal */ }
    }
    nextStep();
}

// ── Step 6: Stripe Setup ─────────────────────────────────────────────────────
function renderStep6() {
    return '<div class="onboarding-step">' +
        '<h2>Payment Processing</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px;">Connect Stripe so HELM can manage payments, invoices, and subscriptions.</p>' +
        '<div class="choice-grid" id="stripe-choices">' +
            '<div class="choice-card" data-choice="connect" onclick="selectStripe(\'connect\')">' +
                '<h4>Connect Existing Stripe</h4>' +
                '<p>I already have a Stripe account with API keys.</p>' +
            '</div>' +
            '<div class="choice-card" data-choice="create" onclick="selectStripe(\'create\')">' +
                '<h4>Create New Account</h4>' +
                '<p>I need to set up Stripe first.</p>' +
            '</div>' +
        '</div>' +
        '<button class="btn btn-ghost" onclick="selectStripe(\'skip\')" style="margin-bottom:16px;">Skip for Now</button>' +
        '<div id="stripe-subform" style="display:none;"></div>' +
        '<div class="step-nav">' +
            '<button class="btn" onclick="prevStep()">Back</button>' +
            '<button class="btn btn-primary" onclick="submitStep6()">Next</button>' +
        '</div>' +
    '</div>';
}

function selectStripe(choice) {
    onboardingState.stripeChoice = choice;

    document.querySelectorAll('#stripe-choices .choice-card').forEach(function(el) {
        el.classList.toggle('selected', el.dataset.choice === choice);
    });

    var subform = document.getElementById('stripe-subform');

    if (choice === 'connect') {
        subform.style.display = '';
        subform.innerHTML =
            '<div class="card" style="margin-top:12px;">' +
                '<h3 style="margin-bottom:12px;">Stripe Credentials</h3>' +
                '<label>Publishable Key<input type="text" id="stripe-pk" placeholder="pk_live_..."></label>' +
                '<label>Secret Key<input type="password" id="stripe-sk" placeholder="sk_live_..."></label>' +
                '<p style="font-size:12px;color:var(--text-muted);margin-top:8px;">Your keys are encrypted at rest in our vault. HELM never stores them in plain text.</p>' +
            '</div>';
    } else if (choice === 'create') {
        subform.style.display = '';
        subform.innerHTML =
            '<div class="card" style="margin-top:12px;">' +
                '<h3 style="margin-bottom:12px;">Create a Stripe Account</h3>' +
                '<p style="font-size:13px;color:var(--text2);margin-bottom:12px;">Sign up at Stripe, then come back to enter your API keys.</p>' +
                '<a href="https://dashboard.stripe.com/register" target="_blank" class="btn btn-primary">Open Stripe Signup</a>' +
                '<div style="margin-top:16px;">' +
                    '<label>Publishable Key<input type="text" id="stripe-pk" placeholder="pk_live_..."></label>' +
                    '<label>Secret Key<input type="password" id="stripe-sk" placeholder="sk_live_..."></label>' +
                '</div>' +
            '</div>';
    } else {
        subform.style.display = 'none';
        subform.innerHTML = '';
    }
}

async function submitStep6() {
    try {
        var choice = onboardingState.stripeChoice || 'skip';

        if (choice === 'skip') {
            // Skip Stripe — save progress then advance
            if (onboardingState.onboardingId) {
                try {
                    await apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/step', {
                        method: 'PATCH', body: { step: 6 },
                    });
                } catch (e) { /* non-fatal */ }
            }
            nextStep();
            return;
        }

        var pk = (document.getElementById('stripe-pk') || {}).value || '';
        var sk = (document.getElementById('stripe-sk') || {}).value || '';

        if (!sk) {
            showToast('Please enter your Stripe Secret Key.', 'error');
            return;
        }

        var payload = {
            stripe_api_key: sk,
            publishable_key: pk || undefined,
        };

        await apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/stripe', {
            method: 'POST',
            body: payload,
        });

        Object.assign(onboardingState.data, { stripe_connected: true });
        nextStep();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ── Step 7: AI Generation (SSE stream) ───────────────────────────────────────
function renderStep7() {
    return '<div class="onboarding-step">' +
        '<h2>Building Your Business Engine</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px;">HELM is generating everything needed to run your business.</p>' +
        '<div class="stream-display" id="gen-stream"></div>' +
        '<ul class="checklist" id="gen-checklist" style="margin-top:16px;"></ul>' +
        '<div class="step-nav">' +
            '<button class="btn" onclick="prevStep()">Back</button>' +
            '<button class="btn btn-primary" id="step7-next" onclick="nextStep()" disabled>Next</button>' +
        '</div>' +
    '</div>';
}

async function startGeneration() {
    var stream = document.getElementById('gen-stream');
    var checklist = document.getElementById('gen-checklist');

    var GEN_ITEMS = [
        { key: 'profile', label: 'Analyzing business profile' },
        { key: 'calendar', label: 'Generating content calendar' },
        { key: 'brand', label: 'Building brand guidelines' },
        { key: 'social', label: 'Setting up social media strategy' },
        { key: 'website', label: 'Configuring website structure' },
        { key: 'email', label: 'Creating email templates' },
        { key: 'analytics', label: 'Setting up analytics tracking' },
        { key: 'automation', label: 'Configuring automation rules' },
    ];

    onboardingState.genChecklist = GEN_ITEMS.map(function(item) {
        return { key: item.key, label: item.label, done: false };
    });

    // Render initial checklist
    checklist.innerHTML = onboardingState.genChecklist.map(function(item) {
        return '<li><span id="gen-icon-' + item.key + '" style="width:18px;display:inline-block;text-align:center;color:var(--text-faint);">\u25CB</span> ' + esc(item.label) + '</li>';
    }).join('');

    stream.innerHTML = '<div class="stream-line"><span class="spin">\u21BB</span> Starting generation...</div>';

    try {
        var url = '/helm/api/onboarding/' + onboardingState.onboardingId + '/generate';
        var resp = await fetch(url, {
            headers: HELM.token ? { 'Authorization': 'Bearer ' + HELM.token } : {},
        });

        if (!resp.ok) {
            var errBody = await resp.json().catch(function() { return {}; });
            throw new Error(errBody.detail || 'Generation failed');
        }

        var contentType = resp.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream')) {
            var reader = resp.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            while (true) {
                var result = await reader.read();
                if (result.done) break;
                buffer += decoder.decode(result.value, { stream: true });

                var lines = buffer.split('\n');
                buffer = lines.pop();

                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (line.startsWith('data:')) {
                        var jsonStr = line.substring(5).trim();
                        if (jsonStr === '[DONE]') continue;
                        try {
                            var evt = JSON.parse(jsonStr);
                            handleGenEvent(evt, stream);
                        } catch (_) { /* skip */ }
                    }
                }
            }
        } else {
            // Non-streaming: mark all done
            var data = await resp.json();
            onboardingState.genChecklist.forEach(function(item) {
                item.done = true;
                var icon = document.getElementById('gen-icon-' + item.key);
                if (icon) { icon.textContent = '\u2713'; icon.style.color = 'var(--success)'; }
            });
            stream.innerHTML = '<div class="stream-line"><span class="check">\u2713</span> All items generated</div>';
        }

        // Ensure all checks shown as done
        onboardingState.genChecklist.forEach(function(item) {
            if (!item.done) {
                item.done = true;
                var icon = document.getElementById('gen-icon-' + item.key);
                if (icon) { icon.textContent = '\u2713'; icon.style.color = 'var(--success)'; }
            }
        });

        stream.innerHTML += '<div class="stream-line"><span class="check" style="color:var(--success);">\u2713</span> Generation complete!</div>';
        document.getElementById('step7-next').disabled = false;

    } catch (err) {
        stream.innerHTML += '<div class="stream-line" style="color:var(--error);">\u2717 ' + esc(err.message) + '</div>';
        showToast(err.message, 'error');
        // Allow proceeding even on error
        document.getElementById('step7-next').disabled = false;
    }
}

function handleGenEvent(evt, stream) {
    if (evt.type === 'progress') {
        stream.innerHTML += '<div class="stream-line"><span class="spin">\u21BB</span> ' + esc(evt.message) + '</div>';
    } else if (evt.type === 'item_complete') {
        var key = evt.key;
        var item = onboardingState.genChecklist.find(function(g) { return g.key === key; });
        if (item) {
            item.done = true;
            var icon = document.getElementById('gen-icon-' + key);
            if (icon) { icon.textContent = '\u2713'; icon.style.color = 'var(--success)'; }
        }
        // Replace last spinner
        var spins = stream.querySelectorAll('.spin');
        if (spins.length > 0) {
            var last = spins[spins.length - 1];
            last.className = 'check';
            last.textContent = '\u2713';
            last.style.color = 'var(--success)';
        }
    } else if (evt.type === 'complete') {
        var spins = stream.querySelectorAll('.spin');
        spins.forEach(function(s) { s.className = 'check'; s.textContent = '\u2713'; s.style.color = 'var(--success)'; });
    }
    stream.scrollTop = stream.scrollHeight;
}

// ── Step 8: Review & Launch ──────────────────────────────────────────────────
function renderStep8() {
    var d = onboardingState.data;
    var autonomy = d.autonomy_level || 8;
    var autonomyLabel = autonomy <= 3 ? 'Conservative' : (autonomy <= 7 ? 'Balanced' : 'Full Autopilot');

    var weekPlan = [
        'Set up and verify all connected accounts',
        'Publish first 3 social media posts',
        'Create and schedule a 2-week content calendar',
        'Configure payment processing (if connected)',
        'Send your first weekly business report',
        'Monitor and respond to initial engagement',
    ];

    return '<div class="onboarding-step">' +
        '<h2>Review &amp; Launch</h2>' +
        '<p style="color:var(--text-muted);margin-bottom:16px;">Here is what HELM will do in Week 1 for ' + esc(d.name || 'your business') + ':</p>' +
        '<div class="card" style="margin-bottom:16px;">' +
            '<h3 style="margin-bottom:10px;">Week 1 Plan</h3>' +
            '<ol style="padding-left:20px;line-height:2;">' +
                weekPlan.map(function(item) { return '<li>' + esc(item) + '</li>'; }).join('') +
            '</ol>' +
        '</div>' +
        '<div class="card" style="margin-bottom:16px;">' +
            '<h3 style="margin-bottom:10px;">Autonomy Level: ' + autonomy + '/10 (' + autonomyLabel + ')</h3>' +
            '<div class="health-bar" style="width:100%;margin-top:6px;"><div class="bar-fill fill-blue" style="width:' + (autonomy * 10) + '%"></div></div>' +
            '<p style="font-size:12px;color:var(--text-muted);margin-top:6px;">' +
                (autonomy <= 3 ? 'HELM will ask your approval before most actions.' :
                 autonomy <= 7 ? 'HELM handles routine tasks automatically, asks for important decisions.' :
                 'HELM runs nearly everything on autopilot. Only high-risk actions need your approval.') +
            '</p>' +
        '</div>' +
        '<div class="card" style="margin-bottom:20px;">' +
            '<h3 style="margin-bottom:10px;">Confirmation</h3>' +
            '<ul class="checklist">' +
                '<li><input type="checkbox" id="confirm-1"> I understand HELM will act on behalf of my business</li>' +
                '<li><input type="checkbox" id="confirm-2"> I can adjust the autonomy level at any time in Settings</li>' +
                '<li><input type="checkbox" id="confirm-3"> I will review HITL items that require my approval</li>' +
            '</ul>' +
        '</div>' +
        '<div class="step-nav">' +
            '<button class="btn" onclick="prevStep()">Back</button>' +
            '<button class="btn btn-lg btn-primary" id="launch-btn" onclick="launchHelm()">Launch HELM</button>' +
        '</div>' +
    '</div>';
}

async function launchHelm() {
    var c1 = document.getElementById('confirm-1');
    var c2 = document.getElementById('confirm-2');
    var c3 = document.getElementById('confirm-3');

    if (!c1.checked || !c2.checked || !c3.checked) {
        showToast('Please confirm all checkboxes before launching.', 'error');
        return;
    }

    var btn = document.getElementById('launch-btn');
    btn.disabled = true;
    btn.textContent = 'Launching...';

    try {
        var result = await apiFetch('/helm/api/onboarding/' + onboardingState.onboardingId + '/launch', {
            method: 'POST',
        });

        showToast('HELM is now running your business!', 'success');

        // Reload businesses and switch to dashboard
        var data = await apiFetch('/helm/api/businesses');
        HELM.businesses = data.businesses || data || [];
        renderBusinessSelector(HELM.businesses);

        var newBiz = HELM.businesses.find(function(b) {
            return b.id === (result.business_id || onboardingState.businessId);
        });
        if (newBiz) {
            selectBusiness(newBiz);
        } else if (HELM.businesses.length > 0) {
            selectBusiness(HELM.businesses[HELM.businesses.length - 1]);
        }
    } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Launch HELM';
    }
}
