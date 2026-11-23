import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";

const { ScrollView } = ReactNative;
const { FormSection, FormInput, FormSwitchRow, FormDivider } = Forms;

const MessageActions = findByProps("sendBotMessage", "receiveMessage");
const UserStore = findByStoreName("UserStore");

storage.enabled ??= true;
storage.apiKey ??= "";
storage.channelId ??= "";
storage.triggerPrefix ??= "?F";
storage.botName ??= "ChatterBot";
storage.systemPrompt ??=
    "You are a friendly, casual Discord chatter bot talking 1-on-1 with a user. Keep replies short (1-3 sentences), natural, and conversational, like a normal Discord user or chatbot. You have no idea anyone else exists—just reply directly to what the user says.";

let chatHistory: { role: "user" | "model"; parts: { text: string }[] }[] = [];

function injectLocalBotMessage(channelId: string, text: string) {
    if (!MessageActions?.receiveMessage) return;

    MessageActions.receiveMessage(channelId, {
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
    });
}

async function generateBotReply(channelId: string) {
    if (!storage.apiKey) return;

    try {
        const key = storage.apiKey.trim();
        const response = await fetch(
            `https://googleapis.com{key}`,
            {
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
            }
        );

        const data = await response.json();
        const firstCandidate = data?.candidates?.at(0);
        const firstPart = firstCandidate?.content?.parts?.at(0);
        const reply = firstPart?.text?.trim();

        if (reply) {
            chatHistory.push({ role: "model", parts: [{ text: reply }] });
            if (chatHistory.length > 16) chatHistory.shift();

            injectLocalBotMessage(channelId, reply);
        }
    } catch (err) {
        console.error("[aibotschizo] Failed to fetch AI reply:", err);
    }
}

function onMessageCreate(event: any) {
    if (!storage.enabled) return;
    if (event.optimistic) return;

    const msg = event.message;
    if (!msg || !msg.content) return;

    // Only work in the target Group DM / Channel
    if (storage.channelId && msg.channel_id !== storage.channelId.trim()) return;

    // Completely ignore everyone else (including our own fake bot messages)
    const currentUser = UserStore.getCurrentUser();
    if (msg.author?.id !== currentUser?.id) return;

    // Only trigger if message starts with the prefix (default: ?F)
    const prefix = (storage.triggerPrefix ?? "?F").trim();
    if (prefix && !msg.content.startsWith(prefix)) return;

    // Strip the "?F" prefix so the bot just sees normal conversation
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

        return (
            <ScrollView style={{ flex: 1 }}>
                <FormSection title="General">
                    <FormSwitchRow
                        label="Enable aibotschizo"
                        subLabel="Replies locally when you start a message with the prefix"
                        value={storage.enabled}
                        onValueChange={(v: boolean) => (storage.enabled = v)}
                    />
                    <FormDivider />
                    <FormInput
                        title="Target Group DM / Channel ID"
                        placeholder="Paste Channel ID here"
                        value={storage.channelId}
                        onChange={(v: string) => (storage.channelId = v)}
                    />
                    <FormDivider />
                    <FormInput
                        title="Trigger Prefix"
                        placeholder="?F"
                        value={storage.triggerPrefix}
                        onChange={(v: string) => (storage.triggerPrefix = v)}
                    />
                    <FormDivider />
                    <FormInput
                        title="Bot Display Name"
                        placeholder="ChatterBot"
                        value={storage.botName}
                        onChange={(v: string) => (storage.botName = v)}
                    />
                </FormSection>

                <FormSection title="AI Brain (Google AI Studio)">
                    <FormInput
                        title="Gemini API Key"
                        placeholder="AIza..."
                        value={storage.apiKey}
                        onChange={(v: string) => (storage.apiKey = v)}
                    />
                    <FormDivider />
                    <FormInput
                        title="System Prompt (Personality)"
                        placeholder="Define how the bot talks..."
                        value={storage.systemPrompt}
                        onChange={(v: string) => (storage.systemPrompt = v)}
                    />
                </FormSection>
            </ScrollView>
        );
    },
};
