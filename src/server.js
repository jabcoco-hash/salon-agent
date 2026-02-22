/**
 * Salon Coco — Agent téléphonique IA v8
 *
 * Architecture simplifiée et robuste :
 * - OpenAI Realtime gère la conversation vocale
 * - DTMF : quand Marie a le numéro de téléphone, le serveur redirige via
 *   Twilio REST vers /collect-phone, collecte les chiffres, puis reprend
 *   la conversation OpenAI EN COURS (même WebSocket, même contexte)
 * - Après DTMF : message vocal Twilio de confirmation, puis SMS envoyé
 */

import express          from "express";
import crypto           from "crypto";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import twilio           from "twilio";

const app        = express();
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Environnement ────────────────────────────────────────────────────────────
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  FALLBACK_NUMBER,
  PUBLIC_BASE_URL,
  CALENDLY_API_TOKEN,
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17",
  OPENAI_TTS_VOICE      = "shimmer",
  CALENDLY_TIMEZONE     = "America/Toronto",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
} = process.env;

function envStr(key, fallback = "") {
  const v = process.env[key];
  if (!v || !v.trim()) return fallback;
  return v.trim().replace(/^["']|["']$/g, "");
}

const SALON_NAME       = envStr("SALON_NAME",       "Salon Coco");
const SALON_CITY       = envStr("SALON_CITY",       "Magog Beach");
const SALON_ADDRESS    = envStr("SALON_ADDRESS",    "Adresse non configurée");
const SALON_HOURS      = envStr("SALON_HOURS",      "Heures non configurées");
const SALON_PRICE_LIST = envStr("SALON_PRICE_LIST", "Prix non configurés");

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function base() { return (PUBLIC_BASE_URL || "").replace(/\/$/, ""); }
function wsBase() { return base().replace(/^https/, "wss").replace(/^http/, "ws"); }

// ─── Stores ───────────────────────────────────────────────────────────────────
// sessions : twilioCallSid → { openaiWs, callState, streamSid, heartbeat }
const sessions = new Map();
// pending  : token → { expiresAt, payload }
const pending  = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw = "") {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  return null;
}

function fmtPhone(e164 = "") {
  const d = e164.replace(/^\+1/, "");
  return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : e164;
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

function serviceUri(s) {
  if (s === "homme")      return CALENDLY_EVENT_TYPE_URI_HOMME;
  if (s === "femme")      return CALENDLY_EVENT_TYPE_URI_FEMME;
  if (s === "nonbinaire") return CALENDLY_EVENT_TYPE_URI_NONBINAIRE;
  return null;
}

function serviceLabel(s) {
  return { homme: "coupe homme", femme: "coupe femme", nonbinaire: "coupe non binaire" }[s] || s;
}

// ─── Calendly ─────────────────────────────────────────────────────────────────
const cHeaders = () => ({
  Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
  "Content-Type": "application/json",
});

async function getSlots(uri) {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  const end   = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  const url = `https://api.calendly.com/event_type_available_times`
    + `?event_type=${encodeURIComponent(uri)}`
    + `&start_time=${encodeURIComponent(start.toISOString())}`
    + `&end_time=${encodeURIComponent(end.toISOString())}`;
  const r = await fetch(url, { headers: cHeaders() });
  if (!r.ok) throw new Error(`Calendly slots ${r.status}: ${await r.text()}`);
  return (await r.json()).collection?.map(x => x.start_time).filter(Boolean) || [];
}

async function getEventLocation(uri) {
  const uuid = uri.split("/").pop();
  const r = await fetch(`https://api.calendly.com/event_types/${uuid}`, { headers: cHeaders() });
  const j = await r.json();
  const locs = j.resource?.locations;
  return Array.isArray(locs) && locs.length ? locs[0] : null;
}

async function createInvitee({ uri, startTimeIso, name, email }) {
  const loc  = await getEventLocation(uri);
  const body = {
    event_type: uri,
    start_time: startTimeIso,
    invitee:    { name, email, timezone: CALENDLY_TIMEZONE },
  };
  if (loc) {
    body.location = { kind: loc.kind };
    if (loc.location) body.location.location = loc.location;
  }
  const r = await fetch("https://api.calendly.com/invitees", {
    method: "POST", headers: cHeaders(), body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Calendly invitee ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_CALLER_ID) return console.warn("[SMS] Config manquante");
  await twilioClient.messages.create({ from: TWILIO_CALLER_ID, to, body });
  console.log(`[SMS] ✅ → ${to}`);
}

// ─── System prompt ────────────────────────────────────────────────────────────
function systemPrompt(callerNumber) {
  return `Tu es Marie, la réceptionniste pétillante et chaleureuse du ${SALON_NAME} à ${SALON_CITY}!
Tu ADORES ton travail. Tu es énergique, naturelle, et tu mets les clients à l'aise instantanément.
Tu parles en français québécois avec des expressions comme "Ok parfait!", "Génial!", "Laisse-moi vérifier ça!", "Pas de problème!", "Super choix!".
Réponses courtes — max 2 phrases. Une seule question à la fois.

INFOS DU SALON :
- Adresse : ${SALON_ADDRESS}
- Heures : ${SALON_HOURS}
- Prix : ${SALON_PRICE_LIST}

NUMÉRO APPELANT (usage interne seulement, ne pas mentionner) : ${callerNumber || "inconnu"}

═══════════════════════════════════
FLUX RENDEZ-VOUS — étape par étape
═══════════════════════════════════

ÉTAPE 1 — Comprendre la demande
  → Écoute la phrase COMPLÈTE du client avant de répondre
  → Le client peut dire plusieurs infos d'un coup : type de coupe, jour, période
  → Exemple : "je veux une coupe homme mercredi après-midi" = service:homme, jour:mercredi, periode:après-midi
  → Si le type de coupe est clair → passe directement à l'étape 2 SANS redemander
  → Si le type de coupe n'est PAS mentionné → demande : "C'est pour une coupe homme, femme ou non binaire?"
  → Ne pose JAMAIS une question dont tu as déjà la réponse

ÉTAPE 2 — Disponibilités
  → Appelle get_available_slots(service, jour?, periode?) avec TOUS les filtres mentionnés par le client
  → Dis : "Ok laisse-moi vérifier ça!" AVANT d'appeler la fonction
  → Si des créneaux correspondent : propose-les : "J'ai [jour] à [heure] — ça te convient?"
  → Si aucune dispo avec le filtre : "Ah, j'ai pas de place mercredi après-midi — par contre j'ai [alternative]. Ça t'irait?"
  → Attends que le client choisisse. Ne choisis pas à sa place.

ÉTAPE 3 — Confirmation créneau
  → Répète le créneau : "Parfait, je te prends [jour] à [heure]!"
  → Attends confirmation.

ÉTAPE 4 — Nom
  → Demande : "Super! C'est à quel nom?"
  → Attends la réponse. OBLIGATOIRE. Ne passe pas à l'étape 5 sans le nom.

ÉTAPE 5 — Numéro de téléphone
  → Dis EXACTEMENT : "Ok [prénom]! J'vais avoir besoin de ton numéro de cellulaire pour t'envoyer la confirmation et que tu puisses saisir ton courriel. Tu vas entendre une autre voix qui va te demander de le taper sur ton clavier!"
  → Appelle IMMÉDIATEMENT collect_phone_dtmf après cette phrase
  → N'avance pas sans le résultat de collect_phone_dtmf

ÉTAPE 6 — Envoi SMS
  → Quand collect_phone_dtmf retourne un numéro valide :
  → Appelle send_booking_link avec service + slot_iso + name + phone
  → Après succès, dis : "Parfait! Vérifie tes textos — t'as reçu un lien pour entrer ton courriel et confirmer ta réservation. Au revoir et à bientôt au ${SALON_NAME}!"
  → Conversation TERMINÉE. Ne fais rien d'autre. N'appelle pas transfer_to_agent.

═══════════════════════
RÈGLES IMPORTANTES
═══════════════════════
- N'invente JAMAIS une réponse du client
- Si tu n'entends pas clairement : "Désolée, j'ai pas bien saisi — tu peux répéter?"
- Ne demande JAMAIS le numéro vocalement — utilise TOUJOURS collect_phone_dtmf
- Ne demande JAMAIS l'email — le lien SMS s'en occupe
- transfer_to_agent SEULEMENT si le client demande explicitement à parler à quelqu'un
- JAMAIS de transfer_to_agent après un send_booking_link réussi`;
}

// ─── Outils OpenAI ────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    name: "get_available_slots",
    description: "Récupère les créneaux Calendly disponibles. Si le client a mentionné un jour ou une période (ex: mercredi, après-midi, vendredi matin), passe-les dans le filtre pour ne retourner que les créneaux correspondants.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", enum: ["homme", "femme", "nonbinaire"] },
        jour: {
          type: "string",
          description: "Jour souhaité en français minuscule, ex: 'lundi', 'mercredi', 'vendredi'. Omets si pas mentionné."
        },
        periode: {
          type: "string",
          enum: ["matin", "après-midi", "soir"],
          description: "Période de la journée souhaitée. Omets si pas mentionnée."
        },
      },
      required: ["service"],
    },
  },
  {
    type: "function",
    name: "collect_phone_dtmf",
    description: "Redirige l'appel pour collecter le numéro de téléphone par touches DTMF. Appelle après avoir prévenu le client. Retourne le numéro validé.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "send_booking_link",
    description: "Envoie un SMS avec le lien de confirmation. Appelle après avoir reçu le numéro de collect_phone_dtmf.",
    parameters: {
      type: "object",
      properties: {
        service:  { type: "string", enum: ["homme", "femme", "nonbinaire"] },
        slot_iso: { type: "string" },
        name:     { type: "string" },
        phone:    { type: "string" },
      },
      required: ["service", "slot_iso", "name", "phone"],
    },
  },
  {
    type: "function",
    name: "get_salon_info",
    description: "Retourne les infos du salon.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["adresse", "heures", "prix"] },
      },
      required: ["topic"],
    },
  },
  {
    type: "function",
    name: "transfer_to_agent",
    description: "Transfère à un agent humain. Uniquement si le client le demande explicitement.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

// ─── Exécution des outils ─────────────────────────────────────────────────────
async function runTool(name, args, session) {
  console.log(`[TOOL] ${name}`, JSON.stringify(args));

  // ── get_available_slots ──────────────────────────────────────────────────
  if (name === "get_available_slots") {
    const uri = serviceUri(args.service);
    if (!uri) return { error: "Type de coupe non configuré dans Railway." };
    try {
      let slots = await getSlots(uri);
      if (!slots.length) return { disponible: false, message: "Aucune disponibilité cette semaine." };

      // Filtrer par jour si spécifié
      const JOURS = { lundi:1, mardi:2, mercredi:3, jeudi:4, vendredi:5, samedi:6, dimanche:0 };
      if (args.jour && JOURS[args.jour.toLowerCase()] !== undefined) {
        const jourNum = JOURS[args.jour.toLowerCase()];
        const filtered = slots.filter(iso => {
          const d = new Date(iso);
          return d.toLocaleDateString("en-CA", { weekday: "long", timeZone: CALENDLY_TIMEZONE })
                  !== undefined &&
                 new Date(iso).toLocaleString("en-CA", { timeZone: CALENDLY_TIMEZONE, weekday: "short" })
                  .toLowerCase().startsWith(["sun","mon","tue","wed","thu","fri","sat"][jourNum].toLowerCase());
        });
        if (filtered.length) slots = filtered;
        else return { disponible: false, message: `Pas de disponibilité ${args.jour} cette semaine.` };
      }

      // Filtrer par période si spécifiée
      if (args.periode) {
        const periodeFilter = slots.filter(iso => {
          const hour = new Date(new Date(iso).toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE })).getHours();
          if (args.periode === "matin")       return hour >= 8  && hour < 12;
          if (args.periode === "après-midi")  return hour >= 12 && hour < 17;
          if (args.periode === "soir")        return hour >= 17;
          return true;
        });
        if (periodeFilter.length) slots = periodeFilter;
        // Si aucun créneau pour cette période, on garde tout plutôt que de dire non
      }

      return {
        disponible: true,
        service: args.service,
        filtre: { jour: args.jour || null, periode: args.periode || null },
        slots: slots.slice(0, 5).map(iso => ({ iso, label: slotToFrench(iso) })),
      };
    } catch (e) {
      console.error("[TOOL] getSlots error:", e.message);
      return { error: "Impossible de vérifier les disponibilités." };
    }
  }

  // ── collect_phone_dtmf ───────────────────────────────────────────────────
  if (name === "collect_phone_dtmf") {
    return new Promise((resolve) => {
      if (!session.twilioCallSid) {
        return resolve({ error: "CallSid introuvable — impossible de rediriger." });
      }

      // Sauvegarder la callback resolve dans la session
      session.dtmfResolve = resolve;
      console.log(`[DTMF] Redirection de l'appel ${session.twilioCallSid}`);

      const collectUrl = `${base()}/collect-phone?sid=${encodeURIComponent(session.twilioCallSid)}`;

      // Redirection après que l'audio d'OpenAI soit terminé
      // On écoute output_audio_buffer.committed qui signale la fin du dernier chunk audio
      let audioCommittedCount = 0;
      const onAudioDone = (raw) => {
        let ev;
        try { ev = JSON.parse(raw); } catch { return; }
        // response.output_item.done avec audio = OpenAI a fini de générer l'audio
        if (ev.type === "response.output_item.done" && ev.item?.type === "message") {
          oaiWs.removeListener("message", onAudioDone);
          console.log(`[DTMF] Audio terminé → redirection dans 800ms vers ${collectUrl}`);
          setTimeout(() => {
            if (!session.dtmfResolve) return; // déjà annulé
            twilioClient.calls(session.twilioCallSid)
              .update({ url: collectUrl, method: "POST" })
              .then(() => console.log("[DTMF] ✅ Redirection déclenchée"))
              .catch(e => {
                console.error("[DTMF] ❌ Erreur redirection:", e.message);
                const r = session.dtmfResolve;
                if (r) { delete session.dtmfResolve; r({ error: "Impossible de rediriger." }); }
              });
          }, 800);
        }
      };
      oaiWs.on("message", onAudioDone);
      // Sécurité : retirer l'écouteur après 15s si jamais response.output_item.done n'arrive pas
      setTimeout(() => oaiWs.removeListener("message", onAudioDone), 15_000);

      // Timeout 60s
      setTimeout(() => {
        if (session.dtmfResolve) {
          delete session.dtmfResolve;
          resolve({ error: "Délai dépassé — le client n'a pas saisi son numéro." });
        }
      }, 60_000);
    });
  }

  // ── send_booking_link ────────────────────────────────────────────────────
  if (name === "send_booking_link") {
    const phone = normalizePhone(args.phone);
    if (!phone) return { error: "Numéro invalide — relance collect_phone_dtmf." };

    const uri = serviceUri(args.service);
    if (!uri)        return { error: "Service non configuré." };
    if (!args.slot_iso) return { error: "Créneau manquant." };
    if (!args.name?.trim()) return { error: "Nom manquant." };

    const token = crypto.randomBytes(16).toString("hex");
    pending.set(token, {
      expiresAt: Date.now() + 20 * 60 * 1000,
      payload: {
        phone, name: args.name.trim(),
        service: args.service,
        eventTypeUri: uri,
        startTimeIso: args.slot_iso,
      },
    });

    const link = `${base()}/confirm-email/${token}`;
    try {
      await sendSms(phone,
        `${SALON_NAME} — Bonjour ${args.name.trim()}!\n` +
        `Pour finaliser ton rendez-vous du ${slotToFrench(args.slot_iso)}, ` +
        `saisis ton courriel ici (lien valide 20 min) :\n${link}`
      );
      return { success: true, phone_display: fmtPhone(phone) };
    } catch (e) {
      return { error: `Erreur SMS : ${e.message}` };
    }
  }

  // ── get_salon_info ───────────────────────────────────────────────────────
  if (name === "get_salon_info") {
    return {
      adresse: SALON_ADDRESS,
      heures:  SALON_HOURS,
      prix:    SALON_PRICE_LIST,
    }[args.topic] ? { [args.topic]: { adresse: SALON_ADDRESS, heures: SALON_HOURS, prix: SALON_PRICE_LIST }[args.topic] }
                  : { error: "Sujet inconnu." };
  }

  // ── transfer_to_agent ────────────────────────────────────────────────────
  if (name === "transfer_to_agent") {
    session.shouldTransfer = true;
    return { transferring: true };
  }

  return { error: `Outil inconnu : ${name}` };
}

