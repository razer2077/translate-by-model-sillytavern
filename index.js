const ctx = SillyTavern.getContext();
const {
    eventSource,
    event_types,
    extensionSettings,
    saveSettingsDebounced,
    saveChatConditional,
    messageFormatting,
} = ctx;

const MODULE = "translate_by_model";

const defaultSettings = {
    targetLang: "Russian",
    autoTranslate: false,
    mode: "economy",
    contextDepth: 6,
    userName: "",
    // Режим подключения: "st" | "openrouter" | "custom"
    apiMode: "st",
    // OpenRouter
    orApiKey: "",
    orModel: "",
    orProvider: "",
    // Custom API
    customApiUrl: "",
    customApiKey: "",
    customModel: "",
    // Режим thinking для custom: "reasoning_off" | "thinking_off" | "on"
    customThinking: "reasoning_off",
    promptTemplate:
        "You are a translation engine. Translate the user's message into " +
        "natural, fluent {{lang}}. Preserve tone, style, formatting and markdown. " +
        "Output ONLY the translation, with no comments, notes or explanations.",
};

function getSettings() {
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const k of Object.keys(defaultSettings)) {
        if (extensionSettings[MODULE][k] === undefined) {
            extensionSettings[MODULE][k] = defaultSettings[k];
        }
    }
    return extensionSettings[MODULE];
}

function cacheKey() {
    return `translation_${getSettings().targetLang}`;
}

function buildInstruction() {
    const s = getSettings();
    const userName = s.userName || ctx.name1 || "User";
    return s.promptTemplate
        .replaceAll("{{lang}}", s.targetLang)
        .replaceAll("{{user}}", userName);
}

// Собрать предыдущие сообщения как текстовый контекст (для accurate режима)
function buildContextText(mesId, count) {
    const lines = [];
    const start = Math.max(0, mesId - count);
    for (let i = start; i < mesId; i++) {
        const m = ctx.chat[i];
        if (!m || m.is_system || !m.mes) continue;
        const who = m.is_user ? (ctx.name1 || "User") : (m.name || "Character");
        lines.push(`${who}: ${m.mes}`);
    }
    return lines.join("\n");
}

// Тело для отключения thinking в зависимости от выбранного режима custom
function customThinkingBody(mode) {
    switch (mode) {
        case "reasoning_off":
            return { reasoning: { enabled: false } };
        case "thinking_off":
            return { thinking: { type: "disabled" } };
        case "on":
        default:
            return {};
    }
}

// Загрузить модели с OpenRouter
async function fetchORModels(apiKey) {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`OpenRouter models: ${resp.status}`);
    const data = await resp.json();
    return (data.data || []).map(m => ({ id: m.id, name: m.name || m.id })).sort((a, b) => a.id.localeCompare(b.id));
}

// Загрузить провайдеров для модели с OpenRouter
async function fetchORProviders(apiKey, modelId) {
    // НЕ кодируем слэш — он часть пути роута /models/{author}/{slug}/endpoints
    const path = modelId.split("/").map(encodeURIComponent).join("/");
    const resp = await fetch(`https://openrouter.ai/api/v1/models/${path}/endpoints`, {
        headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`OpenRouter providers: ${resp.status}`);
    const data = await resp.json();
    // data.data — объект с полем endpoints (массив)
    const endpoints = data?.data?.endpoints || [];
    return endpoints
        .map(e => e.provider_name || e.name)
        .filter(Boolean);
}

// Загрузить модели с кастомного API
async function fetchCustomModels(apiUrl, apiKey) {
    const url = apiUrl.replace(/\/$/, "") + "/models";
    const resp = await fetch(url, {
        headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`Custom API models: ${resp.status}`);
    const data = await resp.json();
    return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean).sort();
}

// Прямой запрос к OpenAI-совместимому API
async function callApi(apiUrl, apiKey, model, systemPrompt, userText, extraBody = {}, extraHeaders = {}) {
    const url = apiUrl.replace(/\/$/, "") + "/chat/completions";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 130000);
    try {
        const body = {
            model,
            max_tokens: 8000, // явный лимит вывода, чтобы не резалось
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userText },
            ],
            ...extraBody,
        };
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                ...extraHeaders,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`API ${resp.status}: ${err}`);
        }
        const data = await resp.json();
        // Некоторые API возвращают 200 с полем error внутри тела
        if (data.error) {
            throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
        }
        // Фолбэк на reasoning-поля, если content пуст (reasoning-модели)
        const msg = data.choices?.[0]?.message;
        const content = msg?.content?.trim()
            || msg?.reasoning_content?.trim()
            || msg?.reasoning?.trim()
            || null;
        return content;
    } finally {
        clearTimeout(timer);
    }
}

