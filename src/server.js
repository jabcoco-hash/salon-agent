import express from "express";
import crypto from "crypto";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Variables d'environnement ────────────────────────────────────────────────
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
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  LANG = "fr-CA",
  TTS_VOICE = "alice",
} = process.env;

// ─── Clients ──────────────────────────────────────────────────────────────────
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ─── Sessions en mémoire ──────────────────────────────────────────────────────
const sessions = new Map();
const pending  = new Map();
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

// ─── Helpers TwiML ────────────────────────────────────────────────────────────
function say(target, text) {
  target.say({ language: LANG, voice: TTS_VOICE }, text);
}

function isHumanRequest(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("humain") || t.includes("agent") ||
    t.includes("personne") || t.includes("transf")
  );
}

// ─── Helpers métier ───────────────────────────────────────────────────────────
function labelForService(s) {
  if (s === "homme")      return "Coupe homme";
  if (s === "femme")      return "Coupe femme";
  if (s === "nonbinaire") return "Coupe non binaire";
  return "Service";
}

function eventTypeUriForService(s) {
  if (s === "homme")      return CALENDLY_EVENT_TYPE_URI_HOMME;
  if (s === "femme")      return CALENDLY_EVENT_TYPE_URI_FEMME;
  if (s === "nonbinaire") return CALENDLY_EVENT_TYPE_URI_NONBINAIRE;
  return null;
}

function slotToFrench(iso) {
  try {
    return new Date(iso).toLocaleString("fr-CA", {
      weekday: "long", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit",
      timeZone: CALENDLY_TIMEZONE,
    });
  } catch { return iso; }
}

