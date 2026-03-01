/**
 * Bx4 -- Intake / Onboarding Wizard
 * Interactive Q&A wizard for new company setup.
 * Supports question types: textarea, text, select, chips, number, currency
 */

'use strict';

var _intakeTotal = 10;
var _intakeAnswered = 0;
var _intakeCurrentQ = null;
var _intakeCompanyId = null;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function initIntake(companyId) {
    _intakeCompanyId = companyId || (window.BX4.currentCompany && window.BX4.currentCompany.id);
    if (!_intakeCompanyId) {
        showToast('No company selected', 'warning');
        return;
    }

    var root = document.getElementById('view-root');
    root.innerHTML = '<div class="flex-center" style="padding:60px;"><div class="spinner spinner-lg"></div></div>';

    try {
        var status = await api('/bx4/api/companies/' + _intakeCompanyId + '/intake/status');
        _intakeTotal = status.total_count || 10;
        _intakeAnswered = status.answered_count || 0;

        if (status.completed) {
            showCompletionScreen();
            return;
        }

        renderIntakeWizard();
        await fetchNextQuestion();
    } catch (err) {
        root.innerHTML =
            '<div class="empty-state" style="padding:60px;">' +
                '<span class="empty-state-icon">&#x26A0;</span>' +
                '<div class="empty-state-title">Failed to Load</div>' +
                '<div class="empty-state-msg">' + esc(err.message) + '</div>' +
                '<button class="btn btn-primary mt-16" onclick="initIntake()">Retry</button>' +
            '</div>';
    }
}

// ---------------------------------------------------------------------------
// Wizard shell and progress
// ---------------------------------------------------------------------------

function renderIntakeWizard() {
    var root = document.getElementById('view-root');
    root.innerHTML =
        '<div class="wizard">' +
            '<div class="view-header" style="justify-content:center;">' +
                '<div style="text-align:center;">' +
                    '<h1 class="view-title">Company Onboarding</h1>' +
                    '<div class="view-subtitle">Help your advisor understand your business</div>' +
                '</div>' +
            '</div>' +
            '<div class="wizard-progress" id="intake-progress"></div>' +
            '<div class="card">' +
                '<div class="card-body" id="intake-question-area">' +
                    '<div class="flex-center"><div class="spinner"></div></div>' +
                '</div>' +
            '</div>' +
        '</div>';

    updateIntakeProgress();
}

function updateIntakeProgress() {
    var el = document.getElementById('intake-progress');
    if (!el) return;
    var dots = '';
    for (var i = 0; i < _intakeTotal; i++) {
        var cls = 'wizard-step-dot';
        if (i < _intakeAnswered) cls += ' done';
        else if (i === _intakeAnswered) cls += ' current';
        dots += '<div class="' + cls + '"></div>';
    }
    el.innerHTML = dots;
}

// ---------------------------------------------------------------------------
// Fetch next question from API
// ---------------------------------------------------------------------------

async function fetchNextQuestion() {
    var area = document.getElementById('intake-question-area');
    if (!area) return;

    area.innerHTML = '<div class="flex-center"><div class="spinner"></div></div>';

    try {
        var data = await api('/bx4/api/companies/' + _intakeCompanyId + '/intake/next');

        if (data.completed) {
            showCompletionScreen();
            return;
        }

        _intakeCurrentQ = data.question;
        renderQuestion(_intakeCurrentQ);
    } catch (err) {
        area.innerHTML =
            '<div class="empty-state" style="padding:40px;">' +
                '<div class="empty-state-title">Failed to load question</div>' +
                '<div class="empty-state-msg">' + esc(err.message) + '</div>' +
                '<button class="btn btn-primary mt-16" onclick="fetchNextQuestion()">Retry</button>' +
            '</div>';
    }
}

// ---------------------------------------------------------------------------
// Render a question object into the question area
// ---------------------------------------------------------------------------

function renderQuestion(q) {
    var area = document.getElementById('intake-question-area');
    if (!area || !q) return;

    var qNum = _intakeAnswered + 1;

    var html =
        '<div class="text-sm text-muted mb-8">Question ' + qNum + ' of ' + _intakeTotal + '</div>' +
        '<div class="wizard-question">' + esc(q.question) + '</div>' +
        (q.hint ? '<div class="wizard-context">' + esc(q.hint) + '</div>' : '') +
        '<form id="intake-answer-form" class="form">' +
            buildInputHTML(q) +
            '<div style="display:flex;justify-content:flex-end;align-items:center;margin-top:16px;">' +
                '<button type="submit" class="btn btn-primary" id="intake-submit-btn" disabled>Submit Answer</button>' +
            '</div>' +
        '</form>';

    area.innerHTML = html;

    // Wire up form
    var form = document.getElementById('intake-answer-form');
    form.addEventListener('submit', submitIntakeAnswer);

    // Wire up input-specific behaviour
    wireInputBehavior(q);
}

