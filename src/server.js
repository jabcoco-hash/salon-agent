/**

- Salon Coco — Agent téléphonique IA v9
- 
- Collecte du numéro de téléphone :
- 1. Marie propose d’envoyer la confirmation au numéro appelant
- 1. Si le client confirme → on utilise ce numéro directement
- 1. Si non → Marie demande le numéro vocalement, le répète chiffre par chiffre,
- ```
  le client confirme avant d'aller plus loin
  ```
- 
- Plus de redirection DTMF — tout reste dans OpenAI Realtime.
  */

import express          from “express”;
import crypto           from “crypto”;
import { createServer } from “http”;
import { WebSocketServer, WebSocket } from “ws”;
import twilio           from “twilio”;

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
OPENAI_REALTIME_MODEL = “gpt-4o-realtime-preview-2024-12-17”,
OPENAI_TTS_VOICE      = “coral”,
CALENDLY_TIMEZONE     = “America/Toronto”,
CALENDLY_EVENT_TYPE_URI_HOMME,
CALENDLY_EVENT_TYPE_URI_FEMME,
CALENDLY_EVENT_TYPE_URI_NONBINAIRE,
GOOGLE_CLIENT_ID,
GOOGLE_CLIENT_SECRET,
} = process.env;

function envStr(key, fallback = “”) {
const v = process.env[key];
if (!v || !v.trim()) return fallback;
return v.trim().replace(/^[”’]|[”’]$/g, “”);
}

const SALON_NAME       = envStr(“SALON_NAME”,       “Salon Coco”);
const SALON_CITY       = envStr(“SALON_CITY”,       “Magog Beach”);
const SALON_ADDRESS    = envStr(“SALON_ADDRESS”,    “Adresse non configurée”);
const SALON_HOURS      = envStr(“SALON_HOURS”,      “Heures non configurées”);
const SALON_PRICE_LIST = envStr(“SALON_PRICE_LIST”, “Prix non configurés”);

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function base() { return (PUBLIC_BASE_URL || “”).replace(//$/, “”); }
function wsBase() { return base().replace(/^https/, “wss”).replace(/^http/, “ws”); }

// ─── Stores ───────────────────────────────────────────────────────────────────
const sessions = new Map(); // twilioCallSid → session
const pending  = new Map(); // token → { expiresAt, payload }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw = “”) {
if (!raw) return null;
// Nettoyer tous les caractères non-numériques
const d = raw.replace(/\D/g, “”);
if (d.length === 10) return `+1${d}`;
if (d.length === 11 && d[0] === “1”) return `+${d}`;
// Format avec indicatif pays 0 (ex: 0514…)
if (d.length === 11 && d[0] === “0”) return `+1${d.slice(1)}`;
return null;
}

// Compare deux numéros en ignorant le format
function samePhone(a, b) {
const na = normalizePhone(a);
const nb = normalizePhone(b);
return na && nb && na === nb;
}

function fmtPhone(e164 = “”) {
const d = e164.replace(/^+1/, “”);
return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : e164;
}

// Épeler un email lettre par lettre pour la lecture vocale
// ex: “jab@hotmail.com” → “j-a-b arobase h-o-t-m-a-i-l point com”
function spellEmail(email = “”) {
const SPECIAL = {
“@”: “arobase”,
“.”: “point”,
“_”: “tiret bas”,
“-”: “tiret”,
“+”: “plus”,
};
return email.toLowerCase().split(””).map(c => SPECIAL[c] || c).join(”-”).replace(/-arobase-/g, “ arobase “).replace(/-point-/g, “ point “).replace(/–/g, “-”);
}

function slotToFrench(iso) {
try {
return new Date(iso).toLocaleString(“fr-CA”, {
weekday: “long”, month: “long”, day: “numeric”,
hour: “2-digit”, minute: “2-digit”,
timeZone: CALENDLY_TIMEZONE,
});
} catch { return iso; }
}

function serviceUri(s) {
if (s === “homme”)      return CALENDLY_EVENT_TYPE_URI_HOMME;
if (s === “femme”)      return CALENDLY_EVENT_TYPE_URI_FEMME;
if (s === “nonbinaire”) return CALENDLY_EVENT_TYPE_URI_NONBINAIRE;
return null;
}

function serviceLabel(s) {
return { homme: “coupe homme”, femme: “coupe femme”, nonbinaire: “coupe non binaire” }[s] || s;
}

// ─── Calendly ─────────────────────────────────────────────────────────────────
const cHeaders = () => ({
Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
“Content-Type”: “application/json”,
});

async function getSlots(uri, startDate = null, endDate = null) {
const start = startDate ? new Date(startDate) : new Date(Date.now() + 5 * 60 * 1000);
const end   = endDate   ? new Date(endDate)   : new Date(start.getTime() + 7 * 24 * 3600 * 1000);

// Calendly limite à 7 jours par requête — si la fenêtre est plus grande, paginer
const allSlots = [];
let cursor = new Date(start);
while (cursor < end) {
const chunkEnd = new Date(Math.min(cursor.getTime() + 7 * 24 * 3600 * 1000, end.getTime()));
const url = `https://api.calendly.com/event_type_available_times`
+ `?event_type=${encodeURIComponent(uri)}`
+ `&start_time=${encodeURIComponent(cursor.toISOString())}`
+ `&end_time=${encodeURIComponent(chunkEnd.toISOString())}`;
console.log(`[SLOTS] Appel Calendly: start=${cursor.toISOString()} end=${chunkEnd.toISOString()}`);
const r = await fetch(url, { headers: cHeaders() });
if (!r.ok) throw new Error(`Calendly slots ${r.status}: ${await r.text()}`);
const data = await r.json();
const slots = data.collection?.map(x => x.start_time).filter(Boolean) || [];
console.log(`[SLOTS] Calendly retourne ${slots.length} slots — premier: ${slots[0] || "aucun"}`);
allSlots.push(…slots);
cursor = chunkEnd;
if (allSlots.length >= 20) break; // assez de résultats
}
return allSlots;
}

async function getEventLocation(uri) {
const uuid = uri.split(”/”).pop();
const r = await fetch(`https://api.calendly.com/event_types/${uuid}`, { headers: cHeaders() });
const j = await r.json();
const locs = j.resource?.locations;
return Array.isArray(locs) && locs.length ? locs[0] : null;
}

// ─── Google OAuth token ───────────────────────────────────────────────────────
// Recharger le refresh_token depuis Railway au démarrage
let googleTokens = process.env.GOOGLE_REFRESH_TOKEN ? {
access_token:  null, // sera rafraîchi automatiquement
refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
expiry_date:   0,    // forcer un refresh immédiat
} : null;

if (googleTokens) console.log(”[GOOGLE] ✅ Refresh token chargé depuis Railway”);
else console.log(”[GOOGLE] ⚠️ Pas de token — visite /oauth/start pour connecter”);

async function getGoogleAccessToken() {
if (!googleTokens) return null;
// Refresh si access_token null OU expiré
if (!googleTokens.access_token || (googleTokens.expiry_date && Date.now() > googleTokens.expiry_date - 60_000)) {
try {
const r = await fetch(“https://oauth2.googleapis.com/token”, {
method: “POST”,
headers: { “Content-Type”: “application/x-www-form-urlencoded” },
body: new URLSearchParams({
client_id:     GOOGLE_CLIENT_ID,
client_secret: GOOGLE_CLIENT_SECRET,
refresh_token: googleTokens.refresh_token,
grant_type:    “refresh_token”,
}),
});
const j = await r.json();
if (j.access_token) {
googleTokens.access_token  = j.access_token;
googleTokens.expiry_date   = Date.now() + (j.expires_in || 3600) * 1000;
console.log(”[GOOGLE] Token rafraîchi”);
}
} catch (e) { console.warn(”[GOOGLE] Erreur refresh:”, e.message); }
}
return googleTokens.access_token;
}

