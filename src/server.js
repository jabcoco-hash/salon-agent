/**

- Salon Coco — Agent téléphonique IA v9
- 
- Collecte du numéro de téléphone :
- 1. Hélène propose d’envoyer la confirmation au numéro appelant
- 1. Si le client confirme → on utilise ce numéro directement
- 1. Si non → Hélène demande le numéro vocalement, le répète chiffre par chiffre,
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
CALENDLY_ORG_URI = “https://api.calendly.com/organizations/bb62d2e8-761e-48ed-9917-58e0a39126dd”,
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
if (!email) return “”;
const lower = email.toLowerCase();
const atIdx = lower.indexOf(”@”);
if (atIdx === -1) return lower.split(””).join(”-”);

const local  = lower.slice(0, atIdx);
const domain = lower.slice(atIdx + 1);

// Domaines courants — lire le mot complet
const domainMap = {
“gmail.com”:     “gmail point com”,
“hotmail.com”:   “hotmail point com”,
“outlook.com”:   “outlook point com”,
“yahoo.com”:     “yahoo point com”,
“yahoo.ca”:      “yahoo point ca”,
“videotron.ca”:  “vidéotron point ca”,
“videotron.net”: “vidéotron point net”,
“icloud.com”:    “icloud point com”,
“me.com”:        “me point com”,
“live.com”:      “live point com”,
“live.ca”:       “live point ca”,
“sympatico.ca”:  “sympatico point ca”,
“bell.net”:      “bell point net”,
};

const SPECIAL = { “.”: “point”, “_”: “tiret bas”, “-”: “tiret”, “+”: “plus” };
const spellPart = str => str.split(””).map(c => SPECIAL[c] || c).join(”-”).replace(/–/g, “-”);

const domainSpoken = domainMap[domain] || spellPart(domain);
return `${spellPart(local)} arobase ${domainSpoken}`;
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
const start = startDate ? new Date(startDate) : new Date(Date.now() + 1 * 60 * 1000); // +1min seulement
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
// ─── Cache coiffeuses Calendly ────────────────────────────────────────────────
// Structure: [{ name, userUri, eventTypes: { homme: uri, femme: uri } }]
let coiffeuses = [];

// URIs des event types Round Robin (chargés dynamiquement)
let roundRobinUris = { homme: null, femme: null };

async function loadCoiffeuses() {
try {
// 1. Membres de l’org (exclure le compte admin)
const membersR = await fetch(
`https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(CALENDLY_ORG_URI)}&count=100`,
{ headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` } }
);
const members = await membersR.json();
const staff = (members.collection || []).filter(m =>
m.user?.email !== “jabcoco@gmail.com”
);

```
// 2. Event types personnels (par user) + partagés (par org) — deux appels séparés
const fetchET = async (params) => {
  const r = await fetch(
    `https://api.calendly.com/event_types?${params}&count=100&active=true`,
    { headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` } }
  );
  const j = await r.json();
  return j.collection || [];
};

// Chercher les event types de l'org (inclut Shared)
const orgET    = await fetchET(`organization=${encodeURIComponent(CALENDLY_ORG_URI)}`);
// Chercher aussi les event types du compte admin (au cas où)
const adminURI = (await (await fetch("https://api.calendly.com/users/me", { headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` } })).json()).resource?.uri || "";
const adminET  = adminURI ? await fetchET(`user=${encodeURIComponent(adminURI)}`) : [];

// Fusionner et dédupliquer par URI
const seen = new Set();
const eventTypes = [...orgET, ...adminET].filter(e => {
  if (seen.has(e.uri)) return false;
  seen.add(e.uri);
  return true;
});

console.log("[CALENDLY] Event types trouvés (" + eventTypes.length + "):", eventTypes.map(e => e.name + " [" + e.type + "]").join(", "));

// 3. Trouver les event types Round Robin
const isRR = e => {
  const t = (e.type || "").toLowerCase().replace(/[_\s]/g, "");
  return t.includes("roundrobin") || t === "group";
};
const rrHomme = eventTypes.find(e => isRR(e) && e.name?.toLowerCase().includes("homme"));
const rrFemme = eventTypes.find(e => isRR(e) && e.name?.toLowerCase().includes("femme"));
roundRobinUris.homme = rrHomme?.uri || CALENDLY_EVENT_TYPE_URI_HOMME || null;
roundRobinUris.femme = rrFemme?.uri || CALENDLY_EVENT_TYPE_URI_FEMME || null;
console.log(`[CALENDLY] Round Robin — Homme: ${roundRobinUris.homme ? "✅" : "❌"} | Femme: ${roundRobinUris.femme ? "✅" : "❌"}`);

// 4. Mapper chaque coiffeuse avec ses event types individuels
coiffeuses = staff.map(m => {
  const userUri = m.user?.uri;
  const name    = m.user?.name;
  const hommeET = eventTypes.find(e =>
    e.profile?.owner === userUri && e.name?.toLowerCase().includes("homme")
  );
  const femmeET = eventTypes.find(e =>
    e.profile?.owner === userUri && e.name?.toLowerCase().includes("femme")
  );
  return {
    name,
    userUri,
    eventTypes: {
      homme: hommeET?.uri || null,
      femme: femmeET?.uri || null,
    }
  };
}).filter(c => c.eventTypes.homme || c.eventTypes.femme);

console.log(`[CALENDLY] ✅ ${coiffeuses.length} coiffeuses: ${coiffeuses.map(c => c.name).join(", ")}`);
```

} catch(e) {
console.error(”[CALENDLY] ❌ Erreur loadCoiffeuses:”, e.message);
}
}

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
return `Tu es Hélène, réceptionniste au ${SALON_NAME} à ${SALON_CITY}.
Tu parles en français québécois naturel. Ton chaleureuse, humaine, jamais robotique.

INFORMATIONS SALON :

- Adresse : ${SALON_ADDRESS}
- Heures : ${SALON_HOURS}
- Prix : ${SALON_PRICE_LIST}
- Numéro appelant : ${callerNumber || “inconnu”}

COMPORTEMENT FONDAMENTAL :

- Tu réponds UNIQUEMENT à ce que le client vient de dire. Rien de plus.
- Après chaque phrase ou question, tu ARRÊTES de parler et tu ATTENDS.
- Tu ne remplis JAMAIS le silence. Le silence est normal au téléphone.
- Maximum 1-2 phrases par tour. Jamais plus.
- Tu ne poses qu’UNE seule question à la fois. Tu attends la réponse avant de continuer.

ACCUEIL :

- Tu dis UNIQUEMENT : “Bienvenu au ${SALON_NAME} à ${SALON_CITY}, je m’appelle Hélène l’assistante virtuelle! Comment puis-je t’aider?”
- Puis SILENCE COMPLET. Tu attends que le client parle. Rien d’autre.

PRISE DE RENDEZ-VOUS — règle d’or : si le client donne plusieurs infos en une phrase, traite-les toutes, ne repose pas de questions auxquelles il a déjà répondu.

1. TYPE ET COIFFEUSE :
   → Si le client dit déjà le type + coiffeuse + date dans sa première phrase → passe directement à l’étape 2 avec tous ces paramètres.
   → Sinon demande le type (homme/femme) si inconnu.
   → Coloration, mise en plis, teinture, balayage → transfer_to_agent immédiatement.
   → Si le client mentionne coupe non binaire, queer, trans, non genrée, ou tout service LGBTQ+ → dis : “Pour s’assurer de bien répondre à tes besoins, je vais te mettre en contact avec un membre de notre équipe tout de suite!” → transfer_to_agent.
   → Si type connu mais coiffeuse inconnue → demande : “Tu as une préférence pour une coiffeuse en particulier?”
   → Interprète la réponse naturellement :
   • Prénom mentionné → paramètre coiffeuse = ce prénom
   • “peu importe”, “n’importe qui”, “pas de préférence”, “non”, “c’est égal” → PAS de paramètre coiffeuse
1. DISPONIBILITÉS :
   → LIMITE 90 JOURS : si la date demandée est à plus de 90 jours d’aujourd’hui → dis : “Cette date est un peu loin dans le temps, je vais te transférer à l’équipe qui pourra mieux t’aider!” → transfer_to_agent immédiatement. Ne cherche PAS de créneaux.
   → Si date relative → calcule et confirme avant de chercher.
   → Appelle get_available_slots avec le bon paramètre coiffeuse si demandé.
   → Les créneaux retournés sont GARANTIS disponibles — ne dis JAMAIS qu’une coiffeuse n’est pas disponible pour un créneau que tu viens de proposer.
   → Présente les créneaux clairement : “J’ai [jour] à [heure] et [jour] à [heure] — tu as une préférence?”
   → Si une seule option : “J’ai seulement le [jour] à [heure] — ça te convient?”
   → Si le client demande une heure précise qui N’EST PAS dans les créneaux retournés : dis “Désolée, le [jour] à [heure demandée] est déjà pris. J’ai plutôt [créneaux disponibles] — ça te convient?” Ne jamais proposer silencieusement d’autres plages sans dire que la plage demandée est prise.
   → Si le client insiste une 2e fois sur la même heure non disponible : dis “Je comprends que ce soit décevant! Je vais te transférer à notre équipe pour s’assurer de bien combler ta demande.” → transfer_to_agent.
   → Attends que le client choisisse. Ne rappelle PAS get_available_slots tant qu’il n’a pas choisi.
1. CONFIRMATION créneau :
   → Regroupe TOUT : “Coupe [homme/femme] le [jour complet] à [heure][, avec [coiffeuse] si coiffeuse choisie] — ça te convient?”
   → Attends OUI avant de continuer.
1. DOSSIER :
   → Appelle lookup_existing_client.
   → Trouvé → dis : “Parfait, j’ai ton dossier [nom]! Je confirme ton rendez-vous avec les informations au dossier.” → enchaîne DIRECTEMENT à l’étape 7 sans poser d’autres questions.
   → Non trouvé → demande le nom.
1. NUMÉRO (NOUVEAU CLIENT SEULEMENT) :
   → Demande le numéro de cellulaire : “Quel est ton numéro de cellulaire?” → attends la réponse → appelle normalize_and_confirm_phone → confirme : “J’ai le [numéro] — c’est bien ça?” → attends OUI/NON.
1. (ÉTAPE SUPPRIMÉE POUR CLIENT EXISTANT — on passe directement à 7)
1. ENVOI ET FIN :
   → Appelle send_booking_link.
   → CLIENT EXISTANT (email connu) : après succès → dis EXACTEMENT : “Ta confirmation est envoyée par texto. Bonne journée!” STOP.
   → Si tu ne reçois pas la confirmation, n’hésite pas à nous recontacter.
   → NOUVEAU CLIENT (pas d’email) : après succès → dis EXACTEMENT : “Tu vas recevoir un texto avec un lien pour confirmer ton courriel — ton rendez-vous sera confirmé une fois complété. Bonne journée!” STOP.
   → Appelle end_call IMMÉDIATEMENT — zéro mot de plus.

FIN D’APPEL SANS RDV :
→ Client dit “merci”, “bonne journée”, “c’est tout”, “au revoir” SANS avoir réservé :
→ Dis : “Bonne journée!” — rien d’autre.
→ Appelle end_call IMMÉDIATEMENT.
→ Ne mentionne JAMAIS confirmation, texto ou RDV si rien n’a été réservé.
→ ATTENTION : si send_booking_link vient d’être appelé avec succès, NE PAS passer par cette règle — l’appel se ferme déjà automatiquement.

RÈGLE ABSOLUE SUR end_call :
→ end_call = OBLIGATOIRE après toute salutation finale, sans exception.
→ Ne jamais laisser l’appel ouvert après avoir dit au revoir.
→ Ne jamais demander “Est-ce que je peux faire autre chose?” — fin directe.

RÈGLES :

- Prix, adresse, heures → réponds directement, sans appeler d’outil.
- N’invente jamais un nom. Utilise UNIQUEMENT ce que le client dit ou ce qui est dans le dossier.
- Ne propose jamais liste d’attente ni rappel.
- INTERDIT : dire “Parfait”.

INTERPRÉTATION NATURELLE — le client ne parle pas comme un robot :

- “non peu importe”, “n’importe qui”, “peu importe”, “c’est égal”, “pas de préférence”, “whatever”, “ça m’est égal” → signifie PAS DE PRÉFÉRENCE de coiffeuse → continue sans coiffeuse spécifique
- “oui”, “correct”, “ok”, “c’est beau”, “exactement”, “en plein ça”, “c’est ça”, “ouais” → signifie OUI → continue
- “non”, “pas vraiment”, “pas nécessairement”, “pas sûr” → signifie NON → ajuste en conséquence
- Si la réponse est ambiguë → interprète selon le contexte de la question posée
- Ne demande JAMAIS de répéter si le sens est compréhensible

TRANSFERT À UN HUMAIN — SEULEMENT si le client demande EXPLICITEMENT :

- Mots clés clairs : “agent”, “humain”, “parler à quelqu’un”, “parler à une personne”, “réceptionniste”
- Frustration répétée (3e fois qu’il dit la même chose sans être compris)
- Sacres répétés avec ton impatient
- Si Hélène ne comprend vraiment pas après 2 tentatives → “Désolée, je vais te transférer à l’équipe!” → transfer_to_agent
- JAMAIS transférer juste parce que la réponse n’est pas le mot exact attendu`;
  }

// ─── Outils ───────────────────────────────────────────────────────────────────
const TOOLS = [
{
type: “function”,
name: “get_available_slots”,
description: “Récupère les créneaux disponibles. NE PAS appeler si la date est à plus de 90 jours — transférer à l’agent. ‘le plus tôt possible’, ‘dès que possible’, ‘le plus rapidement possible’, ‘prochaine disponibilité’ = PAS de date_debut ni offset (cherche aujourd’hui). Pour dates relatives: ‘vendredi prochain’ = date ISO du prochain vendredi, ‘la semaine prochaine’ = date du lundi prochain, ‘en mars’ = ‘2026-03-01’, ‘dans 2 semaines’ = offset_semaines:2.”,
parameters: {
type: “object”,
properties: {
service:    { type: “string”, enum: [“homme”, “femme”, “nonbinaire”] },
coiffeuse:  { type: “string”, description: “Prénom de la coiffeuse souhaitée. Omets si pas de préférence.” },
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
description: “Formate le numéro appelant pour que Hélène puisse le lire à voix haute en groupes de chiffres, sans le 1 initial.”,
parameters: { type: “object”, properties: {}, required: [] },
},
{
type: “function”,
name: “normalize_and_confirm_phone”,
description: “Normalise un numéro de téléphone dicté vocalement et retourne sa version formatée pour que Hélène la confirme au client.”,
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
description: “Envoie le SMS de confirmation et crée le RDV. OBLIGATOIRE : tu dois avoir service + slot_iso + name + phone avant d’appeler. Si l’un de ces champs manque, NE PAS appeler — retourne demander l’info manquante au client d’abord.”,
parameters: {
type: “object”,
properties: {
service:    { type: “string”, enum: [“homme”, “femme”, “nonbinaire”], description: “OBLIGATOIRE — type de coupe” },
slot_iso:   { type: “string”, description: “OBLIGATOIRE — date ISO du créneau choisi” },
name:       { type: “string”, description: “OBLIGATOIRE — nom confirmé du client dans cet appel” },
phone:      { type: “string”, description: “OBLIGATOIRE — numéro validé E.164 ou 10 chiffres” },
email:      { type: “string”, description: “Courriel si déjà connu (client existant). Omets si inconnu.” },
coiffeuse:       { type: “string”, description: “Prénom de la coiffeuse choisie, si applicable.” },
event_type_uri:  { type: “string”, description: “URI exact de l’event type retourné par get_available_slots pour ce créneau. Toujours passer ce paramètre si disponible — c’est l’URI qui garantit que le booking se fait sur le bon calendrier.” },
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
name: “get_coiffeuses”,
description: “Retourne la liste des coiffeuses disponibles. Appelle cet outil quand le client demande à choisir une coiffeuse ou quand tu dois présenter les options.”,
parameters: { type: “object”, properties: {} },
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
description: “Raccroche l’appel proprement. Appelle après avoir dit au revoir, que ce soit après un RDV confirmé OU quand le client termine l’appel sans RDV. TOUJOURS appeler end_call après la salutation finale — ne jamais laisser l’appel ouvert.”,
parameters: { type: “object”, properties: {}, required: [] },
},
{
type: “function”,
name: “transfer_to_agent”,
description: “Transfère à un humain. SEULEMENT si: (1) le client demande explicitement un agent/humain, (2) après 2 tentatives Hélène ne comprend toujours pas, (3) service non supporté (coloration etc). NE PAS utiliser parce que la réponse est vague ou imprécise — interpréter naturellement d’abord.”,
parameters: { type: “object”, properties: {}, required: [] },
},
];

// ─── Exécution des outils ─────────────────────────────────────────────────────
async function runTool(name, args, session) {
console.log(`[TOOL] ${name}`, JSON.stringify(args));

// Logger les tools lents
const toolStart = Date.now();
const clearKeepalive = () => {
const elapsed = Date.now() - toolStart;
if (elapsed > 3000) console.log(`[TOOL] ${name} a pris ${elapsed}ms`);
};

if (name === “get_available_slots”) {
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
const searchEnd = endDate || (startDate
? new Date(startDate.getTime() + 7 * 24 * 3600 * 1000)
: new Date(Date.now() + 14 * 24 * 3600 * 1000));

```
  // Charger coiffeuses si pas encore fait
  if (coiffeuses.length === 0) await loadCoiffeuses();

  // Déterminer quelles coiffeuses chercher
  let coiffeusesCibles = coiffeuses.filter(c =>
    args.service === "femme" ? c.eventTypes.femme : c.eventTypes.homme
  );

  // Filtrer par coiffeuse demandée si spécifiée
  if (args.coiffeuse) {
    const match = coiffeusesCibles.find(c =>
      c.name.toLowerCase().includes(args.coiffeuse.toLowerCase())
    );
    if (match) {
      coiffeusesCibles = [match]; // STRICT : uniquement cette coiffeuse
    } else {
      // Coiffeuse demandée introuvable dans le cache → recharger
      await loadCoiffeuses();
      const match2 = coiffeuses.find(c =>
        c.name.toLowerCase().includes(args.coiffeuse.toLowerCase())
      );
      if (match2) coiffeusesCibles = [match2];
      else return { disponible: false, message: `${args.coiffeuse} n'est pas disponible pour ce service actuellement.` };
    }
    // Avec coiffeuse spécifique : NE PAS utiliser Round Robin
    // Aller directement chercher ses slots
  }

  // Si pas de coiffeuse spécifique → utiliser Round Robin (une coiffeuse sera assignée par Calendly)
  if (!args.coiffeuse && roundRobinUris[args.service === "femme" ? "femme" : "homme"]) {
    const rrUri = roundRobinUris[args.service === "femme" ? "femme" : "homme"];
    const rrSlots = await getSlots(rrUri, startDate, searchEnd);
    const slotCoiffeuseRR = {};
    for (const iso of rrSlots) slotCoiffeuseRR[iso] = ["disponible"];
    const uniqueRR = Object.keys(slotCoiffeuseRR).sort();
    const amRR = uniqueRR.filter(iso => new Date(new Date(iso).toLocaleString("en-US",{timeZone:CALENDLY_TIMEZONE})).getHours() < 12);
    const pmRR = uniqueRR.filter(iso => new Date(new Date(iso).toLocaleString("en-US",{timeZone:CALENDLY_TIMEZONE})).getHours() >= 12);
    const spaced = arr => arr.filter((_,i) => i%2===0);
    let sel = [...spaced(amRR).slice(0,2), ...spaced(pmRR).slice(0,2)];
    if (sel.length < 2) sel = uniqueRR.slice(0,4);
    return {
      disponible: sel.length > 0,
      slots: sel.map(iso => ({ iso, label: slotToFrench(iso), coiffeuses_dispo: [] })),
      note: "Présente les créneaux EN ORDRE CHRONOLOGIQUE — AM d'abord, PM ensuite. Ex: 'J'ai jeudi à 9h et à 14h — tu as une préférence?' JAMAIS PM avant AM.",
    };
  }

  // Fallback Railway si pas de coiffeuses dans le cache
  if (coiffeusesCibles.length === 0) {
    const fallbackUri = serviceUri(args.service);
    if (!fallbackUri) return { error: "Aucun event type configuré pour ce service." };
    coiffeusesCibles = [{ name: "disponible", eventTypes: { homme: fallbackUri, femme: fallbackUri } }];
  }

  // Récupérer les slots de toutes les coiffeuses cibles
  const slotCoiffeuse = {}; // iso -> [noms]
  for (const c of coiffeusesCibles) {
    const cUri = args.service === "femme" ? c.eventTypes.femme : c.eventTypes.homme;
    if (!cUri) continue;
    const cSlots = await getSlots(cUri, startDate, searchEnd);
    for (const iso of cSlots) {
      if (!slotCoiffeuse[iso]) slotCoiffeuse[iso] = [];
      slotCoiffeuse[iso].push(c.name);
    }
  }
  let slots = Object.keys(slotCoiffeuse).sort();

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
  selected.sort((a, b) => new Date(a) - new Date(b)); // toujours AM avant PM
  if (selected.length < 2) selected = unique.slice(0, 4); // fallback

  // Construire la map iso → URI source (pour booking exact)
  const slotUriMap = {};
  for (const c of coiffeusesCibles) {
    const cUri = args.service === "femme" ? c.eventTypes.femme : c.eventTypes.homme;
    if (!cUri) continue;
    const cSlots = await getSlots(cUri, startDate, searchEnd);
    for (const iso of cSlots) { if (!slotUriMap[iso]) slotUriMap[iso] = { uri: cUri, coiffeuse: c.name }; }
  }

  console.log(`[SLOTS] ✅ ${selected.length} créneaux (${amSlots.length} AM dispo, ${pmSlots.length} PM dispo)`);
  return {
    disponible: true,
    periode: startDate ? startDate.toLocaleDateString("fr-CA") : "cette semaine",
    slots: selected.map(iso => ({
      iso,
      label: slotToFrench(iso),
      coiffeuses_dispo: slotCoiffeuse[iso] || [],
      event_type_uri: slotUriMap[iso]?.uri || null,
    })),
    note: "Présente les créneaux EN ORDRE CHRONOLOGIQUE — AM d'abord, PM ensuite. Ex: 'J'ai jeudi à 9h et à 14h — tu as une préférence?' JAMAIS PM avant AM. IMPORTANT: quand le client choisit un créneau, passe son event_type_uri dans send_booking_link comme paramètre 'event_type_uri'.",
  };
} catch (e) {
  console.error("[SLOTS]", e.message);
  return { error: "Impossible de vérifier les disponibilités." };
}
```

}

if (name === “lookup_existing_client”) {
const phone = session?.callerNumber;
if (!phone) { clearKeepalive(); return { found: false, message: “Pas de numéro appelant disponible.” }; }
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
? `Client trouvé : ${client.name}. Dis : "J'ai un dossier au nom de ${client.name} — c'est bien toi?" Attends OUI. Ensuite épelle le courriel : "J'ai le courriel ${spellEmail(client.email)} dans le dossier — c'est toujours bon?"`
: `Client trouvé : ${client.name}, pas de courriel enregistré. Dis : "J'ai un dossier au nom de ${client.name} — c'est bien toi?" Attends OUI.`,
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
message: `Dis EXACTEMENT : "Je t'envoie la confirmation par texto au ${spokenGroups} — c'est bien ton cell?"`,
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
// Valider les champs obligatoires
const missing = [];
if (!args.service)   missing.push("service (homme/femme)");
if (!args.slot_iso)  missing.push("créneau choisi (slot_iso)");
if (!args.name)      missing.push("nom du client");
if (missing.length > 0) {
  console.error(`[BOOKING] ❌ Champs manquants: ${missing.join(", ")}`);
  return { error: `Informations manquantes: ${missing.join(", ")}. Assure-toi d'avoir complété toutes les étapes avant d'appeler send_booking_link.` };
}

const phone = normalizePhone(args.phone) || normalizePhone(session?.callerNumber || "");
if (!phone) { console.error("[BOOKING] ❌ Numéro invalide"); return { error: "Numéro invalide." }; }
// Charger les coiffeuses si pas encore fait
if (coiffeuses.length === 0) await loadCoiffeuses();

// Priorité : 1) event_type_uri du slot choisi (EXACT)  2) URI coiffeuse  3) Round Robin  4) Railway
let uri = args.event_type_uri || null;
let uriSource = "slot exact";

if (!uri && args.coiffeuse) {
  const match = coiffeuses.find(c => c.name.toLowerCase().includes(args.coiffeuse.toLowerCase()));
  if (match) {
    uri = args.service === "femme" ? match.eventTypes.femme : match.eventTypes.homme;
    uriSource = "coiffeuse " + match.name;
  }
}

if (!uri) {
  uri = args.service === "femme" ? roundRobinUris.femme : roundRobinUris.homme;
  uriSource = "round robin";
}

if (!uri) {
  const fallback = coiffeuses.find(c => args.service === "femme" ? c.eventTypes.femme : c.eventTypes.homme);
  if (fallback) {
    uri = args.service === "femme" ? fallback.eventTypes.femme : fallback.eventTypes.homme;
    uriSource = "fallback " + fallback.name;
  }
}

if (!uri) uri = serviceUri(args.service);

if (!uri) {
  console.error("[BOOKING] ❌ Aucun URI trouvé");
  return { error: "Service non configuré — aucun event type trouvé." };
}
console.log(`[BOOKING] URI source: ${uriSource} → ${uri.split("/").pop()}`);
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
`+`✂️ Service    : ${serviceLabel(args.service)}
`+ (args.coiffeuse ?`💇 Coiffeuse  : ${args.coiffeuse}
`: "") +`📅 Date/heure : ${slotToFrench(args.slot_iso)}
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
    // Forcer le raccrochage après que Hélène ait dit au revoir (8s)
    session.shouldHangup = true;
    session.hangupTimer = setTimeout(() => {
      console.log("[HANGUP] ✅ Raccrochage automatique post-booking");
      if (twilioClient && session.twilioCallSid) {
        twilioClient.calls(session.twilioCallSid)
          .update({ status: "completed" })
          .then(() => console.log("[HANGUP] ✅ Appel terminé"))
          .catch(e => console.error("[HANGUP] ❌", e.message));
      }
    }, 8000);
    return { success: true, direct: true, phone_display: fmtPhone(phone), email,
      message: "RDV confirmé. Dis EXACTEMENT cette phrase et RIEN D\'AUTRE : 'Ta confirmation est envoyée par texto. Bonne journée!' STOP. Zéro mot de plus. L\'appel se ferme." };
  } catch (e) {
    console.error(`[BOOKING] ❌ Erreur RDV direct: ${e.message}`);
    return { error: `Impossible de créer le rendez-vous : ${e.message}` };
  }
}

// ── Sinon → envoyer lien SMS pour saisir le courriel ─────────────────────
const token = crypto.randomBytes(16).toString("hex");
pending.set(token, {
  expiresAt: Date.now() + 120 * 60 * 1000, // 2h
  payload: { phone, name, service: args.service, eventTypeUri: uri, startTimeIso: args.slot_iso, coiffeuse: args.coiffeuse || null },
});
console.log(`[BOOKING] Token créé: ${token}`);

const link = `${base()}/confirm-email/${token}`;
const smsPromise = sendSms(phone,
  `${SALON_NAME} — Bonjour ${name}!
```

`+`Pour finaliser ton rendez-vous du ${slotToFrench(args.slot_iso)}, `+`saisis ton courriel ici (lien valide 2h) :
${link}`
);

```
try {
  await Promise.race([smsPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("SMS timeout 15s")), 15_000))]);
  console.log(`[BOOKING] ✅ SMS lien envoyé → ${phone}`);
  session.shouldHangup = true;
  session.hangupTimer = setTimeout(() => {
    console.log("[HANGUP] ✅ Raccrochage automatique post-booking SMS");
    if (twilioClient && session.twilioCallSid) {
      twilioClient.calls(session.twilioCallSid)
        .update({ status: "completed" })
        .then(() => console.log("[HANGUP] ✅ Appel terminé"))
        .catch(e => console.error("[HANGUP] ❌", e.message));
    }
  }, 8000);
  return { success: true, phone_display: fmtPhone(phone),
    message: "SMS envoyé. Dis EXACTEMENT cette phrase et RIEN D\'AUTRE : 'Ta confirmation est envoyée par texto. Bonne journée!' STOP. Zéro mot de plus. L\'appel se ferme." };
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

if (name === “get_coiffeuses”) {
if (coiffeuses.length === 0) await loadCoiffeuses();
const liste = coiffeuses.map(c => ({
nom: c.name,
services: [
c.eventTypes.homme ? “homme” : null,
c.eventTypes.femme ? “femme” : null,
].filter(Boolean)
}));
return {
coiffeuses: liste,
message: `Coiffeuses disponibles : ${liste.map(c => c.nom).join(", ")}. Présente-les au client et demande sa préférence. Si pas de préférence, dis que tu vas prendre la première disponible.`
};
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
const elapsed = Date.now() - (session?.callStartTime || Date.now());
if (elapsed < 15000) {
console.warn(`[HANGUP] ⚠️ Ignoré — trop tôt (${Math.round(elapsed/1000)}s). Continue la conversation.`);
return { error: “Trop tôt pour raccrocher — continue la conversation normalement.” };
}
console.log(`[HANGUP] ✅ Raccrochage programmé (durée: ${Math.round(elapsed/1000)}s)`);
session.shouldHangup = true;
// Raccrochage forcé après 7s — assez de temps pour que l’audio finisse
session.hangupTimer = setTimeout(() => {
console.log(”[HANGUP] ⏱ Exécution forcée”);
if (twilioClient && session.twilioCallSid) {
twilioClient.calls(session.twilioCallSid)
.update({ status: “completed” })
.then(() => console.log(”[HANGUP] ✅ Appel terminé”))
.catch(e => console.error(”[HANGUP] ❌ Erreur:”, e.message));
}
}, 7000);
return { hanging_up: true, message: “Au revoir dit — appel se termine dans quelques secondes.” };
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
// ─── Route info Calendly ──────────────────────────────────────────────────────
app.get(”/calendly-info”, async (req, res) => {
try {
const meR = await fetch(“https://api.calendly.com/users/me”, {
headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` }
});
const me = await meR.json();
const orgUri = me.resource?.current_organization;

```
const membersR = await fetch(`https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(orgUri)}&count=100`, {
  headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` }
});
const members = await membersR.json();

const etR = await fetch(`https://api.calendly.com/event_types?organization=${encodeURIComponent(orgUri)}&count=100`, {
  headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` }
});
const et = await etR.json();

res.type("text/html").send(`
  <h2>Calendly Info</h2>
  <h3>Organization URI</h3>
  <pre style="background:#f0f0f0;padding:10px">${orgUri}</pre>
  <h3>Membres (${members.collection?.length || 0})</h3>
  <pre style="background:#f0f0f0;padding:10px">${(members.collection || []).map(m =>
    "Nom   : " + m.user?.name + "\nEmail : " + m.user?.email + "\nURI   : " + m.user?.uri
  ).join("\n\n")}</pre>
  <h3>Event Types (${et.collection?.length || 0})</h3>
  <pre style="background:#f0f0f0;padding:10px">${(et.collection || []).map(e =>
    "Nom        : " + e.name +
    "\nURI        : " + e.uri +
    "\nOwner name : " + e.profile?.name +
    "\nOwner URI  : " + e.profile?.owner +
    "\nType       : " + e.type +
    "\nActif      : " + e.active
  ).join("\n\n")}</pre>
  <h3>Variables à mettre dans Railway</h3>
  <pre style="background:#e8f5e9;padding:10px">${(et.collection || []).filter(e => e.active).map(e =>
    "# " + e.name + "\n" +
    "CALENDLY_EVENT_TYPE_URI_" + e.name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + " = " + e.uri
  ).join("\n\n")}</pre>
`);
```

} catch(e) {
res.status(500).send(“Erreur: “ + e.message);
}
});

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
if (oaiWs.readyState === WebSocket.OPEN) {
oaiWs.ping();
// Envoyer silence audio pour garder le stream actif
oaiWs.send(JSON.stringify({ type: “input_audio_buffer.append”, audio: Buffer.alloc(160, 0xFF).toString(“base64”) }));
} else {
clearInterval(heartbeat);
}
}, 8_000);
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
      threshold:           0.7,    // équilibre : détecte la parole sans réagir au bruit de ligne
      prefix_padding_ms:   300,
      silence_duration_ms: 1000,
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
      text: "PHRASE OBLIGATOIRE — répète mot pour mot sans rien changer ni ajouter : 'Bienvenu au " + SALON_NAME + " à " + SALON_CITY + ", je m\'appelle Hélène l\'assistante virtuelle! Comment puis-je t\'aider?' — Cette phrase doit être dite EN ENTIER jusqu'au point d'interrogation inclus. Ensuite SILENCE ABSOLU.",
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
      // Le timer est déjà posé dans runTool — on envoie quand même la réponse à OpenAI
      // pour qu'il puisse dire "Bonne journée" avant que Twilio raccroche
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
        callStartTime:  Date.now(),
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

const { phone, name, service, eventTypeUri, startTimeIso, coiffeuse } = entry.payload;
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
  (coiffeuse ? `💇 Coiffeuse  : ${coiffeuse}\n` : "") +
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

// ─── Logs colorés ─────────────────────────────────────────────────────────────
const R = “[31m”, G = “[32m”, Y = “[33m”, X = “[0m”;
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);
console.error = (…a) => _origError(R + “[ERREUR]”, …a, X);
console.warn  = (…a) => _origWarn(Y  + “[AVERT]”,  …a, X);

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
console.log(G + `✅ ${SALON_NAME} — port ${PORT}` + X);
await loadCoiffeuses();
});