// ─── Route : entrée d'appel Twilio ────────────────────────────────────────────
app.get("/", (req, res) => res.json({ ok: true }));

app.get("/debug-env", (req, res) => res.json({
  SALON_NAME, SALON_CITY, SALON_ADDRESS, SALON_HOURS, SALON_PRICE_LIST,
  TWILIO_CALLER_ID:   TWILIO_CALLER_ID   ? "✅" : "❌",
  OPENAI_API_KEY:     OPENAI_API_KEY     ? "✅" : "❌",
  CALENDLY_API_TOKEN: CALENDLY_API_TOKEN ? "✅" : "❌",
  CALENDLY_EVENT_TYPE_URI_HOMME:      CALENDLY_EVENT_TYPE_URI_HOMME      ? "✅" : "❌",
  CALENDLY_EVENT_TYPE_URI_FEMME:      CALENDLY_EVENT_TYPE_URI_FEMME      ? "✅" : "❌",
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE: CALENDLY_EVENT_TYPE_URI_NONBINAIRE ? "✅" : "❌",
}));

app.post("/voice", (req, res) => {
  const { CallSid, From } = req.body;
  console.log(`[VOICE] Appel entrant — CallSid: ${CallSid} — From: ${From}`);

  // Pré-enregistrer la session avec le twilioCallSid comme clé principale
  sessions.set(CallSid, {
    twilioCallSid: CallSid,
    callerNumber:  From || "",
    openaiWs:      null,
    streamSid:     null,
    dtmfResolve:   null,
    shouldTransfer: false,
  });

  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `${wsBase()}/media-stream` });
  // Passer le CallSid Twilio au WebSocket via paramètre custom
  stream.parameter({ name: "twilioCallSid", value: CallSid });
  stream.parameter({ name: "callerNumber",  value: From || "" });

  res.type("text/xml").send(twiml.toString());
});

