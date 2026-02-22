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
  CALENDLY_TIMEZONE      = "America/Toronto",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
  OPENAI_API_KEY,
  OPENAI_MODEL           = "gpt-4o-mini",
  LANG                   = "fr-CA",
  TTS_VOICE              = "alice",
  SALON_ADDRESS          = "123 Saint-Jacques Ouest, Montréal",
  SALON_HOURS            = "lundi au vendredi de 9h à 17h",
  SALON_PRICE_LIST       = "Coupe homme : 25 $. Coupe femme : 45 $. Coupe non binaire : 450 $.",
} = process.env;

// ─── Clients ──────────────────────────────────────────────────────────────────
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ─── Sessions & pending ───────────────────────────────────────────────────────
const sessions = new Map(); // callSid → session
const pending  = new Map(); // token  → payload

const SESSION_TTL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 20 * 60 * 1000;

function now() { return Date.now(); }

function getSession(callSid) {
  const s = sessions.get(callSid);
  if (s && now() - s.updatedAt < SESSION_TTL_MS) {
    s.updatedAt = now();
    return s;
  }
  const fresh = { updatedAt: now(), state: "menu", data: {} };
  sessions.set(callSid, fresh);
  return fresh;
}

function resetSession(callSid) {
  sessions.set(callSid, { updatedAt: now(), state: "menu", data: {} });
}

// ─── Helpers TwiML ────────────────────────────────────────────────────────────
function say(target, text) {
  target.say({ language: LANG, voice: TTS_VOICE }, text);
}

function gatherSpeech(twiml, action, hints = "") {
  return twiml.gather({
    input: "speech",
    action,
    language: LANG,
    speechTimeout: "auto",
    hints,
  });
}

function gatherDtmf(twiml, numDigits, action) {
  return twiml.gather({ input: "dtmf", numDigits, action });
}

function isHumanRequest(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("humain") || t.includes("agent") ||
    t.includes("personne") || t.includes("transf") ||
    t.includes("parler à")
  );
}

// ─── Helpers métier ───────────────────────────────────────────────────────────
function labelForService(s) {
  if (s === "homme")      return "coupe homme";
  if (s === "femme")      return "coupe femme";
  if (s === "nonbinaire") return "coupe non binaire";
  return "service";
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

// Normalise un numéro de téléphone dicté ou tapé en format E.164 canadien/américain
function normalizePhone(raw = "") {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10)  return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // invalide
}

// ─── Calendly API v2 ──────────────────────────────────────────────────────────
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
  const txt = await r.text();
  if (!r.ok) throw new Error(`Calendly avail error: ${r.status} ${txt}`);
  return (JSON.parse(txt).collection || []).map(x => x.start_time).filter(Boolean);
}

