/**
 * Salon Coco — Agent téléphonique IA
 * Architecture : Twilio Media Streams ↔ OpenAI Realtime API (gpt-4o-realtime-preview)
 *
 * Flux :
 *  1. Appel entrant → Twilio → POST /voice → TwiML <Stream> vers /media-stream
 *  2. WebSocket Twilio ↔ serveur ↔ WebSocket OpenAI Realtime
 *  3. OpenAI gère la conversation et appelle des fonctions (Calendly, SMS, etc.)
 *  4. Le serveur exécute les fonctions et retourne les résultats à OpenAI
 *  5. OpenAI répond en audio → Twilio → client
 */

import express         from "express";
import crypto          from "crypto";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import twilio          from "twilio";

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
  SALON_ADDRESS                   = "123 Saint-Jacques Ouest, Montréal",
  SALON_HOURS                     = "lundi au vendredi de 9h à 17h",
  SALON_PRICE_LIST                = "Coupe homme : 25 $. Coupe femme : 45 $. Coupe non binaire : 35 $.",
} = process.env;

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// Pending tokens pour la page de confirmation email
const pending = new Map();
const PENDING_TTL_MS = 20 * 60 * 1000;
function now() { return Date.now(); }
function publicBase() { return (PUBLIC_BASE_URL || "").replace(/\/$/, ""); }