// ─── Route DTMF : page de collecte du numéro ─────────────────────────────────
app.post("/collect-phone", (req, res) => {
  const sid = req.query.sid || "";
  console.log(`[DTMF] /collect-phone — sid: ${sid}`);

  const twiml  = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input:       "dtmf",
    numDigits:   10,
    timeout:     15,
    finishOnKey: "#",
    action:      `${base()}/phone-received?sid=${encodeURIComponent(sid)}`,
    method:      "POST",
  });
  gather.say({ language: "fr-CA", voice: "alice" },
    "Veuillez entrer votre numéro de cellulaire à dix chiffres, puis appuyez sur le dièse."
  );
  // Timeout — retour à Marie
  twiml.say({ language: "fr-CA", voice: "alice" },
    "Je n'ai pas reçu de numéro. Je vous retourne à Marie."
  );
  twiml.redirect({ method: "POST" },
    `${base()}/phone-received?sid=${encodeURIComponent(sid)}&timeout=1`
  );

  res.type("text/xml").send(twiml.toString());
});

// ─── Route DTMF : réception du numéro et reprise de la conversation ──────────
app.post("/phone-received", async (req, res) => {
  const sid     = req.query.sid     || "";
  const timeout = req.query.timeout || "";
  const digits  = (req.body.Digits  || "").replace(/\D/g, "");

  console.log(`[DTMF] /phone-received — sid: ${sid} — digits: "${digits}" — timeout: ${timeout}`);

  const session = sessions.get(sid);

  if (!session) {
    console.error(`[DTMF] Session introuvable pour sid: ${sid}`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ language: "fr-CA", voice: "alice" },
      "Une erreur est survenue. Veuillez rappeler le salon."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  const phone = timeout ? null : normalizePhone(digits);

  // Résoudre la Promise collect_phone_dtmf dans OpenAI
  if (session.dtmfResolve) {
    const resolve = session.dtmfResolve;
    delete session.dtmfResolve;

    if (phone) {
      console.log(`[DTMF] ✅ Numéro validé: ${phone}`);
      resolve({
        phone,
        phone_display: fmtPhone(phone),
        message: `Numéro reçu : ${fmtPhone(phone)}. Appelle maintenant send_booking_link.`,
      });
    } else {
      console.warn(`[DTMF] ❌ Numéro invalide: "${digits}"`);
      resolve({ error: `Numéro invalide. Rappelle collect_phone_dtmf pour réessayer.` });
    }
  }

  // Message vocal de confirmation + reprise du stream OpenAI
  const twiml   = new twilio.twiml.VoiceResponse();

  if (phone) {
    twiml.say({ language: "fr-CA", voice: "alice" },
      `Merci! Je t'envoie le lien de confirmation par texto. Je te repasse Marie.`
    );
  } else {
    twiml.say({ language: "fr-CA", voice: "alice" },
      `Je n'ai pas bien reçu le numéro. Je te repasse Marie.`
    );
  }

  // Reprendre le stream WebSocket OpenAI EXISTANT
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `${wsBase()}/media-stream` });
  stream.parameter({ name: "twilioCallSid", value: sid });
  stream.parameter({ name: "callerNumber",  value: session.callerNumber || "" });
  stream.parameter({ name: "resume",        value: "true" });

  res.type("text/xml").send(twiml.toString());
});

