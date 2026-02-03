import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

/**
 * VYTAS (LT) — paprastas dialogo variklis be AI.
 * (Stabilu, greita, nulinė latencija; vėliau galėsim pakeist į LLM.)
 */

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running");
});

const wss = new WebSocketServer({ server, path: "/ws" });

// Sesijos per WS connection
const sessions = new Map();

function normalize(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isPriceQuestion(t) {
  return (
    t.includes("kaina") ||
    t.includes("kainos") ||
    t.includes("kiek kain") ||
    t.includes("kiek tai") ||
    t.includes("kiek mok") ||
    t.includes("kiek eur") ||
    t.includes("kiek €")
  );
}

function isWhatIsThis(t) {
  return (
    t.includes("kas cia") ||
    t.includes("kas čia") ||
    t.includes("kas jus") ||
    t.includes("kas jūs") ||
    t.includes("kas tu") ||
    t.includes("kas jūs esat") ||
    t.includes("kas esate") ||
    t.includes("kas per") ||
    t.includes("is kur") ||
    t.includes("iš kur")
  );
}

function isCold(t) {
  // labai paprasta heuristika: trumpi, atmetantys atsakymai
  return (
    t === "ne" ||
    t === "nenoriu" ||
    t === "neidomu" ||
    t === "neįdomu" ||
    t === "atsisakau" ||
    t === "nebent" ||
    t === "gal" ||
    t === "ok" ||
    t === "gerai" ||
    t === "ai" ||
    t === "nu" ||
    t.length <= 2
  );
}

function sendAssistant(ws, text) {
  ws.send(JSON.stringify({ type: "assistant", text }));
}

function getTextFromAnyEvent(msg) {
  // Tolerantiškai traukiam tekstą iš įvairių event formatų
  return (
    msg?.text ||
    msg?.transcript ||
    msg?.speech?.text ||
    msg?.payload?.text ||
    msg?.data?.text ||
    msg?.media?.transcript ||
    ""
  );
}

/**
 * VYTAS: 5 klausimai (po vieną), visada pabaigoje 1 klausimas.
 */
const QUESTIONS = [
  "Koks jūsų verslas ir kam dažniausiai skambina klientai?",
  "Ar norit, kad agentas tik registruotų, ar ir parduotų?",
  "Kur registracija vyksta dabar — Calendly, Google Calendar, CRM?",
  "Kokiu laiku daugiausia skambučių ir kokia trukmė?",
  "Norite, kad po skambučio ateitų SMS patvirtinimas?",
];

function greet(ws, s) {
  // PIRMAS SAKINYS (Vytas)
  s.greeted = true;
  s.step = 0;
  s.answers = [];
  s.mode = "normal"; // normal | price_probe
  sendAssistant(
    ws,
    "Labas, čia Vytas iš Paule.ai. Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?"
  );
}

function handleUser(ws, s, userTextRaw) {
  const userText = (userTextRaw || "").toString().trim();
  const t = normalize(userText);

  // Tyla / tuščias
  if (!t) {
    if (!s.lastWasSilence) {
      s.lastWasSilence = true;
      return sendAssistant(ws, "Girdžiu tylą. Ar mane girdite?");
    }
    return;
  }
  s.lastWasSilence = false;

  // “Kas čia?”
  if (isWhatIsThis(t)) {
    s.mode = "normal";
    return sendAssistant(
      ws,
      "Trumpai: mes įdiegiame AI skambučių agentą, kuris atsiliepia 24/7, kalba lietuviškai ir gali užregistruoti į kalendorių. Kokiame versle dirbate?"
    );
  }

  // Kainos klausimas
  if (isPriceQuestion(t)) {
    // pereinam į “price_probe”: duosim intervalą po 2 klausimų (po vieną)
    s.mode = "price_probe";
    s.priceProbeStep = 0;
    s.priceProbeAnswers = [];
    return sendAssistant(
      ws,
      'Priklauso nuo apimties. Galiu užduoti 2 klausimus ir pasakyti kainos intervalą. Pirmas: koks jūsų verslas ir kiek skambučių per dieną maždaug gaunate?'
    );
  }

  // Jei “cold” — pasiūlom 30s paaiškinimą ir 1 klausimą
  if (isCold(t) && !s.coldExplained) {
    s.coldExplained = true;
    return sendAssistant(
      ws,
      "Galiu labai trumpai per 30 sekundžių paaiškinti kaip tai veikia ir kuo naudinga. Ar tęsti?"
    );
  }

  // Jei buvo price_probe — renkam 2 atsakymus ir duodam intervalą
  if (s.mode === "price_probe") {
    s.priceProbeAnswers.push(userText);

    if (s.priceProbeStep === 0) {
      s.priceProbeStep = 1;
      return sendAssistant(
        ws,
        "Ačiū. Antras klausimas: ar norit, kad agentas tik registruotų (booking), ar ir aktyviai parduotų telefonu?"
      );
    }

    // Turim 2 atsakymus — pasakom intervalą + 1 klausimas dėl demo
    s.mode = "normal";
    const interval =
      "Dažniausiai kaina būna intervale nuo ~149 iki ~499 €/mėn, priklausomai nuo skambučių kiekio, ar yra pardavimų scenarijai, ir integracijų (kalendorius/CRM/SMS).";
    return sendAssistant(
      ws,
      `${interval} Jei norit, galim per 10 minučių susiderinti tiksliai — kada jums patogiausia trumpa demo šiandien ar rytoj?`
    );
  }

  // Normalus 5 klausimų flow
  // Jei dar nepraėjom visų 5 klausimų — saugom atsakymą ir klausiam kito
  if (s.step < QUESTIONS.length) {
    s.answers.push({ q: QUESTIONS[s.step] || null, a: userText });
    s.step += 1;

    if (s.step < QUESTIONS.length) {
      return sendAssistant(ws, QUESTIONS[s.step]);
    }

    // Po 5 klausimų — pasiūlom booking (vienas klausimas)
    return sendAssistant(
      ws,
      "Super, supratau. Jei norit, galim greit susiderinti įdiegimą ir parodyti demo. Kuri diena ir maždaug koks laikas jums patogiausia trumpam 10–15 min skambučiui?"
    );
  }

  // Jei jau viską praėjom — palaikom pokalbį ir vis tiek 1 klausimas
  return sendAssistant(
    ws,
    "Gerai, užsirašiau. Kad galėčiau patvirtinti laiką, koks geriausias jūsų el. paštas arba telefono numeris SMS patvirtinimui?"
  );
}

wss.on("connection", (ws) => {
  const s = {
    greeted: false,
    step: 0,
    answers: [],
    mode: "normal",
    lastWasSilence: false,
    coldExplained: false,
    priceProbeStep: 0,
    priceProbeAnswers: [],
  };
  sessions.set(ws, s);

  // Kai tik prisijungia — Vytas pats pradeda
  greet(ws, s);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const text = getTextFromAnyEvent(msg);
    if (text === undefined || text === null) return;

    handleUser(ws, s, text);
  });

  ws.on("close", () => {
    sessions.delete(ws);
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));
