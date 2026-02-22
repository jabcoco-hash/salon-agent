import express from "express";
import crypto from "crypto";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  FALLBACK_NUMBER,
  PUBLIC_BASE_URL,
  CALENDLY_API_TOKEN,
  CALENDLY_TIMEZONE = "America/Toronto",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
  CALENDLY_LOCATION_KIND,
  CALENDLY_LOCATION_TEXT,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  LANG = "fr-CA",
  TTS_VOICE = "alice",
} = process.env;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

const sessions = new Map();
const pending = new Map();
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
  return t.includes("humain") || t.includes("agent") || t.includes("personne") || t.includes("transf");
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
      weekday: "long", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function calendlyHeaders() {
  return {
    Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function calendlyGetAvailableTimes(eventTypeUri, startIso, endIso) {
  const url = `https://api.calendly.com/event_type_available_times?event_type=${encodeURIComponent(eventTypeUri)}&start_time=${encodeURIComponent(startIso)}&end_time=${encodeURIComponent(endIso)}`;
  const r = await fetch(url, { headers: calendlyHeaders() });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Calendly avail error: ${r.status} ${txt}`);
  const json = JSON.parse(txt);
  return (json.collection || []).map(x => x.start_time).filter(Boolean);
}

async function calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email }) {
  const body = {
    event_type: eventTypeUri,
    start_time: startTimeIso,
    invitee: { name, email, timezone: CALENDLY_TIMEZONE }
  };

  // Sécurité renforcée pour éviter l'erreur 400
  if (CALENDLY_LOCATION_KIND && CALENDLY_LOCATION_KIND !== "" && CALENDLY_LOCATION_KIND !== "undefined") {
    body.location = { kind: CALENDLY_LOCATION_KIND };
    if (CALENDLY_LOCATION_TEXT) body.location.location = CALENDLY_LOCATION_TEXT;
  }

  const r = await fetch("https://api.calendly.com/invitees", {
    method: "POST",
    headers: calendlyHeaders(),
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly failed: ${r.status} ${JSON.stringify(json)}`);
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
  const t = text.toLowerCase();
  let service = null;
  if (t.includes("homme")) service = "homme";
  else if (t.includes("femme")) service = "femme";
  else if (t.includes("non")) service = "nonbinaire";

  if (service) return { service };
  if (!openai) return { service: null };

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: "system", content: 'JSON only: {"service":"homme|femme|nonbinaire|null"}' }, { role: "user", content: text }],
    response_format: { type: "json_object" }
  });
  return JSON.parse(r.choices[0].message.content);
}

// Routes
app.get("/", (req, res) => res.json({ ok: true }));

app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({ input: "speech", action: "/process", language: LANG, speechTimeout: "auto" });
  say(gather, "Allô! Bienvenue au Salon Coco. Coupe homme, femme, ou non binaire?");
  res.type("text/xml").send(twiml.toString());
});

app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const speech = (req.body.SpeechResult || "").trim();
  const digits = req.body.Digits;
  const session = getSession(callSid);

  try {
    if (speech && isHumanRequest(speech)) {
      say(twiml, "Je vous transfère.");
      twiml.dial({ callerId: TWILIO_CALLER_ID }).number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.state === "choose_slot") {
      const idx = parseInt(digits, 10);
      const slots = session.data.slots || [];
      if (![1, 2, 3].includes(idx) || !slots[idx - 1]) {
        const g = twiml.gather({ input: "dtmf", numDigits: 1, action: "/process" });
        say(g, "Choix invalide. Appuyez sur 1, 2 ou 3.");
        return res.type("text/xml").send(twiml.toString());
      }
      session.data.selectedSlot = slots[idx - 1];
      session.state = "collect_name";
      const g = twiml.gather({ input: "speech", action: "/process", language: LANG });
      say(g, "C'est noté. Quel est votre prénom et votre nom ?");
      return res.type("text/xml").send(twiml.toString());
    }

    if (session.state === "collect_name") {
      if (!speech) {
        const g = twiml.gather({ input: "speech", action: "/process", language: LANG });
        say(g, "Je n'ai pas entendu. Votre nom svp?");
        return res.type("text/xml").send(twiml.toString());
      }
      session.data.name = speech;
      const token = crypto.randomBytes(16).toString("hex");
      pending.set(token, {
        expiresAt: now() + PENDING_TTL_MS,
        payload: { from, name: speech, service: session.data.service, eventTypeUri: session.data.eventTypeUri, startTimeIso: session.data.selectedSlot }
      });
      const link = `${PUBLIC_BASE_URL}/confirm-email/${token}`;
      await sendSms(from, `Lien de confirmation : ${link}`);
      say