// ─── Helpers Calendly ─────────────────────────────────────────────────────────
function calendlyHeaders() {
  return {
    Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function eventTypeUriForService(service) {
  if (service === "homme")      return CALENDLY_EVENT_TYPE_URI_HOMME;
  if (service === "femme")      return CALENDLY_EVENT_TYPE_URI_FEMME;
  if (service === "nonbinaire") return CALENDLY_EVENT_TYPE_URI_NONBINAIRE;
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
  const r = await fetch("https://api.calendly.com/invitees", {
    method: "POST", headers: calendlyHeaders(), body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendly failed: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_CALLER_ID) return;
  await twilioClient.messages.create({ from: TWILIO_CALLER_ID, to, body });
}

// ─── System prompt OpenAI ─────────────────────────────────────────────────────
function buildSystemPrompt() {
  return `Tu es Marie, l'assistante virtuelle chaleureuse et professionnelle du Salon Coco, un salon de coiffure à Montréal.
Tu parles exclusivement en français québécois, avec un ton naturel, amical et concis.
Tu réponds toujours de façon courte et conversationnelle — pas de longues listes, pas de texte robotique.

INFORMATIONS DU SALON :
- Adresse : ${SALON_ADDRESS}
- Heures d'ouverture : ${SALON_HOURS}
- Prix : ${SALON_PRICE_LIST}

TES CAPACITÉS :
1. Prendre des rendez-vous (coupe homme, femme, ou non binaire)
2. Donner les prix, l'adresse, les heures d'ouverture
3. Transférer à un agent humain si demandé ou si tu ne peux pas aider

RÈGLES IMPORTANTES :
- Sois naturelle et chaleureuse, comme une vraie réceptionniste
- Ne pose qu'une seule question à la fois
- Si le client veut un rendez-vous, utilise get_available_slots pour voir les disponibilités avant de proposer des créneaux
- Pour créer un rendez-vous, tu as besoin : du type de coupe, du créneau choisi, du prénom + nom, et du numéro de téléphone cellulaire
- Une fois que tu as le numéro de téléphone, utilise send_booking_link pour envoyer le lien de confirmation — NE demande PAS l'email par téléphone
- Si le client veut parler à quelqu'un, utilise transfer_to_agent
- Si tu ne comprends pas après 2 tentatives, propose de transférer à un agent

FLUX RENDEZ-VOUS :
1. Demande le type de coupe (si pas déjà mentionné)
2. Appelle get_available_slots avec le type
3. Propose les 3 premiers créneaux naturellement (ex: "J'ai lundi à 14h, mardi à 10h ou jeudi à 15h30, ça vous convient lequel?")
4. Demande le prénom et nom
5. Demande le numéro de cellulaire
6. Appelle send_booking_link — dis au client de vérifier ses textos pour finaliser
7. Confirme chaleureusement et souhaite une belle journée`;
}

// ─── Définition des outils (function calls) ──────────────────────────────────
const TOOLS = [
  {
    type: "function",
    name: "get_available_slots",
    description: "Récupère les créneaux disponibles pour un type de coupe dans les 7 prochains jours.",
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          enum: ["homme", "femme", "nonbinaire"],
          description: "Le type de coupe : homme, femme ou nonbinaire",
        },
      },
      required: ["service"],
    },
  },
  {
    type: "function",
    name: "send_booking_link",
    description: "Enregistre la réservation et envoie un lien SMS au client pour qu'il saisisse son courriel et confirme son rendez-vous.",
    parameters: {
      type: "object",
      properties: {
        service:      { type: "string", enum: ["homme", "femme", "nonbinaire"] },
        slot_iso:     { type: "string", description: "Créneau choisi en format ISO 8601 UTC" },
        name:         { type: "string", description: "Prénom et nom du client" },
        phone:        { type: "string", description: "Numéro de téléphone en format E.164, ex: +15141234567" },
      },
      required: ["service", "slot_iso", "name", "phone"],
    },
  },
  {
    type: "function",
    name: "get_salon_info",
    description: "Retourne les informations du salon : adresse, heures d'ouverture, ou liste de prix.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["adresse", "heures", "prix"],
          description: "Le sujet de la question",
        },
      },
      required: ["topic"],
    },
  },
  {
    type: "function",
    name: "transfer_to_agent",
    description: "Transfère l'appel à un agent humain du salon.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

// ─── Exécution des function calls ─────────────────────────────────────────────
async function executeTool(name, args, callState) {
  console.log(`[TOOL] ${name}`, args);

  if (name === "get_available_slots") {
    const uri = eventTypeUriForService(args.service);
    if (!uri) return { error: "Ce type de coupe n'est pas configuré." };

    const slots = await calendlyGetAvailableTimes(uri);
    if (!slots.length) return { slots: [], message: "Aucune disponibilité dans les 7 prochains jours." };

    const top = slots.slice(0, 5);
    return {
      service: args.service,
      slots: top.map(iso => ({
        iso,
        label: slotToFrench(iso),
      })),
    };
  }

  if (name === "send_booking_link") {
    // Normaliser le téléphone
    const digits = (args.phone || "").replace(/\D/g, "");
    let phone = null;
    if (digits.length === 10)                           phone = `+1${digits}`;
    else if (digits.length === 11 && digits[0] === "1") phone = `+${digits}`;
    else                                                phone = callState.callerNumber || null;

    if (!phone) return { error: "Numéro de téléphone invalide." };

    const uri = eventTypeUriForService(args.service);
    if (!uri) return { error: "Type de coupe non configuré." };

    const token = crypto.randomBytes(16).toString("hex");
    pending.set(token, {
      expiresAt: now() + PENDING_TTL_MS,
      payload: {
        phone,
        name:         args.name,
        service:      args.service,
        eventTypeUri: uri,
        startTimeIso: args.slot_iso,
      },
    });

    const link = `${publicBase()}/confirm-email/${token}`;
    await sendSms(
      phone,
      `Salon Coco — Bonjour ${args.name}!\n` +
      `Pour finaliser votre rendez-vous du ${slotToFrench(args.slot_iso)}, ` +
      `veuillez saisir votre courriel ici (lien valide 20 min) :\n${link}`
    );

    return {
      success: true,
      message: `Lien envoyé au ${phone}. Le client doit cliquer le lien dans ses textos pour confirmer avec son courriel.`,
    };
  }

  if (name === "get_salon_info") {
    if (args.topic === "adresse") return { adresse: SALON_ADDRESS };
    if (args.topic === "heures")  return { heures: SALON_HOURS };
    if (args.topic === "prix")    return { prix: SALON_PRICE_LIST };
    return { error: "Sujet inconnu." };
  }

  if (name === "transfer_to_agent") {
    callState.shouldTransfer = true;
    return { transferring: true };
  }

  return { error: `Fonction inconnue : ${name}` };
}

// ─── Route HTTP : entrée d'appel Twilio ───────────────────────────────────────
app.get("/", (req, res) => res.json({ ok: true, salon: "Salon Coco" }));

app.post("/voice", (req, res) => {
  const wsUrl = publicBase().replace(/^https/, "wss").replace(/^http/, "ws");

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `${wsUrl}/media-stream` });
  // Passer le numéro appelant au WebSocket via paramètre
  stream.parameter({ name: "callerNumber", value: req.body.From || "" });

  res.type("text/xml").send(twiml.toString());
});

