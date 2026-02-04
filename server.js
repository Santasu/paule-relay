import http from "http";
import { WebSocketServer } from "ws";

/**
 * ✅ Twilio ConversationRelay relay server (Railway)
 * ✅ Default TTS = Google (kad 100% kalbėtų)
 * ✅ ENV switch: TTS_PROVIDER=google|eleven
 * ✅ AI switch: AI_MODE=off|openai
 * ✅ On setup: send immediate TEST so you never get "silence"
 *
 * Required ENV (Railway Variables):
 *   PORT=8080 (Railway sets automatically)
 *
 * Optional ENV:
 *   LANG=lt-LT
 *   TTS_PROVIDER=google            (default)
 *   GOOGLE_VOICE=lt-LT-Wavenet-D   (male-ish; change if you want)
 *
 *   ELEVEN_VOICE_ID=quRnZJNH40dJXJwRHnvh
 *   ELEVEN_MODEL=turbo_v2_5
 *   ELEVEN_SPEED=1.0
 *   ELEVEN_STABILITY=0.45
 *   ELEVEN_SIMILARITY=0.92
 *
 *   AI_MODE=off                    (default)
 *   OPENAI_API_KEY=...
 *   OPENAI_MODEL=gpt-5-mini        (example)
 *   SYSTEM_PROMPT=...
 */

const PORT = process.env.PORT || 8080;
const LANG = process.env.LANG || "lt-LT";

// --- TTS provider switch ---
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "google").toLowerCase(); // google | eleven
const GOOGLE_VOICE = process.env.GOOGLE_VOICE || "lt-LT-Wavenet-D";

// --- Eleven params (used only if TTS_PROVIDER=eleven) ---
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "quRnZJNH40dJXJwRHnvh";
const ELEVEN_MODEL = process.env.ELEVEN_MODEL || "turbo_v2_5";
const ELEVEN_SPEED = process.env.ELEVEN_SPEED || "1.0";
const ELEVEN_STABILITY = process.env.ELEVEN_STABILITY || "0.45";
const ELEVEN_SIMILARITY = process.env.ELEVEN_SIMILARITY || "0.92";

// --- AI switch ---
const AI_MODE = (process.env.AI_MODE || "off").toLowerCase(); // off | openai
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

const WELCOME =
  "Labas, čia Vytas iš Paule.ai. Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?";

// default prompt (can override by env)
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu esi Vytas iš Paule.ai.
Kalbi lietuviškai, ramiai, trumpais sakiniais, be robotinio tono.
Tikslas: suprasti poreikį ir pasiūlyti užbookinti laiką.
Visada užbaik 1 klausimu.
Jei žmogus šaltas: pasiūlyk 30 sekundžių paaiškinimą ir paklausk ar tęsti.
Jei klausia kainos: "priklauso nuo apimties, užduosiu 2 klausimus ir pasakysiu intervalą".`;

// --- helpers ---
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

function elevenVoiceString() {
  // Twilio Relay Eleven format: VOICEID-MODEL-SPEED_STABILITY_SIMILARITY
  return `${ELEVEN_VOICE_ID}-${ELEVEN_MODEL}-${ELEVEN_SPEED}_${ELEVEN_STABILITY}_${ELEVEN_SIMILARITY}`;
}

function twiml(wsUrl) {
  // Keep it super explicit.
  // Google: include voice to avoid "silence" edge cases.
  if (TTS_PROVIDER === "eleven") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      language="${escapeXml(LANG)}"
      ttsProvider="ElevenLabs"
      voice="${escapeXml(elevenVoiceString())}"
      welcomeGreeting="${escapeXml(WELCOME)}"
    />
  </Connect>
</Response>`;
  }

  // default: Google
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      language="${escapeXml(LANG)}"
      ttsProvider="Google"
      voice="${escapeXml(GOOGLE_VOICE)}"
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

// --- simple "Vytas" flow (no AI) ---
const QUESTIONS = [
  "Koks jūsų verslas ir kam dažniausiai skambina klientai?",
  "Ar norit, kad agentas tik registruotų, ar ir parduotų?",
  "Kur registracija vyksta dabar — Google Calendar, Calendly ar CRM?",
  "Kokiu laiku daugiausia skambučių ir kokia įprasta trukmė?",
  "Norite, kad po skambučio klientui ateitų SMS patvirtinimas?"
];

