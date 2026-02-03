import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

// === ENV (Railway Variables) ===
// Railway → Settings → Shared Variables:
// ELEVENLABS_API_KEY = ... (nebūtina ConversationRelay TTS atveju)
// ELEVEN_VOICE_ID    = quRnZJNH40dJXJwRHnvh
// ELEVEN_MODEL_ID    = eleven_turbo_v2_5 (Twilio TwiML to nenaudoja, paliekam ateičiai)
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "quRnZJNH40dJXJwRHnvh";

const LANG = "lt-LT";

const WELCOME =
  "Labas, čia Vytas iš Paule.ai. Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?";

const QUESTIONS = [
  "Koks jūsų verslas ir kam dažniausiai skambina klientai?",
  "Ar norit, kad agentas tik registruotų, ar ir parduotų?",
  "Kur registracija vyksta dabar — Calendly, Google Calendar ar CRM?",
  "Kokiu laiku daugiausia skambučių ir kokia įprasta trukmė?",
  "Norite, kad po skambučio klientui ateitų SMS patvirtinimas?",
];

function escapeXml(s = "") {
  return s
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

function twiml(wsUrl) {
  // Pastaba: ttsProvider default yra ElevenLabs, bet paliekam aiškiai.
  // voice — TIK voice ID. Model ID čia NENAUDOJAM. :contentReference[oaicite:2]{index=2}
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      language="${escapeXml(LANG)}"
      ttsProvider="ElevenLabs"
      voice="${escapeXml(ELEVEN_VOICE_ID)}"
      welcomeGreeting="${escapeXml(WELCOME)}"
      interruptible="any"
      debug="debugging tokens-played speaker-events"
    />
  </Connect>
</Response>`;
}

function norm(t) {
  return (t || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}
function isPrice(t) {
  return (
    t.includes("kaina") ||
    t.includes("kainos") ||
    t.includes("kiek kain") ||
    t.includes("kiek mok") ||
    t.includes("kiek eur") ||
    t.includes("kiek €")
  );
}
function isWhatIsThis(t) {
  return (
    t.includes("kas čia") ||
    t.includes("kas cia") ||
    t.includes("kas jūs") ||
    t.includes("kas jus") ||
    t.includes("kas tu") ||
    t.includes("kas per")
  );
}

function newSession() {
  return { step: 0, mode: "normal", priceStep: 0, greeted: false };
}

// 1 klausimas pabaigoje – visada
function replyFor(s, userText) {
  const t = norm(userText);

  if (!t) return "Girdžiu tylą. Ar mane girdite?";

  if (isWhatIsThis(t)) {
    s.step = Math.max(s.step, 1);
    return "Trumpai: mes įdiegiame AI skambučių agentą, kuris atsiliepia 24/7, kalba lietuviškai ir gali užregistruoti į kalendorių. Kokiame versle dirbate?";
  }

  if (isPrice(t)) {
    s.mode = "price_probe";
    s.priceStep = 0;
    return "Priklauso nuo apimties. Galiu užduoti 2 klausimus ir pasakyti kainos intervalą. Pirmas: kiek maždaug skambučių per dieną gaunate?";
  }

  if (s.mode === "price_probe") {
    if (s.priceStep === 0) {
      s.priceStep = 1;
      return "Ačiū. Antras: ar norit, kad agentas tik registruotų (booking), ar ir aktyviai parduotų telefonu?";
    }
    s.mode = "normal";
    return "Dažniausiai kaina būna nuo ~149 iki ~499 €/mėn, priklausomai nuo skambučių kiekio, scenarijų ir integracijų. Norit, kad suderinčiau trumpą 10 min demo šiandien ar rytoj?";
  }

  // Veda per 5 klausimus (vienas per atsakymą)
  if (s.step < QUESTIONS.length) {
    const q = QUESTIONS[s.step];
    s.step += 1;
    return q;
  }

  return "Super, supratau. Kada patogiausia 10–15 min demo skambučiui — šiandien ar rytoj?";
}

// ConversationRelay -> atsakymas turi būti {type:"text", token:"...", last:true} 
function sendText(ws, text) {
  ws.send(JSON.stringify({ type: "text", token: text, last: true }));
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
    console.log("[HTTP] TwiML requested. WS URL =", wsUrl);
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml(wsUrl));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Use /twiml for Twilio and /health for checks.");
});

// WS serveris ant /ws
const wss = new WebSocketServer({ server, path: "/ws" });
const sessions = new Map();

wss.on("connection", (ws, req) => {
  const ip =
    req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "unknown";
  console.log("[WS] CONNECT from", ip);

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      console.log("[WS] Non-JSON message ignored");
      return;
    }

    // Patogūs logai: matysi "debugging", "tokens-played", "speaker-events" :contentReference[oaicite:4]{index=4}
    console.log("[WS] IN:", m.type, m.callSid ? `callSid=${m.callSid}` : "");

    // 1) setup: Twilio pasako callSid ir pan. 
    if (m.type === "setup") {
      const callSid = m.callSid || `call_${Date.now()}`;
      ws.callSid = callSid;

      if (!sessions.has(callSid)) sessions.set(callSid, newSession());

      // Nustatom kalbas (galima, bet naudinga stabilumui)
      ws.send(
        JSON.stringify({
          type: "language",
          ttsLanguage: LANG,
          transcriptionLanguage: LANG,
        })
      );
      return;
    }

    // 2) prompt: Twilio siunčia vartotojo transkriptą / voicePrompt 
    if (m.type === "prompt") {
      const callSid = ws.callSid || m.callSid || `call_${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, newSession());

      const s = sessions.get(callSid);
      const userText = m.voicePrompt || m.transcript || m.text || "";

      const answer = replyFor(s, userText);
      sendText(ws, answer);
      return;
    }

    // 3) interrupt: jei caller pertraukė – galima reaguoti (nebūtina, bet tvarkinga) 
    if (m.type === "interrupt") {
      console.log("[WS] interrupt received");
      return;
    }

    // debug eventai iš Twilio (kai įjungtas debug=...) – tiesiog loginam
    if (m.type) return;
  });

  ws.on("close", () => {
    console.log("[WS] CLOSE", ws.callSid || "");
    if (ws.callSid) sessions.delete(ws.callSid);
  });

  ws.on("error", (e) => {
    console.log("[WS] ERROR", e?.message || e);
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));