async function lookupClientByPhone(phone) {
const token = await getGoogleAccessToken();
if (!token) { console.warn(”[LOOKUP] Pas de token Google”); return null; }

try {
// Chercher dans tous les contacts par numéro de téléphone
const r = await fetch(
`https://people.googleapis.com/v1/people:searchContacts` +
`?query=${encodeURIComponent(phone)}&readMask=names,emailAddresses,phoneNumbers`,
{ headers: { Authorization: `Bearer ${token}` } }
);
const j = await r.json();
const results = j.results || [];

```
for (const result of results) {
  const person = result.person;
  // Vérifier que le téléphone correspond exactement
  const phones = person.phoneNumbers || [];
  const match  = phones.find(p => samePhone(p.value || "", phone));
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
  const match  = phones.find(p => samePhone(p.value || "", phone));
  if (match) {
    const name  = person.names?.[0]?.displayName || null;
    const email = person.emailAddresses?.[0]?.value || null;
    console.log(`[LOOKUP] ✅ Trouvé (local): ${name} (${email})`);
    return { name, email, found: true };
  }
}

console.log(`[LOOKUP] Nouveau client: ${phone}`);
return null;
```

} catch (e) {
console.warn(”[LOOKUP] Erreur:”, e.message);
return null;
}
}

async function saveContactToGoogle({ name, email, phone }) {
const token = await getGoogleAccessToken();
if (!token) {
console.warn(”[GOOGLE] ❌ saveContact — pas de token. Visite /oauth/start.”);
return;
}
try {
// Anti-doublon : chercher si ce numéro existe déjà
const searchR = await fetch(
`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(phone)}&readMask=names,emailAddresses,phoneNumbers`,
{ headers: { Authorization: `Bearer ${token}` } }
);
const searchJ = await searchR.json();
const existingPerson = searchJ.results?.find(r =>
(r.person?.phoneNumbers || []).some(p => samePhone(p.value, phone))
)?.person;

```
if (existingPerson) {
  const resourceName = existingPerson.resourceName;
  const existingEmail = existingPerson.emailAddresses?.[0]?.value;
  if (email && email !== existingEmail) {
    // Mettre à jour l'email seulement
    await fetch(`https://people.googleapis.com/v1/${resourceName}:updateContact?updatePersonFields=emailAddresses`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ emailAddresses: [{ value: email }] }),
    });
    console.log(`[GOOGLE] ✅ Email mis à jour: ${existingPerson.names?.[0]?.displayName} → ${email}`);
  } else {
    console.log(`[GOOGLE] Contact déjà à jour — pas de doublon: ${existingPerson.names?.[0]?.displayName}`);
  }
  return;
}

// Nouveau contact
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
  console.error(`[GOOGLE] ❌ Erreur création: ${r.status}`, JSON.stringify(j));
  if (r.status === 403) console.error("[GOOGLE] ❌ Scope insuffisant — revisite /oauth/start");
  return;
}
console.log(`[GOOGLE] ✅ Nouveau contact créé: ${name} (${email}) — ${phone}`);
```

} catch (e) {
console.error(”[GOOGLE] ❌ Erreur saveContact:”, e.message);
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
const r = await fetch(“https://api.calendly.com/invitees”, {
method: “POST”, headers: cHeaders(), body: JSON.stringify(body),
});
const j = await r.json();
if (!r.ok) throw new Error(`Calendly invitee ${r.status}: ${JSON.stringify(j)}`);
return j;
}

async function sendSms(to, body) {
if (!twilioClient || !TWILIO_CALLER_ID) return console.warn(”[SMS] Config manquante”);
await twilioClient.messages.create({ from: TWILIO_CALLER_ID, to, body });
console.log(`[SMS] ✅ → ${to}`);
}

// ─── System prompt ────────────────────────────────────────────────────────────
function systemPrompt(callerNumber) {
const callerDisplay = callerNumber ? fmtPhone(callerNumber) : null;
return `Tu es Marie, réceptionniste pétillante du ${SALON_NAME} à ${SALON_CITY}. Tu ADORES ton travail. Énergie constante, ton ne baisse jamais.
Français québécois naturel. Réponses max 2 phrases. UNE question à la fois.