async function calendlyGetEventTypeLocation(eventTypeUri) {
  const uuid = eventTypeUri.split("/").pop();
  const r    = await fetch(`https://api.calendly.com/event_types/${uuid}`, {
    headers: calendlyHeaders(),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly event_type error: ${r.status} ${JSON.stringify(json)}`);
  const locs = json.resource?.locations;
  return Array.isArray(locs) && locs.length > 0 ? locs[0] : null;
}

async function calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email }) {
  const locationConfig = await calendlyGetEventTypeLocation(eventTypeUri);

  const body = {
    event_type: eventTypeUri,
    start_time: startTimeIso,
    invitee:    { name, email, timezone: CALENDLY_TIMEZONE },
  };

  if (locationConfig) {
    body.location = { kind: locationConfig.kind };
    if (locationConfig.location) body.location.location = locationConfig.location;
  }

  console.log("BODY CALENDLY:", JSON.stringify(body));

  const r = await fetch("https://api.calendly.com/invitees", {
    method: "POST",
    headers: calendlyHeaders(),
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly failed: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

// ─── SMS ──────────────────────────────────────────────────────────────────────
async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_CALLER_ID) return;
  await twilioClient.messages.create({ from: TWILIO_CALLER_ID, to, body });
}

// ─── Disponibilités ───────────────────────────────────────────────────────────
function computeWindow7Days() {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  const end   = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// ─── Intent service ───────────────────────────────────────────────────────────
async function parseServiceIntent(text) {
  const t = text.toLowerCase();
  if (t.includes("homme") || t.includes("monsieur") || t.includes("garçon")) return { service: "homme" };
  if (t.includes("femme") || t.includes("madame")   || t.includes("fille"))   return { service: "femme" };
  if (t.includes("non bin") || t.includes("nonbin") || t.includes("neutre"))  return { service: "nonbinaire" };

  if (!openai) return { service: null };

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Tu es un assistant de salon de coiffure. " +
          "Identifie si le client veut une coupe pour homme, femme ou non binaire. " +
          'Réponds UNIQUEMENT en JSON: {"service":"homme|femme|nonbinaire|null"}',
      },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object" },
  });
  return JSON.parse(r.choices[0].message.content);
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ ok: true, salon: "Salon Coco" }));

// ════════════════════════════════════════════════════════════════════════════════
// ENTRÉE D'APPEL
// ════════════════════════════════════════════════════════════════════════════════
app.post("/voice", (req, res) => {
  const { CallSid } = req.body;
  resetSession(CallSid);

  const twiml = new twilio.twiml.VoiceResponse();
  const g = gatherSpeech(
    twiml, "/process",
    "rendez-vous, liste des prix, adresse, heures d'ouverture, agent"
  );

  say(g,
    "Bonjour et bienvenue au Salon Coco! " +
    "Pour prendre un rendez-vous, dites rendez-vous. " +
    "Pour connaître notre liste de prix, dites liste des prix. " +
    "Pour obtenir notre adresse, dites adresse. " +
    "Pour nos heures d'ouverture, dites heures d'ouverture. " +
    "Pour parler à un membre de notre équipe, dites agent."
  );

  say(twiml, "Je n'ai pas détecté de réponse. Veuillez rappeler. Au revoir!");
  res.type("text/xml").send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════════
// TRAITEMENT CENTRAL
// ════════════════════════════════════════════════════════════════════════════════
app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const { CallSid, From, SpeechResult, Digits } = req.body;
  const speech  = (SpeechResult || "").trim();
  const session = getSession(CallSid);

  try {

    // ── Transfert agent humain détecté à tout moment ──────────────────────────
    if (speech && isHumanRequest(speech)) {
      say(twiml,
        "Bien sûr! Je vous transfère immédiatement à un membre de notre équipe. " +
        "Veuillez patienter un instant."
      );
      twiml.dial({ callerId: TWILIO_CALLER_ID }).number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAT : choose_slot  (DTMF 1/2/3)
    // ══════════════════════════════════════════════════════════════════════════
    if (session.state === "choose_slot") {
      const idx   = parseInt(Digits, 10);
      const slots = session.data.slots || [];

      if (![1, 2, 3].includes(idx) || !slots[idx - 1]) {
        const g = gatherDtmf(twiml, 1, "/process");
        say(g, "Je n'ai pas compris votre choix. Veuillez appuyer sur 1, 2 ou 3.");
        return res.type("text/xml").send(twiml.toString());
      }

      session.data.selectedSlot = slots[idx - 1];
      session.state = "collect_name";

      const g = gatherSpeech(twiml, "/process", "prénom nom");
      say(g,
        `Excellent! Vous avez choisi le ${slotToFrench(slots[idx - 1])}. ` +
        "Pour finaliser votre réservation, j'ai besoin de quelques informations. " +
        "Commençons : veuillez me dire votre prénom suivi de votre nom de famille."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAT : collect_name
    // ══════════════════════════════════════════════════════════════════════════
    if (session.state === "collect_name") {
      if (!speech || speech.trim().split(/\s+/).length < 2) {
        const g = gatherSpeech(twiml, "/process", "prénom nom");
        say(g,
          "Je n'ai pas bien capté votre nom complet. " +
          "Pourriez-vous répéter votre prénom suivi de votre nom de famille?"
        );
        return res.type("text/xml").send(twiml.toString());
      }

      session.data.name = speech
        .trim()
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");

      session.state = "collect_phone";
      const g = gatherSpeech(twiml, "/process", "numéro de téléphone");
      say(g,
        `Merci ${session.data.name}! ` +
        "Maintenant, veuillez me donner le numéro de téléphone cellulaire " +
        "où vous souhaitez recevoir votre confirmation par message texte. " +
        "Vous pouvez l'énoncer chiffre par chiffre."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAT : collect_phone
    // ══════════════════════════════════════════════════════════════════════════
    if (session.state === "collect_phone") {
      const phoneAttempts = (session.data.phoneAttempts || 0) + 1;
      session.data.phoneAttempts = phoneAttempts;

      // On essaie d'abord le numéro dicté, sinon on utilise le numéro appelant
      const rawInput    = (speech || "").replace(/\D/g, "");
      const normalized  = normalizePhone(rawInput);
      const callerPhone = normalizePhone((From || "").replace(/\D/g, ""));

      if (!normalized && phoneAttempts < 3) {
        const g = gatherSpeech(twiml, "/process", "numéro de téléphone");
        say(g,
          "Je n'ai pas bien saisi ce numéro. " +
          "Veuillez l'énoncer chiffre par chiffre, par exemple : " +
          "cinq un quatre, cinq cinq cinq, douze trente quatre."
        );
        return res.type("text/xml").send(twiml.toString());
      }

      // Utilise le numéro dicté si valide, sinon celui de l'appelant
      session.data.phone = normalized || callerPhone || From;
      session.state = "confirm_phone";

      const displayPhone = session.data.phone.replace("+1", "");
      const formatted    =
        displayPhone.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3");

      const g = gatherDtmf(twiml, 1, "/process");
      say(g,
        `J'ai bien noté le numéro ${formatted}. ` +
        "Appuyez sur 1 pour confirmer ce numéro, " +
        "ou sur 2 pour le corriger."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAT : confirm_phone  (DTMF 1=ok / 2=recommencer)
    // ══════════════════════════════════════════════════════════════════════════
    if (session.state === "confirm_phone") {
      if (Digits === "2") {
        session.data.phoneAttempts = 0;
        session.state = "collect_phone";
        const g = gatherSpeech(twiml, "/process", "numéro de téléphone");
        say(g,
          "Pas de problème. Veuillez me redonner votre numéro de téléphone cellulaire, " +
          "chiffre par chiffre."
        );
        return res.type("text/xml").send(twiml.toString());
      }

      // Digits === "1" ou autre → on confirme et on envoie le lien SMS
      const token = crypto.randomBytes(16).toString("hex");
      pending.set(token, {
        expiresAt: now() + PENDING_TTL_MS,
        payload: {
          phone:        session.data.phone,
          name:         session.data.name,
          service:      session.data.service,
          eventTypeUri: session.data.eventTypeUri,
          startTimeIso: session.data.selectedSlot,
        },
      });

      const link = `${publicBase()}/confirm-email/${token}`;
      await sendSms(
        session.data.phone,
        `Salon Coco — Bonjour ${session.data.name}!\n` +
        `Pour finaliser votre réservation, veuillez saisir votre adresse courriel ` +
        `via ce lien (valide 20 min) :\n${link}`
      );

      say(twiml,
        "Parfait! Un message texte vient d'être envoyé sur votre cellulaire " +
        "avec un lien pour saisir votre adresse courriel. " +
        "Une fois votre courriel confirmé, votre rendez-vous sera immédiatement créé " +
        "et vous recevrez tous les détails par message texte. " +
        "Merci et à très bientôt au Salon Coco!"
      );
      twiml.hangup();
      resetSession(CallSid);
      return res.type("text/xml").send(twiml.toString());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAT : choose_service
    // ══════════════════════════════════════════════════════════════════════════
    if (session.state === "choose_service") {
      const parsed = await parseServiceIntent(speech);

      if (!parsed.service) {
        const g = gatherSpeech(twiml, "/process", "homme, femme, non binaire");
        say(g,
          "Je n'ai pas bien compris. " +
          "Veuillez dire homme pour une coupe homme, " +
          "femme pour une coupe femme, " +
          "ou non binaire pour une coupe non binaire."
        );
        return res.type("text/xml").send(twiml.toString());
      }

      const eventTypeUri = eventTypeUriForService(parsed.service);
      if (!eventTypeUri) {
        const g = gatherSpeech(twiml, "/process",
          "rendez-vous, liste des prix, adresse, heures d'ouverture");
        say(g,
          "Ce type de coupe n'est pas encore disponible en ligne. " +
          "Souhaitez-vous que je vous transfère à un agent?"
        );
        return res.type("text/xml").send(twiml.toString());
      }

      // Récupérer les créneaux disponibles
      const { startIso, endIso } = computeWindow7Days();
      const slots = await calendlyGetAvailableTimes(eventTypeUri, startIso, endIso);

      if (!slots || slots.length < 1) {
        const g = gatherSpeech(twiml, "/process",
          "rendez-vous, liste des prix, adresse, heures d'ouverture");
        say(g,
          "Je suis désolé, il n'y a aucune disponibilité dans les 7 prochains jours. " +
          "Veuillez rappeler dans quelques jours, ou dites agent pour parler à l'équipe."
        );
        return res.type("text/xml").send(twiml.toString());
      }

      const availableSlots = slots.slice(0, 3);
      session.state = "choose_slot";
      session.data  = { service: parsed.service, eventTypeUri, slots: availableSlots };

      const g = gatherDtmf(twiml, 1, "/process");
      let msg = `Voici les prochaines disponibilités pour une ${labelForService(parsed.service)}. `;
      availableSlots.forEach((slot, i) => {
        msg += `Appuyez sur ${i + 1} pour le ${slotToFrench(slot)}. `;
      });
      say(g, msg);
      return res.type("text/xml").send(twiml.toString());
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAT : menu  — détection de l'intention principale
    // ══════════════════════════════════════════════════════════════════════════
    const t = speech.toLowerCase();

    if (t.includes("prix") || t.includes("tarif") || t.includes("coût") || t.includes("combien")) {
      const g = gatherSpeech(twiml, "/process",
        "rendez-vous, liste des prix, adresse, heures d'ouverture");
      say(g,
        `Voici notre liste de prix. ${SALON_PRICE_LIST} ` +
        "Puis-je vous aider avec autre chose? " +
        "Dites rendez-vous, adresse, heures d'ouverture, ou agent."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (t.includes("adresse") || t.includes("où") || t.includes("situé") || t.includes("trouver")) {
      const g = gatherSpeech(twiml, "/process",
        "rendez-vous, liste des prix, adresse, heures d'ouverture");
      say(g,
        `Nous sommes situés au ${SALON_ADDRESS}. ` +
        "Puis-je vous aider avec autre chose? " +
        "Dites rendez-vous, liste des prix, heures d'ouverture, ou agent."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (t.includes("heure") || t.includes("ouvert") || t.includes("horaire") || t.includes("quand")) {
      const g = gatherSpeech(twiml, "/process",
        "rendez-vous, liste des prix, adresse, heures d'ouverture");
      say(g,
        `Le Salon Coco est ouvert ${SALON_HOURS}. ` +
        "Puis-je vous aider avec autre chose? " +
        "Dites rendez-vous, liste des prix, adresse, ou agent."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    if (
      t.includes("rendez") || t.includes("réserv") || t.includes("coupe") ||
      t.includes("appointment") || t.includes("booking") || t.includes("prendre")
    ) {
      session.state = "choose_service";
      const g = gatherSpeech(twiml, "/process", "homme, femme, non binaire");
      say(g,
        "Avec plaisir! Pour quel type de coupe souhaitez-vous prendre rendez-vous? " +
        "Dites homme pour une coupe homme, " +
        "femme pour une coupe femme, " +
        "ou non binaire pour une coupe non binaire."
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // Aucun intent reconnu
    const g = gatherSpeech(twiml, "/process",
      "rendez-vous, liste des prix, adresse, heures d'ouverture");
    say(g,
      "Je n'ai pas bien compris votre demande. Voici vos options : " +
      "dites rendez-vous pour réserver, " +
      "liste des prix pour nos tarifs, " +
      "adresse pour nous trouver, " +
      "heures d'ouverture pour nos horaires, " +
      "ou agent pour parler à l'équipe."
    );
    return res.type("text/xml").send(twiml.toString());

  } catch (e) {
    console.error("Erreur /process:", e);
    say(twiml,
      "Un problème technique est survenu. " +
      "Je vous transfère à un membre de l'équipe."
    );
    twiml.dial({ callerId: TWILIO_CALLER_ID }).number(FALLBACK_NUMBER);
    return res.type("text/xml").send(twiml.toString());
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// PAGE WEB : saisie de l'email (GET = formulaire, POST = création RDV)
// ════════════════════════════════════════════════════════════════════════════════
app.get("/confirm-email/:token", (req, res) => {
  const entry = pending.get(req.params.token);
  if (!entry || entry.expiresAt < now())
    return res.status(410).setHeader("Content-Type", "text/html").send(html410());
  res.setHeader("Content-Type", "text/html").send(htmlConfirmForm(entry.payload.name));
});

app.post("/confirm-email/:token", async (req, res) => {
  const entry = pending.get(req.params.token);
  if (!entry || entry.expiresAt < now())
    return res.status(410).setHeader("Content-Type", "text/html").send(html410());

  const { phone, name, service, eventTypeUri, startTimeIso } = entry.payload;
  const email = (req.body.email || "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res
      .status(400)
      .setHeader("Content-Type", "text/html")
      .send(htmlConfirmForm(name, "Adresse courriel invalide. Veuillez réessayer."));
  }

  try {
    // Créer le RDV Calendly immédiatement
    const result = await calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email });
    pending.delete(req.params.token); // usage unique

    const cancelUrl     = result?.resource?.cancel_url     || "";
    const rescheduleUrl = result?.resource?.reschedule_url || "";
    const slotLabel     = slotToFrench(startTimeIso);

    // SMS de confirmation complet avec tous les détails
    await sendSms(
      phone,
      `✅ Votre rendez-vous au Salon Coco est confirmé!\n\n` +
      `👤 Nom        : ${name}\n` +
      `✉️ Courriel   : ${email}\n` +
      `✂️ Service    : ${labelForService(service)}\n` +
      `📅 Date/heure : ${slotLabel}\n` +
      `📍 Adresse    : ${SALON_ADDRESS}\n\n` +
      (rescheduleUrl ? `📆 Modifier : ${rescheduleUrl}\n` : "Cliquer ici") +
      (cancelUrl     ? `❌ Annuler  : ${cancelUrl}\n`     : "Cliquer ici") +
      `\nNous avons hâte de vous accueillir! — Salon Coco`
    );

    res.setHeader("Content-Type", "text/html")
       .send(htmlSuccess(name, slotLabel, rescheduleUrl, cancelUrl));

  } catch (e) {
    console.error("Erreur confirm-email POST:", e);
    res.status(500)
       .setHeader("Content-Type", "text/html")
       .send(htmlError(e.message));
  }
});

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function htmlLayout(title, content) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Salon Coco</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f5f4ff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 36px 32px;
      max-width: 460px;
      width: 100%;
      box-shadow: 0 4px 24px rgba(108,71,255,.12);
    }
    .logo {
      font-size: 1.6rem;
      font-weight: 700;
      color: #6c47ff;
      margin-bottom: 4px;
    }
    .subtitle {
      color: #888;
      font-size: .9rem;
      margin-bottom: 28px;
    }
    h1 { font-size: 1.25rem; color: #1a1a1a; margin-bottom: 10px; }
    p  { color: #555; font-size: .95rem; line-height: 1.5; margin-bottom: 20px; }
    label { display: block; font-size: .85rem; font-weight: 600; color: #333; margin-bottom: 6px; }
    input[type=email] {
      width: 100%; padding: 13px 14px;
      font-size: 1rem; border: 1.5px solid #ddd;
      border-radius: 10px; outline: none;
      transition: border-color .2s;
    }
    input[type=email]:focus { border-color: #6c47ff; }
    .btn {
      display: block; width: 100%; margin-top: 16px;
      padding: 14px; background: #6c47ff;
      color: #fff; border: none; border-radius: 10px;
      font-size: 1rem; font-weight: 600; cursor: pointer;
      transition: background .2s;
    }
    .btn:hover { background: #5538d4; }
    .err { color: #c0392b; font-size: .88rem; margin-top: 8px; }
    .detail-box {
      background: #f5f4ff; border-radius: 10px;
      padding: 16px 18px; margin: 20px 0;
      font-size: .92rem; line-height: 1.8; color: #333;
    }
    .action-link {
      display: block; margin-top: 12px;
      color: #6c47ff; font-size: .9rem; text-decoration: none;
    }
    .action-link:hover { text-decoration: underline; }
    .muted { color: #aaa; font-size: .8rem; margin-top: 24px; }
  </style>
</head>
<body><div class="card">
  <div class="logo">✂️ Salon Coco</div>
  <div class="subtitle">Confirmation de rendez-vous</div>
  ${content}
</div></body></html>`;
}

function htmlConfirmForm(name = "", error = "") {
  return htmlLayout("Confirmer votre courriel", `
    <h1>Bonjour ${name}!</h1>
    <p>
      Votre créneau est réservé. Pour finaliser votre rendez-vous,
      veuillez entrer votre adresse courriel ci-dessous.
      Vous recevrez ensuite une confirmation complète par message texte.
    </p>
    <form method="POST">
      <label for="email">Adresse courriel</label>
      <input
        id="email" name="email" type="email" required
        placeholder="vous@exemple.com"
        autocomplete="email" inputmode="email"
      />
      ${error ? `<p class="err">⚠️ ${error}</p>` : ""}
      <button class="btn" type="submit">Confirmer mon rendez-vous</button>
    </form>
    <p class="muted">Ce lien est valide 20 minutes.</p>
  `);
}

function htmlSuccess(name, slotLabel, rescheduleUrl, cancelUrl) {
  return htmlLayout("Rendez-vous confirmé", `
    <h1>✅ Rendez-vous confirmé!</h1>
    <p>Merci <strong>${name}</strong>! Votre rendez-vous est bien enregistré.</p>
    <div class="detail-box">
      📅 <strong>${slotLabel}</strong><br>
      📍 ${SALON_ADDRESS}
    </div>
    <p>
      Un message texte de confirmation avec tous les détails
      vient d'être envoyé sur votre cellulaire.
    </p>
    ${rescheduleUrl ? `<a class="action-link" href="${rescheduleUrl}">📆 Modifier le rendez-vous</a>` : ""}
    ${cancelUrl     ? `<a class="action-link" href="${cancelUrl}">❌ Annuler le rendez-vous</a>`     : ""}
    <p class="muted">Vous pouvez fermer cette page.</p>
  `);
}

function htmlError(msg) {
  return htmlLayout("Erreur", `
    <h1>⚠️ Une erreur est survenue</h1>
    <p>Impossible de créer le rendez-vous. Veuillez rappeler le salon.</p>
    <pre style="font-size:.75rem;color:#c0392b;white-space:pre-wrap;margin-top:12px">${msg}</pre>
  `);
}

function html410() {
  return htmlLayout("Lien expiré", `
    <h1>⏰ Lien expiré</h1>
    <p>
      Ce lien de confirmation n'est plus valide (durée de vie : 20 minutes).
      Veuillez rappeler le Salon Coco au pour obtenir un nouveau lien.
    </p>
  `);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Serveur Salon Coco prêt sur le port ${port}`));
