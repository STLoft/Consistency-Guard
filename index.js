/**
 * Consistency Guard (Jev) - SillyTavern extension
 *
 * 흐름: 캐릭터 응답 수신 → Jev(System One)로 설정오류 여부를 빠르게 판정
 *      → 오류 의심 시 별도 API(Connection Profile)로 수정 지시문 생성
 *      → 메인 API로 수정본을 생성해 새 스와이프로 추가 (원본 보존)
 *
 * 수정본 생성/스와이프 추가 방식은 inSTead (MIT, ActualBroeckchen)를 참고했습니다.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveChatConditional,
    reloadCurrentChat,
    saveSettingsDebounced,
    generateQuietPrompt,
    substituteParams,
    getRequestHeaders,
} from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { ConnectionManagerRequestService } from '../../shared.js';

const EXT = 'consistencyGuard';
const LOG = '[ConsistencyGuard]';

/* ------------------------------------------------------------------ */
/* 근거 항목 (체크박스로 켜고 끔)                                         */
/*  field: Jev state와 지시문 프롬프트에 들어가는 이름                     */
/*  max:   항목별 최대 글자 수 (내부 고정)                                */
/*  keep:  길이 초과 시 앞(head)을 남길지 뒤(tail)를 남길지               */
/* ------------------------------------------------------------------ */

const SOURCES = {
    charCard:     { label: '캐릭터 카드 (설명·성격·시나리오)', field: 'CHARACTER_SHEET', max: 6000, keep: 'head' },
    exampleDialogue: { label: '예시 대화', field: 'EXAMPLE_DIALOGUE', max: 3000, keep: 'head' },
    charNote:     { label: '캐릭터 노트', field: 'CHARACTER_NOTE', max: 2000, keep: 'head' },
    firstMessage: { label: '첫 메시지(그리팅)', field: 'FIRST_MESSAGE', max: 3000, keep: 'head' },
    userPersona:  { label: '유저 카드(페르소나)', field: 'USER_PERSONA', max: 3000, keep: 'head' },
    groupMembers: { label: '그룹 채팅의 다른 멤버 카드', field: 'OTHER_CHARACTERS', max: 5000, keep: 'head' },
    lorebook:     { label: '로어북 (이번 턴 활성화된 항목만)', field: 'LOREBOOK', max: 6000, keep: 'head' },
    memory:       { label: '메모리 (요약 확장)', field: 'MEMORY', max: 5000, keep: 'tail' },
    vectors:      { label: '벡터 저장소 검색 결과', field: 'RETRIEVED_PAST', max: 4000, keep: 'tail' },
    authorsNote:  { label: '작가 노트', field: 'AUTHORS_NOTE', max: 2000, keep: 'head' },
    chatVars:     { label: '채팅 변수 (getvar 상태값)', field: 'STATE_VARIABLES', max: 2000, keep: 'head' },
    recentChat:   { label: '최근 대화', field: 'RECENT_CHAT', max: 8000, keep: 'tail' },
    extra:        { label: '추가 텍스트 (아래 입력칸, 매크로 가능)', field: 'EXTRA_CONTEXT', max: 3000, keep: 'head' },
};

/* ------------------------------------------------------------------ */
/* Jev 판정 질문 (모두 boolean: true 확률이 높을수록 오류)                  */
/*  needs: 이 중 하나라도 켜져 있고 내용이 있어야 질문을 보냄               */
/* ------------------------------------------------------------------ */