// ─── WebSocket : Twilio Media Stream ↔ OpenAI Realtime ───────────────────────
wss.on("connection", (twilioWs) => {
  console.log("[WS] Connexion Twilio entrante");

  let openaiWs       = null;
  let streamSid      = null;
  let callState      = { callerNumber: "", shouldTransfer: false };
  let pendingTools   = new Map(); // call_id → args en attente

  // ── Ouvrir la connexion OpenAI Realtime ──────────────────────────────────
  openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta":  "realtime=v1",
      },
    }
  );

  // ── OpenAI connecté : envoyer la config de session ───────────────────────
  openaiWs.on("open", () => {
    console.log("[OpenAI] Connecté au Realtime");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection:    { type: "server_vad" },
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice:             OPENAI_TTS_VOICE,
        instructions:      buildSystemPrompt(),
        tools:             TOOLS,
        tool_choice:       "auto",
        modalities:        ["text", "audio"],
        temperature:       0.7,
      },
    }));

    // Message d'accueil initial
    openaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "L'appel vient de commencer. Dis bonjour chaleureusement et présente les options." }],
      },
    }));
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  });

  // ── Messages entrants depuis OpenAI ──────────────────────────────────────
  openaiWs.on("message", async (data) => {
    let event;
    try { event = JSON.parse(data); } catch { return; }

    // Audio → renvoyer à Twilio
    if (event.type === "response.audio.delta" && event.delta) {
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: event.delta },
        }));
      }
    }

    // Function call reçu — accumuler les arguments
    if (event.type === "response.function_call_arguments.delta") {
      const existing = pendingTools.get(event.call_id) || { name: "", args: "" };
      existing.args += event.delta;
      pendingTools.set(event.call_id, existing);
    }

    // Nom de la fonction associé au call_id
    if (event.type === "response.output_item.added" &&
        event.item?.type === "function_call") {
      pendingTools.set(event.item.call_id, {
        name: event.item.name,
        args: "",
      });
    }

    // Function call complet — exécuter
    if (event.type === "response.function_call_arguments.done") {
      const tool = pendingTools.get(event.call_id);
      if (!tool) return;

      let parsedArgs = {};
      try { parsedArgs = JSON.parse(event.arguments || tool.args || "{}"); } catch {}

      const result = await executeTool(tool.name, parsedArgs, callState).catch(e => ({
        error: e.message,
      }));

      console.log(`[TOOL RESULT] ${tool.name}:`, result);

      // Si transfert demandé, raccrocher et transférer via Twilio REST
      if (callState.shouldTransfer) {
        if (twilioWs.readyState === WebSocket.OPEN) {
          // Laisser OpenAI finir de parler puis terminer le stream
          setTimeout(() => {
            twilioWs.send(JSON.stringify({ event: "stop", streamSid }));
          }, 2000);
        }
        // On ne retourne pas le résultat à OpenAI pour un transfert
        pendingTools.delete(event.call_id);
        return;
      }

      // Retourner le résultat à OpenAI pour qu'il continue la conversation
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type:    "function_call_output",
            call_id: event.call_id,
            output:  JSON.stringify(result),
          },
        }));
        openaiWs.send(JSON.stringify({ type: "response.create" }));
      }

      pendingTools.delete(event.call_id);
    }

    // Erreurs OpenAI
    if (event.type === "error") {
      console.error("[OpenAI ERROR]", event.error);
    }
  });

  openaiWs.on("close",  () => console.log("[OpenAI] Déconnecté"));
  openaiWs.on("error", (e) => console.error("[OpenAI WS error]", e.message));

  // ── Messages entrants depuis Twilio ──────────────────────────────────────
  twilioWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      // Récupérer le numéro appelant depuis les paramètres custom
      const params = msg.start.customParameters || {};
      callState.callerNumber = params.callerNumber || "";
      console.log(`[Twilio] Stream démarré — ${streamSid} — caller: ${callState.callerNumber}`);
    }

    // Audio du client → OpenAI
    if (msg.event === "media" && openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type:  "input_audio_buffer.append",
        audio: msg.media.payload,
      }));
    }

    if (msg.event === "stop") {
      console.log("[Twilio] Stream terminé");
      openaiWs?.close();
    }
  });

  twilioWs.on("close", () => {
    console.log("[Twilio] WebSocket fermé");
    openaiWs?.close();
  });

  twilioWs.on("error", (e) => console.error("[Twilio WS error]", e.message));
});

// ════════════════════════════════════════════════════════════════════════════════
// PAGE WEB : saisie email + création RDV Calendly
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
    const result       = await calendlyCreateInvitee({ eventTypeUri, startTimeIso, name, email });
    pending.delete(req.params.token);

    const cancelUrl     = result?.resource?.cancel_url     || "";
    const rescheduleUrl = result?.resource?.reschedule_url || "";
    const slotLabel     = slotToFrench(startTimeIso);

    await sendSms(
      phone,
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

// ─── HTML helpers ─────────────────────────────────────────────────────────────
function htmlLayout(title, content) {
  return `<!DOCTYPE html>
<html lang="fr"><head>
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
    <p>Un message texte de confirmation avec tous les détails vient d'être envoyé sur votre cellulaire.</p>
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
    <p>Ce lien n'est plus valide (durée : 20 minutes).
       Veuillez rappeler le Salon Coco pour obtenir un nouveau lien.</p>`);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000;
httpServer.listen(port, () =>
  console.log(`✅ Salon Coco — serveur prêt sur le port ${port}`)
);