function publicBase() {
  return (PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

// ─── Calendly API v2 ──────────────────────────────────────────────────────────
function calendlyHeaders() {
  return {
    Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * GET /event_type_available_times  (API v2 — pas legacy)
 * Fenêtre max = 7 jours par appel.
 */
async function calendlyGetAvailableTimes(eventTypeUri, startIso, endIso) {
  const url =
    `https://api.calendly.com/event_type_available_times` +
    `?event_type=${encodeURIComponent(eventTypeUri)}` +
    `&start_time=${encodeURIComponent(startIso)}` +
    `&end_time=${encodeURIComponent(endIso)}`;

  const r = await fetch(url, { headers: calendlyHeaders() });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Calendly avail error: ${r.status} ${txt}`);
  return (JSON.parse(txt).collection || []).map(x => x.start_time).filter(Boolean);
}

/**
 * GET /event_types/{uuid}  (API v2)
 * Récupère la configuration de location de l'event type.
 * Nécessaire pour construire le bon objet location dans POST /invitees.
 *
 * Règle officielle Calendly (doc: /schedule-events-with-ai-agents) :
 *   - Event type SANS location  → NE PAS envoyer le champ location
 *   - Event type AVEC location  → location.kind obligatoire
 *     - "physical"       = In-person (adresse physique)
 *     - "zoom_conference"= Zoom
 *     - "google_conference", "teams_conference", etc.
 *     - "ask_invitee"    = l'invité fournit son adresse → location.location requis
 *     - "outbound_call"  = salon appelle l'invité → location.location = numéro
 */
async function calendlyGetEventTypeLocation(eventTypeUri) {
  const uuid = eventTypeUri.split("/").pop();
  const r = await fetch(`https://api.calendly.com/event_types/${uuid}`, {
    headers: calendlyHeaders(),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly event_type error: ${r.status} ${JSON.stringify(json)}`);

  const locations = json.resource?.locations;
  return Array.isArray(locations) && locations.length > 0 ? locations[0] : null;
}

/**
 * POST /invitees  — Scheduling API v2
 * Construit dynamiquement le bon objet location selon la config de l'event type.
 */
async function calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email }) {
  // Récupérer la location configurée sur l'event type
  const locationConfig = await calendlyGetEventTypeLocation(eventTypeUri);

  const body = {
    event_type: eventTypeUri,
    start_time: startTimeIso,
    invitee: { name, email, timezone: CALENDLY_TIMEZONE },
  };

  if (locationConfig) {
    // Toujours inclure kind quand une location existe
    body.location = { kind: locationConfig.kind };
    // Inclure location.location quand l'API l'exige (adresse, URL, numéro)
    if (locationConfig.location) {
      body.location.location = locationConfig.location;
    }
  }
  // Si locationConfig est null → on n'envoie pas le champ location (règle Calendly)

  console.log("BODY ENVOYÉ À CALENDLY:", JSON.stringify(body));

  const r = await fetch("https://api.calendly.com/invitees", {
    method: "POST",
    headers: calendlyHeaders(),
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly failed: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

// ─── Twilio SMS ───────────────────────────────────────────────────────────────
async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_CALLER_ID) return;
  await twilioClient.messages.create({ from: TWILIO_CALLER_ID, to, body });
}

// ─── Fenêtre de disponibilité ─────────────────────────────────────────────────
function computeWindow7Days() {
  const start = new Date(Date.now() + 2 * 60 * 1000);
  const end   = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// ─── Détection intent service ─────────────────────────────────────────────────
async function parseServiceIntent(text) {
  const t = text.toLowerCase();
  if (t.includes("homme"))  return { service: "homme" };
  if (t.includes("femme"))  return { service: "femme" };
  if (t.includes("non"))    return { service: "nonbinaire" };

  if (!openai) return { service: null };

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: 'Return JSON only: {"service":"homme|femme|nonbinaire|null"}' },
      { role: "user",   content: text },
    ],
    response_format: { type: "json_object" },
  });
  return JSON.parse(r.choices[0].message.content);
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ ok: true, status: "stable" }));

app.post("/voice", (req, res) => {
  const twiml  = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: "speech", action: "/process",
    language: LANG, speechTimeout: "auto",
  });
  say(gather, "Allô! Bienvenue au Salon Coco. Coupe homme, femme, ou non binaire?");
  res.type("text/xml").send(twiml.toString());
});

app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const { CallSid, From, SpeechResult, Digits } = req.body;
  const speech  = (SpeechResult || "").trim();
  const session = getSession(CallSid);

  try {
    if (speech && isHumanRequest(speech)) {
      say(twiml, "Je vous transfère à un membre de l'équipe.");
      twiml.dial({ callerId: TWILIO_CALLER_ID }).number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    // Étape : choix du créneau
    if (session.state === "choose_slot") {
      const idx   = parseInt(Digits, 10);
      const slots = session.data.slots || [];
      if (![1, 2, 3].includes(idx) || !slots[idx - 1]) {
        const g = twiml.gather({ input: "dtmf", numDigits: 1, action: "/process" });
        say(g, "Choix invalide. Veuillez appuyer sur 1, 2 ou 3.");
        return res.type("text/xml").send(twiml.toString());
      }
      session.data.selectedSlot = slots[idx - 1];
      session.state = "collect_name";
      const g = twiml.gather({ input: "speech", action: "/process", language: LANG, speechTimeout: "auto" });
      say(g, "C'est noté. Quel est votre prénom et votre nom?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Étape : collecte du nom
    if (session.state === "collect_name") {
      if (!speech) {
        const g = twiml.gather({ input: "speech", action: "/process", language: LANG, speechTimeout: "auto" });
        say(g, "Je n'ai pas saisi votre nom. Pouvez-vous répéter?");
        return res.type("text/xml").send(twiml.toString());
      }
      session.data.name = speech;

      const token = crypto.randomBytes(16).toString("hex");
      pending.set(token, {
        expiresAt: now() + PENDING_TTL_MS,
        payload: {
          from:         From,
          name:         speech,
          service:      session.data.service,
          eventTypeUri: session.data.eventTypeUri,
          startTimeIso: session.data.selectedSlot,
        },
      });

      const link = `${publicBase()}/confirm-email/${token}`;
      await sendSms(From, `Salon Coco — Confirmez votre RDV (lien valide 20 min) : ${link}`);
      say(twiml, "Parfait! Vérifiez vos messages texte pour confirmer votre adresse courriel. À bientôt!");
      twiml.hangup();
      resetSession(CallSid);
      return res.type("text/xml").send(twiml.toString());
    }

    // Étape initiale : détection du service
    const parsed = await parseServiceIntent(speech);
    if (!parsed.service) {
      say(twiml, "Désolé, je n'ai pas compris. Souhaitez-vous une coupe homme, femme ou non binaire?");
      twiml.redirect("/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    const eventTypeUri = eventTypeUriForService(parsed.service);
    if (!eventTypeUri) {
      say(twiml, "Ce service n'est pas encore disponible. Veuillez nous rappeler.");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const { startIso, endIso } = computeWindow7Days();
    const slots = await calendlyGetAvailableTimes(eventTypeUri, startIso, endIso);

    if (!slots || slots.length < 3) {
      say(twiml, "Il n'y a pas suffisamment de disponibilités dans les 7 prochains jours. Veuillez nous rappeler.");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    session.state = "choose_slot";
    session.data  = { service: parsed.service, eventTypeUri, slots: slots.slice(0, 3) };

    const g = twiml.gather({ input: "dtmf", numDigits: 1, action: "/process" });
    say(
      g,
      `Pour une ${labelForService(parsed.service)}, ` +
      `appuyez sur 1 pour ${slotToFrench(slots[0])}, ` +
      `sur 2 pour ${slotToFrench(slots[1])}, ` +
      `ou sur 3 pour ${slotToFrench(slots[2])}.`
    );
    return res.type("text/xml").send(twiml.toString());

  } catch (e) {
    console.error("Erreur /process:", e);
    say(twiml, "Un petit pépin technique. Je vous transfère.");
    twiml.dial({ callerId: TWILIO_CALLER_ID }).number(FALLBACK_NUMBER);
    return res.type("text/xml").send(twiml.toString());
  }
});

// ─── Confirmation email ───────────────────────────────────────────────────────
app.get("/confirm-email/:token", (req, res) => {
  const entry = pending.get(req.params.token);
  if (!entry || entry.expiresAt < now()) return res.status(410).send(html410());
  res.setHeader("Content-Type", "text/html").send(htmlConfirmForm());
});

app.post("/confirm-email/:token", async (req, res) => {
  const entry = pending.get(req.params.token);
  if (!entry || entry.expiresAt < now()) return res.status(410).send(html410());

  const { eventTypeUri, startTimeIso, name, from } = entry.payload;
  const email = (req.body.email || "").trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).setHeader("Content-Type", "text/html")
      .send(htmlConfirmForm("Adresse courriel invalide. Veuillez réessayer."));
  }

  try {
    const result = await calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email });
    pending.delete(req.params.token);

    const cancelUrl     = result?.resource?.cancel_url     || "";
    const rescheduleUrl = result?.resource?.reschedule_url || "";

    await sendSms(
      from,
      `✅ RDV Salon Coco confirmé!\n` +
      (rescheduleUrl ? `Modifier : ${rescheduleUrl}\n` : "") +
      (cancelUrl     ? `Annuler  : ${cancelUrl}`       : "")
    );

    res.setHeader("Content-Type", "text/html").send(htmlSuccess(rescheduleUrl, cancelUrl));
  } catch (e) {
    console.error("Erreur confirm-email POST:", e);
    res.status(500).setHeader("Content-Type", "text/html").send(htmlError(e.message));
  }
});

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function htmlLayout(content) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Salon Coco</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 20px;color:#1a1a1a}
  h1{font-size:1.4rem}
  input[type=email]{width:100%;padding:12px;font-size:1rem;border:1px solid #ccc;border-radius:8px;box-sizing:border-box;margin-top:8px}
  button{margin-top:12px;width:100%;padding:13px;background:#6c47ff;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
  button:hover{background:#5538d4}
  .err{color:#c0392b;margin-top:8px;font-size:.9rem}
  a.link{display:block;margin-top:12px;font-size:.9rem}
</style></head><body>${content}</body></html>`;
}

function htmlConfirmForm(error = "") {
  return htmlLayout(`
    <h1>Confirmer votre rendez-vous</h1>
    <p>Entrez votre adresse courriel pour finaliser la réservation.</p>
    <form method="POST">
      <input name="email" type="email" required placeholder="votre@courriel.com" autocomplete="email"/>
      ${error ? `<p class="err">${error}</p>` : ""}
      <button type="submit">Confirmer le rendez-vous</button>
    </form>`);
}

function htmlSuccess(rescheduleUrl, cancelUrl) {
  return htmlLayout(`
    <h1>✅ Rendez-vous confirmé!</h1>
    <p>Vous recevrez un courriel de confirmation de Calendly sous peu.</p>
    ${rescheduleUrl ? `<a class="link" href="${rescheduleUrl}">📅 Modifier le rendez-vous</a>` : ""}
    ${cancelUrl     ? `<a class="link" href="${cancelUrl}">❌ Annuler le rendez-vous</a>`     : ""}
    <p style="margin-top:24px;font-size:.85rem;color:#666">Vous pouvez fermer cette page.</p>`);
}

function htmlError(msg) {
  return htmlLayout(`
    <h1>⚠️ Erreur</h1>
    <p>Impossible de créer le rendez-vous. Veuillez rappeler le salon.</p>
    <pre style="font-size:.75rem;color:#c0392b;white-space:pre-wrap">${msg}</pre>`);
}

function html410() {
  return htmlLayout(`
    <h1>Lien expiré</h1>
    <p>Ce lien n'est plus valide (20 min). Veuillez rappeler le salon pour un nouveau lien.</p>`);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Serveur Salon Coco prêt sur le port ${port}`));