const CHECKS = {
    character: {
        label: '캐릭터 설정과 모순 (성격·말투·외모·능력)',
        needs: ['charCard', 'exampleDialogue', 'charNote'],
        instructions: 'NEW_MESSAGE portrays CHARACTER_NAME in a way that contradicts CHARACTER_SHEET, EXAMPLE_DIALOGUE, or CHARACTER_NOTE (personality, speech style, appearance, abilities, background, or relationships).',
    },
    persona: {
        label: '유저 설정과 모순 (외모·배경·관계)',
        needs: ['userPersona'],
        instructions: 'NEW_MESSAGE states or implies facts about USER_NAME that contradict USER_PERSONA (appearance, background, abilities, or relationship with CHARACTER_NAME).',
    },
    world: {
        label: '세계관·로어북 설정과 모순',
        needs: ['lorebook'],
        instructions: 'NEW_MESSAGE contradicts world rules, places, factions, or facts described in LOREBOOK.',
    },
    others: {
        label: '다른 멤버 설정과 모순 (그룹)',
        needs: ['groupMembers'],
        instructions: 'NEW_MESSAGE portrays another character in a way that contradicts OTHER_CHARACTERS.',
    },
    memory: {
        label: '과거 사건·기억과 모순',
        needs: ['memory', 'vectors'],
        instructions: 'NEW_MESSAGE contradicts established past events in MEMORY or RETRIEVED_PAST (what happened, promises, relationship status, or what characters already know).',
    },
    continuity: {
        label: '현재 상황과 모순 (장소·시간·복장·소지품·자세)',
        needs: ['recentChat', 'authorsNote', 'chatVars', 'firstMessage'],
        instructions: 'NEW_MESSAGE breaks continuity with the current situation in RECENT_CHAT, AUTHORS_NOTE, STATE_VARIABLES, or FIRST_MESSAGE: location, time of day, clothing, held items, body positions, injuries, stats, or who said or did what.',
    },
    knowledge: {
        label: '캐릭터가 알 수 없는 정보를 앎',
        needs: ['recentChat', 'memory', 'vectors'],
        instructions: 'In NEW_MESSAGE, CHARACTER_NAME knows or references information they could not have learned from the conversation or past events provided.',
    },
    user_control: {
        label: '{{user}}의 대사·행동·생각을 대신 씀',
        needs: [],
        instructions: 'NEW_MESSAGE writes new dialogue, actions, thoughts, or decisions for USER_NAME (the human player), beyond restating what USER_NAME already did.',
    },
    extra: {
        label: '추가 텍스트 내용과 모순',
        needs: ['extra'],
        instructions: 'NEW_MESSAGE contradicts facts or rules in EXTRA_CONTEXT.',
    },
};

const DEFAULTS = {
    enabled: true,
    mode: 'auto', // auto | confirm | notify
    jevProfileId: '',
    jevTimeoutMs: 5000,
    threshold: 0.6,
    recentMessages: 8,
    sources: {
        charCard: true, exampleDialogue: false, charNote: true, firstMessage: false,
        userPersona: true, groupMembers: true, lorebook: true, memory: true, vectors: false,
        authorsNote: true, chatVars: false, recentChat: true, extra: false,
    },
    checks: {
        character: true, persona: true, world: true, others: true, memory: true,
        continuity: true, knowledge: true, user_control: false, extra: true,
    },
    extraContextTemplate: '',
    directiveProfileId: '',
    directiveMaxTokens: 400,
    showToasts: true,
};

let busy = false;
let lastActivatedLore = []; // WORLD_INFO_ACTIVATED로 받은 이번 턴 로어북 항목

function settings() {
    extension_settings[EXT] = extension_settings[EXT] || {};
    const s = extension_settings[EXT];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    for (const group of ['sources', 'checks']) {
        for (const [k, v] of Object.entries(DEFAULTS[group])) {
            if (s[group][k] === undefined) s[group][k] = v;
        }
    }
    return s;
}

function clip(text, max, keep) {
    text = String(text ?? '').trim();
    if (text.length <= max) return text;
    return keep === 'tail' ? '…' + text.slice(-max) : text.slice(0, max) + '…';
}

const toast = (type, msg) => settings().showToasts && toastr[type](msg, 'Consistency Guard');

/* ------------------------------------------------------------------ */
/* 근거 항목 수집기                                                      */
/* ------------------------------------------------------------------ */

function findCharacter(ctx, message) {
    if (message?.original_avatar) {
        const c = ctx.characters.find(x => x.avatar === message.original_avatar);
        if (c) return c;
    }
    if (ctx.characterId !== undefined) return ctx.characters[ctx.characterId];
    return ctx.characters.find(x => x.name === message?.name);
}

function formatCard(char, withName = true) {
    if (!char) return '';
    const parts = [
        withName && ['Name', char.name],
        ['Description', char.description],
        ['Personality', char.personality],
        ['Scenario', char.scenario],
    ].filter(p => p && p[1] && String(p[1]).trim());
    return parts.map(([k, v]) => `## ${k}\n${v}`).join('\n\n');
}