SALON : ${SALON_ADDRESS} | ${SALON_HOURS} | ${SALON_PRICE_LIST}
NUMÉRO APPELANT : ${callerNumber || “inconnu”}

EXPRESSIONS — varie à chaque réplique, ne répète jamais la même consécutivement :
Acquiescer : “Excellent!”, “D’accord!”, “C’est beau!”, “Génial!”, “Super!”, “Très bien!”, “Absolument!”, “Ben oui!”
Patienter : “Laisse-moi vérifier ça!”, “Une seconde!”, “Je regarde ça!”
INTERDIT ABSOLU : dire “Parfait” — ce mot est BANNI pour tout l’appel

FLUX RENDEZ-VOUS :

1. TYPE DE COUPE
   → Si inconnu : “C’est pour une coupe homme ou femme? Si tu as besoin d’un autre service comme une coloration ou une mise en plis, je peux te transférer à l’équipe tout de suite!”
   → Si le client mentionne coloration, mise en plis, teinture, balayage, barbe ou tout service autre qu’une coupe simple → dis : “Pour ce type de service je vais te transférer à quelqu’un de l’équipe!” → transfer_to_agent
   → RÈGLE : connaître le type AVANT d’appeler get_available_slots
1. DISPONIBILITÉS
   → DATES RELATIVES — si le client mentionne une date relative, calcule-la et CONFIRME avant de chercher :
   “vendredi prochain” → calcule la date → dis : “Ok, donc vendredi le [date ex: 27 février] — c’est bien ça?”
   “dans 2 semaines” → calcule → confirme la date
   “en mars” → confirme : “Tu veux un rendez-vous en mars, c’est ça?”
   → Attends OUI avant d’appeler get_available_slots
   → Date confirmée (ou pas de date relative) → dis “Patiente un instant!” puis appelle get_available_slots
   → PARAMÈTRES : jour = UN SEUL MOT (“vendredi”), date_debut = date ISO calculée (ex: “2026-02-27”)
   → Propose les créneaux : “J’ai [options] — lequel te convient le mieux?”
   → Client veut d’autres options → rappelle avec offset_semaines+1, MAX 2 tentatives
   → Après 2 échecs → “Désolée, je te transfère à l’équipe!” → transfer_to_agent
1. CONFIRMER LE CRÉNEAU
   → “Super! Je te prends [service] le [jour] à [heure] — c’est bien ça?”
   → Attends OUI
1. DOSSIER CLIENT
   → Maintenant que le créneau est confirmé, dis : “Laisse-moi vérifier si t’as déjà un dossier chez nous!”
   → Appelle lookup_existing_client
   → Trouvé → “J’ai un dossier au nom de [nom] — c’est bien toi?” → attends OUI/NON
   → OUI → saute l’étape 5 (nom connu)
   → NON → traite comme nouveau client
   → NON trouvé → continue à l’étape 5
1. NOM
   → Si déjà connu (dossier trouvé et confirmé) → SAUTE cette étape
   → Sinon → “C’est à quel nom?” → enchaîne immédiatement vers étape 6 sans pause
1. NUMÉRO ET COURRIEL
   → Appelle format_caller_number
   → Dis : “Je t’envoie la confirmation par texto au [spoken_groups]… C’est bien ton cellulaire? Si c’est pas un cell, dis Agent.”
   → Attends OUI/NON
   → Si NON → demande le bon numéro → normalize_and_confirm_phone
   
   CLIENT EXISTANT avec email :
   → Épelle l’email lettre par lettre avec spelled_email : “J’ai ton courriel [spelled_email] — c’est toujours bon?”
   → OUI → send_booking_link avec email
   → NON → demande nouveau courriel → update_contact → send_booking_link
   
   NOUVEAU CLIENT :
   → send_booking_link sans email (lien SMS pour saisir le courriel)
1. APRÈS ENVOI SMS (seulement si un RDV a été complété)
   → “Est-ce que je peux faire autre chose pour toi?”
   → OUI → continue | NON → appelle get_current_time → dis EXACTEMENT selon l’heure :
   Avant midi → “Voilà, c’est fait! Tu devrais avoir reçu la confirmation. Je te souhaite une belle matinée!”
   Midi-17h   → “Voilà, c’est fait! Tu devrais avoir reçu la confirmation. Je te souhaite une belle fin de journée!”
   Après 17h  → “Voilà, c’est fait! Tu devrais avoir reçu la confirmation. Je te souhaite une belle soirée!”
   → Appelle end_call immédiatement après — OBLIGATOIRE, sans rien dire de plus

FIN D’APPEL SANS RDV (client pose une question et repart sans réserver) :
→ Si le client dit “merci”, “bonne journée”, “au revoir”, “c’est tout” SANS avoir réservé :
→ NE MENTIONNE PAS de confirmation ou de texto — aucun RDV n’a été pris
→ Appelle get_current_time → dis selon l’heure :
Avant midi → “Avec plaisir! Belle matinée!”
Midi-17h   → “Avec plaisir! Belle fin de journée!”
Après 17h  → “Avec plaisir! Belle soirée!”
→ Appelle end_call immédiatement

