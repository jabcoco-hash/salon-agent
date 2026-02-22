import express from "express";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  // Twilio
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  FALLBACK_NUMBER,

  // Public fallback link (si le client veut booker lui-même)
  CALENDLY_LINK,

  // Calendly API
  CALENDLY_API_TOKEN,
  CALENDLY_TIMEZONE = "America/Toronto",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
  CALENDLY_LOCATION_KIND,
  CALENDLY_LOCATION_TEXT,

  // OpenAI
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",

  // Voice
  LANG = "fr-CA",
  TTS_VOICE = "alice",
} = process.env;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ─────────────────────────────────────────────────────────────
// Simple session store (MVP) : en mémoire (OK pour MVP).
// Key: CallSid, TTL 20 min.
// ─────────────────────────────────────────────────────────────
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000;

function getSession(callSid) {
  const now = Date.now();
  const s = sessions.get(callSid);
  if (s && now - s.updatedAt < SESSION_TTL_MS) {
    s.updatedAt = now;
    return s;
  }
  const fresh = { updatedAt: now, state: "idle", data: {} };
  sessions.set(callSid, fresh);
  return fresh;
}

function resetSession(callSid) {
  sessions.set(callSid, { updatedAt: Date.now(), state: "idle", data: {} });
}

function say(target, text) {
  target.say({ language: LANG, voice: TTS_VOICE }, text);
}

function cleanText(s = "") {
  return (s || "").toString().trim();
}

function isHumanRequest(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("humain") ||
    t.includes("agent") ||
    t.includes("personne") ||
    t.includes("propriétaire") ||
    t.includes("proprietaire") ||
    t.includes("parler à quelqu") ||
    t.includes("parler a quelqu") ||
    t.includes("transf") ||
    t.includes("appelle moi")
  );
}

function isSendLinkRequest(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("envoie") ||
    t.includes("envoye") ||
    t.includes("texto") ||
    t.includes("sms") ||
    t.includes("lien") ||
    t.includes("je vais le faire") ||
    t.includes("moi-même") ||
    t.includes("moi meme")
  );
}

function looksLikeEmail(text = "") {
  const t = text.trim().toLowerCase();
  // simple regex MVP
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t);
}

