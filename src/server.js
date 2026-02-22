import express from "express";
import crypto from "crypto";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  // Twilio
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  FALLBACK_NUMBER,

  // Base URL Railway (obligatoire pour lien SMS)
  PUBLIC_BASE_URL,

  // Calendly API
  CALENDLY_API_TOKEN,
  CALENDLY_TIMEZONE = "America/Toronto",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
  CALENDLY_LOCATION_KIND,
  CALENDLY_LOCATION_TEXT,

  // OpenAI (optionnel)
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",

  // Voice
  LANG = "fr-CA",
  TTS_VOICE = "alice",
} = process.env;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

// Sessions en mémoire (MVP)
const sessions = new Map(); // CallSid -> {state,data,updatedAt}
const pending = new Map();  // token -> {expiresAt, payload}

const SESSION_TTL_MS = 20 * 60 * 1000;
const PENDING_TTL_MS = 20 * 60 * 1000;

function now() { return Date.now(); }

function getSession(callSid) {
  const s = sessions.get(callSid);
  if (s && now() - s.updatedAt < SESSION_TTL_MS) {
    s.updatedAt = now();
    return s;
  }
  const fresh = { updatedAt: now(), state: "idle", data: {} };
  sessions.set(callSid, fresh);
  return fresh;
}
function resetSession(callSid) {
  sessions.set(callSid, { updatedAt: now(), state: "idle", data: {} });
}

function say(target, text) {
  target.say({ language: LANG, voice: TTS_VOICE }, text);
}

function pause(twiml, seconds = 1) {
  twiml.pause({ length: seconds });
}

function isHumanRequest(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("humain") ||
    t.includes("agent") ||
    t.includes("personne") ||
    t.includes("propriétaire") ||
    t.includes("proprietaire") ||
    t.includes("transf")
  );
}

function serviceFromText(text = "") {
  const t = text.toLowerCase();
  if (t.includes("homme")) return "homme";
  if (t.includes("femme")) return "femme";
  if (t.includes("non")) return "nonbinaire";
  return null;
}

function labelForService(s) {
  if (s === "homme") return "Coupe homme";
  if (s === "femme") return "Coupe femme";
  if (s === "nonbinaire") return "Coupe non binaire";
  return "Service";
}

function eventTypeUriForService(s) {
  if (s === "homme") return CALENDLY_EVENT_TYPE_URI_HOMME;
  if (s === "femme") return CALENDLY_EVENT_TYPE_URI_FEMME;
  if (s === "nonbinaire") return CALENDLY_EVENT_TYPE_URI_NONBINAIRE;
  return null;
}

function slotToFrench(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("fr-CA", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function calendlyHeaders() {
  return {
    Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function calendlyGetAvailableTimes(eventTypeUri, startIso, endIso) {
  const url =
    `https://api.calendly.com/event_type_available_times` +
    `?event_type=${encodeURIComponent(eventTypeUri)}` +
    `&start_time=${encodeURIComponent(startIso)}` +
    `&end_time=${encodeURIComponent(endIso)}`;

  const r = await fetch(url, { headers: calendlyHeaders() });
  const txt = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`Calendly available_times failed: ${r.status} ${txt}`);

  const json = JSON.parse(txt);
  return (json.collection || []).map(x => x.start_time).filter(Boolean);
}

async function calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email }) {
  const body = {
    event_type: eventTypeUri,
    start_time: startTimeIso,
    invitee: { name, email, timezone: CALENDLY_TIMEZONE },
  };

  if (CALENDLY_LOCATION_KIND) {
    body.location = { kind: CALENDLY_LOCATION_KIND };
    if (CALENDLY_LOCATION_TEXT) body.location.location = CALENDLY_LOCATION_TEXT;
  }

  const r = await fetch("https://api.calendly.com/invitees", {
    method: "POST",
    headers: calendlyHeaders(),
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly create invitee failed: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_CALLER_ID) return;
  await twilioClient.messages.create({ from: TWILIO_CALLER_ID, to, body });
}

function computeWindow7Days() {
  const start = new Date(Date.now() + 2 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function parseServiceIntent(text) {
  const local = serviceFromText(text);
  if (local) return { service: local };

  if (!openai) return { service: null };

  const system = `
Extract service from user text. Services: homme, femme, nonbinaire.
Return JSON only: {"service":"homme|femme|nonbinaire|null"}
`.trim();

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.1,
    messages: [{ role: "system", content: system }, { role: "user", content: text }],
  });

  const raw = r.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(raw); } catch { return { service: null }; }
}

// ─────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ ok: true, service: "salon-mvp-booking-sms-email", lang: LANG });
});