RÈGLES STRICTES :

- Prix, adresse, heures d’ouverture → réponds IMMÉDIATEMENT depuis le prompt sans appeler aucun outil
- Ne pose JAMAIS une question dont tu as déjà la réponse
- N’invente JAMAIS une réponse — si mal entendu : “Désolée, tu peux répéter?”
- Ne demande JAMAIS l’email — le lien SMS s’en occupe (sauf client existant)
- Ne propose JAMAIS liste d’attente ni rappel
- transfer_to_agent SEULEMENT si client dit explicitement “agent”, “humain”, “parler à quelqu’un”
- Un prénom N’EST PAS une demande de transfert
- end_call JAMAIS avant la salutation complète
- INTERDIT ABSOLU : inventer ou deviner un nom — utilise UNIQUEMENT le nom du dossier Google OU celui dit explicitement par le client dans CET appel
- INTERDIT ABSOLU : réutiliser un nom d’un appel précédent — chaque appel repart à zéro
- Pour send_booking_link : le champ “name” doit être le nom confirmé dans CET appel uniquement`;
  }

// ─── Outils ───────────────────────────────────────────────────────────────────
const TOOLS = [
{
type: “function”,
name: “get_available_slots”,
description: “Récupère les créneaux disponibles. IMPORTANT: convertis TOUJOURS les références temporelles en date ISO avant d’appeler. ‘vendredi prochain’ = calcule la date ISO du prochain vendredi. ‘la semaine prochaine’ = date_debut du lundi prochain. ‘en mars’ = date_debut=‘2026-03-01’. ‘dans 2 semaines’ = offset_semaines:2.”,
parameters: {
type: “object”,
properties: {
service:    { type: “string”, enum: [“homme”, “femme”, “nonbinaire”] },
jour:       { type: “string”, description: “Jour de la semaine UNIQUEMENT en un mot: ‘lundi’, ‘mardi’, ‘mercredi’, ‘jeudi’, ‘vendredi’, ‘samedi’. Ne jamais mettre ‘prochain’ ou autre qualificatif.” },
periode:    { type: “string”, enum: [“matin”, “après-midi”, “soir”], description: “Période souhaitée. Omets si non mentionnée.” },
date_debut: { type: “string”, description: “Date ISO YYYY-MM-DD. Calcule la vraie date: ‘vendredi prochain’ → calcule et mets la date ISO du prochain vendredi. ‘la semaine prochaine’ → date du lundi prochain. ‘en mars’ → ‘2026-03-01’. Omets pour chercher à partir d’aujourd’hui.” },
offset_semaines: { type: “number”, description: “Utilise SEULEMENT quand le client veut d’autres options que celles déjà proposées. Ex: 1 = décaler d’une semaine supplémentaire.” },
},
required: [“service”],
},
},
{
type: “function”,
name: “lookup_existing_client”,
description: “Cherche si le numéro appelant est déjà un client connu dans Calendly. Appelle au début si on a un numéro appelant, AVANT de demander le nom.”,
parameters: { type: “object”, properties: {}, required: [] },
},
{
type: “function”,
name: “format_caller_number”,
description: “Formate le numéro appelant pour que Marie puisse le lire à voix haute en groupes de chiffres, sans le 1 initial.”,
parameters: { type: “object”, properties: {}, required: [] },
},
{
type: “function”,
name: “normalize_and_confirm_phone”,
description: “Normalise un numéro de téléphone dicté vocalement et retourne sa version formatée pour que Marie la confirme au client.”,
parameters: {
type: “object”,
properties: {
raw_phone: { type: “string”, description: “Le numéro tel qu’entendu, ex: ‘514 894 5221’ ou ‘5-1-4-8-9-4-5-2-2-1’” },
},
required: [“raw_phone”],
},
},
{
type: “function”,
name: “send_booking_link”,
description: “Envoie le SMS de confirmation. Si email connu (client existant), crée directement le RDV Calendly et envoie la confirmation complète. Sinon envoie un lien SMS pour saisir le courriel.”,
parameters: {
type: “object”,
properties: {
service:  { type: “string”, enum: [“homme”, “femme”, “nonbinaire”] },
slot_iso: { type: “string” },
name:     { type: “string” },
phone:    { type: “string”, description: “Numéro validé en format E.164 ou 10 chiffres” },
email:    { type: “string”, description: “Courriel si déjà connu (client existant). Omets si inconnu.” },
},
required: [“service”, “slot_iso”, “name”, “phone”],
},
},
{
type: “function”,
name: “get_salon_info”,
description: “Retourne adresse, heures ou prix du salon.”,
parameters: {
type: “object”,
properties: {
topic: { type: “string”, enum: [“adresse”, “heures”, “prix”] },
},
required: [“topic”],
},
},
{
type: “function”,
name: “update_contact”,
description: “Met à jour ou crée un contact dans Google Contacts. Appelle quand le client corrige son courriel ou donne un nouveau numéro.”,
parameters: {
type: “object”,
properties: {
name:  { type: “string”, description: “Nom complet du client” },
email: { type: “string”, description: “Nouveau courriel confirmé” },
phone: { type: “string”, description: “Numéro de téléphone” },
},
required: [“name”, “phone”],
},
},
{
type: “function”,
name: “get_current_time”,
description: “Retourne l’heure locale exacte au Québec. Appelle AVANT de souhaiter une belle matinée/après-midi/soirée pour utiliser la bonne salutation.”,
parameters: { type: “object”, properties: {}, required: [] },
},
{
type: “function”,
name: “end_call”,
description: “Raccroche l’appel proprement. Appelle UNIQUEMENT après avoir dit au revoir suite à un send_booking_link réussi.”,
parameters: { type: “object”, properties: {}, required: [] },
},
{
type: “function”,
name: “transfer_to_agent”,
description: “Transfère à un humain. Uniquement si le client le demande explicitement.”,
parameters: { type: “object”, properties: {}, required: [] },
},
];

// ─── Exécution des outils ─────────────────────────────────────────────────────
async function runTool(name, args, session) {
console.log(`[TOOL] ${name}`, JSON.stringify(args));

if (name === “get_available_slots”) {
const uri = serviceUri(args.service);
if (!uri) return { error: “Type de coupe non configuré dans Railway.” };
try {
// Calculer la fenêtre de dates
let startDate = null;
if (args.date_debut) {
startDate = new Date(args.date_debut);
if (isNaN(startDate.getTime())) startDate = null;
}
if (args.offset_semaines) {
const base = startDate || new Date();
startDate = new Date(base.getTime() + args.offset_semaines * 7 * 24 * 3600 * 1000);
}
const endDate = startDate ? new Date(startDate.getTime() + 7 * 24 * 3600 * 1000) : null;

```
  let slots = await getSlots(uri, startDate, endDate);

  // Filtrer STRICTEMENT dans la plage demandée
  if (startDate) {
    const end = endDate || new Date(startDate.getTime() + 7 * 24 * 3600 * 1000);
    slots = slots.filter(iso => {
      const d = new Date(iso);
      return d >= startDate && d <= end;
    });
    if (!slots.length) {
      return {
        disponible: false,
        message: `Aucun créneau pour la période demandée (${startDate.toLocaleDateString("fr-CA", { timeZone: CALENDLY_TIMEZONE })}). La fenêtre de réservation Calendly ne couvre probablement pas cette date — augmente "Max scheduling notice" dans Calendly. Dis au client et propose une date plus proche ou transfère.`,
      };
    }
  } else if (!slots.length) {
    return { disponible: false, message: "Aucune disponibilité cette semaine." };
  }

  // Filtre par jour
  const JOURS = { lundi:1, mardi:2, mercredi:3, jeudi:4, vendredi:5, samedi:6, dimanche:0 };
  if (args.jour) {
    const jourKey = args.jour.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const jourNum = Object.entries(JOURS).find(([k]) =>
      k.normalize("NFD").replace(/[̀-ͯ]/g, "") === jourKey
    )?.[1];
    if (jourNum !== undefined) {
      const filtered = slots.filter(iso => {
        const d = new Date(new Date(iso).toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE }));
        return d.getDay() === jourNum;
      });
      if (filtered.length) slots = filtered;
      else return { disponible: false, message: `Pas de disponibilité ${args.jour} pour cette période.` };
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

  // Dédupliquer par label
  const seen = new Set();
  const unique = slots.filter(iso => {
    const label = slotToFrench(iso);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  // Sélectionner créneaux variés : 2 AM + 2 PM, espacés (pas consécutifs)
  const getHourLocal = iso => new Date(new Date(iso).toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE })).getHours();
  const amSlots = unique.filter(iso => getHourLocal(iso) < 12);
  const pmSlots = unique.filter(iso => getHourLocal(iso) >= 12);
  const spaced  = arr => arr.filter((_, i) => i % 2 === 0); // 1 sur 2
  let selected  = [...spaced(amSlots).slice(0, 2), ...spaced(pmSlots).slice(0, 2)];
  if (selected.length < 2) selected = unique.slice(0, 4); // fallback

  console.log(`[SLOTS] ✅ ${selected.length} créneaux (${amSlots.length} AM dispo, ${pmSlots.length} PM dispo)`);
  return {
    disponible: true,
    periode: startDate ? startDate.toLocaleDateString("fr-CA") : "cette semaine",
    slots: selected.map(iso => ({ iso, label: slotToFrench(iso) })),
    note: "Lis chaque label UNE SEULE FOIS. Pour plus d'options: offset_semaines+1.",
  };
} catch (e) {
  console.error("[SLOTS]", e.message);
  return { error: "Impossible de vérifier les disponibilités." };
}
```

}

if (name === “lookup_existing_client”) {
const phone = session?.callerNumber;
if (!phone) return { found: false, message: “Pas de numéro appelant disponible.” };
console.log(`[LOOKUP] Recherche client pour ${phone}`);
const client = await lookupClientByPhone(phone);
if (client) {
console.log(`[LOOKUP] ✅ Client trouvé: ${client.name} (${client.email})`);
return {
found:  true,
name:   client.name,
email:  client.email || null,
has_email: !!client.email,
spelled_email: client.email ? spellEmail(client.email) : null,
message: client.email
? `Client existant : ${client.name}, courriel : ${client.email} (à épeler : ${spellEmail(client.email)}). Salue-le par son prénom et confirme le courriel EN L'ÉPELANT : "J'ai ton courriel ${spellEmail(client.email)} dans notre dossier — c'est toujours bon?"`
: `Client existant : ${client.name}, pas de courriel. Salue-le par son prénom et demande son courriel.`,
};
}
console.log(`[LOOKUP] Nouveau client`);
return { found: false, message: “Nouveau client — demande le nom normalement.” };
}