const COLLECTORS = {
    charCard: ({ ctx, char }) => {
        const override = ctx.chatMetadata?.scenario;
        return [formatCard(char), override && `## Scenario (chat override)\n${override}`].filter(Boolean).join('\n\n');
    },
    exampleDialogue: ({ char }) => char?.mes_example,
    charNote: ({ char }) => char?.data?.extensions?.depth_prompt?.prompt,
    firstMessage: ({ ctx, char }) => {
        const first = ctx.chat[0];
        return first && !first.is_user ? first.mes : char?.first_mes;
    },
    userPersona: () => substituteParams('{{persona}}'),
    groupMembers: ({ ctx, char }) => {
        if (!ctx.groupId) return '';
        const group = ctx.groups?.find(g => g.id === ctx.groupId);
        return (group?.members || [])
            .map(avatar => ctx.characters.find(c => c.avatar === avatar))
            .filter(c => c && c !== char)
            .map(c => `# ${c.name}\n${formatCard(c, false)}`)
            .join('\n\n');
    },
    lorebook: () => lastActivatedLore.map(e => e.content).filter(Boolean).join('\n\n'),
    memory: ({ ctx, messageId }) => {
        const out = new Set();
        const injected = ctx.extensionPrompts?.['1_memory']?.value;
        if (injected) out.add(injected.trim());
        for (let i = messageId - 1; i >= 0; i--) {
            const m = ctx.chat[i]?.extra?.memory;
            if (m) { out.add(String(m).trim()); break; }
        }
        return [...out].join('\n\n');
    },
    vectors: ({ ctx }) => ['3_vectors', '4_vectors_data_bank']
        .map(k => ctx.extensionPrompts?.[k]?.value)
        .filter(Boolean).join('\n\n'),
    authorsNote: ({ ctx }) => ctx.chatMetadata?.note_prompt,
    chatVars: ({ ctx }) => {
        const vars = ctx.chatMetadata?.variables || {};
        return Object.entries(vars)
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join('\n');
    },
    recentChat: ({ ctx, messageId }) => {
        const n = settings().recentMessages;
        return ctx.chat
            .slice(Math.max(0, messageId - n), messageId)
            .filter(m => !m.is_system)
            .map(m => `${m.name}: ${m.mes}`)
            .join('\n\n');
    },
    extra: () => settings().extraContextTemplate,
};

function collectState(messageId) {
    const ctx = getContext();
    const s = settings();
    const message = ctx.chat[messageId];
    const char = findCharacter(ctx, message);
    const env = { ctx, char, message, messageId };

    const state = { CHARACTER_NAME: message.name, USER_NAME: ctx.name1 };
    const present = new Set();

    for (const [key, def] of Object.entries(SOURCES)) {
        if (!s.sources[key]) continue;
        let text = '';
        try {
            text = substituteParams(String(COLLECTORS[key](env) ?? ''));
        } catch (e) {
            console.warn(LOG, `${key} 수집 실패`, e);
        }
        text = clip(text, def.max, def.keep);
        if (text) {
            state[def.field] = text;
            present.add(key);
        }
    }
    state.NEW_MESSAGE = message.mes;
    return { state, present };
}

// 질문이 사용 가능한지: 켜져 있고, needs 중 하나라도 실제 내용이 있음
function activeChecks(present) {
    const s = settings();
    return Object.entries(CHECKS).filter(([key, def]) =>
        s.checks[key] && (def.needs.length === 0 || def.needs.some(n => present.has(n))));
}

/* ------------------------------------------------------------------ */
/* Jev 연결: 연결 프로필 + 서버 플러그인 (키는 서버 안에서만 읽음)          */
/* ------------------------------------------------------------------ */

// 자체 플러그인을 먼저 찾고, 없으면 이미 설치된 제브 리콜 플러그인을 재사용
const PLUGIN_ENDPOINTS = [
    '/api/plugins/consistency-guard/evaluate',
    '/api/plugins/jev-recall/evaluate',
];
let workingEndpoint = null;