// Сформировать текст для прямого API в зависимости от режима
function buildUserText(mesId, message) {
    const s = getSettings();
    if (s.mode === "accurate") {
        const context = buildContextText(mesId, s.contextDepth);
        const ctxBlock = context
            ? `Conversation so far (for context only, DO NOT translate this part):\n${context}\n\n`
            : "";
        return `${ctxBlock}Translate ONLY the text between the markers, keeping it consistent with the context above:\n===BEGIN===\n${message.mes}\n===END===`;
    }
    // economy — только текст сообщения, без контекста
    return message.mes;
}

async function getTranslation(mesId) {
    const message = ctx.chat[mesId];
    if (!message) return null;

    message.extra = message.extra || {};
    const key = cacheKey();
    if (message.extra[key]) return message.extra[key];

    const s = getSettings();
    const instruction = buildInstruction();

    let raw;

    if (s.apiMode === "openrouter" && s.orApiKey && s.orModel) {
        // OpenRouter с опциональным провайдером
        const extraBody = {
            // Отключаем reasoning/thinking — нам нужен только перевод
            reasoning: { enabled: false },
        };
        if (s.orProvider) {
            extraBody.provider = { order: [s.orProvider], allow_fallbacks: false };
        }
        const userText = buildUserText(mesId, message);
        raw = await callApi(
            "https://openrouter.ai/api/v1",
            s.orApiKey,
            s.orModel,
            instruction,
            userText,
            extraBody,
            {
                "HTTP-Referer": location.origin,
                "X-Title": "SillyTavern Translate",
            }
        );
    } else if (s.apiMode === "custom" && s.customApiUrl && s.customApiKey && s.customModel) {
        // Кастомный API с выбором режима thinking
        const userText = buildUserText(mesId, message);
        const extraBody = customThinkingBody(s.customThinking);
        raw = await callApi(s.customApiUrl, s.customApiKey, s.customModel, instruction, userText, extraBody);
    } else {
        // Текущее ST подключение
        const cc = ctx.chatCompletionSettings;
        const prevReasoning = cc ? cc.include_reasoning : undefined;
        const prevBody = cc ? cc.custom_include_body : undefined;
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Translation timed out")), 120000)
        );
        try {
            if (cc) {
                cc.include_reasoning = false;
                cc.custom_include_body = '{"thinking":{"type":"disabled"}}';
            }
            if (s.mode === "accurate") {
                const context = buildContextText(mesId, s.contextDepth);
                const ctxBlock = context
                    ? `Conversation so far (for context only, DO NOT translate this part):\n${context}\n\n`
                    : "";
                const prompt = `${instruction}\n\n${ctxBlock}===BEGIN===\n${message.mes}\n===END===`;
                raw = await Promise.race([ctx.generateQuietPrompt(prompt, false, true), timeoutPromise]);
            } else {
                raw = await Promise.race([
                    ctx.generateRaw({ prompt: message.mes, systemPrompt: instruction }),
                    timeoutPromise,
                ]);
            }
        } finally {
            if (cc) {
                cc.include_reasoning = prevReasoning;
                cc.custom_include_body = prevBody;
            }
        }
    }

    const translated = (raw || "").trim();
    message.extra[key] = translated;

    try {
        const save = ctx.saveChatConditional || ctx.saveChat;
        if (typeof save === "function") await save();
    } catch (e) {
        console.warn(`[${MODULE}] could not persist translation cache`, e);
    }

    return translated;
}

