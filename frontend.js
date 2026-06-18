import { UI, Messaging, Events } from "@lumiverse/frontend-api";

UI.injectCSS(`
.rp_translate_btn { cursor: pointer; margin-left: 5px; opacity: 0.7; transition: opacity 0.2s; }
.rp_translate_btn:hover { opacity: 1; }
.rp_translate_btn.rp_active { color: var(--golden, gold); opacity: 1; }
.rp_translate_btn.rp_loading { animation: rp_spin 1s linear infinite; pointer-events: none; opacity: 0.6; }
@keyframes rp_spin { to { transform: rotate(360deg); } }
`);

const MODULE = "translate_by_model";

// Старая структура: храним кэш переводов строго в памяти, без использования временных файлов
const translationCache = new Map(); 

async function toggleTranslation(messageId, textEl, btn) {
    if (textEl.dataset.rpShowing === "translation") {
        textEl.innerHTML = textEl.dataset.rpOriginalHtml;
        textEl.dataset.rpShowing = "original";
        btn.classList.remove("rp_active");
        return;
    }

    btn.classList.add("rp_loading");

    try {
        let translatedText = translationCache.get(messageId);

        if (!translatedText) {
            // Берем настройки из UI
            const targetLang = localStorage.getItem("tbm_lang") || "Russian";
            const apiMode = localStorage.getItem("tbm_apiMode") || "openrouter";
            const customModel = localStorage.getItem("tbm_customModel") || "google/gemini-pro";
            const customThinking = localStorage.getItem("tbm_customThinking") || "reasoning_off";

            const response = await Messaging.sendToBackend("translate_request", {
                text: textEl.innerText,
                targetLang,
                apiMode,
                customModel,
                customThinking
            });

            if (response.success) {
                translatedText = response.translation;
                translationCache.set(messageId, translatedText);
            } else {
                throw new Error(response.error);
            }
        }

        if (!textEl.dataset.rpOriginalHtml) {
            textEl.dataset.rpOriginalHtml = textEl.innerHTML;
        }

        // Вставляем текст
        textEl.innerHTML = translatedText;
        textEl.dataset.rpShowing = "translation";
        btn.classList.add("rp_active");

    } catch (error) {
        console.error(`[${MODULE}] translation failed`, error);
    } finally {
        btn.classList.remove("rp_loading");
    }
}

Events.on("message_rendered", (message) => {
    // Защита от дублей
    if (document.getElementById(`trans_btn_${message.id}`)) return;

    const btn = document.createElement("div");
    btn.id = `trans_btn_${message.id}`;
    btn.className = "mes_button rp_translate_btn fa-solid fa-language interactable";
    btn.title = "Translate message";
    
    btn.addEventListener("click", () => {
        const textEl = document.getElementById(`mes_text_${message.id}`);
        if (textEl) toggleTranslation(message.id, textEl, btn);
    });

    UI.appendMessageButton(message.id, btn);
});

// Настройки для UI 
UI.addSettingsTab("Translate Extension", `
    <div style="display:flex; flex-direction:column; gap: 10px; padding: 10px;">
        <label>Target Language: <input type="text" id="tbm_lang_input" value="Russian" style="width:100%"></label>
        <label>API Mode: 
            <select id="tbm_apimode_input" style="width:100%">
                <option value="st">Lumiverse Default</option>
                <option value="openrouter" selected>OpenRouter</option>
                <option value="custom">Custom API</option>
            </select>
        </label>
        <label>Model: <input type="text" id="tbm_model_input" value="google/gemini-pro" style="width:100%"></label>
        <hr style="opacity:0.3; margin: 10px 0;">
        <label>OpenRouter API Key: <input type="password" id="tbm_or_key" style="width:100%"></label>
        <button id="tbm_save_creds" style="margin-top: 10px; cursor:pointer;">Save API Keys to Secure Enclave</button>
    </div>
`);

setTimeout(() => {
    const saveBtn = document.getElementById("tbm_save_creds");
    if(saveBtn) {
        saveBtn.addEventListener("click", async () => {
            localStorage.setItem("tbm_lang", document.getElementById("tbm_lang_input").value);
            localStorage.setItem("tbm_apiMode", document.getElementById("tbm_apimode_input").value);
            localStorage.setItem("tbm_customModel", document.getElementById("tbm_model_input").value);
            
            await Messaging.sendToBackend("save_credentials", {
                orApiKey: document.getElementById("tbm_or_key").value
            });
            alert("Settings and keys saved securely!");
        });
    }
}, 1000);