function norm(t) {
  return (t || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}
function isPrice(t) {
  return t.includes("kaina") || t.includes("kainos") || t.includes("kiek kain") || t.includes("kiek eur") || t.includes("€");
}
function isWhatIsThis(t) {
  return t.includes("kas čia") || t.includes("kas cia") || t.includes("kas jūs") || t.includes("kas jus") || t.includes("kas per");
}

function newSession() {
  return { step: 0, mode: "normal", priceStep: 0 };
}

function replyRuleBased(sess, userText) {
  const t = norm(userText);

  if (!t) return "Girdžiu tylą. Ar mane girdite?";

  if (isWhatIsThis(t)) {
    sess.step = Math.max(sess.step, 1);
    return "Trumpai: mes įdiegiame AI skambučių agentą, kuris atsiliepia 24/7, kalba lietuviškai ir gali užregistruoti į kalendorių. Kokiame versle dirbate?";
  }

  if (isPrice(t)) {
    sess.mode = "price_probe";
    sess.priceStep = 0;
    return "Priklauso nuo apimties. Galiu užduoti 2 klausimus ir pasakyti kainos intervalą. Pirmas: kiek maždaug skambučių per dieną gaunate?";
  }

  if (sess.mode === "price_probe") {
    if (sess.priceStep === 0) {
      sess.priceStep = 1;
      return "Ačiū. Antras: ar norit, kad agentas tik registruotų, ar ir aktyviai parduotų telefonu?";
    }
    sess.mode = "normal";
    return "Dažniausiai kaina būna nuo ~149 iki ~499 €/mėn, priklausomai nuo skambučių kiekio, scenarijų ir integracijų. Norit trumpą 10 min demo šiandien ar rytoj?";
  }

  if (sess.step < QUESTIONS.length) {
    const q = QUESTIONS[sess.step];
    sess.step += 1;
    return q;
  }

  return "Super, supratau. Kada patogiausia 10–15 min demo — šiandien ar rytoj?";
}

// --- OpenAI streaming (Responses API SSE) ---
async function* openaiStream({ userText, callSid }) {
  if (!OPENAI_API_KEY) {
    yield "Neturiu OPENAI_API_KEY. Įrašyk jį Railway Variables.";
    return;
  }

  const body = {
    model: OPENAI_MODEL,
    stream: true,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Skambutis (${callSid}). Klientas sako: ${userText}` }
    ]
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => "");
    yield `Klaida iš AI: ${resp.status}. ${t}`.slice(0, 350);
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

        // main delta event
        if (json?.type === "response.output_text.delta" && typeof json.delta === "string") {
          yield json.delta;
        }
      }
    }
  }
}

// --- Twilio WS reply helpers ---
function sendText(ws, text) {
  // Single-shot (works reliably)
  ws.send(JSON.stringify({ type: "text", token: text, last: true }));
}

function sendToken(ws, token, last) {
  ws.send(JSON.stringify({ type: "text", token, last: !!last }));
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/twiml") {
    const httpBase = baseUrl(req);
    const wsUrl = toWsUrl(httpBase) + "/ws";
    console.log("[HTTP] /twiml ->", wsUrl, "| TTS:", TTS_PROVIDER, "| AI:", AI_MODE);
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml(wsUrl));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Use /twiml and /health");
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: "/ws" });
const sessions = new Map(); // callSid -> session state

wss.on("connection", (ws, req) => {
  const ip = req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "unknown";
  console.log("[WS] CONNECT from", ip);

  ws.on("message", async (raw) => {
    const m = safeJsonParse(raw);
    if (!m?.type) return;

    // helpful logging (don’t flood)
    if (m.type !== "media") console.log("[WS] IN type:", m.type);

    // 1) SETUP
    if (m.type === "setup") {
      ws.callSid = m.callSid || `call_${Date.now()}`;
      sessions.set(ws.callSid, newSession());

      // Tell Twilio which language to use
      ws.send(JSON.stringify({ type: "language", ttsLanguage: LANG, transcriptionLanguage: LANG }));

      // 🔥 IMPORTANT: Immediately send a TEST phrase so there is never silence
      sendText(ws, "TEST. Aš Vytas. Jei girdi mane, pasakyk: labas.");
      console.log("[WS] setup ok:", ws.callSid);
      return;
    }

    // 2) PROMPT (user speech transcript)
    if (m.type === "prompt") {
      const callSid = ws.callSid || m.callSid || `call_${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, newSession());
      const sess = sessions.get(callSid);

      const userText =
        m.voicePrompt ||
        m.transcript ||
        m.text ||
        m?.payload?.text ||
        "";

      console.log("[WS] prompt:", callSid, "| text:", JSON.stringify(userText));

      // If AI off -> rule-based
      if (AI_MODE !== "openai") {
        const out = replyRuleBased(sess, userText);
        sendText(ws, out);
        return;
      }

      // AI on -> streaming tokens
      try {
        let sentAny = false;
        for await (const delta of openaiStream({ userText, callSid })) {
          if (!delta) continue;
          sentAny = true;
          sendToken(ws, delta, false);
        }
        // finalize
        sendToken(ws, "", true);

        if (!sentAny) sendText(ws, "Supratau. Koks jūsų verslas?");
      } catch (e) {
        console.log("[WS] AI error:", e?.message || e);
        sendText(ws, "Atsiprašau, įvyko klaida. Pakartokite trumpai, prašau.");
      }
      return;
    }
  });

  ws.on("close", () => {
    if (ws.callSid) {
      sessions.delete(ws.callSid);
      console.log("[WS] CLOSE", ws.callSid);
    } else {
      console.log("[WS] CLOSE");
    }
  });
});

server.listen(PORT, () => {
  console.log("Listening on", PORT);
});