async function toggleTranslation(messageEl) {
    const mesId = Number(messageEl.getAttribute("mesid"));
    const textEl = messageEl.querySelector(".mes_text");
    const btn = messageEl.querySelector(".rp_translate_btn");
    if (!textEl) return;

    if (textEl.dataset.rpShowing === "translation") {
        textEl.innerHTML = textEl.dataset.rpOriginalHtml;
        textEl.dataset.rpShowing = "original";
        btn?.classList.remove("rp_active");
        return;
    }

    btn?.classList.add("rp_loading");
    try {
        const translated = await getTranslation(mesId);
        if (translated == null || translated === "") {
            toastr?.warning("Empty translation returned.");
            return;
        }

        if (!textEl.dataset.rpOriginalHtml) {
            textEl.dataset.rpOriginalHtml = textEl.innerHTML;
        }

        const message = ctx.chat[mesId];
        try {
            textEl.innerHTML = messageFormatting(translated, message.name, false, message.is_user, mesId);
        } catch (fmtErr) {
            console.error(`[${MODULE}] messageFormatting failed`, fmtErr);
            textEl.textContent = translated; // фолбэк — просто текст
        }
        textEl.dataset.rpShowing = "translation";
        btn?.classList.add("rp_active");
    } catch (e) {
        console.error(`[${MODULE}] translation failed`, e);
        if (typeof toastr !== "undefined") toastr.error("Translation failed. See console.");
    } finally {
        btn?.classList.remove("rp_loading");
    }
}

function addButton(messageEl) {
    const buttons = messageEl.querySelector(".mes_buttons");
    if (!buttons || buttons.querySelector(".rp_translate_btn")) return;

    const btn = document.createElement("div");
    btn.className = "mes_button rp_translate_btn fa-solid fa-language interactable";
    btn.title = `Translate to ${getSettings().targetLang}`;
    btn.tabIndex = 0;
    btn.addEventListener("click", () => toggleTranslation(messageEl));
    buttons.prepend(btn);
}

function addButtonsToAll() {
    document.querySelectorAll("#chat .mes").forEach(addButton);
}

function invalidateCache(mesId) {
    const message = ctx.chat[Number(mesId)];
    if (message?.extra) {
        for (const k of Object.keys(message.extra)) {
            if (k.startsWith("translation_")) delete message.extra[k];
        }
    }
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    const t = el?.querySelector(".mes_text");
    if (t) {
        delete t.dataset.rpOriginalHtml;
        delete t.dataset.rpShowing;
    }
}

async function onNewMessage(id) {
    if (!getSettings().autoTranslate) return;
    const mesId = Number(id);
    const message = ctx.chat[mesId];
    if (!message || message.is_user) return;

    const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    const textEl = el?.querySelector(".mes_text");
    if (!el || !textEl) return;

    if (!textEl.dataset.rpOriginalHtml) {
        textEl.dataset.rpOriginalHtml = textEl.innerHTML;
    }
    textEl.innerHTML = '<i class="fa-solid fa-language fa-fade"></i> <span style="opacity:.6">перевод...</span>';

    try {
        const translated = await getTranslation(mesId);
        if (translated == null || translated === "") {
            textEl.innerHTML = textEl.dataset.rpOriginalHtml;
            return;
        }
        const m = ctx.chat[mesId];
        try {
            textEl.innerHTML = messageFormatting(translated, m.name, false, m.is_user, mesId);
        } catch (fmtErr) {
            console.error(`[${MODULE}] messageFormatting failed`, fmtErr);
            textEl.textContent = translated;
        }
        textEl.dataset.rpShowing = "translation";
        el.querySelector(".rp_translate_btn")?.classList.add("rp_active");
    } catch (e) {
        console.error(`[${MODULE}] auto-translate failed`, e);
        textEl.innerHTML = textEl.dataset.rpOriginalHtml;
    }
}