// ─── WebSocket : Twilio Media Stream ↔ OpenAI Realtime ───────────────────────
wss.on("connection", (twilioWs) => {
  console.log("[WS] Nouvelle connexion Twilio");

  // Variables locales à cette connexion WebSocket
  let oaiWs        = null;
  let session      = null; // référence à sessions.get(twilioCallSid)
  let streamSid    = null;
  let isResume     = false;
  let pendingTools = new Map(); // call_id → { name, args }
  let heartbeat    = null;

  // ── Créer la connexion OpenAI Realtime ────────────────────────────────
  oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  oaiWs.on("open", () => {
    console.log("[OAI] Connecté");
    heartbeat = setInterval(() => {
      if (oaiWs.readyState === WebSocket.OPEN) oaiWs.ping();
      else clearInterval(heartbeat);
    }, 10_000);
  });

  // Initialiser la session OpenAI (seulement sur nouvelle connexion, pas resume)
  function initOAI() {
    if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;
    console.log(`[OAI] Init session — caller: ${session?.callerNumber}`);

    oaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: {
          type:               "server_vad",
          threshold:          0.85,
          prefix_padding_ms:  500,
          silence_duration_ms: 1200,
        },
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice:               OPENAI_TTS_VOICE,
        instructions:        systemPrompt(session?.callerNumber),
        tools:               TOOLS,
        tool_choice:         "auto",
        modalities:          ["text", "audio"],
        temperature:         0.6,
      },
    }));

    // Message de déclenchement de l'accueil
    oaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message", role: "user",
        content: [{
          type: "input_text",
          text: `L'appel vient de commencer. Fais ton intro en 2-3 phrases : présente-toi comme l'assistante virtuelle du ${SALON_NAME}, dis que tu es là pour que les coiffeurs restent concentrés, mentionne qu'on peut parler à quelqu'un si besoin. Termine UNIQUEMENT par "Comment puis-je vous aider aujourd'hui?" — puis arrête-toi et attends la réponse du client. Ne pose aucune autre question.`,
        }],
      },
    }));
    oaiWs.send(JSON.stringify({ type: "response.create" }));
  }

  // ── Messages OpenAI entrants ──────────────────────────────────────────
  oaiWs.on("message", async (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }

    switch (ev.type) {

      // Audio → Twilio
      case "response.audio.delta":
        if (ev.delta && twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: "media", streamSid,
            media: { payload: ev.delta },
          }));
        }
        break;

      // Enregistrer le nom de la fonction
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          pendingTools.set(ev.item.call_id, { name: ev.item.name, args: "" });
          console.log(`[OAI] Function call: ${ev.item.name}`);
        }
        break;

      // Accumuler les arguments
      case "response.function_call_arguments.delta": {
        const t = pendingTools.get(ev.call_id);
        if (t) t.args += (ev.delta || "");
        break;
      }

      // Exécuter la fonction
      case "response.function_call_arguments.done": {
        const tool = pendingTools.get(ev.call_id);
        if (!tool) break;

        let args = {};
        try { args = JSON.parse(ev.arguments || tool.args || "{}"); } catch {}

        const result = await runTool(tool.name, args, session || {})
          .catch(e => ({ error: e.message }));

        console.log(`[TOOL RESULT] ${tool.name}:`, JSON.stringify(result));

        // Transfert → arrêter le stream
        if (session?.shouldTransfer) {
          setTimeout(() => {
            if (twilioWs.readyState === WebSocket.OPEN)
              twilioWs.send(JSON.stringify({ event: "stop", streamSid }));
          }, 2500);
          pendingTools.delete(ev.call_id);
          break;
        }

        // Retourner le résultat à OpenAI
        if (oaiWs.readyState === WebSocket.OPEN) {
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: ev.call_id,
              output: JSON.stringify(result),
            },
          }));
          oaiWs.send(JSON.stringify({ type: "response.create" }));
        }

        pendingTools.delete(ev.call_id);
        break;
      }

      case "error":
        console.error("[OAI ERROR]", JSON.stringify(ev.error));
        break;
    }
  });

  oaiWs.on("close", (code) => {
    console.log(`[OAI] Fermé (${code})`);
    clearInterval(heartbeat);
  });
  oaiWs.on("error", (e) => console.error("[OAI WS]", e.message));

  // ── Messages Twilio entrants ──────────────────────────────────────────
  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      case "start": {
        streamSid = msg.start.streamSid;
        const p   = msg.start.customParameters || {};
        const sid = p.twilioCallSid || "";
        isResume  = p.resume === "true";

        console.log(`[Twilio] Stream ${isResume ? "RESUME" : "NOUVEAU"} — sid: ${sid} — streamSid: ${streamSid}`);

        // Retrouver la session pré-enregistrée dans /voice
        session = sessions.get(sid);
        if (!session) {
          // Fallback : créer une session à la volée
          console.warn(`[Twilio] Session non trouvée pour ${sid} — création à la volée`);
          session = {
            twilioCallSid: sid,
            callerNumber:  p.callerNumber || "",
            openaiWs:      oaiWs,
            streamSid,
            dtmfResolve:   null,
            shouldTransfer: false,
          };
          sessions.set(sid, session);
        }

        // Mettre à jour la session avec le nouveau WS et streamSid
        session.openaiWs  = oaiWs;
        session.streamSid = streamSid;

        if (isResume) {
          console.log("[Twilio] ✅ Reprise post-DTMF — injection du message de reprise");
          // OpenAI a déjà reçu le function_call_output via la Promise
          // On injecte un nudge pour qu'il reprenne la conversation
          setTimeout(() => {
            if (oaiWs?.readyState === WebSocket.OPEN) {
              oaiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "message", role: "user",
                  content: [{ type: "input_text", text: "Tu viens de recevoir le numéro du client. Continue la conversation normalement — appelle send_booking_link si ce n'est pas encore fait, puis demande si tu peux faire autre chose." }],
                },
              }));
              oaiWs.send(JSON.stringify({ type: "response.create" }));
            }
          }, 1000); // délai pour laisser le function_call_output arriver en premier
        } else {
          // NOUVELLE connexion : initialiser OpenAI
          if (oaiWs.readyState === WebSocket.OPEN) {
            initOAI();
          } else {
            oaiWs.once("open", initOAI);
          }
        }
        break;
      }

      // Audio client → OpenAI
      case "media":
        if (oaiWs?.readyState === WebSocket.OPEN) {
          oaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          }));
        }
        break;

      case "stop":
        console.log("[Twilio] Stream arrêté");
        // Ne pas fermer OpenAI si c'est un arrêt temporaire pour DTMF
        if (!session?.dtmfResolve) {
          clearInterval(heartbeat);
          oaiWs?.close();
        }
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("[Twilio] WS fermé");
    if (!session?.dtmfResolve) {
      clearInterval(heartbeat);
      oaiWs?.close();
    }
  });
  twilioWs.on("error", (e) => console.error("[Twilio WS]", e.message));
});

