/**
 * Salon Coco — Agent téléphonique IA v9
 *
 * Collecte du numéro de téléphone :
 *  1. Marie propose d'envoyer la confirmation au numéro appelant
 *  2. Si le client confirme → on utilise ce numéro directement
 *  3. Si non → Marie demande le numéro vocalement, le répète chiffre par chiffre,
 *     le client confirme avant d'aller plus loin
 *
 * Plus de redirection DTMF — tout reste dans OpenAI Realtime.
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
  OPENAI_TTS_VOICE      = "coral",
  CALENDLY_TIMEZONE     = "America/Toronto",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
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
const sessions = new Map(); // twilioCallSid → session
const pending  = new Map(); // token → { expiresAt, payload }

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

// ─── Google OAuth token (sauvegardé en mémoire après /oauth/callback) ──────────
let googleTokens = null; // { access_token, refresh_token, expiry_date }

async function getGoogleAccessToken() {
  if (!googleTokens) return null;
  // Refresh si expiré
  if (googleTokens.expiry_date && Date.now() > googleTokens.expiry_date - 60_000) {
    try {
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id:     GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: googleTokens.refresh_token,
          grant_type:    "refresh_token",
        }),
      });
      const j = await r.json();
      if (j.access_token) {
        googleTokens.access_token  = j.access_token;
        googleTokens.expiry_date   = Date.now() + (j.expires_in || 3600) * 1000;
        console.log("[GOOGLE] Token rafraîchi");
      }
    } catch (e) { console.warn("[GOOGLE] Erreur refresh:", e.message); }
  }
  return googleTokens.access_token;
}

async function lookupClientByPhone(phone) {
  const token = await getGoogleAccessToken();
  if (!token) { console.warn("[LOOKUP] Pas de token Google"); return null; }

  try {
    // Chercher dans tous les contacts par numéro de téléphone
    const r = await fetch(
      `https://people.googleapis.com/v1/people:searchContacts` +
      `?query=${encodeURIComponent(phone)}&readMask=names,emailAddresses,phoneNumbers`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = await r.json();
    const results = j.results || [];

    for (const result of results) {
      const person = result.person;
      // Vérifier que le téléphone correspond exactement
      const phones = person.phoneNumbers || [];
      const match  = phones.find(p => normalizePhone(p.value || "") === phone);
      if (match) {
        const name  = person.names?.[0]?.displayName || null;
        const email = person.emailAddresses?.[0]?.value || null;
        console.log(`[LOOKUP] ✅ Trouvé: ${name} (${email})`);
        return { name, email, found: true };
      }
    }

    // Essai avec format local (sans +1)
    const local = phone.replace(/^\+1/, "");
    const r2 = await fetch(
      `https://people.googleapis.com/v1/people:searchContacts` +
      `?query=${encodeURIComponent(local)}&readMask=names,emailAddresses,phoneNumbers`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j2 = await r2.json();
    for (const result of (j2.results || [])) {
      const person = result.person;
      const phones = person.phoneNumbers || [];
      const match  = phones.find(p => normalizePhone(p.value || "") === phone);
      if (match) {
        const name  = person.names?.[0]?.displayName || null;
        const email = person.emailAddresses?.[0]?.value || null;
        console.log(`[LOOKUP] ✅ Trouvé (local): ${name} (${email})`);
        return { name, email, found: true };
      }
    }

    console.log(`[LOOKUP] Nouveau client: ${phone}`);
    return null;
  } catch (e) {
    console.warn("[LOOKUP] Erreur:", e.message);
    return null;
  }
}

async function saveContactToGoogle({ name, email, phone }) {
  const token = await getGoogleAccessToken();
  if (!token) {
    console.warn("[GOOGLE] ❌ saveContact — pas de token Google. Visite /oauth/start pour connecter.");
    return;
  }
  try {
    const r = await fetch("https://people.googleapis.com/v1/people:createContact", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        names:          [{ displayName: name, givenName: name.split(" ")[0], familyName: name.split(" ").slice(1).join(" ") }],
        emailAddresses: email ? [{ value: email }] : [],
        phoneNumbers:   [{ value: phone, type: "mobile" }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      console.error(`[GOOGLE] ❌ Erreur création contact: ${r.status}`, JSON.stringify(j));
      // Si erreur 403 = scope insuffisant
      if (r.status === 403) {
        console.error("[GOOGLE] ❌ Scope insuffisant — revisite /oauth/start (scope contacts requis, pas contacts.readonly)");
      }
      return;
    }
    console.log(`[GOOGLE] ✅ Contact créé: ${name} (${email}) — ${phone}`);
  } catch (e) {
    console.error("[GOOGLE] ❌ Erreur création contact:", e.message);
  }
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
  const callerDisplay = callerNumber ? fmtPhone(callerNumber) : null;

  return `Tu es Marie, la réceptionniste pétillante du ${SALON_NAME} à ${SALON_CITY}!
Tu ADORES ton travail. Tu es énergique, chaleureuse et naturelle.
Tu parles en français québécois authentique. Tu es TOUJOURS enthousiaste et rayonnante — peu importe l'heure ou le contexte, ton énergie ne baisse jamais.

RÈGLE ABSOLUE SUR LES EXPRESSIONS — tu dois varier à chaque réplique, JAMAIS deux fois la même de suite :
- Pour acquiescer : "Excellent!", "D'accord!", "C'est beau!", "Génial!", "Super!", "Ok super!", "Très bien!", "Wow, super!", "Absolument!", "Ben oui!", "Pour sûr!"
- Pour patienter  : "Laisse-moi vérifier ça!", "Une seconde!", "Je regarde ça!", "Je vérifie pour toi tout de suite!"
- Pour approuver  : "Super choix!", "Bonne idée!", "Pas de problème!", "Avec plaisir!", "C'est noté!"
- INTERDIT ABSOLU : dire "Parfait" — ce mot est BANNI pour tout l'appel, ne l'utilise JAMAIS
- INTERDIT : commencer deux répliques consécutives par le même mot
- À chaque réplique, choisis un mot d'acquiescement DIFFÉRENT de celui utilisé juste avant
Réponses courtes — max 2 phrases. Une seule question à la fois.

INFOS DU SALON :
- Adresse : ${SALON_ADDRESS}
- Heures : ${SALON_HOURS}
- Prix : ${SALON_PRICE_LIST}

NUMÉRO APPELANT : ${callerNumber || "inconnu"} ${callerDisplay ? `(${callerDisplay})` : ""}

═══════════════════════════════════
FLUX RENDEZ-VOUS — étape par étape
═══════════════════════════════════

ÉTAPE 0 — Reconnaissance client (si numéro appelant disponible)
  → Si tu as un numéro appelant, appelle lookup_existing_client EN PREMIER
  → Si client trouvé : "Hey [prénom], content de te revoir! C'est quoi qui t'amène aujourd'hui?"
    → Tu connais déjà son nom et email — saute l'étape 4 (pas besoin de redemander le nom)
    → Pour l'étape 5, utilise directement son email connu si disponible
  → Si nouveau client : continue normalement avec l'étape 1

ÉTAPE 1 — Comprendre la demande
  → Écoute la phrase COMPLÈTE avant de répondre
  → Le client peut donner plusieurs infos d'un coup (type + jour + période)
  → Exemple : "coupe homme mercredi après-midi" = service:homme, jour:mercredi, periode:après-midi
  → Si le type de coupe est clair → passe à l'étape 2 SANS le redemander
  → Si pas clair → demande : "C'est pour une coupe homme, femme ou non binaire?"

ÉTAPE 2 — Disponibilités
  → Dis "Ok laisse-moi vérifier ça!" puis appelle get_available_slots avec tous les filtres
  → Propose les créneaux disponibles et termine par : "Lequel te convient le mieux?"
  → Exemple : "J'ai lundi à 14h, mercredi à 10h, ou vendredi à 16h — lequel te convient le mieux?"
  → Si un seul créneau : "J'ai [jour] à [heure] — ça te convient?"
  → Si aucune dispo avec le filtre : propose des alternatives
  → Attends que le client choisisse

ÉTAPE 3 — Confirmation créneau
  → Confirme : "Parfait, je te prends [jour] à [heure]!"
  → Attends confirmation du client

ÉTAPE 4 — Nom
  → Demande : "C'est à quel nom?"
  → Dès que le client donne son nom, ENCHAÎNE IMMÉDIATEMENT sans pause :
    "Parfait [prénom]! [phrase de l'étape 5 directement]"
  → Ne demande PAS de confirmation du nom, ne fais PAS de pause, ne dis PAS "parfait" et arrête
  → Combine la confirmation du nom ET la question du numéro en UNE SEULE phrase fluide

ÉTAPE 5 — Numéro de téléphone
  ${callerNumber ? `→ Tu as le numéro appelant. Appelle d'abord format_caller_number pour obtenir la version lisible.
  → Dis EXACTEMENT : "Parfait! Je vais t'envoyer une confirmation par SMS pour que tu puisses saisir ton courriel. Je t'envoie ça au [numéro formaté]... C'est bien ça?"
  → Exemple : "Je t'envoie ça au cinq-un-quatre, huit-neuf-quatre, cinq-deux-deux-un... C'est bien ça?"
  → La phrase se termine par "C'est bien ça?" avec une intonation montante
  → Si OUI → appelle send_booking_link directement avec ce numéro
  → Si NON → demande le numéro vocalement (voir ci-dessous)` : `→ Pas de numéro appelant → demande vocalement (voir ci-dessous)`}

COLLECTE VOCALE DU NUMÉRO (si le client refuse ou si numéro inconnu) :
  → Dis : "Ok, dis-moi ton numéro de cellulaire."
  → Appelle normalize_and_confirm_phone avec le numéro entendu
  → La fonction retourne le numéro — dis EXACTEMENT :
    "J'ai bien le [3 premiers chiffres], [3 suivants], [4 derniers]... C'est bien ça?"
    Exemple : "J'ai bien le cinq-un-quatre, huit-neuf-quatre, cinq-deux-deux-un... C'est bien ça?"
    → La phrase se termine par "C'est bien ça?" avec une intonation montante — c'est une vraie question
  → Si OUI → appelle send_booking_link
  → Si NON → redemande (max 3 fois)

ÉTAPE 6 — Envoi SMS
  → Appelle send_booking_link avec service + slot_iso + name + phone
  → Quand send_booking_link retourne success:true, dis :
    "Tu vas recevoir un lien par texto pour saisir ton courriel et ainsi confirmer ton rendez-vous. Est-ce que je peux faire autre chose pour toi aujourd'hui?"
    (NOTE : ne commence PAS cette phrase par "Parfait" — ce mot est BANNI)
  → ATTENDS la réponse du client — NE raccroche PAS avant
  → Si le client dit NON (ou "non merci", "c'est tout", "ça va", "c'est beau", "non c'est bon") :
      Choisis UNE exclamation parmi : "Excellent!", "D'accord!", "C'est beau!", "Génial!", "Super!", "Très bien!", "Avec plaisir!"
      Puis DIS OBLIGATOIREMENT selon l'heure de l'appel :
      → Avant midi  → "[exclamation]! Alors je te souhaite une belle matinée! À bientôt au ${SALON_NAME}!"
      → Midi à 17h  → "[exclamation]! Alors je te souhaite un bel après-midi! À bientôt au ${SALON_NAME}!"
      → Après 17h   → "[exclamation]! Alors je te souhaite une belle soirée! À bientôt au ${SALON_NAME}!"
      → Cette phrase de salutation EST OBLIGATOIRE — ne saute pas cette étape
      → Appelle end_call SEULEMENT après avoir prononcé la salutation complète
  → Si le client a une autre question → réponds normalement et continue
  → end_call NE doit JAMAIS être appelé avant d'avoir dit la salutation

═══════════════════════
RÈGLES
═══════════════════════
- Ne pose JAMAIS une question dont tu as déjà la réponse
- N'invente JAMAIS une réponse du client — si tu n'entends pas bien : "Désolée, tu peux répéter?"
- Ne demande JAMAIS l'email — le lien SMS s'en occupe
- transfer_to_agent SEULEMENT si le client dit explicitement "agent", "parler à quelqu'un", "humain", "réceptionniste", ou équivalent
- Un prénom ou nom de personne N'EST PAS une demande de transfert
- Si tu n'es pas sûre d'avoir compris une demande de transfert, demande : "Tu veux que je te transfère à quelqu'un de l'équipe?"`;
}

// ─── Outils ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    name: "get_available_slots",
    description: "Récupère les créneaux disponibles. Passe jour et periode si le client les a mentionnés.",
    parameters: {
      type: "object",
      properties: {
        service:  { type: "string", enum: ["homme", "femme", "nonbinaire"] },
        jour:     { type: "string", description: "Jour souhaité ex: 'lundi', 'mercredi'. Omets si non mentionné." },
        periode:  { type: "string", enum: ["matin", "après-midi", "soir"], description: "Période souhaitée. Omets si non mentionnée." },
      },
      required: ["service"],
    },
  },
  {
    type: "function",
    name: "lookup_existing_client",
    description: "Cherche si le numéro appelant est déjà un client connu dans Calendly. Appelle au début si on a un numéro appelant, AVANT de demander le nom.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "format_caller_number",
    description: "Formate le numéro appelant pour que Marie puisse le lire à voix haute en groupes de chiffres, sans le 1 initial.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "normalize_and_confirm_phone",
    description: "Normalise un numéro de téléphone dicté vocalement et retourne sa version formatée pour que Marie la confirme au client.",
    parameters: {
      type: "object",
      properties: {
        raw_phone: { type: "string", description: "Le numéro tel qu'entendu, ex: '514 894 5221' ou '5-1-4-8-9-4-5-2-2-1'" },
      },
      required: ["raw_phone"],
    },
  },
  {
    type: "function",
    name: "send_booking_link",
    description: "Envoie le SMS de confirmation. Appelle seulement après confirmation du numéro.",
    parameters: {
      type: "object",
      properties: {
        service:  { type: "string", enum: ["homme", "femme", "nonbinaire"] },
        slot_iso: { type: "string" },
        name:     { type: "string" },
        phone:    { type: "string", description: "Numéro validé en format E.164 ou 10 chiffres" },
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
    name: "end_call",
    description: "Raccroche l'appel proprement. Appelle UNIQUEMENT après avoir dit au revoir suite à un send_booking_link réussi.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "transfer_to_agent",
    description: "Transfère à un humain. Uniquement si le client le demande explicitement.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

// ─── Exécution des outils ─────────────────────────────────────────────────────
async function runTool(name, args, session) {
  console.log(`[TOOL] ${name}`, JSON.stringify(args));

  if (name === "get_available_slots") {
    const uri = serviceUri(args.service);
    if (!uri) return { error: "Type de coupe non configuré dans Railway." };
    try {
      let slots = await getSlots(uri);
      if (!slots.length) return { disponible: false, message: "Aucune disponibilité cette semaine." };

      // Filtre par jour
      const JOURS = { lundi:1, mardi:2, mercredi:3, jeudi:4, vendredi:5, samedi:6, dimanche:0 };
      if (args.jour) {
        const jourKey = args.jour.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const jourNum = Object.entries(JOURS).find(([k]) =>
          k.normalize("NFD").replace(/[\u0300-\u036f]/g, "") === jourKey
        )?.[1];
        if (jourNum !== undefined) {
          const filtered = slots.filter(iso => {
            const d = new Date(new Date(iso).toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE }));
            return d.getDay() === jourNum;
          });
          if (filtered.length) slots = filtered;
          else return { disponible: false, message: `Pas de disponibilité ${args.jour} cette semaine.` };
        }
      }

      // Filtre par période
      if (args.periode) {
        const filtered = slots.filter(iso => {
          const h = new Date(new Date(iso).toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE })).getHours();
          if (args.periode === "matin")      return h >= 8  && h < 12;
          if (args.periode === "après-midi") return h >= 12 && h < 17;
          if (args.periode === "soir")       return h >= 17;
          return true;
        });
        if (filtered.length) slots = filtered;
      }

      return {
        disponible: true,
        slots: slots.slice(0, 4).map(iso => ({ iso, label: slotToFrench(iso) })),
      };
    } catch (e) {
      return { error: "Impossible de vérifier les disponibilités." };
    }
  }

  if (name === "lookup_existing_client") {
    const phone = session?.callerNumber;
    if (!phone) return { found: false, message: "Pas de numéro appelant disponible." };
    console.log(`[LOOKUP] Recherche client pour ${phone}`);
    const client = await lookupClientByPhone(phone);
    if (client) {
      console.log(`[LOOKUP] ✅ Client trouvé: ${client.name} (${client.email})`);
      return {
        found: true,
        name:  client.name,
        email: client.email,
        message: `Client existant trouvé : ${client.name} (${client.email}). Salue-le par son prénom et confirme que son info est déjà dans le système.`,
      };
    }
    console.log(`[LOOKUP] Nouveau client`);
    return { found: false, message: "Nouveau client — demander le nom normalement." };
  }

  if (name === "format_caller_number") {
    const phone = session?.callerNumber || "";
    const normalized = normalizePhone(phone) || phone;
    const digits = normalized.replace(/^\+1/, "").replace(/\D/g, "");
    if (digits.length !== 10) return { error: "Numéro appelant invalide." };
    const groups = `${digits.slice(0,3)}, ${digits.slice(3,6)}, ${digits.slice(6)}`;
    const spoken = digits.split("").join("-");
    const spokenGroups = `${digits.slice(0,3).split("").join("-")}, ${digits.slice(3,6).split("").join("-")}, ${digits.slice(6).split("").join("-")}`;
    return {
      phone: normalized,
      formatted: fmtPhone(normalized),
      spoken_groups: spokenGroups,
      message: `Numéro à lire : "${spokenGroups}". Dis exactement : "Je t'envoie ça au ${spokenGroups}?"`,
    };
  }

  if (name === "normalize_and_confirm_phone") {
    const phone = normalizePhone(args.raw_phone || "");
    if (!phone) return {
      valid: false,
      message: "Numéro invalide — demande au client de répéter.",
    };
    return {
      valid: true,
      phone,
      formatted: fmtPhone(phone),
      digits_spoken: fmtPhone(phone).replace(/\D/g, "").split("").join("-"),
      message: `Numéro normalisé : ${fmtPhone(phone)}. Répète ce numéro au client chiffre par chiffre pour confirmation.`,
    };
  }

  if (name === "send_booking_link") {
    console.log(`[BOOKING] Début — service:${args.service} slot:${args.slot_iso} name:${args.name} phone:${args.phone}`);

    const phone = normalizePhone(args.phone) || normalizePhone(session?.callerNumber || "");
    if (!phone) { console.error("[BOOKING] ❌ Numéro invalide"); return { error: "Numéro invalide." }; }
    const uri = serviceUri(args.service);
    if (!uri)           return { error: "Service non configuré." };
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
    console.log(`[BOOKING] Token créé: ${token}`);

    const link = `${base()}/confirm-email/${token}`;
    console.log(`[BOOKING] Envoi SMS → ${phone}`);

    // Timeout de 15s sur l'envoi SMS pour éviter que ça bloque indéfiniment
    const smsPromise = sendSms(phone,
      `${SALON_NAME} — Bonjour ${args.name.trim()}!\n` +
      `Pour finaliser ton rendez-vous du ${slotToFrench(args.slot_iso)}, ` +
      `saisis ton courriel ici (lien valide 20 min) :\n${link}`
    );
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("SMS timeout 15s")), 15_000)
    );

    try {
      await Promise.race([smsPromise, timeoutPromise]);
      console.log(`[BOOKING] ✅ SMS envoyé → ${phone}`);
      return { success: true, phone_display: fmtPhone(phone) };
    } catch (e) {
      console.error(`[BOOKING] ❌ Erreur SMS: ${e.message}`);
      // Retourner succès quand même si le token est créé — le SMS peut être en retard
      if (pending.has(token)) {
        return { success: true, phone_display: fmtPhone(phone), warning: "SMS peut être en retard" };
      }
      return { error: `Erreur SMS : ${e.message}` };
    }
  }

  if (name === "get_salon_info") {
    const info = { adresse: SALON_ADDRESS, heures: SALON_HOURS, prix: SALON_PRICE_LIST };
    return info[args.topic] ? { [args.topic]: info[args.topic] } : { error: "Sujet inconnu." };
  }

  if (name === "end_call") {
    session.shouldHangup = true;
    return { hanging_up: true };
  }

  if (name === "transfer_to_agent") {
    session.shouldTransfer = true;
    if (twilioClient && session.twilioCallSid && FALLBACK_NUMBER) {
      setTimeout(async () => {
        try {
          await twilioClient.calls(session.twilioCallSid)
            .update({
              twiml: `<Response><Say language="fr-CA" voice="alice">Veuillez patienter, je vous transfère à un membre de l'équipe.</Say><Dial>${FALLBACK_NUMBER}</Dial></Response>`
            });
          console.log(`[TRANSFER] ✅ Transfert vers ${FALLBACK_NUMBER}`);
        } catch (e) {
          console.error("[TRANSFER] ❌ Erreur:", e.message);
        }
      }, 1500);
    } else {
      console.warn("[TRANSFER] FALLBACK_NUMBER non configuré ou twilioClient manquant");
    }
    return { transferring: true };
  }

  return { error: `Outil inconnu : ${name}` };
}

// ─── Routes HTTP ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ ok: true, google_connected: !!googleTokens }));

// ─── OAuth Google ─────────────────────────────────────────────────────────────
app.get("/oauth/start", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send("GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET manquant dans Railway.");
  }
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  `${base()}/oauth/callback`,
    response_type: "code",
    scope:         "https://www.googleapis.com/auth/contacts",
    access_type:   "offline",
    prompt:        "consent",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/oauth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Erreur OAuth: ${error}`);
  if (!code)  return res.status(400).send("Code manquant");

  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${base()}/oauth/callback`,
        grant_type:    "authorization_code",
      }),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(JSON.stringify(j));

    googleTokens = {
      access_token:  j.access_token,
      refresh_token: j.refresh_token,
      expiry_date:   Date.now() + (j.expires_in || 3600) * 1000,
    };
    console.log("[GOOGLE] ✅ OAuth connecté — token reçu");
    res.type("text/html").send(`
      <h2>✅ Google Contacts connecté!</h2>
      <p>Marie peut maintenant reconnaître tes clients existants.</p>
      <p><strong>Important :</strong> Ce token est en mémoire — si Railway redémarre, visite à nouveau <a href="/oauth/start">/oauth/start</a>.</p>
      <p><a href="/">← Retour</a></p>
    `);
  } catch (e) {
    console.error("[GOOGLE] OAuth erreur:", e.message);
    res.status(500).send(`Erreur: ${e.message}`);
  }
});

app.get("/debug-env", (req, res) => res.json({
  SALON_NAME, SALON_CITY, SALON_ADDRESS, SALON_HOURS, SALON_PRICE_LIST,
  TWILIO_CALLER_ID:     TWILIO_CALLER_ID     ? "✅" : "❌",
  GOOGLE_CLIENT_ID:     GOOGLE_CLIENT_ID     ? "✅" : "❌",
  GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_SECRET ? "✅" : "❌",
  GOOGLE_CONNECTED:     googleTokens         ? "✅ token actif" : "❌ visiter /oauth/start",
  OPENAI_API_KEY:     OPENAI_API_KEY     ? "✅" : "❌",
  CALENDLY_API_TOKEN: CALENDLY_API_TOKEN ? "✅" : "❌",
  URIs: {
    homme:      CALENDLY_EVENT_TYPE_URI_HOMME      ? "✅" : "❌",
    femme:      CALENDLY_EVENT_TYPE_URI_FEMME      ? "✅" : "❌",
    nonbinaire: CALENDLY_EVENT_TYPE_URI_NONBINAIRE ? "✅" : "❌",
  },
}));

app.post("/voice", (req, res) => {
  const { CallSid, From } = req.body;
  console.log(`[VOICE] CallSid: ${CallSid} — From: ${From}`);

  sessions.set(CallSid, {
    twilioCallSid:  CallSid,
    callerNumber:   normalizePhone(From || "") || From || "",
    openaiWs:       null,
    streamSid:      null,
    shouldTransfer: false,
  });

  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `${wsBase()}/media-stream` });
  stream.parameter({ name: "twilioCallSid", value: CallSid });
  stream.parameter({ name: "callerNumber",  value: From || "" });

  res.type("text/xml").send(twiml.toString());
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on("connection", (twilioWs) => {
  let oaiWs     = null;
  let session   = null;
  let streamSid = null;
  let heartbeat = null;
  let pendingTools = new Map();

  oaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  // Silence G.711 µ-law (160 octets = 20ms à 8000Hz) encodé base64
  const SILENCE_PAYLOAD = Buffer.alloc(160, 0xFF).toString("base64");

  oaiWs.on("open", () => {
    console.log("[OAI] Connecté");
    // Ping OpenAI toutes les 10s pour garder le WS vivant
    heartbeat = setInterval(() => {
      if (oaiWs.readyState === WebSocket.OPEN) oaiWs.ping();
      else clearInterval(heartbeat);
    }, 10_000);
  });

  // Keepalive audio vers Twilio toutes les 10s pour éviter le timeout de stream
  let twilioKeepalive = null;
  function startTwilioKeepalive() {
    twilioKeepalive = setInterval(() => {
      if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: SILENCE_PAYLOAD },
        }));
      } else {
        clearInterval(twilioKeepalive);
      }
    }, 10_000);
  }

  function initOAI() {
    if (!oaiWs || oaiWs.readyState !== WebSocket.OPEN) return;
    console.log(`[OAI] Init — caller: ${session?.callerNumber}`);

    oaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        turn_detection: {
          type:                "server_vad",
          threshold:           0.85,
          prefix_padding_ms:   500,
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

    oaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message", role: "user",
        content: [{
          type: "input_text",
          text: `L'appel commence. Présente-toi comme l'assistante virtuelle du ${SALON_NAME} à ${SALON_CITY}, dis que tu es là pour que les coiffeurs restent concentrés, et mentionne que pour parler à quelqu'un il suffit de dire "agent" à tout moment. Termine par "Comment puis-je vous aider aujourd'hui?" et attends.`,
        }],
      },
    }));
    oaiWs.send(JSON.stringify({ type: "response.create" }));
  }

  oaiWs.on("message", async (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }

    switch (ev.type) {

      case "response.audio.delta":
        if (ev.delta && twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: "media", streamSid,
            media: { payload: ev.delta },
          }));
        }
        break;

      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          pendingTools.set(ev.item.call_id, { name: ev.item.name, args: "" });
          console.log(`[OAI] Function call: ${ev.item.name}`);
        }
        break;

      case "response.function_call_arguments.delta": {
        const t = pendingTools.get(ev.call_id);
        if (t) t.args += (ev.delta || "");
        break;
      }

      case "response.function_call_arguments.done": {
        const tool = pendingTools.get(ev.call_id);
        if (!tool) break;

        let args = {};
        try { args = JSON.parse(ev.arguments || tool.args || "{}"); } catch {}

        const result = await runTool(tool.name, args, session || {})
          .catch(e => ({ error: e.message }));

        console.log(`[TOOL RESULT] ${tool.name}:`, JSON.stringify(result));

        if (session?.shouldHangup) {
          // Raccrocher après 3s pour laisser l'audio finir complètement
          setTimeout(() => {
            if (twilioClient && session.twilioCallSid) {
              twilioClient.calls(session.twilioCallSid)
                .update({ status: "completed" })
                .then(() => console.log("[END] ✅ Appel raccroché"))
                .catch(e => console.error("[END] Erreur raccrochage:", e.message));
            }
          }, 3000);
          pendingTools.delete(ev.call_id);
          break;
        }

        if (session?.shouldTransfer) {
          setTimeout(() => {
            if (twilioWs.readyState === WebSocket.OPEN)
              twilioWs.send(JSON.stringify({ event: "stop", streamSid }));
          }, 2500);
          pendingTools.delete(ev.call_id);
          break;
        }

        if (oaiWs.readyState === WebSocket.OPEN) {
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(result) },
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
    clearInterval(twilioKeepalive);

    // Code 1005 = fermeture inattendue — tenter une reconnexion si Twilio est encore actif
    if (code === 1005 && twilioWs.readyState === WebSocket.OPEN && streamSid) {
      console.log("[OAI] Reconnexion automatique dans 500ms...");
      setTimeout(() => {
        if (twilioWs.readyState !== WebSocket.OPEN) return;
        console.log("[OAI] Reconnexion en cours...");

        oaiWs = new WebSocket(
          `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
          { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
        );

        oaiWs.on("open", () => {
          console.log("[OAI] ✅ Reconnecté");
          // Mettre à jour la référence dans la session
          if (session) session.openaiWs = oaiWs;

          heartbeat = setInterval(() => {
            if (oaiWs.readyState === WebSocket.OPEN) oaiWs.ping();
            else clearInterval(heartbeat);
          }, 10_000);

          startTwilioKeepalive();

          // Réinitialiser la session avec contexte de reprise
          oaiWs.send(JSON.stringify({
            type: "session.update",
            session: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.85,
                prefix_padding_ms: 500,
                silence_duration_ms: 1200,
              },
              input_audio_format:  "g711_ulaw",
              output_audio_format: "g711_ulaw",
              voice:       OPENAI_TTS_VOICE,
              instructions: systemPrompt(session?.callerNumber),
              tools:        TOOLS,
              tool_choice:  "auto",
              modalities:   ["text", "audio"],
              temperature:  0.6,
            },
          }));

          // Dire au client qu'on est de retour
          oaiWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message", role: "user",
              content: [{ type: "input_text", text: "La connexion a été brièvement interrompue. Reprends la conversation naturellement là où tu en étais, avec la même énergie. Ne mentionne pas l'interruption technique." }],
            },
          }));
          oaiWs.send(JSON.stringify({ type: "response.create" }));
        });

        // Rebrancher les handlers sur le nouveau oaiWs
        oaiWs.on("message", async (raw) => {
          // Réutiliser le même handler — pointer vers la fonction existante
          // En pratique on doit re-attacher tous les handlers
          // Simple : rediriger l'audio vers Twilio
          let ev;
          try { ev = JSON.parse(raw); } catch { return; }
          if (ev.type === "response.audio.delta" && ev.delta && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: ev.delta } }));
          }
          if (ev.type === "error") console.error("[OAI RECONNECT ERROR]", JSON.stringify(ev.error));
        });

        oaiWs.on("close",  (c) => { console.log(`[OAI] Reconnexion fermée (${c})`); clearInterval(heartbeat); });
        oaiWs.on("error",  (e) => console.error("[OAI WS reconnect]", e.message));
      }, 500);
    }
  });
  oaiWs.on("error",  (e) => console.error("[OAI WS]", e.message));

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      case "start": {
        streamSid      = msg.start.streamSid;
        const p        = msg.start.customParameters || {};
        const sid      = p.twilioCallSid || "";

        session = sessions.get(sid);
        if (!session) {
          session = {
            twilioCallSid:  sid,
            callerNumber:   normalizePhone(p.callerNumber || "") || p.callerNumber || "",
            openaiWs:       null,
            streamSid,
            shouldTransfer: false,
          };
          sessions.set(sid, session);
        }
        session.openaiWs  = oaiWs;
        session.streamSid = streamSid;

        console.log(`[Twilio] Stream — sid: ${sid} — caller: ${session.callerNumber}`);

        // Démarrer le keepalive audio Twilio
        startTwilioKeepalive();

        if (oaiWs.readyState === WebSocket.OPEN) initOAI();
        else oaiWs.once("open", initOAI);
        break;
      }

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
        clearInterval(heartbeat);
        clearInterval(twilioKeepalive);
        oaiWs?.close();
        break;
    }
  });

  twilioWs.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(twilioKeepalive);
    oaiWs?.close();
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

    // Sauvegarder dans Google Contacts si nouveau client
    await saveContactToGoogle({ name, email, phone });

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
  return layout("Lien expiré", `<h1>⏰ Lien expiré</h1><p>Ce lien n'est plus valide. Rappelle le salon pour un nouveau lien.</p>`);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`✅ ${SALON_NAME} — port ${PORT}`));