if (name === “format_caller_number”) {
const phone = session?.callerNumber || “”;
const normalized = normalizePhone(phone) || phone;
const digits = normalized.replace(/^+1/, “”).replace(/\D/g, “”);
if (digits.length !== 10) return { error: “Numéro appelant invalide.” };
const groups = `${digits.slice(0,3)}, ${digits.slice(3,6)}, ${digits.slice(6)}`;
const spoken = digits.split(””).join(”-”);
const spokenGroups = `${digits.slice(0,3).split("").join("-")}, ${digits.slice(3,6).split("").join("-")}, ${digits.slice(6).split("").join("-")}`;
return {
phone: normalized,
formatted: fmtPhone(normalized),
spoken_groups: spokenGroups,
message: `Numéro à lire : "${spokenGroups}". Dis exactement : "Je t'envoie ça au ${spokenGroups}?"`,
};
}

if (name === “normalize_and_confirm_phone”) {
const phone = normalizePhone(args.raw_phone || “”);
if (!phone) return {
valid: false,
message: “Numéro invalide — demande au client de répéter.”,
};
return {
valid: true,
phone,
formatted: fmtPhone(phone),
digits_spoken: fmtPhone(phone).replace(/\D/g, “”).split(””).join(”-”),
message: `Numéro normalisé : ${fmtPhone(phone)}. Répète ce numéro au client chiffre par chiffre pour confirmation.`,
};
}