// ─── Page web : saisie email ──────────────────────────────────────────────────
app.get("/confirm-email/:token", (req, res) => {
  const entry = pending.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now())
    return res.status(410).type("text/html").send(html410());
  res.type("text/html").send(htmlForm(entry.payload.name));
});

app.post("/confirm-email/:token", async (req, res) => {
  const entry = pending.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now())
    return res.status(410).type("text/html").send(html410());

  const { phone, name, service, eventTypeUri, startTimeIso } = entry.payload;
  const email = (req.body.email || "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return res.status(400).type("text/html").send(htmlForm(name, "Courriel invalide."));

  try {
    const result = await createInvitee({ uri: eventTypeUri, startTimeIso, name, email });
    pending.delete(req.params.token);

    const cancelUrl     = result?.resource?.cancel_url     || "";
    const rescheduleUrl = result?.resource?.reschedule_url || "";

    await sendSms(phone,
      `✅ Ton rendez-vous au ${SALON_NAME} est confirmé!\n\n` +
      `👤 Nom        : ${name}\n` +
      `✉️ Courriel   : ${email}\n` +
      `✂️ Service    : ${serviceLabel(service)}\n` +
      `📅 Date/heure : ${slotToFrench(startTimeIso)}\n` +
      `📍 Adresse    : ${SALON_ADDRESS}\n\n` +
      (rescheduleUrl ? `📆 Modifier : ${rescheduleUrl}\n` : "") +
      (cancelUrl     ? `❌ Annuler  : ${cancelUrl}\n`     : "") +
      `\nÀ bientôt! — ${SALON_NAME}`
    );

    res.type("text/html").send(htmlSuccess(name, slotToFrench(startTimeIso), rescheduleUrl, cancelUrl));
  } catch (e) {
    console.error("[EMAIL]", e);
    res.status(500).type("text/html").send(htmlError(e.message));
  }
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f5f4ff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#fff;border-radius:16px;padding:36px 32px;max-width:460px;width:100%;box-shadow:0 4px 24px rgba(108,71,255,.12)}.logo{font-size:1.6rem;font-weight:700;color:#6c47ff;margin-bottom:4px}.sub{color:#888;font-size:.9rem;margin-bottom:28px}h1{font-size:1.25rem;color:#1a1a1a;margin-bottom:10px}p{color:#555;font-size:.95rem;line-height:1.5;margin-bottom:20px}label{display:block;font-size:.85rem;font-weight:600;color:#333;margin-bottom:6px}input[type=email]{width:100%;padding:13px 14px;font-size:1rem;border:1.5px solid #ddd;border-radius:10px;outline:none}input[type=email]:focus{border-color:#6c47ff}.btn{display:block;width:100%;margin-top:16px;padding:14px;background:#6c47ff;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer}.btn:hover{background:#5538d4}.err{color:#c0392b;font-size:.88rem;margin-top:8px}.box{background:#f5f4ff;border-radius:10px;padding:16px 18px;margin:20px 0;font-size:.92rem;line-height:1.8}a.lnk{display:block;margin-top:12px;color:#6c47ff;font-size:.9rem;text-decoration:none}.muted{color:#aaa;font-size:.8rem;margin-top:24px}`;

function layout(title, body) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — ${SALON_NAME}</title><style>${css}</style></head><body><div class="card"><div class="logo">✂️ ${SALON_NAME}</div><div class="sub">Confirmation de rendez-vous</div>${body}</div></body></html>`;
}

function htmlForm(name, err = "") {
  return layout("Confirmer ton courriel", `
    <h1>Bonjour ${name}!</h1>
    <p>Entre ton adresse courriel pour finaliser ta réservation. Tu recevras tous les détails par texto.</p>
    <form method="POST">
      <label for="e">Adresse courriel</label>
      <input id="e" name="email" type="email" required placeholder="toi@exemple.com" autocomplete="email" inputmode="email"/>
      ${err ? `<p class="err">⚠️ ${err}</p>` : ""}
      <button class="btn" type="submit">Confirmer ma réservation</button>
    </form>
    <p class="muted">Lien valide 20 minutes.</p>`);
}

function htmlSuccess(name, slot, reschedule, cancel) {
  return layout("Réservation confirmée", `
    <h1>✅ Réservation confirmée!</h1>
    <p>Merci <strong>${name}</strong>! Ton rendez-vous est enregistré.</p>
    <div class="box">📅 <strong>${slot}</strong><br>📍 ${SALON_ADDRESS}</div>
    <p>Un texto de confirmation a été envoyé sur ton cellulaire.</p>
    ${reschedule ? `<a class="lnk" href="${reschedule}">📆 Modifier</a>` : ""}
    ${cancel     ? `<a class="lnk" href="${cancel}">❌ Annuler</a>`     : ""}
    <p class="muted">Tu peux fermer cette page.</p>`);
}

function htmlError(msg) {
  return layout("Erreur", `<h1>⚠️ Erreur</h1><p>Impossible de créer le rendez-vous. Rappelle le salon.</p><pre style="font-size:.75rem;color:#c0392b;margin-top:12px;white-space:pre-wrap">${msg}</pre>`);
}

function html410() {
  return layout("Lien expiré", `<h1>⏰ Lien expiré</h1><p>Ce lien n'est plus valide (20 min). Rappelle le salon pour un nouveau lien.</p>`);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`✅ ${SALON_NAME} — port ${PORT}`));
