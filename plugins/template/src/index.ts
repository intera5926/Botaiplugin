import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

const { ScrollView } = ReactNative;
const { FormSection, FormInput, FormSwitchRow, FormDivider } = Forms;

const MessageActions = findByProps("sendBotMessage", "receiveMessage");
const UserStore = findByStoreName("UserStore");

storage.enabled ??= true;
storage.channelId ??= "";
storage.triggerPrefix ??= "?F";
storage.botName ??= "ChatterBot";
storage.endpointUrl ??= "http://127.0.0";
storage.modelName ??= "qwen2.5:7b";
storage.apiKey ??= "";
storage.systemPrompt ??=
    "You are a friendly, casual Discord chatter bot talking 1-on-1 with a user. Keep replies short (1-3 sentences), natural, and conversational, like a normal Discord user or chatbot. You have no idea anyone else exists—just reply directly to what the user says.";

let chatHistory: { role: "user" | "assistant"; content: string }[] = [];

function trimHistoryChunked() {
    // Let history grow to 16 messages, then drop the oldest 6 in one batch.
    // This keeps the prompt prefix identical across 6 turns so llama.cpp reuses its KV cache.
    if (chatHistory.length > 16) {
        chatHistory.splice(0, 6);
    }
}

function generateSnowflake(): string {
    const discordEpoch = 1420070400000n;
    const timestamp = BigInt(Date.now()) - discordEpoch;
    const randomBits = BigInt(Math.floor(Math.random() * 4194303));
    return ((timestamp << 22n) | randomBits).toString();
}

function injectLocalBotMessage(channelId: string, text: string) {
    const fakeMsg = {
        id: generateSnowflake(),
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

function postXHR(
    url: string,
    headers: Record<string, string>,
    bodyStr: string
): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url, true);
        for (const [k, v] of Object.entries(headers)) {
            xhr.setRequestHeader(k, v);
        }
        xhr.timeout = 30000;

        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
        xhr.onerror = () => reject(new Error(`XHR error (status=${xhr.status})`));
        xhr.ontimeout = () => reject(new Error("Request timed out (30s)"));
        xhr.send(bodyStr);
    });
}

async function generateBotReply(channelId: string) {
    const url = (storage.endpointUrl || "http://127.0.0").trim();
    const model = (storage.modelName || "qwen2.5:7b").trim();
    const key = (storage.apiKey || "").trim();

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (key) {
        headers["Authorization"] = `Bearer ${key}`;
    }

    try {
        const res = await postXHR(
            url,
            headers,
            JSON.stringify({
                model,
                messages: [
                    { role: "system", content: storage.systemPrompt },
                    ...chatHistory,
                ],
                max_tokens: 150,
                temperature: 0.85,
                stream: false,
            })
        );

        let data: any = null;
        try {
            data = JSON.parse(res.text);
        } catch {}

        if (res.status < 200 || res.status >= 300) {
            const errMsg = data?.error?.message || `HTTP ${res.status}: ${res.text.slice(0, 100)}`;
            showToast(`AI Error: ${errMsg}`);
            return;
        }

        const firstChoice = data?.choices?.at(0);
        const reply = firstChoice?.message?.content?.trim();

        if (reply) {
            chatHistory.push({ role: "assistant", content: reply });
            trimHistoryChunked();
            injectLocalBotMessage(channelId, reply);
        } else {
            showToast("AI returned empty reply");
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

    chatHistory.push({ role: "user", content: cleanText });
    trimHistoryChunked();

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
                { title: "AI Endpoint (Localhost or OpenAI-Compatible)" },
                React.createElement(FormInput, {
                    title: "API Endpoint URL",
                    placeholder: "http://127.0.0",
                    value: storage.endpointUrl,
                    onChange: (v: string) => (storage.endpointUrl = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "Model Name",
                    placeholder: "qwen2.5:7b",
                    value: storage.modelName,
                    onChange: (v: string) => (storage.modelName = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "API Key (Leave blank for localhost)",
                    placeholder: "Optional",
                    value: storage.apiKey,
                    onChange: (v: string) => (storage.apiKey = v),
                }),
                React.createElement(FormDivider, null),
                React.createElement(FormInput, {
                    title: "System Prompt",
                    placeholder: "Define how the bot talks...",
                    value: storage.systemPrompt,
                    onChange: (v: string) => (storage.systemPrompt = v),
                })
            )
        );
    },
};