if (name === “send_booking_link”) {
console.log(`[BOOKING] Début — service:${args.service} slot:${args.slot_iso} name:${args.name} phone:${args.phone} email:${args.email || "inconnu"}`);

```
const phone = normalizePhone(args.phone) || normalizePhone(session?.callerNumber || "");
if (!phone) { console.error("[BOOKING] ❌ Numéro invalide"); return { error: "Numéro invalide." }; }
const uri = serviceUri(args.service);
if (!uri)           return { error: "Service non configuré." };
if (!args.slot_iso) return { error: "Créneau manquant." };
if (!args.name?.trim()) return { error: "Nom manquant." };

const name = args.name.trim();

// ── Si email déjà connu → créer le RDV Calendly directement ─────────────
if (args.email?.trim()) {
  const email = args.email.trim().toLowerCase();
  console.log(`[BOOKING] Email connu — création RDV Calendly directement pour ${email}`);
  try {
    const result = await createInvitee({ uri, startTimeIso: args.slot_iso, name, email });
    const cancelUrl     = result?.resource?.cancel_url     || "";
    const rescheduleUrl = result?.resource?.reschedule_url || "";

    await saveContactToGoogle({ name, email, phone });

    const smsBody =
      `✅ Ton rendez-vous au ${SALON_NAME} est confirmé!
```

`+`👤 Nom        : ${name}
`+`✉️ Courriel   : ${email}
`+`✂️ Service    : ${serviceLabel(args.service)}
`+`📅 Date/heure : ${slotToFrench(args.slot_iso)}
`+`📍 Adresse    : ${SALON_ADDRESS}

`+ (rescheduleUrl ?`📆 Modifier : ${rescheduleUrl}
`: "") + (cancelUrl     ?`❌ Annuler  : ${cancelUrl}
`    : "") +`
À bientôt! — ${SALON_NAME}`;

```
    await Promise.race([
      sendSms(phone, smsBody),
      new Promise((_, rej) => setTimeout(() => rej(new Error("SMS timeout")), 15_000)),
    ]);
    console.log(`[BOOKING] ✅ RDV créé et SMS envoyé → ${phone}`);
    return { success: true, direct: true, phone_display: fmtPhone(phone), email };
  } catch (e) {
    console.error(`[BOOKING] ❌ Erreur RDV direct: ${e.message}`);
    return { error: `Impossible de créer le rendez-vous : ${e.message}` };
  }
}

// ── Sinon → envoyer lien SMS pour saisir le courriel ─────────────────────
const token = crypto.randomBytes(16).toString("hex");
pending.set(token, {
  expiresAt: Date.now() + 20 * 60 * 1000,
  payload: { phone, name, service: args.service, eventTypeUri: uri, startTimeIso: args.slot_iso },
});
console.log(`[BOOKING] Token créé: ${token}`);

const link = `${base()}/confirm-email/${token}`;
const smsPromise = sendSms(phone,
  `${SALON_NAME} — Bonjour ${name}!
```

`+`Pour finaliser ton rendez-vous du ${slotToFrench(args.slot_iso)}, `+`saisis ton courriel ici (lien valide 20 min) :
${link}`
);

```
try {
  await Promise.race([smsPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("SMS timeout 15s")), 15_000))]);
  console.log(`[BOOKING] ✅ SMS lien envoyé → ${phone}`);
  return { success: true, phone_display: fmtPhone(phone) };
} catch (e) {
  console.error(`[BOOKING] ❌ Erreur SMS: ${e.message}`);
  if (pending.has(token)) return { success: true, phone_display: fmtPhone(phone), warning: "SMS peut être en retard" };
  return { error: `Erreur SMS : ${e.message}` };
}
```

}

if (name === “get_salon_info”) {
const info = { adresse: SALON_ADDRESS, heures: SALON_HOURS, prix: SALON_PRICE_LIST };
return info[args.topic] ? { [args.topic]: info[args.topic] } : { error: “Sujet inconnu.” };
}

if (name === “update_contact”) {
const phone = normalizePhone(args.phone) || args.phone;
const name  = args.name?.trim();
const email = args.email?.trim().toLowerCase() || null;
if (!name || !phone) return { error: “Nom et téléphone requis.” };
await saveContactToGoogle({ name, email, phone });
console.log(`[CONTACT] ✅ Mis à jour: ${name} (${email}) — ${phone}`);
return { success: true, message: `Contact mis à jour : ${name}${email ? ` (${email})` : ""}.` };
}

if (name === “get_current_time”) {
const now = new Date();
const localStr = now.toLocaleString(“fr-CA”, { timeZone: CALENDLY_TIMEZONE, hour: “2-digit”, minute: “2-digit”, hour12: false });
const hour = parseInt(new Date(now.toLocaleString(“en-US”, { timeZone: CALENDLY_TIMEZONE })).getHours());
const periode = hour < 12 ? “matin” : hour < 17 ? “après-midi” : “soir”;
const salutation = hour < 12 ? “belle matinée” : hour < 17 ? “bel après-midi” : “belle soirée”;
return { heure_locale: localStr, heure: hour, periode, salutation_correcte: salutation };
}

