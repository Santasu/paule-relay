import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

// LT kalbai: naudok Google (Twilio viduje).
// ElevenLabs per ConversationRelay reikalauja language="en-US" (todėl LT neveiks).
const LANG = "lt-LT";
const TTS_PROVIDER = process.env.TTS_PROVIDER || "Google"; // palik "Google"

// Jei nori – gali bandyti nurodyti Google voice (nebūtina).
// Kai kuriuose setupuose užtenka ttsProvider + language.
// Pvz: "lt-LT-Standard-B" (kaip tavo Twilio UI mappinge).
const GOOGLE_VOICE = process.env.GOOGLE_VOICE || ""; // optional

const WELCOME =
  "Labas, čia Vytas iš Paule.ai. Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?";

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

function twiml(wsUrl) {
  const voiceAttr = GOOGLE_VOICE ? ` voice="${escapeXml(GOOGLE_VOICE)}"` : "";
  // NOTE: TwiML matysi naršyklėje kaip XML – tai normalu.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${escapeXml(wsUrl)}"
      language="${escapeXml(LANG)}"
      ttsProvider="${escapeXml(TTS_PROVIDER)}"${voiceAttr}
      welcomeGreeting="${escapeXml(WELCOME)}"
    />
  </Connect>
</Response>`;
}

// ---- VYTAS dialog logika ----
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

const QUESTIONS = [
  "Koks jūsų verslas ir kam dažniausiai skambina klientai?",
  "Ar norit, kad agentas tik registruotų, ar ir parduotų?",
  "Kur registracija vyksta dabar — Calendly, Google Calendar ar CRM?",
  "Kokiu laiku daugiausia skambučių ir kokia įprasta trukmė?",
  "Norite, kad po skambučio klientui ateitų SMS patvirtinimas?"
];

function newSession() {
  return { step: 0, mode: "normal", priceStep: 0 };
}

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
    return "Dažniausiai kaina būna maždaug nuo 149 iki 499 eurų per mėnesį — priklauso nuo skambučių kiekio, scenarijų ir integracijų. Norit, kad suderintume trumpą 10 minučių demo šiandien ar rytoj?";
  }

  // 5 klausimų kelias
  if (s.step < QUESTIONS.length) {
    const q = QUESTIONS[s.step];
    s.step += 1;
    return q;
  }

  return "Super, supratau. Kada patogiausia 10–15 min demo skambučiui — šiandien ar rytoj?";
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (req.url === "/twiml") {
    const httpBase = baseUrl(req);
    const wsUrl = toWsUrl(httpBase) + "/ws";
    console.log("TwiML requested. WS URL:", wsUrl);
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml(wsUrl));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Use /twiml for Twilio and /health for checks.");
});

// ---- WebSocket (ConversationRelay) ----
const wss = new WebSocketServer({ server, path: "/ws" });
const sessions = new Map();

function sendText(ws, text) {
  // Twilio ConversationRelay expects text tokens messages like this. :contentReference[oaicite:6]{index=6}
  ws.send(JSON.stringify({ type: "text", token: text, last: true }));
}

wss.on("connection", (ws, req) => {
  console.log(
    "WS CONNECT from:",
    req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "unknown"
  );

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Tipiniai eventai: setup, prompt. :contentReference[oaicite:7]{index=7}
    if (m.type === "setup") {
      ws.callSid = m.callSid || `call_${Date.now()}`;
      sessions.set(ws.callSid, newSession());

      // (Nebūtina, bet naudinga) nurodom kalbas
      ws.send(
        JSON.stringify({
          type: "language",
          ttsLanguage: LANG,
          transcriptionLanguage: LANG
        })
      );
      return;
    }

    if (m.type === "prompt") {
      const callSid = ws.callSid || m.callSid || `call_${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, newSession());

      const userText = m.voicePrompt || m.transcript || m.text || "";
      const s = sessions.get(callSid);

      const out = replyFor(s, userText);
      sendText(ws, out);
      return;
    }
  });

  ws.on("close", () => {
    console.log("WS CLOSE", ws.callSid || "");
    if (ws.callSid) sessions.delete(ws.callSid);
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));
