import http from "http";
import { WebSocketServer } from "ws";

/**
 * ✅ Twilio <ConversationRelay> + OpenAI streaming -> Twilio text tokens (low latency)
 * ✅ Default TTS: Google (kad 100% kalbėtų)
 * ✅ Switch per env: TTS_PROVIDER=google|eleven
 *
 * REQUIRED ENV:
 *   OPENAI_API_KEY=...
 *
 * OPTIONAL ENV:
 *   OPENAI_MODEL=gpt-5-mini (ar koks nori)
 *   LANG=lt-LT
 *   TTS_PROVIDER=google|eleven      (default: google)
 *
 * GOOGLE (optional):
 *   GOOGLE_VOICE=...                (jei Twilio palaiko voice paramą Google provider’iui)
 *
 * ELEVEN (Twilio Relay integracija, NE tavo tiesioginis Eleven API):
 *   ELEVEN_VOICE_ID=quRnZJNH40dJXJwRHnvh
 *   ELEVEN_MODEL=turbo_v2_5         (Twilio dažnai palaiko: flash_v2_5 / turbo_v2_5 / ...)
 *   ELEVEN_SPEED=1.0
 *   ELEVEN_STABILITY=0.45
 *   ELEVEN_SIMILARITY=0.92
 */

const PORT = process.env.PORT || 8080;

// ---- AI ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

// ---- LANG / TTS ----
const LANG = process.env.LANG || "lt-LT";
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "google").toLowerCase(); // google | eleven

// Google voice (jei Twilio priima voice param, paliekam optional)
const GOOGLE_VOICE = process.env.GOOGLE_VOICE || "";

// Eleven (Relay integracija per Twilio)
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "quRnZJNH40dJXJwRHnvh";
const ELEVEN_MODEL = process.env.ELEVEN_MODEL || "turbo_v2_5";
const ELEVEN_SPEED = process.env.ELEVEN_SPEED || "1.0";
const ELEVEN_STABILITY = process.env.ELEVEN_STABILITY || "0.45";
const ELEVEN_SIMILARITY = process.env.ELEVEN_SIMILARITY || "0.92";

const WELCOME =
  "Labas, čia Vytas iš Paule.ai. Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu esi Vytas iš Paule.ai.
Kalbi lietuviškai, ramiai, trumpais sakiniais, be robotinio tono.
Tikslas: suprasti poreikį ir pasiūlyti užbookinti laiką.
Visada užbaik 1 klausimu.
Jei žmogus šaltas – pasiūlyk 30 sek paaiškinimą ir paklausk ar tęsti.
Jei klausia kainos – sakyk: "priklauso nuo apimties, užduosiu 2 klausimus ir pasakysiu intervalą".`;

// ----------------- helpers -----------------
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
  return `${ELEVEN_VOICE_ID}-${ELEVEN_MODEL}-${ELEVEN_SPEED}_${ELEVEN_STABILITY}_${ELEVEN_SIMILARITY}`;
}

function twiml(wsUrl) {
  const provider = TTS_PROVIDER === "eleven" ? "ElevenLabs" : "Google";

  // Voice atributas: vienur veikia, vienur ignoruojamas – todėl darom "optional"
  let voiceAttr = "";
  if (provider === "ElevenLabs") {
    voiceAttr = `voice="${escapeXml(elevenVoiceString())}"`;
  } else if (provider === "Google" && GOOGLE_VOICE) {
    voiceAttr = `voice="${escapeXml(GOOGLE_VOICE)}"`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      language="${escapeXml(LANG)}"
      ttsProvider="${escapeXml(provider)}"
      ${voiceAttr}
      welcomeGreeting="${escapeXml(WELCOME)}"
    />
  </Connect>
</Response>`;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

// ------------- OpenAI streaming (Responses API SSE) -------------
async function* openaiStream({ userText, callSid, signal }) {
  if (!OPENAI_API_KEY) {
    yield "Neturiu OPENAI_API_KEY. Įrašyk jį Railway Variables.";
    return;
  }

  const body = {
    model: OPENAI_MODEL,
    stream: true,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Skambutis (${callSid}). Vartotojas: ${userText}` },
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
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

    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }

        if (json?.type === "response.output_text.delta" && typeof json.delta === "string") {
          yield json.delta;
        }
        if (json?.type === "response.output_text" && typeof json.text === "string") {
          yield json.text;
        }
      }
    }
  }
}

// ----------------- HTTP server -----------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/twiml") {
    const httpBase = baseUrl(req);
    const wsUrl = toWsUrl(httpBase) + "/ws";

    console.log("[HTTP] /twiml requested",
      "| provider:", TTS_PROVIDER,
      "| wsUrl:", wsUrl
    );

    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml(wsUrl));
  }

  // root
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Use /twiml and /health");
});

// ----------------- WS server (Twilio ConversationRelay) -----------------
const wss = new WebSocketServer({ server, path: "/ws" });

// per call: allow cancel old stream (interrupt)
const sessions = new Map(); // callSid -> { busy, aborter }

function sendToken(ws, token, last) {
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
      sessions.set(ws.callSid, { busy: false, aborter: null });

      console.log("[WS] setup", ws.callSid);

      // Twilio language config message (ok jei ignoruos)
      ws.send(JSON.stringify({
        type: "language",
        ttsLanguage: LANG,
        transcriptionLanguage: LANG,
      }));
      return;
    }

    if (m.type === "prompt") {
      const callSid = ws.callSid || m.callSid || `call_${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, { busy: false, aborter: null });
      const s = sessions.get(callSid);

      // cancel previous stream if still running
      if (s.aborter) {
        try { s.aborter.abort(); } catch {}
        s.aborter = null;
      }

      const userText = (m.voicePrompt || m.transcript || m.text || "").toString().trim();
      console.log("[WS] prompt", callSid, "text:", userText);

      if (!userText) {
        sendToken(ws, "Girdžiu tylą. Ar mane girdite?", true);
        return;
      }

      // start AI stream
      const aborter = new AbortController();
      s.aborter = aborter;

      try {
        let sentAny = false;

        // Greitesnis TTS: siųsk gabaliukais ASAP
        for await (const delta of openaiStream({ userText, callSid, signal: aborter.signal })) {
          if (!delta) continue;
          sendToken(ws, delta, false);
          sentAny = true;
        }

        // end marker
        sendToken(ws, "", true);

        if (!sentAny) {
          sendToken(ws, "Supratau. Koks jūsų verslas?", true);
        }
      } catch (e) {
        const msg = (e?.name === "AbortError")
          ? "[WS] stream aborted (interruption)"
          : `[WS] AI error: ${e?.message || e}`;
        console.log(msg);

        if (e?.name !== "AbortError") {
          sendToken(ws, "Atsiprašau, įvyko klaida. Pakartokite, prašau.", true);
        }
      } finally {
        s.aborter = null;
      }
      return;
    }

    // log other events if needed:
    // console.log("[WS] event", m.type);
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE", ws.callSid || "");
    if (ws.callSid) sessions.delete(ws.callSid);
  });
});

server.listen(PORT, () => {
  console.log("Listening on", PORT);
  console.log("TTS_PROVIDER =", TTS_PROVIDER);
});
