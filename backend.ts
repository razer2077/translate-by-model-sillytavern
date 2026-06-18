import { Spindle } from "@lumiverse/spindle";

// Помощник для отключения thinking
function customThinkingBody(mode: string) {
    switch (mode) {
        case "reasoning_off": return { reasoning: { enabled: false } };
        case "thinking_off": return { thinking: { type: "disabled" } };
        case "on": default: return {};
    }
}

Spindle.on("translate_request", async (payload) => {
    const { text, targetLang, apiMode, customModel, customThinking } = payload;
    
    // Строгий промпт для сохранения нарративного стиля (без искажений символов, кавычек и звездочек)
    const systemPrompt = `You are a translation engine. Translate the user's message into natural, fluent ${targetLang}. Preserve tone, style, formatting, markdown, exact quotes (""), and asterisks (*). Output ONLY the translation, with no comments, notes or explanations.`;

    let resultText = "";

    try {
        if (apiMode === "openrouter") {
            const apiKey = await Spindle.SecureEnclave.get("orApiKey");
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: customModel,
                    max_tokens: 8000,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: text }
                    ],
                    reasoning: { enabled: false }
                })
            });
            const data = await response.json();
            resultText = data.choices?.[0]?.message?.content?.trim() || "";
        } 
        else if (apiMode === "custom") {
            const apiUrl = await Spindle.SecureEnclave.get("customApiUrl");
            const apiKey = await Spindle.SecureEnclave.get("customApiKey");
            const extraBody = customThinkingBody(customThinking);
            
            const url = apiUrl.replace(/\/$/, "") + "/chat/completions";
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: customModel,
                    max_tokens: 8000,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: text }
                    ],
                    ...extraBody
                })
            });
            const data = await response.json();
            resultText = data.choices?.[0]?.message?.content?.trim() || "";
        } else {
             // Логика по умолчанию для локальной модели через Lumiverse API
             const response = await Spindle.LLM.generate({
                 prompt: text,
                 system: systemPrompt,
                 max_tokens: 8000
             });
             resultText = response.text.trim();
        }

        return { success: true, translation: resultText };

    } catch (error) {
        return { success: false, error: (error as Error).message };
    }
});

// Хуки для сохранения ключей из UI в Secure Enclave
Spindle.on("save_credentials", async (payload) => {
    const { orApiKey, customApiUrl, customApiKey } = payload;
    if (orApiKey) await Spindle.SecureEnclave.set("orApiKey", orApiKey);
    if (customApiUrl) await Spindle.SecureEnclave.set("customApiUrl", customApiUrl);
    if (customApiKey) await Spindle.SecureEnclave.set("customApiKey", customApiKey);
    return { success: true };
});