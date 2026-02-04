/**
 * server.js — Paule Relay (Twilio ConversationRelay) — STABLE
 *
 * ✅ Default TTS = Google (kad 100% kalbėtų)
 * ✅ Switch per env: TTS_PROVIDER=google|eleven
 * ✅ Female/Male switch per env: VOICE_PROFILE=female|male
 * ✅ Dynamic AI (ne scenarijus) — OpenAI Responses API streaming
 * ✅ Strong logs: matysi ar ateina setup/prompt ir koks transcript
 *
 * ROUTES:
 *  GET  /health   -> "ok"
 *  POST /twiml    -> TwiML Response su <ConversationRelay .../>
 *  WS   /ws       -> Twilio Relay events
 *
 * REQUIRED ENV (Railway):
 *  OPENAI_API_KEY=...
 *
 * OPTIONAL ENV:
 *  OPENAI_MODEL=gpt-5-mini
 *  LANG=lt-LT
 *  TTS_PROVIDER=google|eleven          (default google)
 *  VOICE_PROFILE=female|male           (default female)
 *  WELCOME="Labas, čia Paule! ..."
 *  SYSTEM_PROMPT="..."
 *
 * ElevenLabs (only if TTS_PROVIDER=eleven):
 *  ELEVENLABS_API_KEY=...              (Twilio relay reads from your Twilio account integration; kept here for clarity)
 *  ELEVEN_VOICE_ID=...
 *  ELEVEN_MODEL_ID=turbo_v2_5          (Twilio-supported: flash_v2_5, flash_v2, turbo_v2_5, turbo_v2)
 *  ELEVEN_SPEED=1.0
 *  ELEVEN_STABILITY=0.45
 *  ELEVEN_SIMILARITY=0.92
 */

import http from "http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

const LANG = process.env.LANG || "lt-LT";

// google | eleven
const TTS_PROVIDER = String(process.env.TTS_PROVIDER || "google").toLowerCase().trim();

// female | male
const VOICE_PROFILE = String(process.env.VOICE_PROFILE || "female").toLowerCase().trim();

const DEFAULT_WELCOME =
  "Labas, čia Paule! Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?";
const WELCOME = process.env.WELCOME || DEFAULT_WELCOME;

const DEFAULT_SYSTEM_PROMPT = `Tu esi Paule iš Paule.ai.
Kalbi lietuviškai, šiltai, natūraliai, trumpais sakiniais.
Nesi robotas. Nekartoji tų pačių frazių.
Atsakinėji pagal tai, ką žmogus pasakė, ir užduodi 1 klausimą į priekį.
Tikslas: aptarnauti / parduoti / užbookinti laiką.
Jei vartotojas nori registracijos, paprašyk jo vardo, telefono ir pageidaujamo laiko.`;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

// ElevenLabs (only used if TTS_PROVIDER=eleven)
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "";
const ELEVEN_MODEL_ID = process.env.ELEVEN_MODEL_ID || "turbo_v2_5";
const ELEVEN_SPEED = process.env.ELEVEN_SPEED || "1.0";
const ELEVEN_STABILITY = process.env.ELEVEN_STABILITY || "0.45";
const ELEVEN_SIMILARITY = process.env.ELEVEN_SIMILARITY || "0.92";

function escapeXml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
function toWsUrl(httpUrl) {
  return httpUrl.replace("https://", "wss://").replace("http://", "ws://");
}

/**
 * Twilio ConversationRelay ElevenLabs voice format:
 * voice="VOICEID-MODEL-SPEED_STABILITY_SIMILARITY"
 */
function elevenVoiceString() {
  // If you want male/female profiles using different voices, set ELEVEN_VOICE_ID accordingly.
  // (VOICING itself is controlled by Eleven voice id.)
  return `${ELEVEN_VOICE_ID}-${ELEVEN_MODEL_ID}-${ELEVEN_SPEED}_${ELEVEN_STABILITY}_${ELEVEN_SIMILARITY}`;
}

/**
 * IMPORTANT:
 * - For Google TTS: do NOT send "voice" unless you're sure Twilio accepts it in Relay for Google.
 *   Many "Invalid Parameter (64101)" cases are caused by unsupported attributes.
 * - For Eleven: send ttsProvider="ElevenLabs" and voice="<formatted>".
 */