// ---------------------------------------------------------------------------
// Build the correct input HTML for a question type
// ---------------------------------------------------------------------------

function buildInputHTML(q) {
    var type = q.type || 'textarea';

    switch (type) {
        case 'textarea':
            return '<textarea class="form-textarea" id="intake-answer" ' +
                'placeholder="' + esc(q.placeholder || '') + '" rows="4"></textarea>';

        case 'text':
            return '<input type="text" class="form-input" id="intake-answer" ' +
                'placeholder="' + esc(q.placeholder || '') + '">';

        case 'select':
            return buildSelectHTML(q);

        case 'chips':
            return buildChipsHTML(q);

        case 'number':
            return '<div style="display:flex;align-items:center;gap:8px;">' +
                '<input type="number" class="form-input" id="intake-answer" ' +
                'min="0" step="1" placeholder="' + esc(q.placeholder || '0') + '" style="flex:1;">' +
                (q.unit ? '<span class="text-muted">' + esc(q.unit) + '</span>' : '') +
            '</div>';

        case 'currency':
            return '<div style="display:flex;align-items:center;gap:8px;">' +
                '<span class="text-muted" style="font-weight:600;">$</span>' +
                '<input type="number" class="form-input" id="intake-answer" ' +
                'min="0" step="1" placeholder="0" style="flex:1;">' +
                '<span class="text-muted">/month</span>' +
            '</div>';

        default:
            return '<textarea class="form-textarea" id="intake-answer" ' +
                'placeholder="' + esc(q.placeholder || '') + '" rows="4"></textarea>';
    }
}

// ---------------------------------------------------------------------------
// Select type: styled option cards
// ---------------------------------------------------------------------------

function buildSelectHTML(q) {
    var options = q.options || [];
    var html = '<div id="intake-select-cards" style="display:flex;flex-direction:column;gap:8px;">' +
        '<input type="hidden" id="intake-answer" value="">';

    for (var i = 0; i < options.length; i++) {
        var opt = options[i];
        var label = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
        var desc = typeof opt === 'object' ? (opt.desc || opt.description || '') : '';

        html += '<div class="card intake-select-card" data-value="' + esc(label) + '" ' +
            'style="cursor:pointer;transition:border-color 0.15s,background 0.15s;">' +
            '<div class="card-body" style="padding:12px 16px;">' +
                '<div style="font-weight:600;">' + esc(label) + '</div>' +
                (desc ? '<div class="text-sm text-muted">' + esc(desc) + '</div>' : '') +
            '</div>' +
        '</div>';
    }

    html += '</div>';
    return html;
}

// ---------------------------------------------------------------------------
// Chips type: multi-select chip buttons
// ---------------------------------------------------------------------------

function buildChipsHTML(q) {
    var options = q.options || [];
    var html = '<div id="intake-chips" style="display:flex;flex-wrap:wrap;gap:8px;">';

    for (var i = 0; i < options.length; i++) {
        var opt = options[i];
        var label = typeof opt === 'string' ? opt : (opt.label || opt.value || '');
        html += '<button type="button" class="badge intake-chip" data-value="' + esc(label) + '" ' +
            'style="cursor:pointer;padding:8px 16px;font-size:14px;">' + esc(label) + '</button>';
    }

    if (q.allow_other) {
        html += '<button type="button" class="badge intake-chip" id="intake-chip-other" ' +
            'data-value="__other__" style="cursor:pointer;padding:8px 16px;font-size:14px;">Other...</button>';
    }

    html += '</div>';

    if (q.allow_other) {
        html += '<div id="intake-other-wrap" style="display:none;margin-top:8px;">' +
            '<input type="text" class="form-input" id="intake-other-input" placeholder="Please specify...">' +
        '</div>';
    }

    return html;
}

// ---------------------------------------------------------------------------
// Wire up interactive behavior per type
// ---------------------------------------------------------------------------