function injectSettingsUI() {
    const s = getSettings();
    const html = `
    <div class="translate-by-model-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Translate by Current Model</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <label for="tbm_lang">Target language</label>
          <input id="tbm_lang" class="text_pole" type="text" value="${s.targetLang}">

          <label for="tbm_username">Player character name (use {{user}} in prompt)</label>
          <input id="tbm_username" class="text_pole" type="text" placeholder="e.g. Vladislav (male)" value="${s.userName || ""}">

          <label class="checkbox_label" for="tbm_auto">
            <input id="tbm_auto" type="checkbox" ${s.autoTranslate ? "checked" : ""}>
            Auto-translate new AI messages
          </label>

          <hr style="margin:10px 0;opacity:.3">

          <label for="tbm_mode">Mode</label>
          <select id="tbm_mode" class="text_pole">
            <option value="economy">Economy (no context, fast)</option>
            <option value="accurate">Accurate (with context, slower)</option>
          </select>
          <small style="opacity:.6;display:block;margin-top:4px">
            Mode applies to all connection types below.
          </small>

          <div id="tbm_depth_wrap" style="margin-top:8px;display:${s.mode === 'accurate' ? 'block' : 'none'}">
            <label for="tbm_depth">Context depth (previous messages)</label>
            <input id="tbm_depth" class="text_pole" type="number" min="0" max="50" step="1" value="${s.contextDepth}">
            <small style="opacity:.6;display:block;margin-top:4px">
              How many preceding messages to send as context. 0 = none. Higher = more accurate but slower and more tokens.
            </small>
          </div>

          <hr style="margin:10px 0;opacity:.3">

          <!-- Табы -->
          <div style="display:flex;gap:4px;margin-bottom:8px">
            <div class="tbm_tab menu_button ${s.apiMode === 'st' ? 'active_tab' : ''}" data-tab="st" style="flex:1;text-align:center;cursor:pointer">Current ST profile</div>
            <div class="tbm_tab menu_button ${s.apiMode === 'openrouter' ? 'active_tab' : ''}" data-tab="openrouter" style="flex:1;text-align:center;cursor:pointer">OpenRouter</div>
            <div class="tbm_tab menu_button ${s.apiMode === 'custom' ? 'active_tab' : ''}" data-tab="custom" style="flex:1;text-align:center;cursor:pointer">Custom API</div>
          </div>

          <!-- ST tab -->
          <div class="tbm_tabcontent" id="tbm_tab_st" style="display:${s.apiMode === 'st' ? 'block' : 'none'}">
            <small style="opacity:.6">Uses the currently active ST connection profile. No extra setup needed.</small>
          </div>

          <!-- OpenRouter tab -->
          <div class="tbm_tabcontent" id="tbm_tab_openrouter" style="display:${s.apiMode === 'openrouter' ? 'block' : 'none'}">
            <label for="tbm_or_key">OpenRouter API Key</label>
            <input id="tbm_or_key" class="text_pole" type="password" placeholder="sk-or-..." value="${s.orApiKey || ""}">

            <div style="display:flex;gap:6px;align-items:flex-end;margin-top:6px">
              <div style="flex:1">
                <label for="tbm_or_model">Model</label>
                <select id="tbm_or_model" class="text_pole">
                  ${s.orModel ? `<option value="${s.orModel}" selected>${s.orModel}</option>` : '<option value="">— load models first —</option>'}
                </select>
              </div>
              <div id="tbm_or_load_models" class="menu_button" style="white-space:nowrap;padding:4px 8px;cursor:pointer">
                <i class="fa-solid fa-rotate"></i> Load
              </div>
            </div>

            <div style="display:flex;gap:6px;align-items:flex-end;margin-top:6px">
              <div style="flex:1">
                <label for="tbm_or_provider">Provider <small style="opacity:.6">(optional)</small></label>
                <select id="tbm_or_provider" class="text_pole">
                  <option value="">— any provider —</option>
                  ${s.orProvider ? `<option value="${s.orProvider}" selected>${s.orProvider}</option>` : ''}
                </select>
              </div>
              <div id="tbm_or_load_providers" class="menu_button" style="white-space:nowrap;padding:4px 8px;cursor:pointer">
                <i class="fa-solid fa-rotate"></i> Load
              </div>
            </div>
          </div>

          <!-- Custom API tab -->
          <div class="tbm_tabcontent" id="tbm_tab_custom" style="display:${s.apiMode === 'custom' ? 'block' : 'none'}">
            <label for="tbm_custom_url">API URL</label>
            <input id="tbm_custom_url" class="text_pole" type="text" placeholder="https://api.example.com/v1" value="${s.customApiUrl || ""}">

            <label for="tbm_custom_key">API Key</label>
            <input id="tbm_custom_key" class="text_pole" type="password" placeholder="sk-..." value="${s.customApiKey || ""}">

            <div style="display:flex;gap:6px;align-items:flex-end;margin-top:6px">
              <div style="flex:1">
                <label for="tbm_custom_model">Model</label>
                <select id="tbm_custom_model" class="text_pole">
                  ${s.customModel ? `<option value="${s.customModel}" selected>${s.customModel}</option>` : '<option value="">— load models first —</option>'}
                </select>
              </div>
              <div id="tbm_custom_load_models" class="menu_button" style="white-space:nowrap;padding:4px 8px;cursor:pointer">
                <i class="fa-solid fa-rotate"></i> Load
              </div>
            </div>

            <label for="tbm_custom_thinking" style="margin-top:6px;display:block">Thinking / reasoning</label>
            <select id="tbm_custom_thinking" class="text_pole">
              <option value="reasoning_off">Disable via reasoning: { enabled: false }</option>
              <option value="thinking_off">Disable via thinking: { type: "disabled" }</option>
              <option value="on">Keep thinking enabled</option>
            </select>
            <small style="opacity:.6;display:block;margin-top:4px">
              Choose how to disable model thinking. Format depends on your backend.
            </small>
          </div>

          <hr style="margin:10px 0;opacity:.3">
          <label for="tbm_prompt">Instruction (use {{lang}}, {{user}})</label>
          <textarea id="tbm_prompt" class="text_pole textarea_compact" rows="5"></textarea>

        </div>
      </div>
    </div>`;
    $("#extensions_settings2").append(html);
    $("#tbm_prompt").val(s.promptTemplate);
    $("#tbm_mode").val(s.mode);
    $("#tbm_custom_thinking").val(s.customThinking);

    // Табы
    $(".tbm_tab").on("click", function () {
        const tab = $(this).data("tab");
        getSettings().apiMode = tab;
        saveSettingsDebounced();
        $(".tbm_tab").removeClass("active_tab");
        $(this).addClass("active_tab");
        $(".tbm_tabcontent").hide();
        $(`#tbm_tab_${tab}`).show();
    });

    // Общие настройки
    $("#tbm_lang").on("input", function () {
        getSettings().targetLang = String($(this).val());
        saveSettingsDebounced();
        document.querySelectorAll(".rp_translate_btn").forEach(b => {
            b.title = `Translate to ${getSettings().targetLang}`;
        });
    });
    $("#tbm_mode").on("change", function () {
        const mode = String($(this).val());
        getSettings().mode = mode;
        saveSettingsDebounced();
        $("#tbm_depth_wrap").toggle(mode === "accurate");
    });
    $("#tbm_depth").on("input", function () {
        let v = parseInt($(this).val(), 10);
        if (isNaN(v) || v < 0) v = 0;
        if (v > 50) v = 50;
        getSettings().contextDepth = v;
        saveSettingsDebounced();
    });
    $("#tbm_auto").on("change", function () {
        getSettings().autoTranslate = $(this).prop("checked");
        saveSettingsDebounced();
    });
    $("#tbm_username").on("input", function () {
        getSettings().userName = String($(this).val());
        saveSettingsDebounced();
    });
    $("#tbm_prompt").on("input", function () {
        getSettings().promptTemplate = String($(this).val());
        saveSettingsDebounced();
    });

    // OpenRouter tab
    $("#tbm_or_key").on("input", function () {
        getSettings().orApiKey = String($(this).val()).trim();
        saveSettingsDebounced();
    });
    $("#tbm_or_model").on("change", function () {
        getSettings().orModel = String($(this).val());
        // Сбросить провайдера при смене модели
        getSettings().orProvider = "";
        $("#tbm_or_provider").html('<option value="">— any provider —</option>');
        saveSettingsDebounced();
    });
    $("#tbm_or_provider").on("change", function () {
        getSettings().orProvider = String($(this).val());
        saveSettingsDebounced();
    });

    $("#tbm_or_load_models").on("click", async function () {
        const apiKey = String($("#tbm_or_key").val()).trim();
        if (!apiKey) { toastr?.warning("Enter OpenRouter API Key first."); return; }
        const btn = $(this);
        btn.html('<i class="fa-solid fa-spinner fa-spin"></i>');
        try {
            const models = await fetchORModels(apiKey);
            const current = getSettings().orModel;
            const $sel = $("#tbm_or_model");
            $sel.empty();
            if (!current) $sel.append('<option value="">— select model —</option>');
            models.forEach(m => {
                const opt = document.createElement("option");
                opt.value = m.id;
                opt.textContent = m.name !== m.id ? `${m.name} (${m.id})` : m.id;
                if (m.id === current) opt.selected = true;
                $sel.append(opt);
            });
            toastr?.success(`Loaded ${models.length} models.`);
        } catch (e) {
            console.error(`[${MODULE}]`, e);
            toastr?.error("Failed to load models.");
        } finally {
            btn.html('<i class="fa-solid fa-rotate"></i> Load');
        }
    });

    $("#tbm_or_load_providers").on("click", async function () {
        const apiKey = String($("#tbm_or_key").val()).trim();
        const model = String($("#tbm_or_model").val()).trim();
        if (!apiKey) { toastr?.warning("Enter OpenRouter API Key first."); return; }
        if (!model) { toastr?.warning("Select a model first."); return; }
        const btn = $(this);
        btn.html('<i class="fa-solid fa-spinner fa-spin"></i>');
        try {
            const providers = await fetchORProviders(apiKey, model);
            const current = getSettings().orProvider;
            const $sel = $("#tbm_or_provider");
            $sel.empty();
            $sel.append('<option value="">— any provider —</option>');
            providers.forEach(p => {
                const opt = document.createElement("option");
                opt.value = p;
                opt.textContent = p;
                if (p === current) opt.selected = true;
                $sel.append(opt);
            });
            toastr?.success(`Loaded ${providers.length} providers.`);
        } catch (e) {
            console.error(`[${MODULE}]`, e);
            toastr?.error("Failed to load providers.");
        } finally {
            btn.html('<i class="fa-solid fa-rotate"></i> Load');
        }
    });

    // Custom API tab
    $("#tbm_custom_url").on("input", function () {
        getSettings().customApiUrl = String($(this).val()).trim();
        saveSettingsDebounced();
    });
    $("#tbm_custom_key").on("input", function () {
        getSettings().customApiKey = String($(this).val()).trim();
        saveSettingsDebounced();
    });
    $("#tbm_custom_model").on("change", function () {
        getSettings().customModel = String($(this).val());
        saveSettingsDebounced();
    });
    $("#tbm_custom_thinking").on("change", function () {
        getSettings().customThinking = String($(this).val());
        saveSettingsDebounced();
    });

    $("#tbm_custom_load_models").on("click", async function () {
        const apiUrl = String($("#tbm_custom_url").val()).trim();
        const apiKey = String($("#tbm_custom_key").val()).trim();
        if (!apiUrl || !apiKey) { toastr?.warning("Enter API URL and Key first."); return; }
        const btn = $(this);
        btn.html('<i class="fa-solid fa-spinner fa-spin"></i>');
        try {
            const models = await fetchCustomModels(apiUrl, apiKey);
            const current = getSettings().customModel;
            const $sel = $("#tbm_custom_model");
            $sel.empty();
            if (!current) $sel.append('<option value="">— select model —</option>');
            models.forEach(m => {
                const opt = document.createElement("option");
                opt.value = m;
                opt.textContent = m;
                if (m === current) opt.selected = true;
                $sel.append(opt);
            });
            toastr?.success(`Loaded ${models.length} models.`);
        } catch (e) {
            console.error(`[${MODULE}]`, e);
            toastr?.error("Failed to load models.");
        } finally {
            btn.html('<i class="fa-solid fa-rotate"></i> Load');
        }
    });
}

jQuery(async () => {
    getSettings();
    injectSettingsUI();

    eventSource.on(event_types.MESSAGE_RENDERED, addButtonsToAll);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, addButtonsToAll);
    eventSource.on(event_types.CHAT_CHANGED, addButtonsToAll);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (id) => {
        addButtonsToAll();
        onNewMessage(id);
    });
    eventSource.on(event_types.MESSAGE_EDITED, invalidateCache);
    eventSource.on(event_types.MESSAGE_SWIPED, invalidateCache);

    addButtonsToAll();
});