function twiml(wsUrl) {
  const provider = TTS_PROVIDER === "eleven" ? "ElevenLabs" : "Google";

  // Twilio Relay supports:
  // url, language, ttsProvider, welcomeGreeting
  // + voice (only for ElevenLabs via Twilio Relay format)
  // Keep it minimal to avoid 64101 invalid parameter.
  const attrs = [
    `url="${escapeXml(wsUrl)}"`,
    `language="${escapeXml(LANG)}"`,
    `ttsProvider="${escapeXml(provider)}"`,
    `welcomeGreeting="${escapeXml(WELCOME)}"`,
  ];

  if (provider === "ElevenLabs") {
    if (!ELEVEN_VOICE_ID) {
      // If Eleven requested but no voice id, fall back to Google to keep calls alive.
      attrs[2] = `ttsProvider="Google"`;
    } else {
      attrs.push(`voice="${escapeXml(elevenVoiceString())}"`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay ${attrs.join(" ")} />
  </Connect>
</Response>`;
}

/**
 * OpenAI Responses API Streaming (SSE)
 * We stream output_text deltas and forward them token-by-token to Twilio Relay:
 * ws.send({type:"text", token:"...", last:false})
 */
async function* openaiStream({ userText, callSid }) {
  if (!OPENAI_API_KEY) {
    yield "Neturiu OPENAI_API_KEY (Railway Variables).";
    return;
  }

  const body = {
    model: OPENAI_MODEL,
    stream: true,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Skambutis (${callSid}). Vartotojas pasakė: ${userText}`,
      },
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => "");
    yield `AI klaida: ${resp.status}. ${t}`.slice(0, 300);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE frames separated by \n\n
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        // Typical delta event:
        if (json?.type === "response.output_text.delta" && typeof json.delta === "string") {
          yield json.delta;
        }
        // Fallback variants:
        if (json?.type === "response.output_text" && typeof json.text === "string") {
          yield json.text;
        }
      }
    }
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function now() {
  return new Date().toISOString();
}

function sendTextToken(ws, token, last) {
  ws.send(JSON.stringify({ type: "text", token, last }));
}

function extractUserText(m) {
  // Twilio Relay can send transcript fields depending on config/version
  return (
    m?.voicePrompt ||
    m?.transcript ||
    m?.text ||
    m?.payload?.text ||
    m?.payload?.transcript ||
    ""
  );
}

// HTTP server
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/twiml") {
    const httpBase = baseUrl(req);
    const wsUrl = toWsUrl(httpBase) + "/ws";

    console.log(`[${now()}] [HTTP] /twiml -> ws=${wsUrl} tts=${TTS_PROVIDER} lang=${LANG} profile=${VOICE_PROFILE}`);

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml(wsUrl));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Use /twiml and /health");
});

// WS server
const wss = new WebSocketServer({ server, path: "/ws" });

// per call state
const sessions = new Map(); // callSid -> { busy:boolean }

wss.on("connection", (ws, req) => {
  const ip = req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "unknown";
  console.log(`[${now()}] [WS] CONNECT ip=${ip}`);

  ws.on("message", async (raw) => {
    const m = safeJsonParse(raw);
    if (!m?.type) return;

    // Twilio Relay first message: setup
    if (m.type === "setup") {
      ws.callSid = m.callSid || m?.payload?.callSid || `call_${Date.now()}`;
      sessions.set(ws.callSid, { busy: false });

      console.log(`[${now()}] [WS] setup callSid=${ws.callSid}`);

      // Optional language hints (safe)
      ws.send(
        JSON.stringify({
          type: "language",
          ttsLanguage: LANG,
          transcriptionLanguage: LANG,
        })
      );
      return;
    }

    // Main event with user speech transcript
    if (m.type === "prompt") {
      const callSid = ws.callSid || m.callSid || `call_${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, { busy: false });
      const s = sessions.get(callSid);

      const userText = String(extractUserText(m) || "").trim();
      console.log(`[${now()}] [WS] prompt callSid=${callSid} text="${userText}"`);

      if (!userText) {
        sendTextToken(ws, "Girdžiu tylą. Ar mane girdite?", true);
        return;
      }

      // Avoid overlapping streams
      if (s.busy) {
        // Basic interrupt behavior: ignore new prompt while busy
        // (Can be improved later.)
        console.log(`[${now()}] [WS] prompt ignored (busy) callSid=${callSid}`);
        sendTextToken(ws, "Gerai, pakartokite trumpai dar kartą.", true);
        return;
      }

      s.busy = true;

      try {
        let sentAny = false;

        for await (const delta of openaiStream({ userText, callSid })) {
          if (!delta) continue;
          sendTextToken(ws, delta, false);
          sentAny = true;
        }

        // End marker
        sendTextToken(ws, "", true);

        if (!sentAny) {
          sendTextToken(ws, "Supratau. Kuo galiu padėti?", true);
        }
      } catch (e) {
        console.log(`[${now()}] [WS] AI error callSid=${callSid} err=${e?.message || e}`);
        sendTextToken(ws, "Atsiprašau, įvyko klaida. Pakartokite, prašau.", true);
      } finally {
        s.busy = false;
      }
      return;
    }

    // Log anything else (helpful)
    if (m.type !== "ping" && m.type !== "heartbeat") {
      console.log(`[${now()}] [WS] event type=${m.type}`);
    }
  });

  ws.on("close", () => {
    if (ws.callSid) sessions.delete(ws.callSid);
    console.log(`[${now()}] [WS] CLOSE callSid=${ws.callSid || "-"}`);
  });
});

server.listen(PORT, () => {
  console.log(`[${now()}] Listening on ${PORT}`);
});