function wireInputBehavior(q) {
    var type = q.type || 'textarea';
    var submitBtn = document.getElementById('intake-submit-btn');

    switch (type) {
        case 'textarea':
        case 'text': {
            var input = document.getElementById('intake-answer');
            input.addEventListener('input', function() {
                submitBtn.disabled = !input.value.trim();
            });
            input.focus();
            break;
        }

        case 'number':
        case 'currency': {
            var numInput = document.getElementById('intake-answer');
            numInput.addEventListener('input', function() {
                submitBtn.disabled = numInput.value === '';
            });
            numInput.focus();
            break;
        }

        case 'select': {
            var cards = document.querySelectorAll('.intake-select-card');
            var hidden = document.getElementById('intake-answer');
            cards.forEach(function(card) {
                card.addEventListener('click', function() {
                    cards.forEach(function(c) { c.classList.remove('selected'); });
                    card.classList.add('selected');
                    hidden.value = card.getAttribute('data-value');
                    submitBtn.disabled = false;
                });
            });
            break;
        }

        case 'chips': {
            var chips = document.querySelectorAll('.intake-chip');
            var otherWrap = document.getElementById('intake-other-wrap');

            chips.forEach(function(chip) {
                chip.addEventListener('click', function() {
                    var val = chip.getAttribute('data-value');

                    if (val === '__other__') {
                        chip.classList.toggle('active');
                        if (otherWrap) {
                            otherWrap.style.display = chip.classList.contains('active') ? 'block' : 'none';
                            if (chip.classList.contains('active')) {
                                var otherInput = document.getElementById('intake-other-input');
                                if (otherInput) otherInput.focus();
                            }
                        }
                    } else {
                        chip.classList.toggle('active');
                    }

                    // Enable submit if at least one chip active
                    var anyActive = document.querySelectorAll('.intake-chip.active').length > 0;
                    submitBtn.disabled = !anyActive;
                });
            });
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Collect answer value based on question type
// ---------------------------------------------------------------------------

function collectAnswer(q) {
    var type = q.type || 'textarea';

    switch (type) {
        case 'textarea':
        case 'text':
        case 'number':
        case 'select':
            return (document.getElementById('intake-answer').value || '').trim();

        case 'currency': {
            var raw = document.getElementById('intake-answer').value || '';
            raw = raw.trim();
            if (!raw || raw === '0') return '$0';
            var num = parseInt(raw, 10);
            if (isNaN(num)) return '$0';
            return '$' + num.toLocaleString('en-US');
        }

        case 'chips': {
            var selected = [];
            var activeChips = document.querySelectorAll('.intake-chip.active');
            activeChips.forEach(function(chip) {
                var val = chip.getAttribute('data-value');
                if (val === '__other__') {
                    var otherInput = document.getElementById('intake-other-input');
                    var otherVal = otherInput ? otherInput.value.trim() : '';
                    if (otherVal) {
                        selected.push('Other: ' + otherVal);
                    }
                } else {
                    selected.push(val);
                }
            });
            return selected.join(', ');
        }

        default:
            return (document.getElementById('intake-answer').value || '').trim();
    }
}

// ---------------------------------------------------------------------------
// Submit answer
// ---------------------------------------------------------------------------

async function submitIntakeAnswer(e) {
    e.preventDefault();

    var answer = collectAnswer(_intakeCurrentQ);
    if (!answer) return;

    var submitBtn = document.getElementById('intake-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    try {
        var response = await api('/bx4/api/companies/' + _intakeCompanyId + '/intake/answer', {
            method: 'POST',
            body: {
                question: _intakeCurrentQ.question,
                answer: answer,
                phase: _intakeCurrentQ.phase || 'foundation'
            }
        });

        _intakeAnswered++;
        updateIntakeProgress();

        if (response.completed) {
            showCompletionScreen();
        } else if (response.next_question) {
            _intakeCurrentQ = response.next_question;
            renderQuestion(_intakeCurrentQ);
        } else {
            // Fallback: fetch from API if next_question not provided
            await fetchNextQuestion();
        }
    } catch (err) {
        showToast('Failed to save answer: ' + err.message, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Answer';
    }
}

// ---------------------------------------------------------------------------
// Completion screen
// ---------------------------------------------------------------------------

function showCompletionScreen() {
    var root = document.getElementById('view-root');
    root.innerHTML =
        '<div class="wizard">' +
            '<div class="empty-state" style="padding:60px;">' +
                '<span class="empty-state-icon" style="font-size:64px;">&#x2705;</span>' +
                '<div class="empty-state-title">Setup Complete!</div>' +
                '<div class="empty-state-msg">Bx4 now has everything it needs to start advising your business.</div>' +
                '<div style="display:flex;gap:12px;justify-content:center;margin-top:24px;">' +
                    '<button class="btn btn-primary" onclick="triggerPostIntakeAnalysis()">Run Initial Analysis</button>' +
                    '<button class="btn btn-secondary" onclick="renderView(\'dashboard\')">Go to Dashboard</button>' +
                '</div>' +
            '</div>' +
        '</div>';
}

// ---------------------------------------------------------------------------
// Post-intake analysis trigger
// ---------------------------------------------------------------------------

async function triggerPostIntakeAnalysis() {
    showToast('Running initial analysis...', 'info');
    try {
        await api('/bx4/api/companies/' + _intakeCompanyId + '/advisor/analyze', {
            method: 'POST',
            body: { depth: 'quick' }
        });
        showToast('Initial analysis complete!', 'success');
        renderView('dashboard');
    } catch (err) {
        showToast('Analysis will run in the background.', 'info');
        renderView('dashboard');
    }
}

// ---------------------------------------------------------------------------
// Expose globally
// ---------------------------------------------------------------------------

window.initIntake = initIntake;
window.triggerPostIntakeAnalysis = triggerPostIntakeAnalysis;