// ─────────────────────────────────────────────
// 1) Entrée voix (gather -> /process)
// ─────────────────────────────────────────────
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech dtmf",
    action: "/process",
    method: "POST",
    language: LANG,
    speechTimeout: "auto",
    timeout: 14,    // PLUS LONG
    numDigits: 1,
    bargeIn: true,  // plus naturel
  });

  // Message plus court + humain
  say(gather, "Allô! Bienvenue au Salon Coco.");
  pause(gather, 1);
  say(gather, "Dis-moi ce que tu veux réserver: homme, femme, ou non binaire.");
  pause(gather, 1);
  say(gather, "Tu peux aussi dire: humain.");

  // Si rien capté
  say(twiml, "Je t’ai pas entendu. On recommence.");
  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml").send(twiml.toString());
});

// ─────────────────────────────────────────────
// 2) State machine voix
// ─────────────────────────────────────────────
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid || "no-callsid";
  const from = (req.body.From || "").trim();
  const speech = (req.body.SpeechResult || "").trim();
  const digits = (req.body.Digits || "").trim();

  const session = getSession(callSid);
  console.log("[process]", { state: session.state, speech, digits, from });

  try {
    // humain prioritaire
    if (speech && isHumanRequest(speech)) {
      say(twiml, "Parfait. Je te transfère.");
      const dial = twiml.dial(TWILIO_CALLER_ID ? { callerId: TWILIO_CALLER_ID } : {});
      dial.number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    // ── ÉTAT: choose_slot (attend DTMF 1/2/3)
    if (session.state === "choose_slot") {
      const idx = parseInt(digits, 10);
      const slots = session.data.slots || [];
      if (![1, 2, 3].includes(idx) || !slots[idx - 1]) {
        say(twiml, "Appuie sur 1, 2 ou 3 pour choisir.");
        // IMPORTANT: on reste dans /process (pas /voice)
        twiml.redirect({ method: "POST" }, "/process");
        return res.type("text/xml").send(twiml.toString());
      }

      session.data.selectedSlot = slots[idx - 1];
      session.state = "collect_name";

      say(twiml, "Parfait.");
      pause(twiml, 1);
      say(twiml, "Dis-moi ton prénom et ton nom.");
      // IMPORTANT: rester dans /process
      twiml.redirect({ method: "POST" }, "/process");
      return res.type("text/xml").send(twiml.toString());
    }

    // ── ÉTAT: collect_name (attend speech)
    if (session.state === "collect_name") {
      if (!speech) {
        say(twiml, "Je t’ai pas bien entendu.");
        pause(twiml, 1);
        say(twiml, "Répète ton prénom et ton nom.");
        // IMPORTANT: rester dans /process
        twiml.redirect({ method: "POST" }, "/process");
        return res.type("text/xml").send(twiml.toString());
      }

      session.data.name = speech;

      // SMS pour email + booking final
      if (!PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL");
      if (!CALENDLY_API_TOKEN) throw new Error("Missing CALENDLY_API_TOKEN");
      if (!from) throw new Error("Missing caller From number");

      const token = crypto.randomBytes(16).toString("hex");
      const payload = {
        from,
        name: session.data.name,
        service: session.data.service,
        eventTypeUri: session.data.eventTypeUri,
        startTimeIso: session.data.selectedSlot,
      };

      pending.set(token, { expiresAt: now() + PENDING_TTL_MS, payload });

      const link = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/confirm-email/${token}`;

      await sendSms(from, `✅ Pour confirmer ton RDV, entre ton email ici: ${link}`);

      say(twiml, "Super.");
      pause(twiml, 1);
      say(twiml, "Je viens de t’envoyer un texto.");
      pause(twiml, 1);
      say(twiml, "Confirme ton courriel, et je finalise le rendez-vous.");
      pause(twiml, 1);
      say(twiml, "À bientôt!");
      twiml.hangup();

      resetSession(callSid);
      return res.type("text/xml").send(twiml.toString());
    }

    // ── ÉTAT: idle (début)
    if (!speech && !digits) {
      say(twiml, "Je t’ai pas entendu.");
      pause(twiml, 1);
      say(twiml, "Dis: coupe homme, coupe femme, ou coupe non binaire.");
      twiml.redirect({ method: "POST" }, "/voice"); // ici oui, on retourne au menu
      return res.type("text/xml").send(twiml.toString());
    }

    // Parse service
    const parsed = await parseServiceIntent(speech);
    const service = parsed.service;

    if (!service) {
      say(twiml, "OK.");
      pause(twiml, 1);
      say(twiml, "Tu veux une coupe homme, une coupe femme, ou une coupe non binaire?");
      twiml.redirect({ method: "POST" }, "/voice"); // menu
      return res.type("text/xml").send(twiml.toString());
    }

    const eventTypeUri = eventTypeUriForService(service);
    if (!eventTypeUri) throw new Error(`Missing CALENDLY_EVENT_TYPE_URI for ${service}`);

    const { startIso, endIso } = computeWindow7Days();
    const slots = await calendlyGetAvailableTimes(eventTypeUri, startIso, endIso);

    if (!slots.length) {
      say(twiml, "Je ne vois pas de disponibilités dans les prochains jours.");
      pause(twiml, 1);
      say(twiml, "Tu veux que je te transfère à un humain?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // Proposer 3 slots max (lentement)
    const top = slots.slice(0, 3);

    session.state = "choose_slot";
    session.data = {
      service,
      eventTypeUri,
      serviceLabel: labelForService(service),
      slots: top,
      selectedSlot: null,
      name: null,
    };

    say(twiml, `Parfait. Pour ${session.data.serviceLabel}, j’ai trois choix.`);
    pause(twiml, 1);
    say(twiml, `Appuie sur 1 pour ${slotToFrench(top[0])}.`);
    pause(twiml, 1);
    if (top[1]) {
      say(twiml, `Appuie sur 2 pour ${slotToFrench(top[1])}.`);
      pause(twiml, 1);
    }
    if (top[2]) {
      say(twiml, `Appuie sur 3 pour ${slotToFrench(top[2])}.`);
      pause(twiml, 1);
    }

    // IMPORTANT: on reste dans /process pour capter les digits
    twiml.redirect({ method: "POST" }, "/process");
    return res.type("text/xml").send(twiml.toString());

  } catch (e) {
    console.error("process error:", e?.message || e);
    say(twiml, "Désolé, petit pépin technique.");
    pause(twiml, 1);
    say(twiml, "Dis: humain pour être transféré.");
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());
  }
});

// ─────────────────────────────────────────────
// 3) Page SMS: entrer email -> crée le booking
// ─────────────────────────────────────────────
app.get("/confirm-email/:token", (req, res) => {
  const { token } = req.params;
  const entry = pending.get(token);
  if (!entry || entry.expiresAt < now()) {
    pending.delete(token);
    return res.status(410).send("Lien expiré. Rappelle le salon pour reprendre le rendez-vous.");
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html lang="fr-CA">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Confirmer email</title>
</head>
<body style="font-family: system-ui; max-width: 520px; margin: 40px auto; padding: 0 16px;">
  <h2>Confirmer ton courriel</h2>
  <p>Entre ton email pour finaliser le rendez-vous.</p>
  <form method="POST" action="/confirm-email/${token}">
    <input name="email" type="email" required placeholder="ex: jean@gmail.com"
      style="width:100%; padding:12px; font-size:16px; margin: 8px 0;" />
    <button type="submit" style="padding:12px 16px; font-size:16px;">Confirmer</button>
  </form>
</body>
</html>
  `);
});

app.post("/confirm-email/:token", async (req, res) => {
  const { token } = req.params;
  const entry = pending.get(token);

  if (!entry || entry.expiresAt < now()) {
    pending.delete(token);
    return res.status(410).send("Lien expiré. Rappelle le salon pour reprendre le rendez-vous.");
  }

  const email = (req.body.email || "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).send("Email invalide. Reviens en arrière et réessaie.");
  }

  const { from, name, service, eventTypeUri, startTimeIso } = entry.payload;

  try {
    await calendlyCreateInvitee({
      eventTypeUri,
      startTimeIso,
      name,
      email,
    });

    pending.delete(token);

    const when = slotToFrench(startTimeIso);
    const svcLabel = labelForService(service);

    // SMS confirmation final (best effort)
    await sendSms(from, `✅ RDV confirmé: ${svcLabel}\n🗓️ ${when}\nMerci!`);

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`
<!doctype html>
<html lang="fr-CA">
<head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Confirmé</title></head>
<body style="font-family: system-ui; max-width: 520px; margin: 40px auto; padding: 0 16px;">
  <h2>✅ Rendez-vous confirmé</h2>
  <p><strong>${svcLabel}</strong></p>
  <p>${when}</p>
  <p>Tu peux fermer cette page.</p>
</body>
</html>
    `);
  } catch (e) {
    console.error("confirm-email booking error:", e?.message || e);
    return res.status(500).send("Erreur technique lors de la confirmation. Réessaie plus tard ou rappelle le salon.");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Salon MVP stable running on ${port}`));
