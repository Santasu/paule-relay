import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

// ====== AI (OpenAI) ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

// ====== LANG ======
// Jei lt-LT meta 64101 / invalid, testui uždėk en-US ir pasitikrink, kad gyva.
// Tada bandysi grąžint lt-LT.
const TRANSCRIBE_LANG = process.env.TRANSCRIBE_LANG || "en-US";
const TTS_LANG = process.env.TTS_LANG || "en-US";

// ====== TTS provider switch ======
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "google").toLowerCase(); // google | eleven

// --- Google TTS (per Twilio ConversationRelay) ---
// Twilio Google voice format dažnai būna: "Google.<voiceName>"
// Pvz: Google.en-US-Standard-C, Google.en-US-Wavenet-D, ir pan.
const GOOGLE_VOICE = process.env.GOOGLE_VOICE || "Google.en-US-Standard-C";

// --- ElevenLabs (per Twilio ConversationRelay provider) ---
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "";     // pvz: quRnZJNH40dJXJwRHnvh
const ELEVEN_MODEL = process.env.ELEVEN_MODEL || "turbo_v2_5"; // Twilio palaikomi model strings (turbo_v2_5, flash_v2_5, etc.)
const ELEVEN_SPEED = process.env.ELEVEN_SPEED || "1.0";
const ELEVEN_STABILITY = process.env.ELEVEN_STABILITY || "0.45";
const ELEVEN_SIMILARITY = process.env.ELEVEN_SIMILARITY || "0.92";

const WELCOME =
  process.env.WELCOME ||
  "Labas, čia Vytas iš Paule.ai. Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu esi Vytas iš Paule.ai.
Kalbi lietuviškai (jei klientas kalba lietuviškai), trumpais sakiniais, natūraliai.
Tikslas: suprasti poreikį ir pasiūlyti užbookinti laiką.
Visada pabaigoje užduok 1 klausimą.
Jei klausia kainos: "priklauso nuo apimties – užduosiu 2 klausimus ir pasakysiu intervalą".`;

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

// Twilio ConversationRelay ElevenLabs voice format (pagal Twilio pavyzdžius):
// voice="VOICEID-MODEL-SPEED_STABILITY_SIMILARITY"
function elevenVoiceString() {
  return `${ELEVEN_VOICE_ID}-${ELEVEN_MODEL}-${ELEVEN_SPEED}_${ELEVEN_STABILITY}_${ELEVEN_SIMILARITY}`;
}

function buildConversationRelayAttrs(wsUrl) {
  // Twilio invalid parameter dažniausiai būna dėl:
// - neteisingo ttsProvider (case/leidžiamos reikšmės)
// - trūkstamo voice (pvz. Google)
// - neteisingos kalbos reikšmės

  if (TTS_PROVIDER === "eleven") {
    if (!ELEVEN_VOICE_ID) {
      // jei nepaduotas voice id – geriau fallback į google, kad bent kalbėtų
      return {
        ttsProvider: "google",
        voice: GOOGLE_VOICE,
      };
    }
    return {
      ttsProvider: "ElevenLabs",
      voice: elevenVoiceString(),
    };
  }

  // Default: google
  return {
    ttsProvider: "google",
    voice: GOOGLE_VOICE,
  };
}

function twiml(wsUrl) {
  const { ttsProvider, voice } = buildConversationRelayAttrs(wsUrl);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      transcriptionLanguage="${escapeXml(TRANSCRIBE_LANG)}"
      ttsLanguage="${escapeXml(TTS_LANG)}"
      ttsProvider="${escapeXml(ttsProvider)}"
      voice="${escapeXml(voice)}"
      welcomeGreeting="${escapeXml(WELCOME)}"
    />
  </Connect>
</Response>`;
}

function twimlFallback() {
  // Jei Relay nepasileidžia, bent pasakys balsu „fallback“
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Atsiprasau, siuo metu vyksta konfiguracijos klaida. Pabandykite veliau.</Say>
</Response>`;
}

// --- OpenAI Streaming (Responses API SSE) ---
async function* openaiStream({ userText, callSid }) {
  if (!OPENAI_API_KEY) {
    yield "Trūksta OPENAI_API_KEY (Railway Variables).";
    return;
  }

  const body = {
    model: OPENAI_MODEL,
    stream: true,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Skambutis (${callSid}). Vartotojas pasakė: ${userText}` },
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
    yield `AI klaida: ${resp.status}. ${t}`.slice(0, 400);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");

  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;

        let json;
        try { json = JSON.parse(data); } catch { continue; }

        if (json?.type === "response.output_text.delta" && typeof json.delta === "string") {
          yield json.delta;
        } else if (json?.type === "response.output_text" && typeof json.text === "string") {
          yield json.text;
        }
      }
    }
  }
}

function safeJsonParse(raw) {
  try { return JSON.parse(raw.toString()); } catch { return null; }
}

// ====== HTTP server ======
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/twiml") {
    const httpBase = baseUrl(req);
    const wsUrl = toWsUrl(httpBase) + "/ws";
    console.log("[HTTP] /twiml ->", wsUrl, "TTS_PROVIDER:", TTS_PROVIDER);
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml(wsUrl));
  }

  if (req.url === "/twiml-fallback") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twimlFallback());
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Use /twiml, /twiml-fallback and /health");
});

// ====== WS server (Twilio ConversationRelay) ======
const wss = new WebSocketServer({ server, path: "/ws" });

const sessions = new Map(); // callSid -> { busy }

function sendTextToken(ws, token, last) {
  ws.send(JSON.stringify({ type: "text", token, last }));
}

wss.on("connection", (ws, req) => {
  const ip = req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "unknown";
  console.log("[WS] CONNECT from", ip);

  ws.on("message", async (raw) => {
    const m = safeJsonParse(raw);
    if (!m?.type) return;

    if (m.type === "setup") {
      ws.callSid = m.callSid || `call_${Date.now()}`;
      sessions.set(ws.callSid, { busy: false });
      console.log("[WS] setup", ws.callSid);
      return;
    }

    if (m.type === "prompt") {
      const callSid = ws.callSid || m.callSid || `call_${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, { busy: false });
      const s = sessions.get(callSid);
      s.busy = true;

      const userText = m.voicePrompt || m.transcript || m.text || m?.payload?.text || "";
      console.log("[WS] prompt", callSid, "text:", userText);

      if (!String(userText || "").trim()) {
        sendTextToken(ws, "Girdžiu tylą. Ar mane girdite?", true);
        s.busy = false;
        return;
      }

      try {
        let sentAny = false;
        for await (const delta of openaiStream({ userText, callSid })) {
          if (!delta) continue;
          sendTextToken(ws, delta, false);
          sentAny = true;
        }
        sendTextToken(ws, "", true);

        if (!sentAny) sendTextToken(ws, "Supratau. Koks jūsų verslas?", true);
      } catch (e) {
        console.log("[WS] AI error", e?.message || e);
        sendTextToken(ws, "Atsiprašau, įvyko klaida. Pakartokite, prašau.", true);
      } finally {
        s.busy = false;
      }
    }
  });

  ws.on("close", () => {
    if (ws.callSid) sessions.delete(ws.callSid);
    console.log("[WS] CLOSE", ws.callSid || "");
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));