function getJevProfile() {
    const s = settings();
    if (!s.jevProfileId) throw new Error('Jev 연결 프로필을 선택해 주세요.');
    const profile = ConnectionManagerRequestService.getProfile(s.jevProfileId);
    if (!profile) throw new Error('선택한 Jev 연결 프로필을 찾을 수 없습니다.');
    if (profile.api !== 'custom') throw new Error('Jev 프로필은 Custom (OpenAI-compatible) 이어야 합니다.');
    if (!/jev/i.test(String(profile.model || ''))) throw new Error('선택한 프로필의 모델이 Jev가 아닙니다.');
    let host = '';
    try { host = new URL(String(profile['api-url'] || '')).hostname; } catch { /* 아래에서 처리 */ }
    if (host !== 'ai-gateway.vercel.sh') throw new Error('프로필 URL은 https://ai-gateway.vercel.sh/v1 이어야 합니다.');
    return profile;
}

function compactProfile(profile) {
    return {
        id: String(profile.id || ''),
        name: String(profile.name || ''),
        api: String(profile.api || ''),
        apiUrl: String(profile['api-url'] || ''),
        model: String(profile.model || ''),
        secretId: String(profile['secret-id'] || ''),
    };
}

function answerProbability(answer) {
    const n = Number(answer?.probability ?? answer?.noul ?? answer?.true_probability ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

async function postEvaluation(body, timeoutMs) {
    const candidates = workingEndpoint ? [workingEndpoint] : PLUGIN_ENDPOINTS;
    let lastError = null;
    for (const endpoint of candidates) {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404) { lastError = null; continue; }
        const text = await res.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
        if (!res.ok) {
            const detail = payload?.error?.message || payload?.error || text || res.statusText;
            lastError = new Error(`Jev HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
            break;
        }
        workingEndpoint = endpoint;
        return payload;
    }
    throw lastError || new Error('Jev 서버 플러그인을 찾지 못했습니다. plugins 폴더 설치와 enableServerPlugins: true를 확인하고 ST를 재시작하세요.');
}

/* ------------------------------------------------------------------ */
/* 1단계: Jev 판정                                                      */
/* ------------------------------------------------------------------ */

async function judgeWithJev(state, checks) {
    const s = settings();
    if (!checks.length) return {};
    const profile = getJevProfile();

    const questions = Object.fromEntries(checks.map(([key, def]) => [key, {
        type: 'boolean',
        instructions: def.instructions,
        criteria: {
            true: 'NEW_MESSAGE clearly contradicts or violates what the provided sources establish.',
            false: 'NEW_MESSAGE is consistent, or the provided sources do not establish this detail at all.',
        },
    }]));

    const t0 = performance.now();
    const payload = await postEvaluation({ profile: compactProfile(profile), state, questions }, s.jevTimeoutMs);
    console.debug(LOG, `Jev ${Math.round(performance.now() - t0)}ms`, payload);
    if (!payload?.answers) throw new Error('Jev 응답에 answers가 없습니다.');

    const scores = {};
    for (const [key] of checks) scores[key] = answerProbability(payload.answers[key]);
    return scores;
}

/* ------------------------------------------------------------------ */
/* 2단계: 별도 API로 수정 지시문 생성                                     */
/* ------------------------------------------------------------------ */

async function generateDirective(state, flagged) {
    const s = settings();
    const fill = t => t.replaceAll('CHARACTER_NAME', state.CHARACTER_NAME).replaceAll('USER_NAME', state.USER_NAME);
    const flaggedText = flagged
        .map(f => `- ${fill(CHECKS[f.key].instructions)} (probability ${f.p.toFixed(2)})`)
        .join('\n');

    const sections = Object.entries(state)
        .filter(([k]) => !['CHARACTER_NAME', 'USER_NAME', 'NEW_MESSAGE'].includes(k))
        .map(([k, v]) => `# ${k}\n${v}`)
        .join('\n\n');

    const system = `You are a continuity editor for an ongoing roleplay between ${state.USER_NAME} (the human player) and ${state.CHARACTER_NAME}. An automatic checker flagged possible problems in the latest message.
Verify each flagged problem against the sources. For every problem that is real, write one concrete revision instruction: point to the wrong detail, state the correct fact from the sources, and say how to fix it. Do not rewrite the message yourself. Do not add stylistic suggestions. Keep the instructions short.
Write the instructions in the same language as NEW_MESSAGE.
If none of the flagged problems is real, output exactly: NO_ISSUE`;

    const user = `${sections}\n\n# NEW_MESSAGE (by ${state.CHARACTER_NAME})\n${state.NEW_MESSAGE}\n\n# FLAGGED PROBLEMS\n${flaggedText}`;

    let text;
    if (s.directiveProfileId) {
        const result = await ConnectionManagerRequestService.sendRequest(
            s.directiveProfileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            s.directiveMaxTokens,
        );
        text = typeof result === 'string' ? result : result?.content;
    } else {
        text = await quietGenerate(`${system}\n\n${user}`);
    }
    text = String(text ?? '').trim();
    return /^NO_ISSUE\b/i.test(text) ? null : text;
}

/* ------------------------------------------------------------------ */
/* 3단계: 수정본 생성 → 새 스와이프 (inSTead 방식)                        */
/* ------------------------------------------------------------------ */

async function quietGenerate(prompt) {
    const objectStyle = /^[^(]*\(\s*\{/.test(String(generateQuietPrompt));
    const out = objectStyle
        ? await generateQuietPrompt({ quietPrompt: prompt })
        : await generateQuietPrompt(prompt, false);
    return String(out ?? '').trim();
}

function buildRevisionPrompt(original, directive) {
    return `# Editorial Revision Task

Rewrite the message below so it fixes the continuity problems listed in the directive.

## Critical Rules
- Output ONLY the revised message text
- Change only what the directive requires; keep everything else, including style and length
- Do NOT continue the story or add new events
- Do NOT add meta-commentary or reference these instructions

## Original Message
<original_message>
${original}
</original_message>

## Directive
<directive>
${directive}
</directive>

Begin your revised message now:`;
}

function addRevisionSwipe(message, revisedText, directive, scores) {
    if (!Array.isArray(message.swipes)) {
        message.swipes = [message.mes];
        message.swipe_info = [message.extra ? { extra: { ...message.extra } } : {}];
        message.swipe_id = 0;
    }
    if (!Array.isArray(message.swipe_info)) message.swipe_info = message.swipes.map(() => ({}));
    while (message.swipe_info.length < message.swipes.length) message.swipe_info.push({});

    const now = new Date().toISOString();
    const extra = { api: 'consistencyGuard', model: 'revision', cg_revised: true, cg_directive: directive, cg_scores: scores };
    message.swipes.push(revisedText);
    message.swipe_info.push({ send_date: now, gen_started: now, gen_finished: now, extra });
    message.swipe_id = message.swipes.length - 1;
    message.mes = revisedText;
    message.extra = { ...(message.extra || {}), ...extra };
}

/* ------------------------------------------------------------------ */
/* 파이프라인                                                           */
/* ------------------------------------------------------------------ */

async function runCheck(messageId, { manual = false } = {}) {
    const s = settings();
    const ctx = getContext();
    const message = ctx.chat[messageId];
    if (!message || message.is_user || message.is_system) return;
    if (busy) { if (manual) toast('warning', '이미 검사 중입니다.'); return; }

    busy = true;
    const origMes = message.mes;
    const stillSame = () => getContext().chat[messageId] === message && message.mes === origMes;

    try {
        const { state, present } = collectState(messageId);
        const checks = activeChecks(present);
        if (!checks.length) {
            if (manual) toast('warning', '켜진 근거 항목에 내용이 없어 검사할 질문이 없습니다.');
            return;
        }

        // 1) Jev 판정
        let scores;
        try {
            scores = await judgeWithJev(state, checks);
        } catch (e) {
            console.warn(LOG, 'Jev 실패, 건너뜀:', e);
            const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
            if (manual || !timedOut) toast('error', `Jev 판정 실패: ${e.message}`);
            return;
        }
        const flagged = Object.entries(scores)
            .filter(([, p]) => p >= s.threshold)
            .map(([key, p]) => ({ key, p }))
            .sort((a, b) => b.p - a.p);

        if (!flagged.length) {
            if (manual) toast('success', '설정오류가 감지되지 않았습니다.');
            return;
        }
        toast('info', `오류 의심: ${flagged.map(f => `${CHECKS[f.key].label.split(' (')[0]} ${Math.round(f.p * 100)}%`).join(', ')}`);

        // 2) 지시문 생성
        let directive = await generateDirective(state, flagged);
        if (!directive) { toast('success', '재검토 결과 실제 오류는 없었습니다.'); return; }
        if (!stillSame()) return;

        if (s.mode === 'notify') {
            await callGenericPopup(`<h3>수정 지시문</h3><pre style="white-space:pre-wrap;text-align:left">${escapeHtml(directive)}</pre>`, POPUP_TYPE.TEXT);
            return;
        }
        if (s.mode === 'confirm') {
            const edited = await callGenericPopup('수정 지시문 (편집 가능)', POPUP_TYPE.INPUT, directive, { rows: 8, okButton: '수정본 생성', cancelButton: '무시' });
            if (!edited) return;
            directive = String(edited);
        }
        if (!stillSame()) return;

        // 3) 수정본 생성
        toast('info', '수정본 생성 중…');
        const revised = await quietGenerate(buildRevisionPrompt(message.mes, directive));
        if (!revised) { toast('error', '수정본이 비어 있습니다.'); return; }
        if (!stillSame()) { toast('warning', '메시지가 바뀌어 수정본을 버렸습니다.'); return; }

        addRevisionSwipe(message, revised, directive, scores);
        await saveChatConditional();
        await reloadCurrentChat();
        toast('success', '수정본을 새 스와이프로 추가했습니다. 왼쪽으로 넘기면 원본이 있습니다.');
    } catch (e) {
        console.error(LOG, e);
        toast('error', `오류: ${e.message}`);
    } finally {
        busy = false;
    }
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

function currentDirective(message) {
    if (Array.isArray(message?.swipe_info)) return message.swipe_info[message.swipe_id]?.extra?.cg_directive;
    return message?.extra?.cg_directive;
}

function decorateMessage(id) {
    const ctx = getContext();
    const message = ctx.chat?.[id];
    const el = document.querySelector(`.mes[mesid="${id}"]`);
    if (!message || !el || message.is_user) return;

    const buttons = el.querySelector('.extraMesButtons') || el.querySelector('.mes_buttons');
    if (buttons && !buttons.querySelector('.cg-check-btn')) {
        const b = document.createElement('div');
        b.className = 'mes_button cg-check-btn interactable fa-solid fa-spell-check';
        b.title = '설정오류 검사 (Consistency Guard)';
        b.tabIndex = 0;
        buttons.prepend(b);
    }

    el.querySelector('.cg-feedback')?.remove();
    const directive = currentDirective(message);
    if (directive) {
        const box = document.createElement('details');
        box.className = 'cg-feedback';
        box.innerHTML = `<summary>설정오류 수정 지시문</summary><pre>${escapeHtml(directive)}</pre>`;
        el.querySelector('.mes_text')?.after(box);
    }
}

function decorateAll() {
    document.querySelectorAll('#chat .mes').forEach(el => {
        const id = Number(el.getAttribute('mesid'));
        if (!Number.isNaN(id)) decorateMessage(id);
    });
}

// 근거 항목이 모두 꺼진 질문은 흐리게 + 비활성화
function refreshCheckAvailability() {
    const s = settings();
    for (const [key, def] of Object.entries(CHECKS)) {
        const available = def.needs.length === 0 || def.needs.some(n => s.sources[n]);
        const $input = $(`[data-cg-check="${key}"]`);
        $input.prop('disabled', !available);
        $input.closest('label').toggleClass('cg-unavailable', !available);
    }
    $('#cg_recent_row').toggle(!!s.sources.recentChat);
    $('#cg_extra').toggle(!!s.sources.extra);
}

function setStatus(sel, text, kind = '') {
    $(sel).text(text).toggleClass('is-ok', kind === 'ok').toggleClass('is-error', kind === 'error');
}

function refreshJevStatus() {
    const s = settings();
    try {
        const profile = getJevProfile();
        setStatus('#cg_jev_status', `${profile.name} · ${profile.model} · 저장된 연결 키 사용`, 'ok');
    } catch (e) {
        setStatus('#cg_jev_status', s.jevProfileId ? e.message : '', s.jevProfileId ? 'error' : '');
    }
}

function installProfileDropdowns() {
    const s = settings();
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cg_jev_profile',
            s.jevProfileId,
            profile => {
                s.jevProfileId = profile?.id || '';
                saveSettingsDebounced();
                refreshJevStatus();
            },
            () => {},
            () => refreshJevStatus(),
            profile => {
                if (s.jevProfileId === profile?.id) s.jevProfileId = '';
                refreshJevStatus();
            },
        );
        ConnectionManagerRequestService.handleDropdown(
            '#cg_profile',
            s.directiveProfileId,
            profile => {
                s.directiveProfileId = profile?.id || '';
                saveSettingsDebounced();
            },
            () => {},
            () => {},
            profile => {
                if (s.directiveProfileId === profile?.id) s.directiveProfileId = '';
            },
        );
    } catch (e) {
        setStatus('#cg_jev_status', `연결 관리자를 불러오지 못했습니다: ${e.message}`, 'error');
    }
    refreshJevStatus();
}

async function testJevConnection() {
    const $btn = $('#cg_jev_test').addClass('disabled');
    setStatus('#cg_jev_test_status', '시험 중…');
    try {
        const t0 = performance.now();
        const scores = await judgeWithJev(
            { CHARACTER_NAME: 'Mina', USER_NAME: 'User', CHARACTER_SHEET: 'Mina has short black hair.', NEW_MESSAGE: 'Mina tucked her long blonde hair behind her ear.' },
            [['character', CHECKS.character]],
        );
        const ms = Math.round(performance.now() - t0);
        setStatus('#cg_jev_test_status', `성공 · ${ms}ms · 모순 확률 ${Math.round(scores.character * 100)}%`, 'ok');
    } catch (e) {
        setStatus('#cg_jev_test_status', e.message, 'error');
    } finally {
        $btn.removeClass('disabled');
    }
}

function renderSettings() {
    const s = settings();
    const sourceBoxes = Object.entries(SOURCES).map(([k, d]) =>
        `<label class="checkbox_label"><input type="checkbox" data-cg-source="${k}" ${s.sources[k] ? 'checked' : ''}> ${escapeHtml(d.label)}</label>`).join('');
    const checkBoxes = Object.entries(CHECKS).map(([k, d]) =>
        `<label class="checkbox_label"><input type="checkbox" data-cg-check="${k}" ${s.checks[k] ? 'checked' : ''}> ${escapeHtml(d.label)}</label>`).join('');

    const html = `
<div class="cg-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Consistency Guard (Jev)</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="cg_enabled" ${s.enabled ? 'checked' : ''}> 응답마다 자동 검사</label>
      <div class="cg-row"><label for="cg_mode">오류 발견 시</label>
        <select id="cg_mode" class="text_pole">
          <option value="auto">바로 수정본 생성</option>
          <option value="confirm">지시문 확인 후 생성</option>
          <option value="notify">지시문만 보여주기</option>
        </select></div>

      <h4>검사 근거로 쓸 항목</h4>
      <small>켠 항목만 Jev와 지시문 모델에 전달됩니다. 길이는 항목별로 자동 제한됩니다.</small>
      <div class="cg-checks">${sourceBoxes}</div>
      <div class="cg-row" id="cg_recent_row"><label for="cg_recent">최근 대화 메시지 수</label><input id="cg_recent" class="text_pole" type="number" min="1" max="50"></div>
      <textarea id="cg_extra" class="text_pole" rows="3" placeholder="예: {{getvar::world_state}} 또는 직접 적은 설정"></textarea>

      <h4>검사할 오류 종류</h4>
      <small>흐리게 보이는 항목은 필요한 근거 항목이 꺼져 있어 검사하지 않습니다.</small>
      <div class="cg-checks">${checkBoxes}</div>
      <div class="cg-row"><label for="cg_threshold">오류 판정 기준 <span id="cg_threshold_val"></span></label>
        <input id="cg_threshold" type="range" min="0.3" max="0.95" step="0.05"></div>

      <h4>Jev 연결</h4>
      <div class="cg-row"><label for="cg_jev_profile">연결 프로필</label><select id="cg_jev_profile" class="text_pole"></select></div>
      <small>Custom (OpenAI-compatible) · URL https://ai-gateway.vercel.sh/v1 · 모델 typesafe-ai/jev 프로필을 고르세요. 키는 서버 플러그인이 서버 안에서만 읽습니다.</small>
      <small id="cg_jev_status" class="cg-status"></small>
      <div class="cg-row"><label for="cg_timeout">타임아웃(ms)</label><input id="cg_timeout" class="text_pole" type="number" min="1000" step="500"></div>
      <div class="cg-row"><div id="cg_jev_test" class="menu_button menu_button_icon"><i class="fa-solid fa-plug-circle-check"></i><span>연결 시험</span></div>
        <small id="cg_jev_test_status" class="cg-status"></small></div>

      <h4>지시문 생성</h4>
      <div class="cg-row"><label for="cg_profile">연결 프로필</label><select id="cg_profile" class="text_pole"></select></div>
      <small>비워 두면 메인 API로 지시문을 만듭니다. 수정본 자체는 항상 메인 API로 생성합니다.</small>
      <div class="cg-row"><label for="cg_dirtokens">지시문 최대 토큰</label><input id="cg_dirtokens" class="text_pole" type="number" min="100" step="50"></div>
      <label class="checkbox_label"><input type="checkbox" id="cg_toasts"> 진행 알림 표시</label>
    </div>
  </div>
</div>`;
    $('#extensions_settings2').append(html);

    const bind = (sel, key, parse = v => v, prop = 'value') => {
        $(sel).prop(prop, s[key]).on('input change', function () {
            s[key] = parse($(this).prop(prop));
            saveSettingsDebounced();
        });
    };
    bind('#cg_enabled', 'enabled', Boolean, 'checked');
    bind('#cg_mode', 'mode');
    bind('#cg_timeout', 'jevTimeoutMs', Number);
    bind('#cg_recent', 'recentMessages', Number);
    bind('#cg_extra', 'extraContextTemplate');
    bind('#cg_dirtokens', 'directiveMaxTokens', Number);
    bind('#cg_toasts', 'showToasts', Boolean, 'checked');
    bind('#cg_threshold', 'threshold', Number);

    const showT = () => $('#cg_threshold_val').text(`(${Number(s.threshold).toFixed(2)})`);
    showT(); $('#cg_threshold').on('input', showT);

    $('[data-cg-source]').on('change', function () {
        s.sources[this.dataset.cgSource] = this.checked;
        saveSettingsDebounced();
        refreshCheckAvailability();
    });
    $('[data-cg-check]').on('change', function () {
        s.checks[this.dataset.cgCheck] = this.checked;
        saveSettingsDebounced();
    });
    refreshCheckAvailability();

    installProfileDropdowns();
    $('#cg_jev_test').on('click', testJevConnection);
}

/* ------------------------------------------------------------------ */
/* 초기화                                                               */
/* ------------------------------------------------------------------ */

jQuery(() => {
    settings();
    renderSettings();

    $(document).on('click', '.cg-check-btn', function (e) {
        e.stopPropagation();
        const id = Number($(this).closest('.mes').attr('mesid'));
        if (!Number.isNaN(id)) runCheck(id, { manual: true });
    });

    // 이번 생성에서 활성화된 로어북 항목 기억 (검사 중 생기는 quiet 생성분은 무시)
    if (event_types.WORLD_INFO_ACTIVATED) {
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, entries => {
            if (!busy) lastActivatedLore = Array.isArray(entries) ? entries : [];
        });
    }

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        if (!settings().enabled) return;
        if (['impersonate', 'quiet', 'first_message', 'extension'].includes(type)) return;
        const message = getContext().chat[messageId];
        if (!message || message.extra?.cg_revised || message.extra?.instead_revised) return;
        setTimeout(() => runCheck(messageId), 0);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, id => decorateMessage(id));
    eventSource.on(event_types.MESSAGE_SWIPED, () => setTimeout(decorateAll, 50));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastActivatedLore = [];
        setTimeout(decorateAll, 100);
    });
    if (event_types.MORE_MESSAGES_LOADED) {
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => setTimeout(decorateAll, 50));
    }

    console.log(LOG, 'loaded');
});