if (name === “end_call”) {
session.shouldHangup = true;
return { hanging_up: true };
}

if (name === “transfer_to_agent”) {
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
console.error(”[TRANSFER] ❌ Erreur:”, e.message);
}
}, 1500);
} else {
console.warn(”[TRANSFER] FALLBACK_NUMBER non configuré ou twilioClient manquant”);
}
return { transferring: true };
}

return { error: `Outil inconnu : ${name}` };
}

// ─── Routes HTTP ──────────────────────────────────────────────────────────────
app.get(”/”, (req, res) => res.json({ ok: true, google_connected: !!googleTokens }));

// ─── OAuth Google ─────────────────────────────────────────────────────────────
app.get(”/oauth/start”, (req, res) => {
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
return res.status(500).send(“GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET manquant dans Railway.”);
}
const params = new URLSearchParams({
client_id:     GOOGLE_CLIENT_ID,
redirect_uri:  `${base()}/oauth/callback`,
response_type: “code”,
scope:         “https://www.googleapis.com/auth/contacts”,
access_type:   “offline”,
prompt:        “consent”,
});
res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get(”/oauth/callback”, async (req, res) => {
const { code, error } = req.query;
if (error) return res.status(400).send(`Erreur OAuth: ${error}`);
if (!code)  return res.status(400).send(“Code manquant”);

try {
const r = await fetch(“https://oauth2.googleapis.com/token”, {
method: “POST”,
headers: { “Content-Type”: “application/x-www-form-urlencoded” },
body: new URLSearchParams({
code,
client_id:     GOOGLE_CLIENT_ID,
client_secret: GOOGLE_CLIENT_SECRET,
redirect_uri:  `${base()}/oauth/callback`,
grant_type:    “authorization_code”,
}),
});
const j = await r.json();
if (!j.access_token) throw new Error(JSON.stringify(j));

```
googleTokens = {
  access_token:  j.access_token,
  refresh_token: j.refresh_token || process.env.GOOGLE_REFRESH_TOKEN,
  expiry_date:   Date.now() + (j.expires_in || 3600) * 1000,
};
console.log("[GOOGLE] ✅ OAuth connecté — token reçu");
const refreshToken = j.refresh_token || "(déjà configuré)";
res.type("text/html").send(`
  <h2>✅ Google Contacts connecté!</h2>
  ${j.refresh_token ? `
  <p>⚠️ <strong>Action requise pour que ça survive aux redémarrages Railway :</strong></p>
  <p>Copie cette variable dans Railway → Settings → Variables :</p>
  <pre style="background:#f0f0f0;padding:12px;border-radius:8px;word-break:break-all">GOOGLE_REFRESH_TOKEN = ${j.refresh_token}</pre>
  <p>Une fois ajoutée, tu n'auras plus jamais à refaire cette étape.</p>
  ` : '<p>✅ Refresh token déjà configuré dans Railway.</p>'}
  <p><a href="/">← Retour</a></p>
`);
```

} catch (e) {
console.error(”[GOOGLE] OAuth erreur:”, e.message);
res.status(500).send(`Erreur: ${e.message}`);
}
});

app.get(”/debug-env”, (req, res) => res.json({
SALON_NAME, SALON_CITY, SALON_ADDRESS, SALON_HOURS, SALON_PRICE_LIST,
TWILIO_CALLER_ID:     TWILIO_CALLER_ID     ? “✅” : “❌”,
GOOGLE_CLIENT_ID:     GOOGLE_CLIENT_ID     ? “✅” : “❌”,
GOOGLE_CLIENT_SECRET: GOOGLE_CLIENT_SECRET ? “✅” : “❌”,
GOOGLE_CONNECTED:     googleTokens         ? “✅ token actif” : “❌ visiter /oauth/start”,
OPENAI_API_KEY:     OPENAI_API_KEY     ? “✅” : “❌”,
CALENDLY_API_TOKEN: CALENDLY_API_TOKEN ? “✅” : “❌”,
URIs: {
homme:      CALENDLY_EVENT_TYPE_URI_HOMME      ? “✅” : “❌”,
femme:      CALENDLY_EVENT_TYPE_URI_FEMME      ? “✅” : “❌”,
nonbinaire: CALENDLY_EVENT_TYPE_URI_NONBINAIRE ? “✅” : “❌”,
},
}));