// Convertit un slot ISO -> phrase FR-CA simple (timezone déjà renvoyée par Calendly)
function slotToFrench(slotIso) {
  try {
    const d = new Date(slotIso);
    // afficher local (MVP) — précision parfaite viendra plus tard
    return d.toLocaleString("fr-CA", { weekday: "long", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return slotIso;
  }
}

// ─────────────────────────────────────────────────────────────
// Calendly API helpers
// ─────────────────────────────────────────────────────────────
function calendlyHeaders() {
  return {
    "Authorization": `Bearer ${CALENDLY_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function calendlyGetAvailableTimes(eventTypeUri, startIso, endIso) {
  // GET /event_type_available_times?event_type=...&start_time=...&end_time=...
  // max 7 jours. :contentReference[oaicite:5]{index=5}
  const url =
    `https://api.calendly.com/event_type_available_times` +
    `?event_type=${encodeURIComponent(eventTypeUri)}` +
    `&start_time=${encodeURIComponent(startIso)}` +
    `&end_time=${encodeURIComponent(endIso)}`;

  const r = await fetch(url, { headers: calendlyHeaders() });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Calendly available_times failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  const collection = json?.collection || [];
  // chaque item contient start_time (ISO). :contentReference[oaicite:6]{index=6}
  return collection.map(x => x.start_time).filter(Boolean);
}

async function calendlyCreateInvitee({ eventTypeUri, startTimeUtcIso, name, email }) {
  // POST /invitees  :contentReference[oaicite:7]{index=7}
  // Minimum : event_type, start_time(UTC Z), invitee{name,email,timezone}
  const body = {
    event_type: eventTypeUri,
    start_time: startTimeUtcIso,
    invitee: {
      name,
      email,
      timezone: CALENDLY_TIMEZONE,
    },
  };

  // location est requis si ton event type a une location configurée :contentReference[oaicite:8]{index=8}
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
  if (!r.ok) {
    throw new Error(`Calendly create invitee failed: ${r.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_CALLER_ID) return;
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.messages.create({ from: TWILIO_CALLER_ID, to, body });
}

// ─────────────────────────────────────────────────────────────
// OpenAI: intention + service + préférence date
// ─────────────────────────────────────────────────────────────
async function aiParseIntent(userText) {
  if (!openai) return { intent: "unknown" };

  const system = `
Tu es un assistant téléphonique pour un salon au Québec (fr-CA).
Tu dois extraire une intention de l'utilisateur.

Services possibles:
- "homme" (coupe homme 25$)
- "femme" (coupe femme 45$)
- "nonbinaire" (coupe non binaire 250$)

Intent possibles:
- "book" : veut réserver
- "info" : question prix/horaire/adresse (déjà gérée ailleurs)
- "human" : veut parler à un humain
- "send_link" : veut un lien par SMS
- "unknown"

Pour le booking, essaie aussi d'extraire une préférence de date/heure (ex: "vendredi après-midi", "demain 14h").
Réponds STRICTEMENT en JSON:
{"intent":"book|info|human|send_link|unknown","service":"homme|femme|nonbinaire|null","date_pref":"string|null"}
`.trim();

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
  });

  const raw = r.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(raw); } catch { return { intent: "unknown" }; }
}

// Interprétation MVP de la préférence date -> une fenêtre 7 jours
function computeSearchWindow(datePrefText) {
  // MVP: si "demain" => 1 jour, sinon 7 jours à partir de maintenant
  const now = new Date();
  const start = new Date(now.getTime() + 2 * 60 * 1000); // +2 min (Calendly exige futur)
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  const t = (datePrefText || "").toLowerCase();
  if (t.includes("demain")) {
    const e = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { startIso: start.toISOString(), endIso: e.toISOString() };
  }
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function eventTypeUriForService(service) {
  if (service === "homme") return CALENDLY_EVENT_TYPE_URI_HOMME;
  if (service === "femme") return CALENDLY_EVENT_TYPE_URI_FEMME;
  if (service === "nonbinaire") return CALENDLY_EVENT_TYPE_URI_NONBINAIRE;
  return null;
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ ok: true, service: "salon-agent-booking-direct", lang: LANG });
});

// Entrée d’appel
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Gather speech + digits (digits sert quand on propose 1/2/3)
  const gather = twiml.gather({
    input: "speech dtmf",
    action: "/process",
    method: "POST",
    language: LANG,
    speechTimeout: "auto",
    timeout: 6,
    numDigits: 1,
  });

  say(gather, "Allô! Dis-moi ce que tu veux. Par exemple: coupe homme vendredi après-midi. Tu peux aussi dire: prix, horaires, adresse, ou humain.");

  twiml.redirect({ method: "POST" }, "/voice");
  res.type("text/xml").send(twiml.toString());
});

app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid || "no-callsid";
  const session = getSession(callSid);

  const speech = cleanText(req.body.SpeechResult || "");
  const digits = cleanText(req.body.Digits || "");
  const from = req.body.From;

  console.log("[process]", { callSid, state: session.state, speech, digits, from });

  try {
    // “humain” est prioritaire
    if (speech && isHumanRequest(speech)) {
      session.state = "idle";
      session.data = {};
      say(twiml, "Parfait. Je te transfère.");
      const dial = twiml.dial(TWILIO_CALLER_ID ? { callerId: TWILIO_CALLER_ID } : {});
      dial.number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    // State machine
    if (session.state === "propose_slots") {
      // on attend 1/2/3
      const idx = parseInt(digits, 10);
      const slots = session.data.slots || [];
      if (![1,2,3].includes(idx) || !slots[idx - 1]) {
        say(twiml, "Pas de stress. Appuie sur 1, 2 ou 3 pour choisir une disponibilité.");
        twiml.redirect({ method: "POST" }, "/voice");
        return res.type("text/xml").send(twiml.toString());
      }
      session.data.selectedSlot = slots[idx - 1];
      session.state = "collect_name";

      say(twiml, "Parfait. C’est quoi ton prénom?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.state === "collect_name") {
      if (!speech) {
        say(twiml, "Je t’ai pas bien entendu. C’est quoi ton prénom?");
        twiml.redirect({ method: "POST" }, "/voice");
        return res.type("text/xml").send(twiml.toString());
      }
      session.data.name = speech;
      session.state = "collect_email";

      say(twiml, "Parfait. Et ton adresse courriel?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.state === "collect_email") {
      if (!speech || !looksLikeEmail(speech)) {
        say(twiml, "OK. Dis-moi ton courriel au complet, exemple: jean point tremblay arobase gmail point com.");
        twiml.redirect({ method: "POST" }, "/voice");
        return res.type("text/xml").send(twiml.toString());
      }
      session.data.email = speech;
      session.state = "confirm_booking";

      const when = slotToFrench(session.data.selectedSlot);
      const svc = session.data.serviceLabel || "ton service";
      say(twiml, `Je confirme: ${svc}, ${when}. Appuie sur 1 pour confirmer, ou 2 pour annuler.`);
      // Gather digits
      const g = twiml.gather({ input: "dtmf", numDigits: 1, action: "/process", method: "POST" });
      // (on met pas de say ici; déjà dit)
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.state === "confirm_booking") {
      const choice = parseInt(digits, 10);
      if (choice === 2) {
        resetSession(callSid);
        say(twiml, "Parfait, on annule ça. Tu veux que je t’envoie le lien pour réserver toi-même?");
        twiml.redirect({ method: "POST" }, "/voice");
        return res.type("text/xml").send(twiml.toString());
      }
      if (choice !== 1) {
        say(twiml, "Appuie sur 1 pour confirmer, ou 2 pour annuler.");
        twiml.redirect({ method: "POST" }, "/voice");
        return res.type("text/xml").send(twiml.toString());
      }

      // Create booking
      session.state = "booking";
      const eventTypeUri = session.data.eventTypeUri;
      const startTimeUtcIso = session.data.selectedSlot; // Calendly renvoie ISO; on le passe tel quel
      const name = session.data.name;
      const email = session.data.email;

      const created = await calendlyCreateInvitee({ eventTypeUri, startTimeUtcIso, name, email });
      const inviteeUri = created?.resource?.uri || created?.uri || null;

      const when = slotToFrench(startTimeUtcIso);
      say(twiml, "C’est réservé! Je t’envoie une confirmation par texto. À bientôt!");
      twiml.hangup();

      // SMS confirmation (best effort)
      if (from) {
        const svc = session.data.serviceLabel || "Service";
        const msg = inviteeUri
          ? `✅ RDV confirmé - ${svc}\n🗓️ ${when}\n📍 ${CALENDLY_LOCATION_TEXT || "Salon"}\nDétails: ${inviteeUri}`
          : `✅ RDV confirmé - ${svc}\n🗓️ ${when}\n📍 ${CALENDLY_LOCATION_TEXT || "Salon"}`;
        await sendSms(from, msg);
      }

      resetSession(callSid);
      return res.type("text/xml").send(twiml.toString());
    }

    // ─────────────────────────────────────────
    // État idle : interpréter la demande
    // ─────────────────────────────────────────
    if (!speech && !digits) {
      say(twiml, "Je t’ai pas bien entendu. Répète, ou dis: rendez-vous.");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // Option “envoie le lien”
    if (speech && isSendLinkRequest(speech)) {
      if (from && CALENDLY_LINK) {
        await sendSms(from, `Voici le lien pour réserver: ${CALENDLY_LINK}`);
        say(twiml, "Parfait. Je viens de t’envoyer le lien par texto.");
        twiml.hangup();
        return res.type("text/xml").send(twiml.toString());
      }
      say(twiml, "Je peux te l’envoyer par texto. Dis simplement: envoie le lien.");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // FAQ locale (rapide, stable)
    const t = (speech || "").toLowerCase();
    if (t.includes("prix") || t.includes("coût") || t.includes("combien") || t.includes("tarif")) {
      say(twiml, "Nos prix: coupe homme 25 dollars. Coupe femme 45 dollars. Coupe non binaire 250 dollars.");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }
    if (t.includes("horaire") || t.includes("ouvert") || t.includes("fermé") || t.includes("heure")) {
      say(twiml, "On est ouverts lundi à vendredi 9 à 18. Samedi 10 à 14. Dimanche fermé.");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }
    if (t.includes("adresse") || t.includes("où") || t.includes("ou êtes") || t.includes("situé") || t.includes("situe")) {
      say(twiml, "On est au 123 rue des salons test, à Magog.");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // Parse AI intent (booking intelligent)
    const parsed = await aiParseIntent(speech);
    if (parsed.intent === "human") {
      say(twiml, "Parfait. Je te transfère.");
      const dial = twiml.dial(TWILIO_CALLER_ID ? { callerId: TWILIO_CALLER_ID } : {});
      dial.number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    if (parsed.intent !== "book") {
      say(twiml, "OK. Tu veux un rendez-vous, ou tu veux le lien par texto?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // Déterminer service (si pas clair, on demande)
    const service = parsed.service;
    if (!service) {
      session.state = "idle";
      say(twiml, "Parfait. Tu veux une coupe homme, femme, ou non binaire?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    const eventTypeUri = eventTypeUriForService(service);
    if (!eventTypeUri) {
      say(twiml, "Désolé, ce service n’est pas disponible. Tu veux une coupe homme, femme, ou non binaire?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    const serviceLabel =
      service === "homme" ? "Coupe homme" :
      service === "femme" ? "Coupe femme" :
      "Coupe non binaire";

    // Fenêtre recherche dispo
    const { startIso, endIso } = computeSearchWindow(parsed.date_pref);

    // Obtenir dispos Calendly
    const slots = await calendlyGetAvailableTimes(eventTypeUri, startIso, endIso);
    if (!slots.length) {
      say(twiml, "Je vois pas de disponibilités dans les prochains jours. Veux-tu que je t’envoie le lien pour choisir toi-même?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // Proposer 3 choix max
    const top = slots.slice(0, 3);
    session.state = "propose_slots";
    session.data = {
      eventTypeUri,
      service,
      serviceLabel,
      slots: top,
      selectedSlot: null,
      name: null,
      email: null,
    };

    const optionsSpoken = top
      .map((s, i) => `${i + 1}: ${slotToFrench(s)}`)
      .join(". ");

    say(twiml, `Parfait. J’ai des dispos. ${optionsSpoken}. Appuie sur 1, 2 ou 3 pour choisir.`);
    // on laisse gather digits via /voice redirect
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());

  } catch (e) {
    console.error("process error:", e?.message || e);

    // Pas de “panic transfer” : on reste pro.
    say(twiml, "Désolé, petit pépin technique. Veux-tu que je te transfère à un humain, ou que je t’envoie le lien par texto?");
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());
  }
});


app.get("/admin/calendly/event-types", async (req, res) => {
  if (req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false });
  }
  const r = await fetch("https://api.calendly.com/event_types", {
    headers: { Authorization: `Bearer ${process.env.CALENDLY_API_TOKEN}` },
  });
  const data = await r.json();
  res.json(data);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Salon agent (booking direct) running on ${port}`));
