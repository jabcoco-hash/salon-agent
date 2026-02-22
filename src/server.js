/**
 * Salon Coco — Agent téléphonique IA v7
 * Architecture : Twilio Media Streams ↔ OpenAI Realtime API
 *
 * Particularité : collecte du numéro de téléphone par DTMF (touches clavier)
 * pour éviter les erreurs de transcription vocale.
 *
 * Flux DTMF :
 *  1. OpenAI appelle collect_phone_dtmf → serveur met le callSid en attente DTMF
 *  2. Twilio reçoit l'instruction de rediriger vers /collect-phone (via Twilio REST)
 *  3. /collect-phone retourne un TwiML <Gather> qui capture 10 chiffres
 *  4. /phone-collected reçoit les chiffres, valide, stocke dans dtmfPending
 *  5. OpenAI Realtime reçoit le résultat via function_call_output et continue
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

// ─── Variables d'environnement ────────────────────────────────────────────────
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,
  FALLBACK_NUMBER,
  PUBLIC_BASE_URL,
  CALENDLY_API_TOKEN,
  CALENDLY_TIMEZONE               = "America/Toronto",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL           = "gpt-4o-realtime-preview-2024-12-17",
  OPENAI_TTS_VOICE                = "shimmer",
} = process.env;

// Lecture explicite sans valeur par défaut hardcodée — Railway doit définir ces variables
// On nettoie les guillemets/espaces invisibles qui peuvent s'y glisser
function envStr(key, fallback = "") {
  const val = process.env[key];
  if (!val || val.trim() === "") return fallback;
  return val.trim().replace(/^["']|["']$/g, ""); // enlève guillemets éventuels
}

const SALON_ADDRESS   = envStr("SALON_ADDRESS",   "Adresse non configurée — définir SALON_ADDRESS dans Railway");
const SALON_HOURS     = envStr("SALON_HOURS",     "Heures non configurées — définir SALON_HOURS dans Railway");
const SALON_PRICE_LIST = envStr("SALON_PRICE_LIST", "Prix non configurés — définir SALON_PRICE_LIST dans Railway");
const SALON_CITY       = envStr("SALON_CITY",       "Magog Beach");

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ─── Stores en mémoire ────────────────────────────────────────────────────────
const pending     = new Map(); // token  → payload confirmation email
const dtmfPending = new Map(); // callSid → { resolve, callId, openaiWs }
const callSessions = new Map(); // callSid → { openaiWs, callState, streamSid }

const PENDING_TTL_MS = 20 * 60 * 1000;
function now()        { return Date.now(); }
function publicBase() { return (PUBLIC_BASE_URL || "").replace(/\/$/, ""); }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw = "") {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10)                            return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function formatPhoneDisplay(e164 = "") {
  const d = e164.replace(/^\+1/, "");
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return e164;
}

// ─── Calendly ─────────────────────────────────────────────────────────────────
function calendlyHeaders() {
  return {
    Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function eventTypeUriForService(s) {
  if (s === "homme")      return CALENDLY_EVENT_TYPE_URI_HOMME;
  if (s === "femme")      return CALENDLY_EVENT_TYPE_URI_FEMME;
  if (s === "nonbinaire") return CALENDLY_EVENT_TYPE_URI_NONBINAIRE;
  return null;
}

function labelForService(s) {
  if (s === "homme")      return "coupe homme";
  if (s === "femme")      return "coupe femme";
  if (s === "nonbinaire") return "coupe non binaire";
  return "service";
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

async function calendlyGetAvailableTimes(eventTypeUri) {
  const start = new Date(Date.now() + 5 * 60 * 1000);
  const end   = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const url =
    `https://api.calendly.com/event_type_available_times` +
    `?event_type=${encodeURIComponent(eventTypeUri)}` +
    `&start_time=${encodeURIComponent(start.toISOString())}` +
    `&end_time=${encodeURIComponent(end.toISOString())}`;
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
  const loc  = await calendlyGetEventTypeLocation(eventTypeUri);
  const body = {
    event_type: eventTypeUri,
    start_time: startTimeIso,
    invitee:    { name, email, timezone: CALENDLY_TIMEZONE },
  };
  if (loc) {
    body.location = { kind: loc.kind };
    if (loc.location) body.location.location = loc.location;
  }
  const r = await fetch("https://api.calendly.com/invitees", {
    method: "POST", headers: calendlyHeaders(), body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly failed: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_CALLER_ID) {
    console.warn("[SMS] Config manquante — non envoyé");
    return;
  }
  console.log(`[SMS] → ${to}`);
  await twilioClient.messages.create({ from: TWILIO_CALLER_ID, to, body });
  console.log(`[SMS] ✅ Envoyé → ${to}`);
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(callerNumber) {
  return `Tu es Marie, l'assistante virtuelle chaleureuse du Salon Coco à ${SALON_CITY}.
Tu parles en français québécois, ton ton est naturel, amical et concis.
Maximum 2-3 phrases par réponse. Une seule question à la fois.

INFOS DU SALON :
- Adresse : ${SALON_ADDRESS}
- Heures : ${SALON_HOURS}
- Prix : ${SALON_PRICE_LIST}

NUMÉRO DE L'APPELANT : ${callerNumber || "inconnu"}
(Utilise-le uniquement comme référence interne, ne le mentionne pas au client.)

FLUX RENDEZ-VOUS — suis cet ordre EXACTEMENT :
1. Détermine le type de coupe (homme / femme / non binaire)
2. Appelle get_available_slots(service) → propose 3 créneaux naturellement
3. Confirme le créneau choisi
4. Demande le prénom et nom complet
5. Avant d'appeler collect_phone_dtmf, dis exactement :
   "Parfait! Maintenant, tapez votre numéro de cellulaire à dix chiffres sur le clavier de votre téléphone, puis appuyez sur le dièse."
   → Appelle IMMÉDIATEMENT collect_phone_dtmf après avoir dit cette phrase
   → NE pose AUCUNE autre question avant d'avoir le résultat de collect_phone_dtmf
   → NE demande PAS "quelle est votre numéro" — utilise uniquement collect_phone_dtmf
   → La fonction retourne { phone, phone_display } si succès, ou { error } si échec
6. Quand collect_phone_dtmf retourne un numéro, confirme-le : "J'ai bien le [phone_display]. C'est bien ça?"
   → Si le client confirme → appelle send_booking_link
   → Si le client dit non → appelle collect_phone_dtmf à nouveau
7. Appelle send_booking_link avec le numéro confirmé
8. Dis : "Parfait! J'ai envoyé un lien par texto au [phone_display]. Cliquez dessus pour entrer votre courriel et votre rendez-vous sera confirmé. Bonne journée!"

RÈGLES :
- NE demande JAMAIS l'email par téléphone
- NE demande JAMAIS le numéro vocalement — utilise TOUJOURS collect_phone_dtmf
- NE continue PAS si le client est silencieux — attends sa réponse, ne choisis pas à sa place
- Si le client ne répond pas à une proposition de créneaux, redemande : "Lequel vous convient le mieux, le 1, 2 ou 3?"
- Appelle send_booking_link IMMÉDIATEMENT après avoir confirmé le numéro
- Si transfert demandé → transfer_to_agent
- "l'heure" dans une réponse = le client parle des créneaux, PAS une question sur les heures d'ouverture`;
}

// ─── Outils ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    name: "get_available_slots",
    description: "Récupère les créneaux disponibles pour un type de coupe dans les 7 prochains jours.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", enum: ["homme", "femme", "nonbinaire"] },
      },
      required: ["service"],
    },
  },
  {
    type: "function",
    name: "collect_phone_dtmf",
    description: "Interrompt le stream audio et demande au client de taper son numéro de cellulaire sur le clavier de son téléphone. Retourne le numéro validé en format E.164. DOIT être utilisé à la place de demander le numéro vocalement.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "send_booking_link",
    description: "Envoie un lien SMS pour confirmer le courriel et finaliser le RDV. Appelle après avoir reçu le numéro de collect_phone_dtmf.",
    parameters: {
      type: "object",
      properties: {
        service:  { type: "string", enum: ["homme", "femme", "nonbinaire"] },
        slot_iso: { type: "string", description: "Créneau ISO 8601 UTC" },
        name:     { type: "string", description: "Prénom et nom complet" },
        phone:    { type: "string", description: "Numéro E.164 retourné par collect_phone_dtmf" },
      },
      required: ["service", "slot_iso", "name", "phone"],
    },
  },
  {
    type: "function",
    name: "get_salon_info",
    description: "Retourne adresse, heures ou prix du salon.",
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
    description: "Transfère l'appel à un agent humain.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

// ─── Exécution des function calls ─────────────────────────────────────────────
async function executeTool(name, args, callState, callSid) {
  console.log(`[TOOL] ${name}`, JSON.stringify(args));

  if (name === "get_available_slots") {
    const uri = eventTypeUriForService(args.service);
    if (!uri) return { error: "Type de coupe non configuré." };
    const slots = await calendlyGetAvailableTimes(uri);
    console.log(`[TOOL] ${slots.length} créneaux pour ${args.service}`);
    if (!slots.length) return { slots: [], message: "Aucune disponibilité dans les 7 prochains jours." };
    return {
      service: args.service,
      slots: slots.slice(0, 5).map(iso => ({ iso, label: slotToFrench(iso) })),
    };
  }

  // ── collect_phone_dtmf ────────────────────────────────────────────────────
  // On crée une Promise qui sera résolue quand /phone-collected reçoit les chiffres
  if (name === "collect_phone_dtmf") {
    return new Promise((resolve) => {
      const session = callSessions.get(callSid);
      if (!session) {
        resolve({ error: "Session introuvable." });
        return;
      }

      console.log(`[DTMF] En attente des chiffres pour ${callSid}`);

      // Stocker la callback pour que /phone-collected puisse la résoudre
      dtmfPending.set(callSid, { resolve, callId: null });

      // Rediriger Twilio vers /collect-phone via Twilio REST API
      // (on ne peut pas envoyer de TwiML depuis un WebSocket — on doit
      //  modifier l'appel actif via l'API REST Twilio)
      if (twilioClient && session.twilioCallSid) {
        const collectUrl = `${publicBase()}/collect-phone?callSid=${encodeURIComponent(callSid)}`;
        twilioClient.calls(session.twilioCallSid)
          .update({ url: collectUrl, method: "POST" })
          .then(() => console.log(`[DTMF] Appel redirigé vers ${collectUrl}`))
          .catch(e => {
            console.error("[DTMF] Erreur redirection:", e.message);
            dtmfPending.delete(callSid);
            resolve({ error: "Impossible de rediriger l'appel pour la saisie DTMF." });
          });
      } else {
        console.error("[DTMF] twilioClient ou twilioCallSid manquant");
        resolve({ error: "Configuration Twilio manquante." });
      }

      // Timeout de sécurité : 45 secondes
      setTimeout(() => {
        if (dtmfPending.has(callSid)) {
          console.warn(`[DTMF] Timeout pour ${callSid}`);
          dtmfPending.delete(callSid);
          resolve({ error: "Délai dépassé — le client n'a pas saisi son numéro." });
        }
      }, 45_000);
    });
  }

  if (name === "send_booking_link") {
    console.log(`[TOOL] send_booking_link — phone: "${args.phone}"`);

    const phone = normalizePhone(args.phone) || normalizePhone(callState.callerNumber);
    if (!phone) {
      return { error: "Numéro invalide. Appelle collect_phone_dtmf pour récupérer un numéro valide." };
    }

    const uri = eventTypeUriForService(args.service);
    if (!uri)        return { error: "Type de coupe non configuré." };
    if (!args.slot_iso) return { error: "Créneau manquant." };
    if (!args.name?.trim()) return { error: "Nom manquant." };

    const token = crypto.randomBytes(16).toString("hex");
    pending.set(token, {
      expiresAt: now() + PENDING_TTL_MS,
      payload: {
        phone,
        name:         args.name.trim(),
        service:      args.service,
        eventTypeUri: uri,
        startTimeIso: args.slot_iso,
      },
    });

    const link = `${publicBase()}/confirm-email/${token}`;

    try {
      await sendSms(
        phone,
        `Salon Coco — Bonjour ${args.name}!\n` +
        `Pour finaliser votre rendez-vous du ${slotToFrench(args.slot_iso)}, ` +
        `veuillez saisir votre courriel ici (lien valide 20 min) :\n${link}`
      );
    } catch (e) {
      console.error("[TOOL] Erreur SMS:", e.message);
      return { error: `Erreur SMS : ${e.message}` };
    }

    return {
      success:    true,
      phone_used: phone,
      message:    `SMS envoyé au ${formatPhoneDisplay(phone)}. Dis au client de vérifier ses textos.`,
    };
  }

  if (name === "get_salon_info") {
    if (args.topic === "adresse") return { adresse: SALON_ADDRESS };
    if (args.topic === "heures")  return { heures: SALON_HOURS };
    if (args.topic === "prix")    return { prix: SALON_PRICE_LIST };
    return { error: "Sujet inconnu." };
  }

  if (name === "transfer_to_agent") {
    console.log("[TOOL] Transfert demandé");
    callState.shouldTransfer = true;
    return { transferring: true };
  }

  return { error: `Fonction inconnue : ${name}` };
}

// ─── Routes HTTP ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ ok: true, salon: "Salon Coco" }));

// Debug temporaire — retire cette route une fois les variables confirmées
app.get("/debug-env", (req, res) => {
  res.json({
    SALON_ADDRESS,
    SALON_HOURS,
    SALON_PRICE_LIST,
    SALON_CITY,
    CALENDLY_TIMEZONE,
    OPENAI_TTS_VOICE,
    PUBLIC_BASE_URL:    publicBase(),
    TWILIO_CALLER_ID:   TWILIO_CALLER_ID   ? '✅ défini' : '❌ manquant',
    CALENDLY_API_TOKEN: CALENDLY_API_TOKEN ? '✅ défini' : '❌ manquant',
    OPENAI_API_KEY:     OPENAI_API_KEY     ? '✅ défini' : '❌ manquant',
    _raw: {
      SALON_ADDRESS:    process.env.SALON_ADDRESS    || '(vide)',
      SALON_HOURS:      process.env.SALON_HOURS      || '(vide)',
      SALON_PRICE_LIST: process.env.SALON_PRICE_LIST || '(vide)',
      SALON_CITY:       process.env.SALON_CITY       || '(vide)',
    },
  });
});

// Entrée d'appel Twilio
app.post("/voice", (req, res) => {
  const wsUrl      = publicBase().replace(/^https/, "wss").replace(/^http/, "ws");
  const callerSid  = req.body.CallSid || "";
  const callerFrom = req.body.From    || "";

  console.log(`[VOICE] Appel entrant — CallSid: ${callerSid} — From: ${callerFrom}`);

  // Stocker le CallSid Twilio pour pouvoir rediriger l'appel plus tard (DTMF)
  // On l'associera au callSid WebSocket dans le handler "start"
  // Ici on le stocke temporairement avec le From comme clé
  callSessions.set(`pending_${callerFrom}`, { twilioCallSid: callerSid, callerNumber: callerFrom });

  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `${wsUrl}/media-stream` });
  stream.parameter({ name: "callerNumber", value: callerFrom });
  stream.parameter({ name: "twilioCallSid", value: callerSid });

  res.type("text/xml").send(twiml.toString());
});

// Page DTMF : Twilio redirige ici pour collecter le numéro
app.post("/collect-phone", (req, res) => {
  const callSid = req.query.callSid || "";
  console.log(`[DTMF] /collect-phone — callSid: ${callSid}`);

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input:          "dtmf",
    numDigits:      10,
    timeout:        15,
    finishOnKey:    "#",
    action:         `${publicBase()}/phone-collected?callSid=${encodeURIComponent(callSid)}`,
    method:         "POST",
  });
  gather.say({ language: "fr-CA", voice: "alice" },
    "Veuillez taper votre numéro de cellulaire à dix chiffres, puis appuyez sur le dièse."
  );

  // Si aucune touche en 15s
  twiml.say({ language: "fr-CA", voice: "alice" },
    "Je n'ai pas reçu de numéro. Je vous retourne à Marie."
  );
  twiml.redirect({
    method: "POST",
  }, `${publicBase()}/resume-stream?callSid=${encodeURIComponent(callSid)}&error=timeout`);

  res.type("text/xml").send(twiml.toString());
});

// Réception des chiffres DTMF
app.post("/phone-collected", (req, res) => {
  const callSid = req.query.callSid || "";
  const digits  = (req.body.Digits || "").replace(/\D/g, "");

  console.log(`[DTMF] /phone-collected — callSid: ${callSid} — digits: ${digits}`);

  const phone = normalizePhone(digits);
  const entry = dtmfPending.get(callSid);

  if (entry) {
    dtmfPending.delete(callSid);
    if (phone) {
      console.log(`[DTMF] ✅ Numéro validé: ${phone}`);
      entry.resolve({
        phone,
        phone_display: formatPhoneDisplay(phone),
        message: `Numéro reçu : ${formatPhoneDisplay(phone)}. Confirme ce numéro au client puis appelle send_booking_link.`,
      });
    } else {
      console.warn(`[DTMF] ❌ Numéro invalide: "${digits}"`);
      entry.resolve({
        error: `Numéro invalide (${digits}). Demande au client de retaper son numéro — rappelle collect_phone_dtmf.`,
      });
    }
  } else {
    console.warn(`[DTMF] Aucune entrée pending pour ${callSid}`);
  }

  // Reprendre le stream OpenAI Realtime
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const wsUrl   = publicBase().replace(/^https/, "wss").replace(/^http/, "ws");
  const stream  = connect.stream({ url: `${wsUrl}/media-stream` });

  const session = callSessions.get(callSid);
  stream.parameter({ name: "callerNumber",  value: session?.callerNumber  || "" });
  stream.parameter({ name: "twilioCallSid", value: session?.twilioCallSid || "" });
  stream.parameter({ name: "resumeSession", value: "true" });

  res.type("text/xml").send(twiml.toString());
});

// ─── WebSocket : Twilio ↔ OpenAI Realtime ────────────────────────────────────
wss.on("connection", (twilioWs) => {
  console.log("[WS] Nouvelle connexion Twilio");

  let openaiWs         = null;
  let streamSid        = null;
  let callSid          = null;
  let heartbeatInterval = null;
  let isResuming    = false;
  let callState     = { callerNumber: "", shouldTransfer: false };
  let pendingTools  = new Map();
  let sessionReady  = false;

  // ── Ouvrir OpenAI Realtime ─────────────────────────────────────────────
  openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta":  "realtime=v1",
      },
    }
  );

  function initSession(resume = false) {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || sessionReady) return;
    sessionReady = true;

    console.log(`[OpenAI] Init session — caller: ${callState.callerNumber} — resume: ${resume}`);

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,              // plus élevé = moins sensible au bruit ambiant
          prefix_padding_ms: 300,       // attendre 300ms avant de considérer parole
          silence_duration_ms: 800,     // attendre 800ms de silence avant de couper le tour
        },
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice:               OPENAI_TTS_VOICE,
        instructions:        buildSystemPrompt(callState.callerNumber),
        tools:               TOOLS,
        tool_choice:         "auto",
        modalities:          ["text", "audio"],
        temperature:         0.7,
      },
    }));

    if (!resume) {
      // Première connexion : message d'accueil
      openaiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message", role: "user",
          content: [{ type: "input_text", text: "L'appel commence. Dis bonjour et présente les options." }],
        },
      }));
      openaiWs.send(JSON.stringify({ type: "response.create" }));
    }
    // Si resume : OpenAI reprend naturellement avec le contexte existant
    // Les function_call_output seront injectés par executeTool via la Promise
  }

  openaiWs.on("open", () => {
    console.log("[OpenAI] WebSocket ouvert — attente du message start Twilio");

    // Heartbeat toutes les 10s pour garder la connexion WebSocket vivante sur Railway
    heartbeatInterval = setInterval(() => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.ping();
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 10_000);
  });

  // ── Messages OpenAI ────────────────────────────────────────────────────
  openaiWs.on("message", async (rawData) => {
    let event;
    try { event = JSON.parse(rawData); } catch { return; }

    switch (event.type) {

      case "response.audio.delta":
        if (event.delta && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: "media", streamSid,
            media: { payload: event.delta },
          }));
        }
        break;

      case "response.output_item.added":
        if (event.item?.type === "function_call") {
          pendingTools.set(event.item.call_id, { name: event.item.name, args: "" });
          console.log(`[OpenAI] Function call: ${event.item.name} (${event.item.call_id})`);
        }
        break;

      case "response.function_call_arguments.delta": {
        const t = pendingTools.get(event.call_id);
        if (t) t.args += (event.delta || "");
        break;
      }

      case "response.function_call_arguments.done": {
        const tool = pendingTools.get(event.call_id);
        if (!tool) break;

        let args = {};
        try { args = JSON.parse(event.arguments || tool.args || "{}"); } catch {}

        // executeTool peut être async longue durée (ex: collect_phone_dtmf attend 45s max)
        const result = await executeTool(tool.name, args, callState, callSid)
          .catch(e => ({ error: e.message }));

        console.log(`[TOOL RESULT] ${tool.name}:`, JSON.stringify(result));

        if (callState.shouldTransfer) {
          setTimeout(() => {
            if (twilioWs.readyState === WebSocket.OPEN)
              twilioWs.send(JSON.stringify({ event: "stop", streamSid }));
          }, 2500);
          pendingTools.delete(event.call_id);
          break;
        }

        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: event.call_id,
              output: JSON.stringify(result),
            },
          }));
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }

        pendingTools.delete(event.call_id);
        break;
      }

      case "error":
        console.error("[OpenAI ERROR]", JSON.stringify(event.error));
        break;
    }
  });

  openaiWs.on("close", (c) => {
    console.log(`[OpenAI] Fermé (${c})`);
    clearInterval(heartbeatInterval);
  });
  openaiWs.on("error",  (e) => console.error("[OpenAI WS]", e.message));

  // ── Messages Twilio ────────────────────────────────────────────────────
  twilioWs.on("message", (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }

    switch (msg.event) {

      case "start": {
        streamSid  = msg.start.streamSid;
        const p    = msg.start.customParameters || {};
        isResuming = p.resumeSession === "true";

        callState.callerNumber = p.callerNumber  || "";
        const twilioCallSid    = p.twilioCallSid || "";

        // Utiliser le streamSid comme clé de session stable
        callSid = streamSid;

        // Récupérer ou créer la session
        let existingSession = null;
        // Chercher la session par callerNumber (créée dans /voice)
        const pendingKey = `pending_${callState.callerNumber}`;
        if (callSessions.has(pendingKey)) {
          existingSession = callSessions.get(pendingKey);
          callSessions.delete(pendingKey);
        }

        callSessions.set(callSid, {
          openaiWs,
          callState,
          streamSid,
          twilioCallSid: twilioCallSid || existingSession?.twilioCallSid || "",
          callerNumber:  callState.callerNumber,
        });

        // Si c'est un resume post-DTMF, mettre à jour la session existante
        if (isResuming) {
          // Retrouver l'ancienne session par callerNumber pour migrer le dtmfPending
          console.log(`[Twilio] Resume stream — ${streamSid}`);
          // La Promise collect_phone_dtmf est déjà résolue via /phone-collected
          // OpenAI va recevoir le function_call_output et continuer
        } else {
          console.log(`[Twilio] Nouveau stream — ${streamSid} — caller: ${callState.callerNumber}`);
        }

        if (openaiWs.readyState === WebSocket.OPEN) {
          initSession(isResuming);
        } else {
          openaiWs.once("open", () => initSession(isResuming));
        }
        break;
      }

      case "media":
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type:  "input_audio_buffer.append",
            audio: msg.media.payload,
          }));
        }
        break;

      case "stop":
        console.log("[Twilio] Stream arrêté");
        if (!isResuming) openaiWs?.close();
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("[Twilio] WS fermé");
    clearInterval(heartbeatInterval);
    if (!isResuming) openaiWs?.close();
  });

  twilioWs.on("error", (e) => console.error("[Twilio WS]", e.message));
});

// ════════════════════════════════════════════════════════════════════════════════
// PAGE WEB : saisie email + création RDV
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
    return res.status(400).setHeader("Content-Type", "text/html")
      .send(htmlConfirmForm(name, "Adresse courriel invalide. Veuillez réessayer."));
  }

  try {
    const result        = await calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email });
    pending.delete(req.params.token);

    const cancelUrl     = result?.resource?.cancel_url     || "";
    const rescheduleUrl = result?.resource?.reschedule_url || "";
    const slotLabel     = slotToFrench(startTimeIso);

    await sendSms(phone,
      `✅ Votre rendez-vous au Salon Coco est confirmé!\n\n` +
      `👤 Nom        : ${name}\n` +
      `✉️ Courriel   : ${email}\n` +
      `✂️ Service    : ${labelForService(service)}\n` +
      `📅 Date/heure : ${slotLabel}\n` +
      `📍 Adresse    : ${SALON_ADDRESS}\n\n` +
      (rescheduleUrl ? `📆 Modifier : ${rescheduleUrl}\n` : "") +
      (cancelUrl     ? `❌ Annuler  : ${cancelUrl}\n`     : "") +
      `\nNous avons hâte de vous accueillir! — Salon Coco`
    );

    res.setHeader("Content-Type", "text/html")
       .send(htmlSuccess(name, slotLabel, rescheduleUrl, cancelUrl));
  } catch (e) {
    console.error("Erreur confirm-email:", e);
    res.status(500).setHeader("Content-Type", "text/html").send(htmlError(e.message));
  }
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
function htmlLayout(title, content) {
  return `<!DOCTYPE html><html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Salon Coco</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f5f4ff;min-height:100vh;
       display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#fff;border-radius:16px;padding:36px 32px;max-width:460px;
        width:100%;box-shadow:0 4px 24px rgba(108,71,255,.12)}
  .logo{font-size:1.6rem;font-weight:700;color:#6c47ff;margin-bottom:4px}
  .sub{color:#888;font-size:.9rem;margin-bottom:28px}
  h1{font-size:1.25rem;color:#1a1a1a;margin-bottom:10px}
  p{color:#555;font-size:.95rem;line-height:1.5;margin-bottom:20px}
  label{display:block;font-size:.85rem;font-weight:600;color:#333;margin-bottom:6px}
  input[type=email]{width:100%;padding:13px 14px;font-size:1rem;
    border:1.5px solid #ddd;border-radius:10px;outline:none;transition:border-color .2s}
  input[type=email]:focus{border-color:#6c47ff}
  .btn{display:block;width:100%;margin-top:16px;padding:14px;background:#6c47ff;
       color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;
       cursor:pointer;transition:background .2s}
  .btn:hover{background:#5538d4}
  .err{color:#c0392b;font-size:.88rem;margin-top:8px}
  .detail{background:#f5f4ff;border-radius:10px;padding:16px 18px;
          margin:20px 0;font-size:.92rem;line-height:1.8;color:#333}
  a.lnk{display:block;margin-top:12px;color:#6c47ff;font-size:.9rem;text-decoration:none}
  a.lnk:hover{text-decoration:underline}
  .muted{color:#aaa;font-size:.8rem;margin-top:24px}
</style></head>
<body><div class="card">
  <div class="logo">✂️ Salon Coco</div>
  <div class="sub">Confirmation de rendez-vous</div>
  ${content}
</div></body></html>`;
}

function htmlConfirmForm(name = "", error = "") {
  return htmlLayout("Confirmer votre courriel", `
    <h1>Bonjour ${name}!</h1>
    <p>Votre créneau est réservé. Entrez votre adresse courriel pour finaliser —
       vous recevrez ensuite tous les détails par message texte.</p>
    <form method="POST">
      <label for="email">Adresse courriel</label>
      <input id="email" name="email" type="email" required
             placeholder="vous@exemple.com" autocomplete="email" inputmode="email"/>
      ${error ? `<p class="err">⚠️ ${error}</p>` : ""}
      <button class="btn" type="submit">Confirmer mon rendez-vous</button>
    </form>
    <p class="muted">Ce lien est valide 20 minutes.</p>`);
}

function htmlSuccess(name, slotLabel, rescheduleUrl, cancelUrl) {
  return htmlLayout("Rendez-vous confirmé", `
    <h1>✅ Rendez-vous confirmé!</h1>
    <p>Merci <strong>${name}</strong>! Votre rendez-vous est bien enregistré.</p>
    <div class="detail">📅 <strong>${slotLabel}</strong><br>📍 ${SALON_ADDRESS}</div>
    <p>Un message texte de confirmation vient d'être envoyé sur votre cellulaire.</p>
    ${rescheduleUrl ? `<a class="lnk" href="${rescheduleUrl}">📆 Modifier le rendez-vous</a>` : ""}
    ${cancelUrl     ? `<a class="lnk" href="${cancelUrl}">❌ Annuler le rendez-vous</a>`     : ""}
    <p class="muted">Vous pouvez fermer cette page.</p>`);
}

function htmlError(msg) {
  return htmlLayout("Erreur", `
    <h1>⚠️ Une erreur est survenue</h1>
    <p>Impossible de créer le rendez-vous. Veuillez rappeler le salon.</p>
    <pre style="font-size:.75rem;color:#c0392b;white-space:pre-wrap;margin-top:12px">${msg}</pre>`);
}

function html410() {
  return htmlLayout("Lien expiré", `
    <h1>⏰ Lien expiré</h1>
    <p>Ce lien n'est plus valide (20 min). Veuillez rappeler le salon pour un nouveau lien.</p>`);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
httpServer.listen(port, () =>
  console.log(`✅ Salon Coco — serveur prêt sur le port ${port}`)
);