app.post(”/voice”, (req, res) => {
const { CallSid, From } = req.body;
console.log(`[VOICE] CallSid: ${CallSid} — From: ${From}`);

sessions.set(CallSid, {
twilioCallSid:  CallSid,
callerNumber:   normalizePhone(From || “”) || From || “”,
openaiWs:       null,
streamSid:      null,
shouldTransfer: false,
});

const twiml   = new twilio.twiml.VoiceResponse();
const connect = twiml.connect();
const stream  = connect.stream({ url: `${wsBase()}/media-stream` });
stream.parameter({ name: “twilioCallSid”, value: CallSid });
stream.parameter({ name: “callerNumber”,  value: From || “” });

res.type(“text/xml”).send(twiml.toString());
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on(“connection”, (twilioWs) => {
let oaiWs     = null;
let session   = null;
let streamSid = null;
let heartbeat = null;
let pendingTools = new Map();

oaiWs = new WebSocket(
`wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`,
{ headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, “OpenAI-Beta”: “realtime=v1” } }
);

// Silence G.711 µ-law (160 octets = 20ms à 8000Hz) encodé base64
const SILENCE_PAYLOAD = Buffer.alloc(160, 0xFF).toString(“base64”);

oaiWs.on(“open”, () => {
console.log(”[OAI] Connecté”);
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
event: “media”,
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

```
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
```

}

oaiWs.on(“message”, async (raw) => {
let ev;
try { ev = JSON.parse(raw); } catch { return; }

```
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
      }, 6000); // 6s pour laisser la phrase complète se terminer
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
```

});

oaiWs.on(“close”, (code) => {
console.log(`[OAI] Fermé (${code})`);
clearInterval(heartbeat);
clearInterval(twilioKeepalive);

```
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
```

});
oaiWs.on(“error”,  (e) => console.error(”[OAI WS]”, e.message));

twilioWs.on(“message”, (raw) => {
let msg;
try { msg = JSON.parse(raw); } catch { return; }

```
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
```

});

twilioWs.on(“close”, () => {
clearInterval(heartbeat);
clearInterval(twilioKeepalive);
oaiWs?.close();
});
twilioWs.on(“error”, (e) => console.error(”[Twilio WS]”, e.message));
});

// ─── Page web : saisie email ──────────────────────────────────────────────────
app.get(”/confirm-email/:token”, (req, res) => {
const entry = pending.get(req.params.token);
if (!entry || entry.expiresAt < Date.now())
return res.status(410).type(“text/html”).send(html410());
res.type(“text/html”).send(htmlForm(entry.payload.name));
});

app.post(”/confirm-email/:token”, async (req, res) => {
const entry = pending.get(req.params.token);
if (!entry || entry.expiresAt < Date.now())
return res.status(410).type(“text/html”).send(html410());

const { phone, name, service, eventTypeUri, startTimeIso } = entry.payload;
const email = (req.body.email || “”).trim().toLowerCase();

if (!email || !/^[^\s@]+@[^\s@]+.[^\s@]{2,}$/.test(email))
return res.status(400).type(“text/html”).send(htmlForm(name, “Courriel invalide.”));

try {
const result = await createInvitee({ uri: eventTypeUri, startTimeIso, name, email });
pending.delete(req.params.token);

```
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
```

} catch (e) {
console.error(”[EMAIL]”, e);
res.status(500).type(“text/html”).send(htmlError(e.message));
}
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f5f4ff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#fff;border-radius:16px;padding:36px 32px;max-width:460px;width:100%;box-shadow:0 4px 24px rgba(108,71,255,.12)}.logo{font-size:1.6rem;font-weight:700;color:#6c47ff;margin-bottom:4px}.sub{color:#888;font-size:.9rem;margin-bottom:28px}h1{font-size:1.25rem;color:#1a1a1a;margin-bottom:10px}p{color:#555;font-size:.95rem;line-height:1.5;margin-bottom:20px}label{display:block;font-size:.85rem;font-weight:600;color:#333;margin-bottom:6px}input[type=email]{width:100%;padding:13px 14px;font-size:1rem;border:1.5px solid #ddd;border-radius:10px;outline:none}input[type=email]:focus{border-color:#6c47ff}.btn{display:block;width:100%;margin-top:16px;padding:14px;background:#6c47ff;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer}.btn:hover{background:#5538d4}.err{color:#c0392b;font-size:.88rem;margin-top:8px}.box{background:#f5f4ff;border-radius:10px;padding:16px 18px;margin:20px 0;font-size:.92rem;line-height:1.8}a.lnk{display:block;margin-top:12px;color:#6c47ff;font-size:.9rem;text-decoration:none}.muted{color:#aaa;font-size:.8rem;margin-top:24px}`;

function layout(title, body) {
return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — ${SALON_NAME}</title><style>${css}</style></head><body><div class="card"><div class="logo">✂️ ${SALON_NAME}</div><div class="sub">Confirmation de rendez-vous</div>${body}</div></body></html>`;
}

function htmlForm(name, err = “”) {
return layout(“Confirmer ton courriel”, `<h1>Bonjour ${name}!</h1> <p>Entre ton adresse courriel pour finaliser ta réservation. Tu recevras tous les détails par texto.</p> <form method="POST"> <label for="e">Adresse courriel</label> <input id="e" name="email" type="email" required placeholder="toi@exemple.com" autocomplete="email" inputmode="email"/> ${err ?`<p class="err">⚠️ ${err}</p>` : ""} <button class="btn" type="submit">Confirmer ma réservation</button> </form> <p class="muted">Lien valide 20 minutes.</p>`);
}

function htmlSuccess(name, slot, reschedule, cancel) {
return layout(“Réservation confirmée”, `<h1>✅ Réservation confirmée!</h1> <p>Merci <strong>${name}</strong>! Ton rendez-vous est enregistré.</p> <div class="box">📅 <strong>${slot}</strong><br>📍 ${SALON_ADDRESS}</div> <p>Un texto de confirmation a été envoyé sur ton cellulaire.</p> ${reschedule ?`<a class="lnk" href="${reschedule}">📆 Modifier</a>`: ""} ${cancel     ?`<a class="lnk" href="${cancel}">❌ Annuler</a>`     : ""} <p class="muted">Tu peux fermer cette page.</p>`);
}

function htmlError(msg) {
return layout(“Erreur”, `<h1>⚠️ Erreur</h1><p>Impossible de créer le rendez-vous. Rappelle le salon.</p><pre style="font-size:.75rem;color:#c0392b;margin-top:12px;white-space:pre-wrap">${msg}</pre>`);
}

function html410() {
return layout(“Lien expiré”, `<h1>⏰ Lien expiré</h1><p>Ce lien n'est plus valide. Rappelle le salon pour un nouveau lien.</p>`);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`✅ ${SALON_NAME} — port ${PORT}`));