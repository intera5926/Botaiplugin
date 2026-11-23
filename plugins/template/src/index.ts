import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";
import { safeFetch } from "@vendetta/utils";

const { ScrollView } = ReactNative;
const { FormSection, FormInput, FormSwitchRow, FormDivider } = Forms;

const MessageActions = findByProps("sendBotMessage", "receiveMessage");
const UserStore = findByStoreName("UserStore");

storage.enabled ??= true;
storage.apiKey ??= "";
storage.channelId ??= "";
storage.triggerPrefix ??= "?F";
storage.botName ??= "ChatterBot";
storage.model ??= "gemini-3.5-flash-lite";
storage.systemPrompt ??=
    "You are a friendly, casual Discord chatter bot talking 1-on-1 with a user. Keep replies short (1-3 sentences), natural, and conversational, like a normal Discord user or chatbot. You have no idea anyone else exists—just reply directly to what the user says.";

let chatHistory: { role: "user" | "model"; parts: { text: string }[] }[] = [];

function injectLocalBotMessage(channelId: string, text: string) {
    const fakeMsg = {
        id: String(Date.now() * 100000 + Math.floor(Math.random() * 9999)),
        type: 0,
        channel_id: channelId,
        content: text,
        author: {
            id: "100000000000000001",
            username: storage.botName || "ChatterBot",
            global_name: storage.botName || "ChatterBot",
            avatar: null,
            discriminator: "0000",
            bot: true,
        },
        timestamp: new Date().toISOString(),
        tts: false,
        mention_everyone: false,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        pinned: false,
        flags: 0,
    };

    if (MessageActions?.receiveMessage) {
        try {
            MessageActions.receiveMessage(channelId, fakeMsg);
            return;
        } catch (e) {
            console.error("[aibotschizo] receiveMessage failed:", e);
        }
    }

    if (MessageActions?.sendBotMessage) {
        try {
            MessageActions.sendBotMessage(channelId, text, storage.botName || "ChatterBot");
            return;
        } catch (e) {
            console.error("[aibotschizo] sendBotMessage failed:", e);
        }
    }

    try {
        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId,
            message: fakeMsg,
            optimistic: false,
            isPushNotification: false,
        });
    } catch (e: any) {
        showToast(`Inject error: ${e?.message || e}`);
    }
}

async function generateBotReply(channelId: string) {
    const key = (storage.apiKey || "").trim();
    if (!key) {
        showToast("aibotschizo: No API key set!");
        return;
    }

    const modelName = (storage.model || "gemini-3.5-flash-lite").trim();
    const url = `https://googleapis.com{modelName}:generateContent?key=${encodeURIComponent(key)}`;

    try {
        const fetcher = typeof safeFetch === "function" ? safeFetch : fetch;
        const response = await fetcher(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: storage.systemPrompt }],
                },
                contents: chatHistory,
                generationConfig: {
                    maxOutputTokens: 150,
                    temperature: 0.85,
                },
            }),
        });

        const data = await response.json();

        if (!response.ok || data?.error) {
            const errMsg = data?.error?.message || `HTTP ${response.status}`;
            showToast(`API Error: ${errMsg}`);
            injectLocalBotMessage(channelId, `⚠️ [API Error]: ${errMsg}`);
            return;
        }

        const firstCandidate = data?.candidates?.at(0);
        const firstPart = firstCandidate?.content?.parts?.at(0);
        const reply = firstPart?.text?.trim();

        if (reply) {
            chatHistory.push({ role: "model", parts: [{ text: reply }] });
            if (chatHistory.length > 16) chatHistory.shift();

            injectLocalBotMessage(channelId, reply);
        } else {
            showToast("Gemini returned empty reply");
        }
    } catch (err: any) {
        showToast(`Net Error: ${err?.message || err}`);
    }
}

function onMessageCreate(event: any) {
    if (!storage.enabled) return;
    if (event.optimistic) return;

    const msg = event.message;
    if (!msg || !msg.content) return;

    if (storage.channelId && msg.channel_id !== storage.channelId.trim()) return;

    const currentUser = UserStore.getCurrentUser();
    if (msg.author?.id !== currentUser?.id) return;

    const prefix = (storage.triggerPrefix ?? "?F").trim();
    if (prefix && !msg.content.startsWith(prefix)) return;

    const cleanText = prefix ? msg.content.slice(prefix.length).trim() : msg.content.trim();
    if (!cleanText) return;

    const lastEntry = chatHistory.at(-1);
    if (lastEntry && lastEntry.role === "user") {
        const firstUserPart = lastEntry.parts.at(0);
        if (firstUserPart) firstUserPart.text += `\n${cleanText}`;
    } else {
        chatHistory.push({
            role: "user",
            parts: [{ text: cleanText }],
        });
    }

    if (chatHistory.length > 16) chatHistory.shift();

    generateBotReply(msg.channel_id);
}

export default {
    onLoad() {
        chatHistory = [];
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },

    onUnload() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        chatHistory = [];
    },

    settings() {
        useProxy(storage);

        return React.createElement(
            ScrollView,
            { style: { flex: 1 } },
            React.createElement(
                FormSection,
                { title: "General" },
                React.createElement(FormSwitchRow, {
                    label: "Enable aibotschizo",
                    subLabel: "Replies locally when you start a message with the prefix",
                    value: storage.enabled,
                    onValueChange: (v: boolean) => (storage.enabled = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "Target Group DM / Channel ID",
                    placeholder: "Paste Channel ID here",
                    value: storage.channelId,
                    onChange: (v: string) => (storage.channelId = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "Trigger Prefix",
                    placeholder: "?F",
                    value: storage.triggerPrefix,
                    onChange: (v: string) => (storage.triggerPrefix = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "Bot Display Name",
                    placeholder: "ChatterBot",
                    value: storage.botName,
                    onChange: (v: string) => (storage.botName = v),
                })
            ),
            React.createElement(
                FormSection,
                { title: "AI Brain (Google AI Studio)" },
                React.createElement(FormInput, {
                    title: "Gemini API Key",
                    placeholder: "AQ...",
                    value: storage.apiKey,
                    onChange: (v: string) => (storage.apiKey = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "Model Name",
                    placeholder: "gemini-3.5-flash-lite",
                    value: storage.model,
                    onChange: (v: string) => (storage.model = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "System Prompt (Personality)",
                    placeholder: "Define how the bot talks...",
                    value: storage.systemPrompt,
                    onChange: (v: string) => (storage.systemPrompt = v),
                })
            )
        );
    },
};
