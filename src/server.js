/**
 * Salon Coco — Agent téléphonique IA v9
 *
 * Collecte du numéro de téléphone :
 *  1. Hélène propose d'envoyer la confirmation au numéro appelant
 *  2. Si le client confirme → on utilise ce numéro directement
 *  3. Si non → Hélène demande le numéro vocalement, le répète chiffre par chiffre,
 *     le client confirme avant d'aller plus loin
 *
 * Plus de redirection DTMF — tout reste dans OpenAI Realtime.
 */

import express          from "express";
import crypto           from "crypto";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import twilio           from "twilio";
import fs               from "fs";
import path             from "path";

const app        = express();
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/static", express.static(path.resolve("src")));

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
  CALENDLY_TIMEZONE     = "America/Montreal",
  CALENDLY_EVENT_TYPE_URI_HOMME,
  CALENDLY_EVENT_TYPE_URI_FEMME,
  CALENDLY_EVENT_TYPE_URI_FEMME_COLOR,
  CALENDLY_EVENT_TYPE_URI_FEMME_PLIS,
  CALENDLY_EVENT_TYPE_URI_FEMME_COLOR_PLIS,
  CALENDLY_EVENT_TYPE_URI_ENFANT,
  CALENDLY_EVENT_TYPE_URI_AUTRE,
  CALENDLY_ORG_URI = "https://api.calendly.com/organizations/bb62d2e8-761e-48ed-9917-58e0a39126dd",
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  RAILWAY_API_TOKEN,
} = process.env;

// Variables auto-injectées par Railway
const RAILWAY_SERVICE_ID     = process.env.RAILWAY_SERVICE_ID;
const RAILWAY_PROJECT_ID     = process.env.RAILWAY_PROJECT_ID;
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID; // ex: c86295eb-3b4d-4d99-a4f8-4ee25b68d080

function envStr(key, fallback = "") {
  const v = process.env[key];
  if (!v || !v.trim()) return fallback;
  return v.trim().replace(/^["']|["']$/g, "");
}

const AGENT_NAME        = envStr("AGENT_NAME",        "Hélène");
const SALON_NAME        = envStr("SALON_NAME",        "Salon Coco");
const SALON_CITY        = envStr("SALON_CITY",        "Magog Beach");
const SALON_ADDRESS     = envStr("SALON_ADDRESS",     "Adresse non configurée");
const SALON_HOURS       = envStr("SALON_HOURS",       "Heures non configurées");
const SALON_PRICE_LIST  = envStr("SALON_PRICE_LIST",  "Prix non configurés");
const SALON_LOGO_URL    = envStr("SALON_LOGO_URL",    "");
const SALON_PAYMENT     = envStr("SALON_PAYMENT",     "Nous acceptons comptant, débit et carte de crédit.");
const SALON_PARKING     = envStr("SALON_PARKING",     "Stationnement disponible directement sur place.");
const SALON_ACCESS      = envStr("SALON_ACCESS",      "Le salon est accessible aux personnes à mobilité réduite.");

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

function base() { return (PUBLIC_BASE_URL || "").replace(/\/$/, ""); }
function wsBase() { return base().replace(/^https/, "wss").replace(/^http/, "ws"); }

// ─── Stores ───────────────────────────────────────────────────────────────────
const sessions = new Map(); // twilioCallSid → session
const pending  = new Map(); // token → { expiresAt, payload }
// ─── Persistance logs JSON ────────────────────────────────────────────────────
// Railway Volume monté sur /data — persiste entre redémarrages
// Sur Railway : Settings → Add Volume → Mount Path: /data
// En local : fichier dans le répertoire courant
const LOGS_DIR  = fs.existsSync("/data") ? "/data" : ".";
const LOGS_FILE = path.join(LOGS_DIR, "call_logs.json");
const FAQ_FILE  = path.join(LOGS_DIR, "faq.json");

// Charger / sauvegarder FAQ
let faqItems = []; // [{ id, question, reponse, createdAt }]
function loadFaq() {
  try {
    if (fs.existsSync(FAQ_FILE)) {
      faqItems = JSON.parse(fs.readFileSync(FAQ_FILE, "utf8"));
      console.log(`[FAQ] ✅ ${faqItems.length} entrée(s) chargée(s)`);
    }
  } catch(e) { console.warn("[FAQ] ⚠️ Erreur chargement:", e.message); }
}
function saveFaq() {
  try { fs.writeFileSync(FAQ_FILE, JSON.stringify(faqItems, null, 2), "utf8"); }
  catch(e) { console.error("[FAQ] ❌ Erreur sauvegarde:", e.message); }
}
loadFaq();
const MAX_LOGS  = 500;

const callLogs = new Map(); // twilioCallSid → callLog

// Charger les logs existants au démarrage
function loadLogsFromDisk() {
  try {
    if (fs.existsSync(LOGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOGS_FILE, "utf8"));
      let fixed = 0, dropped = 0;
      for (const log of data) {
        if (log.result === "en cours") {
          // Un échange réel = au moins 1 message client OU plus de 1 event
          const hasRealExchange = (log.resumeClient?.length > 0) || (log.events?.length > 1);
          if (hasRealExchange) {
            // Garder mais fermer proprement
            log.result  = "fin normale";
            log.endedAt = log.endedAt || log.startedAt || new Date().toISOString();
            fixed++;
            callLogs.set(log.sid, log);
          } else {
            // Appel fantôme sans échange → supprimer
            dropped++;
          }
        } else {
          callLogs.set(log.sid, log);
        }
      }
      console.log(`[LOGS] ✅ ${data.length} appels chargés — ${fixed} fermés, ${dropped} fantômes supprimés`);
      if (fixed > 0 || dropped > 0) saveLogsToDisk();
    }
  } catch(e) {
    console.error("[LOGS] ❌ Erreur chargement:", e.message);
  }
}

// Sauvegarder sur disque — trié du plus récent au plus ancien
function saveLogsToDisk() {
  try {
    const arr = [...callLogs.values()]
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, MAX_LOGS);
    fs.writeFileSync(LOGS_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch(e) {
    console.error("[LOGS] ❌ Erreur sauvegarde:", e.message);
  }
}

function startCallLog(sid, callerNumber) {
  const log = {
    sid,
    callerNumber,
    startedAt: new Date().toISOString(),
    endedAt: null,
    result: "en cours",
    demandes: [],
    coiffeuse: null,
    service: null,
    slot: null,
    clientNom: null,
    clientType: null,        // "existant" | "nouveau" | null
    resumeClient: [],
    unanswered_questions: [],
    domains: [],
    emailDomains: [],
    events: [],
    serverLog: [],  // logs Railway bruts liés à cet appel
  };
  callLogs.set(sid, log);
  // Garder max en mémoire
  if (callLogs.size > MAX_LOGS) callLogs.delete(callLogs.keys().next().value);
  saveLogsToDisk();
  return log;
}

function logEvent(sid, type, msg) {
  const log = callLogs.get(sid);
  if (!log) return;
  log.events.push({ ts: new Date().toISOString(), type, msg });
  // Pas de save ici — on save seulement à la fermeture pour éviter I/O excessif
}

// Ajouter une ligne brute dans le serverLog d'un appel
function logRaw(sid, msg) {
  const log = callLogs.get(sid);
  if (!log) return;
  if (!log.serverLog) log.serverLog = [];
  const ts = new Date().toLocaleTimeString("fr-CA", { timeZone: "America/Montreal", hour12: false });
  log.serverLog.push(`[${ts}] ${msg}`);
}

function closeCallLog(sid, result) {
  const log = callLogs.get(sid);
  if (!log) return;
  // Supprimer les appels sans aucun échange réel (fantômes)
  const hasRealExchange = (log.resumeClient?.length > 0) || (log.events?.length > 1);
  if (!hasRealExchange && result === "fin normale") {
    callLogs.delete(sid);
    saveLogsToDisk();
    console.log(`[LOGS] 🗑 Appel fantôme supprimé (${sid})`);
    return;
  }
  log.endedAt = new Date().toISOString();
  log.result  = result;
  saveLogsToDisk();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(raw = "") {
  if (!raw) return null;
  // Nettoyer tous les caractères non-numériques
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === "1") return `+${d}`;
  // Format avec indicatif pays 0 (ex: 0514...) 
  if (d.length === 11 && d[0] === "0") return `+1${d.slice(1)}`;
  return null;
}

// Compare deux numéros en ignorant le format
function samePhone(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na && nb && na === nb;
}

function fmtPhone(e164 = "") {
  const d = e164.replace(/^\+1/, "");
  return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : e164;
}

// Épeler un email lettre par lettre pour la lecture vocale
// ex: "jab@hotmail.com" → "j-a-b arobase h-o-t-m-a-i-l point com"
function spellEmail(email = "") {
  if (!email) return "";
  const lower = email.toLowerCase();
  const atIdx = lower.indexOf("@");
  if (atIdx === -1) return lower.split("").join("-");

  const local  = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  // Domaines courants — lire le mot complet
  const domainMap = {
    "gmail.com":     "gmail point com",
    "hotmail.com":   "hotmail point com",
    "outlook.com":   "outlook point com",
    "yahoo.com":     "yahoo point com",
    "yahoo.ca":      "yahoo point ca",
    "videotron.ca":  "vidéotron point ca",
    "videotron.net": "vidéotron point net",
    "icloud.com":    "icloud point com",
    "me.com":        "me point com",
    "live.com":      "live point com",
    "live.ca":       "live point ca",
    "sympatico.ca":  "sympatico point ca",
    "bell.net":      "bell point net",
  };

  const SPECIAL = { ".": "point", "_": "tiret bas", "-": "tiret", "+": "plus" };
  const spellPart = str => str.split("").map(c => SPECIAL[c] || c).join("-").replace(/--/g, "-");

  const domainSpoken = domainMap[domain] || spellPart(domain);
  return `${spellPart(local)} arobase ${domainSpoken}`;
}

function slotToFrench(iso) {
  try {
    const d = new Date(iso);
    const datePart = d.toLocaleString("fr-CA", {
      weekday: "long", day: "numeric", month: "long",
      timeZone: CALENDLY_TIMEZONE,
    });
    // Ex: "mardi 3 mars" → "mardi le 3 mars"
    const datePartFull = datePart.replace(/^(\w+) (\d+) (.+)$/, "$1 le $2 $3");
    // Heure locale
    const loc = new Date(d.toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE }));
    const h = loc.getHours();
    const m = loc.getMinutes();
    // Minutes : 00 = omis, sinon en chiffres groupés (15, 30, 45, etc.)
    const minStr = m === 0 ? "" : String(m).padStart(2, "0");
    return `${datePartFull} à ${h}h${minStr}`;
  } catch { return iso; }
}

function serviceUri(s) {
  const map = {
    "homme":            CALENDLY_EVENT_TYPE_URI_HOMME,
    "femme":            CALENDLY_EVENT_TYPE_URI_FEMME,
    "femme_coloration": CALENDLY_EVENT_TYPE_URI_FEMME_COLOR,
    "femme_plis":       CALENDLY_EVENT_TYPE_URI_FEMME_PLIS,
    "femme_color_plis": CALENDLY_EVENT_TYPE_URI_FEMME_COLOR_PLIS,
    "enfant":           CALENDLY_EVENT_TYPE_URI_ENFANT,
    "autre":            CALENDLY_EVENT_TYPE_URI_AUTRE,
  };
  return map[s] || null;
}

function serviceLabel(s) {
  return {
    homme:            "coupe homme",
    femme:            "coupe femme",
    femme_coloration: "coupe femme + coloration",
    femme_plis:       "coupe femme + mise en plis",
    femme_color_plis: "coupe femme + coloration & mise en plis",
    enfant:           "coupe enfant",
    autre:            "coupe autre",
  }[s] || s;
}

// ─── Calendly ─────────────────────────────────────────────────────────────────
const cHeaders = () => ({
  Authorization: `Bearer ${CALENDLY_API_TOKEN}`,
  "Content-Type": "application/json",
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
    allSlots.push(...slots);
    cursor = chunkEnd;
    if (allSlots.length >= 20) break; // assez de résultats
  }
  return allSlots;
}

async function getEventLocation(uri) {
  const uuid = uri.split("/").pop();
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
let roundRobinUris = { homme: null, femme: null, femme_coloration: null, femme_plis: null, femme_color_plis: null, enfant: null, autre: null };
let serviceDescriptions = {}; // svc → description Calendly (chargée dynamiquement)

async function loadCoiffeuses() {
  try {
    // 1. Membres de l'org (exclure le compte admin)
    const membersR = await fetch(
      `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(CALENDLY_ORG_URI)}&count=100`,
      { headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` } }
    );
    const members = await membersR.json();
    const staff = (members.collection || []).filter(m =>
      m.user?.email !== "jabcoco@gmail.com"
    );

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
    // Round Robin chargé dans le bloc coiffeuses ci-dessous

    // 4. Mapper chaque coiffeuse avec ses event types individuels (tous services)
    const svcMatch = (name, keywords) => keywords.some(k => name?.toLowerCase().includes(k));
    coiffeuses = staff.map(m => {
      const userUri = m.user?.uri;
      const uname   = m.user?.name;
      const find = (...kws) => eventTypes.find(e => e.profile?.owner === userUri && svcMatch(e.name, kws));
      const et = {
        homme:            find("homme"),
        femme:            find("femme"),
        femme_coloration: find("coloration"),
        femme_plis:       find("mise en plis", "plis"),
        femme_color_plis: find("coloration & mise", "color & plis", "coloration et mise"),
        enfant:           find("enfant"),
        autre:            find("autre", "lgbtq", "non binaire", "nonbinaire"),
      };
      return {
        name: uname,
        userUri,
        eventTypes: Object.fromEntries(Object.entries(et).map(([k,v]) => [k, v?.uri || null])),
        eventDescriptions: Object.fromEntries(
          Object.entries(et)
            .filter(([,v]) => v?.description_plain)
            .map(([k,v]) => [k, v.description_plain.trim()])
        ),
      };
    }).filter(c => Object.values(c.eventTypes).some(Boolean));

    // Construire un index global des descriptions par service (prendre la 1ère trouvée)
    serviceDescriptions = {};
    for (const c of coiffeuses) {
      for (const [svc, desc] of Object.entries(c.eventDescriptions || {})) {
        if (!serviceDescriptions[svc] && desc) serviceDescriptions[svc] = desc;
      }
    }
    // Chercher aussi dans les event types partagés (org-level, sans owner individuel)
    const SVC_KEYS = { homme:["homme"], femme:["femme"], femme_coloration:["coloration"],
      femme_plis:["mise en plis","plis"], femme_color_plis:["coloration & mise","color & plis"],
      enfant:["enfant"], autre:["autre","lgbtq","non binaire"] };
    for (const [svc, kws] of Object.entries(SVC_KEYS)) {
      if (!serviceDescriptions[svc]) {
        const shared = eventTypes.find(e => svcMatch(e.name, kws) && e.description_plain);
        if (shared) serviceDescriptions[svc] = shared.description_plain.trim();
      }
    }
    const descCount = Object.keys(serviceDescriptions).length;
    console.log(`[CALENDLY] ✅ ${descCount} description(s) de services chargée(s):`, Object.keys(serviceDescriptions).join(", "));

    // Charger aussi les Round Robin pour tous les services
    const findRR = (...kws) => eventTypes.find(e => isRR(e) && svcMatch(e.name, kws));
    roundRobinUris = {
      homme:            findRR("homme")?.uri || CALENDLY_EVENT_TYPE_URI_HOMME || null,
      femme:            findRR("femme")?.uri || CALENDLY_EVENT_TYPE_URI_FEMME || null,
      femme_coloration: findRR("coloration")?.uri || CALENDLY_EVENT_TYPE_URI_FEMME_COLOR || null,
      femme_plis:       findRR("mise en plis", "plis")?.uri || CALENDLY_EVENT_TYPE_URI_FEMME_PLIS || null,
      femme_color_plis: findRR("coloration & mise", "color & plis")?.uri || CALENDLY_EVENT_TYPE_URI_FEMME_COLOR_PLIS || null,
      enfant:           findRR("enfant")?.uri || CALENDLY_EVENT_TYPE_URI_ENFANT || null,
      autre:            findRR("autre", "lgbtq")?.uri || CALENDLY_EVENT_TYPE_URI_AUTRE || null,
    };

    console.log(`[CALENDLY] ✅ ${coiffeuses.length} coiffeuses: ${coiffeuses.map(c => c.name).join(", ")}`);
    console.log(`[CALENDLY] Round Robin: ${Object.entries(roundRobinUris).filter(([,v])=>v).map(([k])=>k).join(", ")}`);
  } catch(e) {
    console.error("[CALENDLY] ❌ Erreur loadCoiffeuses:", e.message);
  }
}

let googleTokens = process.env.GOOGLE_REFRESH_TOKEN ? {
  access_token:  null, // sera rafraîchi automatiquement
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  expiry_date:   0,    // forcer un refresh immédiat
} : null;

if (googleTokens) console.log("[GOOGLE] ✅ Refresh token chargé depuis Railway");
else console.log("[GOOGLE] ⚠️ Pas de token — visite /oauth/start pour connecter");

async function getGoogleAccessToken() {
  if (!googleTokens) return null;
  // Refresh si access_token null OU expiré
  if (!googleTokens.access_token || (googleTokens.expiry_date && Date.now() > googleTokens.expiry_date - 60_000)) {
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
    // searchContacts ne trouve pas le contact — on utilise listConnections à la place
    // Les champs userDefined sont stockés avec clé/valeur inversés dans Google Contacts :
    // key="Coupe Homme", value="SalonCoco-TypeCoupe" (inverse de ce qu'on écrit)
    const r = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,userDefined&pageSize=1000`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = await r.json();
    const connections = j.connections || [];
    if (connections.length === 0) {
      console.log(`[LOOKUP] Aucun contact Google — nouveau client: ${phone}`);
      return null; // null = pas trouvé (Google vide ou erreur)
    }

    const extractSalonFields = (fields) => {
      const typeCoupe = fields.find(f => f.key === "SalonCoco-TypeCoupe")?.value || null;
      const coiffeuse = fields.find(f => f.key === "SalonCoco-Coiffeuse")?.value || null;
      return { typeCoupe, coiffeuse };
    };

    const match = connections.find(p =>
      (p.phoneNumbers || []).some(n => samePhone(n.value || "", phone))
    );

    if (match) {
      const name  = match.names?.[0]?.displayName || null;
      const email = match.emailAddresses?.[0]?.value || null;
      const { typeCoupe, coiffeuse } = extractSalonFields(match.userDefined || []);
      console.log(`[LOOKUP] ✅ Trouvé: ${name} (${email}) typeCoupe:${typeCoupe} coiffeuse:${coiffeuse}`);
      return { name, email, found: true, typeCoupe, coiffeuse, resourceName: match.resourceName };
    }

    console.log(`[LOOKUP] Nouveau client: ${phone}`);
    return null;
  } catch (e) {
    console.warn("[LOOKUP] Erreur:", e.message);
    return null;
  }
}

async function saveContactToGoogle({ name, email, phone, typeCoupe = null, coiffeuse = null, ownerName = null }) {
  // ownerName = nom du titulaire du dossier (parent si enfant, conjoint si pour quelqu'un d'autre)
  // name = nom sur l'invitation Calendly (peut être "Emma / Bergeron")
  const contactName = ownerName || name; // utiliser ownerName si fourni
  const token = await getGoogleAccessToken();
  if (!token) {
    console.warn("[GOOGLE] ❌ saveContact — pas de token. Visite /oauth/start.");
    return;
  }
  try {
    // ── Anti-doublon fiable : listConnections (même méthode que lookupClientByPhone) ──
    // searchContacts est peu fiable — on utilise la liste complète et on cherche par numéro
    const connR = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,userDefined&pageSize=1000`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const connJ = await connR.json();
    const connections = connJ.connections || [];

    const existing = connections.find(p =>
      (p.phoneNumbers || []).some(n => samePhone(n.value || "", phone))
    );

    if (existing) {
      // Contact trouvé — mettre à jour sans créer de doublon
      const resourceName   = existing.resourceName;
      const etag           = existing.etag;
      const existingEmail  = existing.emailAddresses?.[0]?.value || null;
      const existingUD     = existing.userDefined || [];

      const updateFields = {
        // Toujours inclure phoneNumbers pour satisfaire l'etag
        phoneNumbers: existing.phoneNumbers,
        userDefined: [
          { key: "SalonCoco-TypeCoupe", value: typeCoupe || "" },
          { key: "SalonCoco-Coiffeuse", value: coiffeuse || "" },
        ],
      };
      // Mettre à jour l'email seulement s'il change ou si on en a un nouveau
      if (email && email !== existingEmail) {
        updateFields.emailAddresses = [{ value: email }];
      } else if (existingEmail) {
        updateFields.emailAddresses = [{ value: existingEmail }];
      }

      const updateMask = Object.keys(updateFields).join(",");
      const patchR = await fetch(
        `https://people.googleapis.com/v1/${resourceName}:updateContact?updatePersonFields=${updateMask}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ etag, ...updateFields }),
        }
      );
      if (!patchR.ok) {
        const pe = await patchR.json();
        console.error(`[GOOGLE] ❌ Erreur mise à jour: ${patchR.status}`, JSON.stringify(pe));
      } else {
        console.log(`[GOOGLE] ✅ Contact mis à jour (pas de doublon): ${existing.names?.[0]?.displayName} — typeCoupe:${typeCoupe} coiffeuse:${coiffeuse}`);
      }
      return;
    }

    // ── Aucun contact existant → créer ──────────────────────────────────────
    const r = await fetch("https://people.googleapis.com/v1/people:createContact", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        names:          [{ displayName: contactName, givenName: contactName.split(" ")[0], familyName: contactName.split(" ").slice(1).join(" ") }],
        emailAddresses: email ? [{ value: email }] : [],
        phoneNumbers:   [{ value: phone, type: "mobile" }],
        userDefined:    [
          { key: "SalonCoco-TypeCoupe", value: typeCoupe || "" },
          { key: "SalonCoco-Coiffeuse", value: coiffeuse || "" },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      console.error(`[GOOGLE] ❌ Erreur création: ${r.status}`, JSON.stringify(j));
      if (r.status === 403) console.error("[GOOGLE] ❌ Scope insuffisant — revisite /oauth/start");
      return;
    }
    console.log(`[GOOGLE] ✅ Nouveau contact créé: ${name} (${email || "sans email"}) — ${phone}`);
  } catch (e) {
    console.error("[GOOGLE] ❌ Erreur saveContact:", e.message);
  }
}

// Cherche le prochain RDV Calendly pour un email donné
async function lookupUpcomingAppointment(email) {
  try {
    const r = await fetch(
      `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(CALENDLY_ORG_URI)}&invitee_email=${encodeURIComponent(email)}&status=active&count=5&sort=start_time:asc`,
      { headers: cHeaders() }
    );
    const j = await r.json();
    const events = j.collection || [];
    if (!events.length) return null;
    // Prendre le prochain dans le futur
    const now = new Date();
    const next = events.find(e => new Date(e.start_time) > now);
    if (!next) return null;
    return {
      start_time:    next.start_time,
      cancel_url:    next.cancellation?.cancel_url || null,
      reschedule_url: next.location?.join_url || null, // pas toujours dispo
      event_uri:     next.uri,
      status:        next.status,
    };
  } catch(e) {
    console.warn("[CALENDLY] Erreur lookupUpcoming:", e.message);
    return null;
  }
}

async function createInvitee({ uri, startTimeIso, name, email }) {
  const loc  = await getEventLocation(uri);
  const body = {
    event_type: uri,
    start_time: startTimeIso,
    invitee:    { name, email },
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

function slotToShort(iso) {
  // Format court pour SMS : "Lun 2 mars 9h30"
  const loc = new Date(iso).toLocaleString("fr-CA", { timeZone: CALENDLY_TIMEZONE, weekday:"short", day:"numeric", month:"long", hour:"numeric", minute:"2-digit" });
  // "lun. 2 mars 09 h 30" → "Lun 2 mars 9h30"
  return loc.replace(/\./g,"").replace(/(\w)/g, c=>c.toUpperCase()).replace(/\s0(\d)\sh\s00/,"$1h").replace(/\s(\d+)\sh\s00/," $1h").replace(/\s(\d+)\sh\s(\d+)/," $1h$2");
}

// ─── System prompt ────────────────────────────────────────────────────────────
function systemPrompt(callerNumber) {
  const callerDisplay = callerNumber ? fmtPhone(callerNumber) : null;
  return `Tu es ${AGENT_NAME}, réceptionniste au ${SALON_NAME} à ${SALON_CITY}.
Tu parles en français québécois naturel. Ton ton est chaleureux, humain, jamais robotique.

INFORMATIONS SALON :
- Adresse : ${SALON_ADDRESS}
- Heures : ${SALON_HOURS}
- Prix : ${SALON_PRICE_LIST}
- Prix service "autre" (non binaire, queer, trans, LGBTQ+) : le prix varie selon la complexité — évalué avec la coiffeuse lors du RDV.
${Object.keys(serviceDescriptions).length > 0 ? "- Détails par service :\n" + Object.entries(serviceDescriptions).map(([svc,desc]) => `  • ${svc}: ${desc}`).join("\n") : ""}
- Paiement : ${SALON_PAYMENT}
- Stationnement : ${SALON_PARKING}
- Accessibilité : ${SALON_ACCESS}
- Numéro appelant : [confidentiel]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ÉTATS CONVERSATIONNELS — AVANCE TOUJOURS EN AVANT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATE = INTRO → SERVICE → COIFFEUSE → SLOTS → CONFIRM_SLOT → NEW_CLIENT_INFO (si nouveau) → SEND_LINK → END

Règle absolue : ne jamais reculer à un état précédent sauf si le client change explicitement d'idée.
Le lookup initial n'est PAS un état — il s'exécute en arrière-plan pendant l'intro.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PATH CLIENT EXISTANT (prefetch ou lookup trouvé)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
→ Après intro : "Salut [prénom]! Super de t'entendre. Comment je peux t'aider aujourd'hui?"
→ Confirmation créneau → "Un instant, je finalise ta réservation." → send_booking_link DIRECTEMENT (ZÉRO question nom/cell/email).
→ Fin : "Ta confirmation sera envoyée par texto et courriel. Bonne journée!" → end_call.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PATH NOUVEAU CLIENT (aucun dossier trouvé)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
→ Après intro : "Comment je peux t'aider?"
→ Confirmation créneau → "Un instant, je finalise ta réservation." → collecter prénom → nom → cellulaire → send_booking_link.
→ Fin : "Je t'envoie un texto pour confirmer ton courriel. Une fois confirmé, tu recevras ta confirmation. Bonne journée!" → end_call.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPORTEMENT CONVERSATIONNEL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RÉPONSE :
- Tu accuses réception uniquement quand il y a une réponse exploitable.
- Bruits, "euh", interjections isolées, mots sans contexte → ignorer complètement, attendre une vraie réponse.
- Quand le client donne une réponse exploitable : accuse réception brièvement ("Super!", "Très bien!", "C'est noté!", "D'accord!", "Ça marche!") puis continue IMMÉDIATEMENT vers la prochaine étape logique.
- Maximum 1–2 phrases par tour. Jamais plus.
- Une seule question à la fois. Attends la réponse avant de continuer.
- Après chaque question → STOP. Silence jusqu'à réponse réelle.

MOTS ISOLÉS — deux catégories distinctes :
1. TRANSFERT (déclenche transfer_to_agent si dit seul, sans phrase) : "équipe", "agent", "humain", "réceptionniste", "transfert"
2. CONVERSATIONNELS (ne déclenchent rien, ignorer) : "ok", "oui", "non", "bye", "merci", "euh", bruits

ATTENTE OUTIL :
- Dès qu'un outil est appelé → dis IMMÉDIATEMENT : "Un instant, je regarde ça. Merci de patienter."
- Puis silence complet.
- Si le délai dépasse ~7 secondes → répète UNE seule fois : "Merci de patienter." Jamais en boucle.

PENDANT L'INTRO : si le client parle ou fait un bruit → ignorer complètement, terminer l'intro EN ENTIER.
APRÈS "Comment je peux t'aider?" → STOP COMPLET. Silence total jusqu'à ce que le client parle.
INTERRUPTION : si le client parle pendant que tu parles → arrête-toi, écoute, reprends selon ce qu'il dit.

VOCABULAIRE AUTORISÉ : Super, D'accord, C'est noté, Ça marche, Un petit instant, Excellent, Très bien.
INTERDIT : dire "Parfait" (utilise les alternatives ci-dessus). Jamais "je vérifie ton dossier".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACCUEIL (STATE = INTRO)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Dis UNIQUEMENT la phrase d'intro fournie par le système.
- Puis SILENCE ABSOLU — le système envoie immédiatement le followUp selon le dossier client.
- NE PAS improviser ni ajouter quoi que ce soit avant ce message système.
- La personnalisation (si client existant) arrive via le followUp — ne jamais la devancer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRISE DE RENDEZ-VOUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Règle d'or : si le client donne plusieurs infos en une phrase, traite-les toutes sans reposer de questions auxquelles il a déjà répondu.

1. TYPE DE SERVICE (STATE = SERVICE) :
   SERVICES — valeurs exactes pour get_available_slots :
   • "homme"            = coupe homme
   • "femme"            = coupe femme
   • "femme_coloration" = coupe femme + coloration
   • "femme_plis"       = coupe femme + mise en plis
   • "femme_color_plis" = coupe femme + coloration & mise en plis
   • "enfant"           = coupe enfant (garçon ou fille)
   • "autre"            = coupe autre (non binaire, queer, trans, etc.)

   → Si service + coiffeuse + date déjà connus → passe directement à l'étape 3.
   → ORDRE : 1) service? 2) coiffeuse? 3) get_available_slots.
   → Ambiguïté de service → toujours poser UNE question de clarification : "C'est pour une coupe homme, femme, enfant ou autre service?"
   → Coloration seule ou mise en plis seule sans coupe → transfer_to_agent.
   → Coupe non binaire/queer/trans → service "autre", pas de transfert.
   → Service connu, coiffeuse non précisée → TOUJOURS demander : "Tu as une préférence pour une coiffeuse?"
   → "peu importe", "n'importe qui", "pas de préférence", "non" → PAS de paramètre coiffeuse.
   → Changer de coiffeuse → accepter, demander "Tu as quelqu'un en tête?"
   → Lister services → appelle get_coiffeuses, liste services_offerts sans doublon.

2. RDV POUR UN TIERS :
   → "mon enfant / ma fille / mon garçon / mon fils / mon kid" → service "enfant" → "Quel est le prénom de l'enfant?"
   → "mon conjoint / ma conjointe / mon mari / ma femme / mon partenaire / ma mère / mon père" → service selon coupe → "Quel est le prénom de [personne]?"
   → NOM CALENDLY : prénom + nom de la personne qui reçoit le service. Demander nom de famille si inconnu.
   → DOSSIER GOOGLE : créé au prénom + nom du client appelant. Si nouveau, demander séparément prénom puis nom de famille.

3. DISPONIBILITÉS (STATE = SLOTS) :
   → Limite 90 jours → transfer_to_agent si dépassé.
   → Avant get_available_slots → "Un instant, je regarde ça. Merci de patienter." puis appelle.
   → Créneaux retournés GARANTIS disponibles — ne jamais dire qu'une coiffeuse n'est pas disponible.
   → DATE COMPLÈTE — TOUJOURS "jour le X mois à Hh". JAMAIS "mardi à 13h30".
   → REGROUPEMENT PAR JOURNÉE : même jour → date une fois, puis heures. Ex: "mardi le 3 mars à 9h et à 10h".
   → Coiffeuse demandée : "Avec [nom], les disponibilités sont : [liste]"
   → UN seul créneau : "J'ai seulement le [jour le X mois à Hh] — ça te convient?"
   → PLUSIEURS créneaux : liste-les TOUS puis dis "Quel moment serait le mieux pour toi?" — JAMAIS "ça te convient?" avec plusieurs créneaux.
   → Nom de coiffeuse incertain → demander confirmation : "C'est bien [nom] que tu veux?"
   → Si le client demande quelles coiffeuses sont disponibles → liste les noms dans coiffeuses_dispo déjà retournés, NE PAS rappeler get_available_slots.
   → Client insiste 2e fois sur même heure prise → "Je comprends! Je vais te transférer à l'équipe." → transfer_to_agent.
   → Aucun créneau SANS coiffeuse → "Je n'ai pas de disponibilité [cette semaine / ce jour-là]. Je peux regarder [la semaine prochaine / un autre jour]?" → OUI → get_available_slots offset ou nouvelle date. NON → transfer_to_agent.
   → Aucun créneau AVEC coiffeuse demandée → suis EXACTEMENT le message retourné par get_available_slots (propose prochaines dispo OU autres coiffeuses). NE JAMAIS transférer automatiquement dans ce cas.
   → Le message retourné par get_available_slots contient TOUJOURS les instructions exactes à suivre quand disponible=false — lis-le et exécute-le mot pour mot.
   → Client précise moment différent ("plus tard", "la semaine prochaine", "jeudi plutôt") → NE PAS transférer → rappelle get_available_slots avec la nouvelle contrainte.
   → Attends que le client choisisse. Ne rappelle PAS get_available_slots tant qu'il n'a pas choisi.

4. CONFIRMATION CRÉNEAU (STATE = CONFIRM_SLOT) :
   → "[Service] le [jour complet] à [heure], avec [coiffeuse] — ça te convient?"
   → Si coiffeuses_dispo vide → omets la coiffeuse.
   → Attends OUI. Ensuite → dis UNIQUEMENT "Super!" et passe à l'étape 5 IMMÉDIATEMENT.
   → NE PAS dire "je finalise ta réservation" ici — ce sera dit à l'étape 8 seulement, après avoir toutes les infos.

5. DOSSIER (après OUI confirmation créneau) :
   → Si prefetch fourni → email et nom connus → SAUTE à l'étape 8.
   → Sinon → appelle lookup_existing_client silencieusement (sans le mentionner).
   → Client trouvé → SAUTE à l'étape 8. ZÉRO question.
   → Client non trouvé → étape 5b.

5b. COLLECTE NOM — NOUVEAU CLIENT SEULEMENT (STATE = NEW_CLIENT_INFO) :
   → Dis EXACTEMENT : "Je ne semble pas avoir de dossier à ton nom — pas de problème, je vais en créer un! Quel est ton prénom?"
   → Client répond → IMMÉDIATEMENT : "Et ton nom de famille?"
   → Client répond → IMMÉDIATEMENT, transition fluide : "[prénom] [nom], super! Et pour t'envoyer ta confirmation, quel est ton numéro de cellulaire?" → étape 6.

6. NUMÉRO CELLULAIRE — NOUVEAU CLIENT SEULEMENT :
   ⚠️ INTERDIT si client existant.
   → Extrait uniquement les chiffres, ignore les mots autour.
   → DÈS que le client donne des chiffres → normalize_and_confirm_phone IMMÉDIATEMENT.
   → Le résultat te donne EXACTEMENT quoi dire — dis-le mot pour mot à voix haute.
   → Après OUI du client : dis "Super!" puis passe à l'étape 8 IMMÉDIATEMENT.
   → NON → "Peux-tu me le répéter?" → 2e tentative.
   → NON 2e fois → transfer_to_agent.
   → Pas de cellulaire → transfer_to_agent.

7. ÉVÉNEMENT SPÉCIAL :
   → Mariage, graduation, bal, événement → "Super! Je vais noter ça." → ajoute note dans description.

8. ENVOI ET FIN (STATE = SEND_LINK → END) :
   → Appelle send_booking_link avec : service, slot_iso, name, phone (si nouveau), email (si existant).
   → CLIENT EXISTANT : "Ta confirmation sera envoyée par texto et courriel. Bonne journée!" → end_call.
   → NOUVEAU CLIENT : "Je t'envoie un texto pour que tu confirmes ton courriel. Une fois confirmé, tu recevras ta confirmation. Bonne journée!" → end_call.

FIN D'APPEL SANS RDV :
   → "merci", "bonne journée", "c'est tout", "au revoir" sans RDV actif → "Bonne journée!" → end_call.
   → Ne jamais mentionner confirmation ou texto si rien n'a été réservé.

RÈGLE ABSOLUE end_call :
   → Après toute salutation finale, sans exception. Jamais "Est-ce que je peux faire autre chose?".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GESTION RDV EXISTANTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ANNULATION : get_existing_appointment → RDV trouvé avec cancel_url → SMS lien → "Lien envoyé! Tu veux prendre un nouveau RDV?" → NON → end_call. Sans cancel_url → transfer_to_agent. Aucun RDV → "Je ne trouve pas de RDV actif. Je te transfère?" → OUI → transfer_to_agent. NON → "Comment je peux t'aider?"
- MODIFICATION : get_existing_appointment → confirme date → "Pour modifier, utilise le lien dans ton texto, ou je te transfère." → transfer_to_agent si besoin.
- CONFIRMATION RDV : get_existing_appointment → lis date → "Bonne journée!" → end_call.
- RETARD : "Je vais avertir l'équipe." → transfer_to_agent.
- CHANGER NUMÉRO : "Pour modifier ton dossier, je te mets en contact avec l'équipe." → transfer_to_agent.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FAQ SALON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Paiement, stationnement, accessibilité → utilise les infos SALON ci-dessus.
- Durée service : "En général une coupe prend environ 30 à 45 minutes. Pour plus de détails je peux te transférer."
${faqItems.length > 0 ? "\nQUESTIONS FRÉQUENTES PERSONNALISÉES :\n" + faqItems.map((f,i) => "Q"+(i+1)+": "+f.question+"\nR"+(i+1)+": "+f.reponse).join("\n") : ""}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTRES SCÉNARIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- CADEAU / BON CADEAU → transfer_to_agent.
- CLIENT EN COLÈRE / PLAINTE → "Je suis désolée d'apprendre ça. Je te mets en contact avec l'équipe." → transfer_to_agent.
- JURONS : 1er sacre → ignorer complètement. 2e sacre agressif → "Je suis désolée, je te transfère à l'équipe." → transfer_to_agent.
- RAPPEL CONFIRMATION RDV → get_existing_appointment → lis date/heure → end_call.
- QUESTION HORS PORTÉE → "Désolée, je ne peux pas répondre à ça. Tu veux que je te transfère?" → OUI → transfer_to_agent. NON → "Comment je peux t'aider?"
- Ne jamais inventer une réponse à une question inconnue.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTERPRÉTATION NATURELLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- "non peu importe", "n'importe qui", "peu importe", "whatever", "ça m'est égal" → PAS DE PRÉFÉRENCE coiffeuse.
- "oui", "correct", "ok", "c'est beau", "exactement", "en plein ça", "c'est ça", "ouais" → OUI.
- "non", "pas vraiment", "pas nécessairement" → NON.
- Ambiguïté → interprète selon le contexte. Ne demande JAMAIS de répéter si le sens est compréhensible.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RÈGLES ABSOLUES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- N'invente jamais un nom. Utilise UNIQUEMENT ce que le client dit ou ce qui est dans le dossier.
- Ne propose jamais liste d'attente ni rappel.
- INTERDIT : "Parfait" (utilise Super, D'accord, Très bien, C'est noté, Ça marche, Excellent).
- INTERDIT : "je vérifie ton dossier" ou toute mention du lookup.
- APRÈS CHOIX DE CRÉNEAU : ne jamais redemander service ou coiffeuse déjà connus.
- CLIENT EXISTANT : JAMAIS demander nom, numéro ou email. Appelle send_booking_link directement.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRANSFERT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHRASE UNIQUE — deux cas, jamais d'autre formulation :
- Client demande explicitement un humain → "Un instant, je te transfère!"
- Impasse / limite d'Hélène → "Désolée, je ne peux pas t'aider davantage. Un instant, je te transfère."
→ transfer_to_agent immédiatement après. Ne rien dire de plus.

TRANSFERT IMMÉDIAT si demande EXPLICITE d'action :
• Mot isolé seul (sans phrase) : "équipe", "agent", "humain", "réceptionniste", "transfert"
• Phrase explicite : "je veux parler à quelqu'un / une personne / l'équipe / le propriétaire", "peux-tu me transférer", "parle-moi à quelqu'un", "talk to someone"
NE PAS transférer si le mot est dans une question d'info : "c'est quoi l'équipe?", "qui sont vos coiffeuses?" → répondre normalement.

TRANSFERT CONTEXTUEL :
- Frustration répétée (3e fois sans être compris) → transfer_to_agent.
- Sacres répétés (2e agressif) → transfer_to_agent.
- Hélène ne comprend pas après 2 tentatives → transfer_to_agent.
- JAMAIS transférer parce que la réponse est vague — interpréter d'abord.`;
}



// ─── Outils ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    name: "get_available_slots",
    description: "Récupère les créneaux disponibles. NE PAS appeler si la date est à plus de 90 jours — transférer à l'agent. 'le plus tôt possible', 'dès que possible', 'le plus rapidement possible', 'prochaine disponibilité', 'right now', 'tout de suite', 'tento', 'maintenant', 'live', 'asap' = PAS de date_debut ni offset (cherche AUJOURD'HUI — même journée). Pour dates relatives: 'vendredi prochain' = date ISO du prochain vendredi, 'la semaine prochaine' = date du lundi prochain, 'en mars' = '2026-03-01', 'dans 2 semaines' = offset_semaines:2.",
    parameters: {
      type: "object",
      properties: {
        service:    { type: "string", enum: ["homme", "femme", "femme_coloration", "femme_plis", "femme_color_plis", "enfant", "autre"] },
        coiffeuse:  { type: "string", description: "Prénom de la coiffeuse souhaitée. Omets si pas de préférence." },
        jour:       { type: "string", description: "Jour de la semaine UNIQUEMENT en un mot: 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'. Ne jamais mettre 'prochain' ou autre qualificatif." },
        periode:    { type: "string", enum: ["matin", "après-midi", "soir"], description: "Période souhaitée. Omets si non mentionnée." },
        date_debut: { type: "string", description: "Date ISO YYYY-MM-DD. Calcule la vraie date: 'vendredi prochain' → calcule et mets la date ISO du prochain vendredi. 'la semaine prochaine' → date du lundi prochain. 'en mars' → '2026-03-01'. Omets pour chercher à partir d'aujourd'hui." },
        offset_semaines: { type: "number", description: "Utilise SEULEMENT quand le client veut d'autres options que celles déjà proposées. Ex: 1 = décaler d'une semaine supplémentaire." },
      },
      required: ["service"],
    },
  },
  {
    type: "function",
    name: "lookup_existing_client",
    description: "Cherche si le numéro appelant est déjà un client connu. N'appelle PAS cet outil si le système t'a déjà fourni les infos client en début d'appel. Si tu dois l'appeler (aucune info reçue du système), appelle-le silencieusement sans rien dire avant.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "format_caller_number",
    description: "Formate le numéro appelant pour que Hélène puisse le lire à voix haute en groupes de chiffres, sans le 1 initial.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "normalize_and_confirm_phone",
    description: "Normalise un numéro de téléphone dicté vocalement et retourne sa version formatée pour que Hélène la confirme au client.",
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
    description: "Envoie la confirmation et crée le RDV Calendly. Appelle dès que le client a confirmé son créneau (OUI à l'étape de confirmation). CLIENT EXISTANT (prefetch ou lookup trouvé) : appelle IMMÉDIATEMENT — le serveur auto-complète nom/email/phone depuis le dossier, NE PAS redemander ces infos. NOUVEAU CLIENT : tu dois avoir name + phone avant d'appeler.",
    parameters: {
      type: "object",
      properties: {
        service:        { type: "string", enum: ["homme", "femme", "femme_coloration", "femme_plis", "femme_color_plis", "enfant", "autre"], description: "OBLIGATOIRE — type de service" },
        slot_iso:       { type: "string", description: "OBLIGATOIRE — date ISO du créneau choisi" },
        name:           { type: "string", description: "Nom du client. OPTIONNEL si client existant — le serveur le récupère automatiquement du dossier." },
        phone:          { type: "string", description: "Numéro de téléphone. OPTIONNEL si client existant — le serveur utilise le numéro appelant." },
        email:          { type: "string", description: "Courriel si connu. OPTIONNEL si client existant — le serveur le récupère du dossier." },
        coiffeuse:      { type: "string", description: "Prénom de la coiffeuse choisie, si applicable." },
        event_type_uri: { type: "string", description: "URI exact de l'event type retourné par get_available_slots. Toujours passer si disponible." },
      },
      required: ["service", "slot_iso"],
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
    name: "update_contact",
    description: "Met à jour ou crée un contact dans Google Contacts. Appelle quand le client corrige son courriel ou donne un nouveau numéro.",
    parameters: {
      type: "object",
      properties: {
        name:  { type: "string", description: "Nom complet du client" },
        email: { type: "string", description: "Nouveau courriel confirmé" },
        phone: { type: "string", description: "Numéro de téléphone" },
      },
      required: ["name", "phone"],
    },
  },
  {
    type: "function",
    name: "get_coiffeuses",
    description: "Retourne la liste des coiffeuses disponibles. Appelle cet outil quand le client demande à choisir une coiffeuse ou quand tu dois présenter les options.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_current_time",
    description: "Retourne l'heure locale exacte au Québec. Appelle AVANT de souhaiter une belle matinée/après-midi/soirée pour utiliser la bonne salutation.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "end_call",
    description: "Raccroche l'appel proprement. Appelle après avoir dit au revoir, que ce soit après un RDV confirmé OU quand le client termine l'appel sans RDV. TOUJOURS appeler end_call après la salutation finale — ne jamais laisser l'appel ouvert.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_existing_appointment",
    description: "Cherche le prochain rendez-vous Calendly du client appelant, basé sur son email. Appelle si le client parle d'annuler, modifier ou confirmer son RDV existant. Retourne la date/heure et les liens d'annulation/modification.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "transfer_to_agent",
    description: "Transfère à un humain. SEULEMENT si: (1) le client demande explicitement un agent/humain, (2) après 2 tentatives Hélène ne comprend toujours pas, (3) service non supporté (coloration etc). JAMAIS pour: une préférence de date, d'heure, de semaine, un changement de disponibilité, une question sur les services — dans ces cas interpréter et agir directement.",
    parameters: { type: "object", properties: {
      raison: { type: "string", enum: ["client", "erreur", "incomprehension", "service_non_supporte"], description: "Raison du transfert. 'client' = client a demandé. 'erreur' = erreur système/booking. 'incomprehension' = Hélène ne comprend pas. 'service_non_supporte' = coloration etc." }
    }, required: [] },
  },
];

// ─── Exécution des outils ─────────────────────────────────────────────────────
async function runTool(name, args, session) {
  console.log(`[TOOL] ${name}`, JSON.stringify(args));

  // Logger dans callLogs
  const sid = session?.twilioCallSid;
  const cl  = sid ? callLogs.get(sid) : null;
  if (cl) {
    if (name === "get_available_slots") {
      if (args.service) cl.service = args.service;
      if (args.coiffeuse) cl.coiffeuse = args.coiffeuse;
      // Coiffeuse sera mise à jour dans send_booking_link depuis coiffeuses_dispo si besoin
      if (!cl.demandes.includes("rdv")) cl.demandes.push("rdv");
      logEvent(sid, "tool", `Recherche créneaux — service:${args.service}${args.coiffeuse ? " coiffeuse:"+args.coiffeuse : ""}${args.date_debut ? " date:"+args.date_debut : ""}`);
          } else if (name === "get_salon_info") {
      if (!cl.demandes.includes(args.topic)) cl.demandes.push(args.topic);
      logEvent(sid, "tool", `Info salon demandée : ${args.topic}`);
    } else if (name === "lookup_existing_client") {
      logEvent(sid, "tool", "Recherche dossier client");
    } else if (name === "send_booking_link") {
      cl.service    = args.service || cl.service;
      cl.coiffeuse  = args.coiffeuse || cl.coiffeuse;
      cl.slot       = args.slot_iso || null;
      cl.clientNom  = args.name || null;
      logEvent(sid, "booking", `Envoi confirmation — ${args.name} | ${args.service} | ${args.slot_iso}`);
    } else if (name === "end_call") {
      logEvent(sid, "info", "end_call déclenché");
    } else if (name === "transfer_to_agent") {
      logEvent(sid, "warn", "Transfert agent demandé");
    }
  }

  // Logger les tools lents
  const toolStart = Date.now();
  const clearKeepalive = () => {
    const elapsed = Date.now() - toolStart;
    if (elapsed > 3000) console.log(`[TOOL] ${name} a pris ${elapsed}ms`);
  };

  if (name === "get_available_slots") {
    try {
      // Calculer la fenêtre de dates
      let startDate = null;
      if (args.date_debut) {
        // Interpréter YYYY-MM-DD en heure locale (Toronto) et non UTC
        // "2026-02-28" + "T06:00:00" = minuit heure locale (UTC-5 en hiver)
        const tzOffset = new Date().toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE, timeZoneName: "shortOffset" })
          .match(/GMT([+-]\d+)/)?.[1] || "-5";
        const offsetHours = -parseInt(tzOffset);
        const paddedOffset = String(Math.abs(offsetHours)).padStart(2, "0");
        const sign = offsetHours >= 0 ? "+" : "-";
        startDate = new Date(`${args.date_debut}T00:00:00${sign}${paddedOffset}:00`);
        if (isNaN(startDate.getTime())) startDate = new Date(args.date_debut);
        // Si la date calculée est dans le passé, utiliser maintenant
        if (startDate < new Date()) startDate = new Date(Date.now() + 60 * 1000);
      }
      if (args.offset_semaines) {
        const base = startDate || new Date();
        startDate = new Date(base.getTime() + args.offset_semaines * 7 * 24 * 3600 * 1000);
      }
      const endDate = startDate ? new Date(startDate.getTime() + 7 * 24 * 3600 * 1000) : null;
      const searchEnd = endDate || (startDate
        ? new Date(startDate.getTime() + 7 * 24 * 3600 * 1000)
        : new Date(Date.now() + 14 * 24 * 3600 * 1000));

      // Charger coiffeuses si pas encore fait
      if (coiffeuses.length === 0) await loadCoiffeuses();

      // Déterminer quelles coiffeuses chercher
      const svc = args.service || "homme";
      let coiffeusesCibles = coiffeuses.filter(c => c.eventTypes[svc]);

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
          else return { disponible: false, raison: "coiffeuse_inconnue", coiffeuse_demandee: args.coiffeuse, message: `Coiffeuse "${args.coiffeuse}" introuvable dans le système. Dis au client : "Je ne trouve pas de coiffeuse avec ce nom. ${coiffeuses.length ? 'Nos coiffeuses disponibles sont : ' + coiffeuses.map(c=>c.name).join(', ') + '. Tu as une préférence?' : 'Veux-tu que je te propose des disponibilités?'}" — NE PAS transférer.` };
        }
        // Avec coiffeuse spécifique : NE PAS utiliser Round Robin
        // Aller directement chercher ses slots
      }

      // Si pas de coiffeuse spécifique → utiliser Round Robin (une coiffeuse sera assignée par Calendly)
      // Round Robin désactivé — on utilise directement les coiffeuses individuelles
      // (roundRobinUris conservé en mémoire mais non utilisé pour les slots)

      // Fallback Railway si pas de coiffeuses dans le cache
      if (coiffeusesCibles.length === 0) {
        const fallbackUri = serviceUri(svc);
        if (!fallbackUri) return { error: `Aucun event type configuré pour le service "${svc}".` };
        coiffeusesCibles = [{ name: "disponible", eventTypes: { [svc]: fallbackUri } }];
      }

      // Récupérer les slots de toutes les coiffeuses cibles — un seul appel par coiffeuse
      const slotCoiffeuse = {}; // iso -> [noms]
      const slotUriMap    = {}; // iso -> { uri, coiffeuse } — construit ICI, pas après
      for (const c of coiffeusesCibles) {
        const cUri = c.eventTypes[svc] || c.eventTypes.femme || c.eventTypes.homme;
        if (!cUri) continue;
        const cSlots = await getSlots(cUri, startDate, searchEnd);
        for (const iso of cSlots) {
          if (!slotCoiffeuse[iso]) slotCoiffeuse[iso] = [];
          slotCoiffeuse[iso].push(c.name);
          if (!slotUriMap[iso]) slotUriMap[iso] = { uri: cUri, coiffeuse: c.name };
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
          const nomCoiffeuse = args.coiffeuse || null;
          return {
            disponible: false,
            raison: "aucun_creneau_periode",
            coiffeuse_demandee: nomCoiffeuse,
            message: nomCoiffeuse
              ? `${nomCoiffeuse} n'a pas de disponibilité pour cette période. Dis EXACTEMENT : "${nomCoiffeuse} n'est pas disponible cette semaine-là. Est-ce que tu veux que je regarde ses prochaines disponibilités, ou tu préfères voir d'autres coiffeuses?" — puis attends la réponse. NE PAS transférer.`
              : `Aucun créneau pour la période demandée. La fenêtre Calendly ne couvre peut-être pas cette date. Dis au client et propose une date plus proche.`,
          };
        }
      } else if (!slots.length) {
        const nomCoiffeuse = args.coiffeuse || null;
        return {
          disponible: false,
          raison: "aucun_creneau_semaine",
          coiffeuse_demandee: nomCoiffeuse,
          message: nomCoiffeuse
            ? `${nomCoiffeuse} n'a pas de disponibilité cette semaine. Dis EXACTEMENT : "${nomCoiffeuse} n'est pas disponible cette semaine. Est-ce que tu veux que je regarde ses prochaines disponibilités, ou tu préfères voir d'autres coiffeuses?" — puis attends la réponse. NE PAS transférer.`
            : "Aucune disponibilité cette semaine. Propose la semaine prochaine.",
        };
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

      // Sélectionner MINIMUM 4 créneaux variés — garantir la diversité AM/PM
      const getHourLocal = iso => new Date(new Date(iso).toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE })).getHours();
      const amSlots = unique.filter(iso => getHourLocal(iso) < 12);
      const pmSlots = unique.filter(iso => getHourLocal(iso) >= 12);
      // Prendre jusqu'à 2 AM + jusqu'à 2 PM, espacés
      const spaced  = arr => arr.filter((_, i) => i % 2 === 0);
      let selected  = [...spaced(amSlots).slice(0, 2), ...spaced(pmSlots).slice(0, 2)];
      selected.sort((a, b) => new Date(a) - new Date(b));
      // Si on a moins de 4, compléter avec les prochains créneaux disponibles
      if (selected.length < 4) {
        const existing = new Set(selected);
        for (const iso of unique) {
          if (selected.length >= 4) break;
          if (!existing.has(iso)) { selected.push(iso); existing.add(iso); }
        }
        selected.sort((a, b) => new Date(a) - new Date(b));
      }

      console.log(`[SLOTS] ✅ ${selected.length} créneaux (${amSlots.length} AM dispo, ${pmSlots.length} PM dispo)`);
      const svcDesc = serviceDescriptions[svc] || null;
      return {
        disponible: true,
        periode: startDate ? startDate.toLocaleDateString("fr-CA") : "cette semaine",
        slots: selected.map(iso => ({
          iso,
          label: slotToFrench(iso),
          coiffeuses_dispo: slotCoiffeuse[iso] || [],
          event_type_uri: slotUriMap[iso]?.uri || null,
        })),
        description_service: svcDesc,
        note: "Présente les créneaux EN ORDRE CHRONOLOGIQUE avec DATE COMPLÈTE. RÈGLE ABSOLUE : ne propose QUE les créneaux présents dans cette liste. Si une coiffeuse a été demandée, commence par 'Avec [prénom], les disponibilités sont :'. Si aucune coiffeuse demandée mais coiffeuses_dispo non vide, mentionne les noms. REGROUPER par journée. AM avant PM. Si UN SEUL créneau : 'J\'ai seulement le [date] — ça te convient?'. Si PLUSIEURS créneaux : liste-les et dis 'Quel moment serait le mieux pour toi?' — JAMAIS 'ça te convient?' avec plusieurs créneaux. CONFIRMATION après choix : '[Service] le [date] à [heure], avec [coiffeuse] — ça te convient?' puis attends OUI. Retiens le nom de coiffeuse du créneau choisi et passe-le OBLIGATOIREMENT dans send_booking_link.",
      };
    } catch (e) {
      console.error("[SLOTS]", e.message);
      return { error: "Impossible de vérifier les disponibilités." };
    }
  }

  if (name === "lookup_existing_client") {
    const phone = session?.callerNumber;
    if (!phone) { clearKeepalive(); return { found: false, message: "Pas de numéro appelant disponible." }; }
    // Utiliser le résultat prefetch si déjà disponible (lookup lancé pendant l'accueil)
    let client = session?.prefetchedClient;
    if (client === undefined) {
      console.log(`[LOOKUP] Recherche client pour ${phone}`);
      client = await lookupClientByPhone(phone);
    } else {
      console.log(`[LOOKUP] Utilisation prefetch pour ${phone}: ${client?.name || "nouveau"}`);
    }
    if (client) {
      console.log(`[LOOKUP] ✅ Client trouvé: ${client.name} (${client.email})`);
      if (cl) { cl.clientNom = client.name; cl.clientType = "existant"; logEvent(sid, "info", `Client trouvé: ${client.name}`); }
      const prefSuggestion = client.typeCoupe || client.coiffeuse
        ? ` Désires-tu prendre rendez-vous pour une ${client.typeCoupe || "coupe"}${client.coiffeuse ? " avec " + client.coiffeuse : ""}?`
        : "";
      return {
        found:      true,
        name:       client.name,
        email:      client.email || null,
        has_email:  !!client.email,
        typeCoupe:  client.typeCoupe || null,
        coiffeuse:  client.coiffeuse || null,
        message:    `Dossier trouvé : ${client.name}.${prefSuggestion ? ` Complète ton accueil avec : "Comment puis-je t'aider, ${client.name.split(" ")[0]}?${prefSuggestion}"` : ` Dis : "Comment puis-je t'aider, ${client.name.split(" ")[0]}?"`}. Attends sa réponse.`,
      };
    }
    console.log(`[LOOKUP] Nouveau client`);
    if (cl) cl.clientType = "nouveau";
    return { found: false, message: "Nouveau client — demande le nom normalement." };
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
      message: `Dis EXACTEMENT : "Je t'envoie la confirmation par texto au ${spokenGroups} — c'est bien ton cell?"`,
    };
  }

  if (name === "normalize_and_confirm_phone") {
    const phone = normalizePhone(args.raw_phone || "");
    if (!phone) return {
      valid: false,
      message: "Numéro invalide — demande au client de répéter.",
    };
    const digs = phone.replace(/\D/g,"").slice(-10);
    const digitWords = {"0":"zéro","1":"un","2":"deux","3":"trois","4":"quatre","5":"cinq","6":"six","7":"sept","8":"huit","9":"neuf"};
    const spellGroup = g => g.split("").map(d => digitWords[d]||d).join("-");
    const g1 = spellGroup(digs.slice(0,3));
    const g2 = spellGroup(digs.slice(3,6));
    const g3 = spellGroup(digs.slice(6));
    return {
      valid: true,
      phone,
      formatted: fmtPhone(phone),
      spoken_groups: g1 + " " + g2 + " " + g3,
      message: `Numéro reçu. Tu DOIS parler maintenant. Dis EXACTEMENT et IMMÉDIATEMENT à voix haute : "Super! Pour confirmer, c'est bien le ${g1}... ${g2}... ${g3}?" — prononce chaque groupe séparément avec une courte pause. Ne fais RIEN d'autre avant d'avoir dit cette phrase. Attends OUI ou NON du client.`,
    };
  }

  if (name === "send_booking_link") {
    // ── Auto-compléter depuis le prefetch si le modèle n'a pas passé les infos ──
    const prefetch = session?.prefetchedClient;
    if (!args.name  && prefetch?.name)  args.name  = prefetch.name;
    if (!args.email && prefetch?.email) args.email = prefetch.email;
    if (!args.phone && prefetch?.phone) args.phone = prefetch.phone;

    console.log(`[BOOKING] Début — service:${args.service} slot:${args.slot_iso} name:${args.name} phone:${args.phone} email:${args.email || "inconnu"}`);

    // Valider les champs obligatoires
    const missing = [];
    if (!args.service)  missing.push("service");
    if (!args.slot_iso) missing.push("créneau (slot_iso)");
    if (!args.name)     missing.push("nom du client");
    if (missing.length > 0) {
      console.error(`[BOOKING] ❌ Champs manquants: ${missing.join(", ")}`);
      return { error: `Informations manquantes: ${missing.join(", ")}.` };
    }

    const phone = normalizePhone(args.phone) || normalizePhone(session?.callerNumber || "");
    if (!phone) { console.error("[BOOKING] ❌ Numéro invalide"); return { error: "Numéro invalide." }; }
    // Confirmer le type client si pas encore déterminé
    if (cl && !cl.clientType) cl.clientType = args.email ? "existant" : "nouveau";
    // coiffeuseNom sera résolu plus bas après la déclaration
    // Charger les coiffeuses si pas encore fait
    if (coiffeuses.length === 0) await loadCoiffeuses();

    // Priorité : 1) event_type_uri du slot choisi (EXACT)  2) URI coiffeuse  3) Round Robin  4) Railway
    let uri = args.event_type_uri || null;
    let uriSource = "slot exact";

    if (!uri && args.coiffeuse) {
      const match = coiffeuses.find(c => c.name.toLowerCase().includes(args.coiffeuse.toLowerCase()));
      if (match) {
        uri = match.eventTypes[args.service] || match.eventTypes.femme || match.eventTypes.homme;
        uriSource = "coiffeuse " + match.name;
      }
    }

    // Round Robin désactivé — on passe directement au fallback coiffeuse individuelle

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

    // Résoudre le vrai nom de coiffeuse — 3 sources par ordre de priorité
    let coiffeuseNom = args.coiffeuse || null;
    // Source 2 : depuis l'URI de l'event type (coiffeuse individuelle)
    if (!coiffeuseNom && uri) {
      const matchedC = coiffeuses.find(c =>
        Object.values(c.eventTypes || {}).some(u => u === uri)
      );
      if (matchedC && matchedC.name !== "disponible") {
        coiffeuseNom = matchedC.name;
        console.log(`[BOOKING] Coiffeuse résolue depuis URI: ${coiffeuseNom}`);
      }
    }
    // Source 3 : depuis cl.coiffeuse (capturé lors du get_available_slots)
    if (!coiffeuseNom && cl?.coiffeuse) {
      coiffeuseNom = cl.coiffeuse;
      console.log(`[BOOKING] Coiffeuse depuis session: ${coiffeuseNom}`);
    }

    // Maintenant coiffeuseNom est résolu — mettre à jour le log
    if (cl && coiffeuseNom) cl.coiffeuse = coiffeuseNom;

    // ── Si email déjà connu → créer le RDV Calendly directement ─────────────
    if (args.email?.trim()) {
      const email = args.email.trim().toLowerCase();
      console.log(`[BOOKING] Email connu — création RDV Calendly directement pour ${email}`);
      try {
        const result = await createInvitee({ uri, startTimeIso: args.slot_iso, name, email });
        const cancelUrl     = result?.resource?.cancel_url     || "";
        const rescheduleUrl = result?.resource?.reschedule_url || "";

        // ownerName = nom du titulaire (pas l'enfant/conjoint)
        const ownerNameDirect = session?.prefetchedClient?.name || null;
        await saveContactToGoogle({ name, email, phone, typeCoupe: args.service || null, coiffeuse: coiffeuseNom || null, ownerName: ownerNameDirect });

        const smsBody =
          `${SALON_NAME}: RDV confirme
` +
          `${slotToShort(args.slot_iso)}${coiffeuseNom ? " avec " + coiffeuseNom : ""}
` +
          (rescheduleUrl ? `Modifier: ${rescheduleUrl}
` : "") +
          (cancelUrl     ? `Annuler: ${cancelUrl}`        : "");

        await Promise.race([
          sendSms(phone, smsBody),
          new Promise((_, rej) => setTimeout(() => rej(new Error("SMS timeout")), 15_000)),
        ]);
        console.log(`[BOOKING] ✅ RDV créé et SMS envoyé → ${phone}`);
        closeCallLog(session?.twilioCallSid, "réservation");
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
        }, 11000);
        return { success: true, direct: true, phone_display: fmtPhone(phone), email, coiffeuse: coiffeuseNom,
          message: `RDV confirmé.${coiffeuseNom ? " Coiffeuse assignée : " + coiffeuseNom + "." : ""} Dis EXACTEMENT ces deux phrases dans cet ordre : "Laisse-moi ajouter ça au calendrier de ${coiffeuseNom || "ta coiffeuse"}." [pause 1s] "Ta confirmation sera envoyée par texto et par courriel avec les informations au dossier. Bonne journée!" Puis STOP absolu — zéro mot de plus, l'appel se ferme.` };
      } catch (e) {
        console.error(`[BOOKING] ❌ Erreur RDV direct: ${e.message}`);
        return { error: `Impossible de créer le rendez-vous : ${e.message}` };
      }
    }

    // ── Sinon → envoyer lien SMS pour saisir le courriel ─────────────────────
    const token = crypto.randomBytes(16).toString("hex");
    pending.set(token, {
      expiresAt: Date.now() + 20 * 60 * 1000, // 20min — au-delà le créneau peut être pris
      payload: { phone, name, service: args.service, eventTypeUri: uri, startTimeIso: args.slot_iso, coiffeuse: coiffeuseNom || null },
    });
    console.log(`[BOOKING] Token créé: ${token}`);

    const link = `${base()}/confirm-email/${token}`;
    const smsPromise = sendSms(phone,
      `${SALON_NAME}: Confirme ton RDV
` +
      `${slotToShort(args.slot_iso)}
` +
      `Courriel requis: ${link}`
    );

    try {
      await Promise.race([smsPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("SMS timeout 15s")), 15_000))]);
      console.log(`[BOOKING] ✅ SMS lien envoyé → ${phone}`);
      closeCallLog(session?.twilioCallSid, "réservation (lien courriel)");
      session.shouldHangup = true;
      session.hangupTimer = setTimeout(() => {
        console.log("[HANGUP] ✅ Raccrochage automatique post-booking SMS");
        if (twilioClient && session.twilioCallSid) {
          twilioClient.calls(session.twilioCallSid)
            .update({ status: "completed" })
            .then(() => console.log("[HANGUP] ✅ Appel terminé"))
            .catch(e => console.error("[HANGUP] ❌", e.message));
        }
      }, 14000); // phrase nouveau client plus longue — 14s
      return { success: true, phone_display: fmtPhone(phone),
        message: `SMS envoyé.${coiffeuseNom ? " Coiffeuse assignée : " + coiffeuseNom + "." : ""} TU DOIS PARLER MAINTENANT — dis immédiatement et sans pause : "Je t'envoie un texto pour confirmer ton courriel. Une fois confirmé, tu recevras ta confirmation de réservation. Bonne journée!" — puis SILENCE ABSOLU. L'appel se ferme automatiquement dans quelques secondes.` };
    } catch (e) {
      console.error(`[BOOKING] ❌ Erreur SMS: ${e.message}`);
      if (pending.has(token)) return { success: true, phone_display: fmtPhone(phone), warning: "SMS peut être en retard" };
      return { error: `Erreur SMS : ${e.message}` };
    }
  }

  if (name === "get_salon_info") {
    const info = { adresse: SALON_ADDRESS, heures: SALON_HOURS, prix: SALON_PRICE_LIST };
    return info[args.topic] ? { [args.topic]: info[args.topic] } : { error: "Sujet inconnu." };
  }

  if (name === "update_contact") {
    const phone = normalizePhone(args.phone) || args.phone;
    const name  = args.name?.trim();
    const email = args.email?.trim().toLowerCase() || null;
    if (!name || !phone) return { error: "Nom et téléphone requis." };
    // Si format "Prénom / NomParent" (enfant/conjoint), extraire le nom du titulaire
    const ownerNameCB = name.includes(" / ") ? name.split(" / ").slice(1).join(" ").trim() : null;
    await saveContactToGoogle({ name, email, phone, typeCoupe: entry.payload.service || null, coiffeuse: entry.payload.coiffeuse || null, ownerName: ownerNameCB });
    console.log(`[CONTACT] ✅ Mis à jour: ${name} (${email}) — ${phone}`);
    return { success: true, message: `Contact mis à jour : ${name}${email ? ` (${email})` : ""}.` };
  }

  if (name === "get_coiffeuses") {
    if (coiffeuses.length === 0) await loadCoiffeuses();
    const SVC_LABELS = {
      homme:"coupe homme", femme:"coupe femme",
      femme_coloration:"coupe femme + coloration",
      femme_plis:"coupe femme + mise en plis",
      femme_color_plis:"coupe femme + coloration & mise en plis",
      enfant:"coupe enfant", autre:"coupe autre",
    };
    const liste = coiffeuses.map(c => ({
      nom: c.name,
      services: Object.entries(c.eventTypes).filter(([,v])=>v).map(([k])=>SVC_LABELS[k]||k)
    }));
    // Services uniques offerts par le salon (dédupliqués)
    const allServices = [...new Set(coiffeuses.flatMap(c =>
      Object.entries(c.eventTypes).filter(([,v])=>v).map(([k])=>SVC_LABELS[k]||k)
    ))];
    // Ajouter les descriptions des services depuis Calendly
    const descParService = Object.entries(serviceDescriptions)
      .filter(([svc]) => allServices.includes(SVC_LABELS[svc] || svc))
      .map(([svc, desc]) => `${SVC_LABELS[svc]||svc}: ${desc}`)
      .join(" | ");

    return {
      coiffeuses: liste,
      services_offerts: allServices,
      descriptions_services: serviceDescriptions,
      message: `Services offerts : ${allServices.join(", ")}. Coiffeuses : ${liste.map(c => c.nom).join(", ")}. ${descParService ? "Détails services : " + descParService + ". " : ""}Présente les services au client selon sa demande. Pour chaque service, utilise la description pour répondre aux questions de prix ou de complexité. Ne liste pas un même service en double.`
    };
  }

  if (name === "get_current_time") {
    const now = new Date();
    const localStr = now.toLocaleString("fr-CA", { timeZone: CALENDLY_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
    const hour = parseInt(new Date(now.toLocaleString("en-US", { timeZone: CALENDLY_TIMEZONE })).getHours());
    const periode = hour < 12 ? "matin" : hour < 17 ? "après-midi" : "soir";
    const salutation = hour < 12 ? "belle matinée" : hour < 17 ? "bel après-midi" : "belle soirée";
    return { heure_locale: localStr, heure: hour, periode, salutation_correcte: salutation };
  }

  if (name === "end_call") {
    const elapsed = Date.now() - (session?.callStartTime || Date.now());
    if (elapsed < 15000) {
      console.warn(`[HANGUP] ⚠️ Ignoré — trop tôt (${Math.round(elapsed/1000)}s). Continue la conversation.`);
      return { error: "Trop tôt pour raccrocher — continue la conversation normalement." };
    }
    console.log(`[HANGUP] ✅ Raccrochage programmé (durée: ${Math.round(elapsed/1000)}s)`);
    closeCallLog(session?.twilioCallSid, "fin normale");
    session.shouldHangup = true;
    // Raccrochage forcé après 7s — assez de temps pour que l'audio finisse
    session.hangupTimer = setTimeout(() => {
      console.log("[HANGUP] ⏱ Exécution forcée");
      if (twilioClient && session.twilioCallSid) {
        twilioClient.calls(session.twilioCallSid)
          .update({ status: "completed" })
          .then(() => console.log("[HANGUP] ✅ Appel terminé"))
          .catch(e => console.error("[HANGUP] ❌ Erreur:", e.message));
      }
    }, 7000);
    return { hanging_up: true, message: "Au revoir dit — appel se termine dans quelques secondes." };
  }

  if (name === "get_existing_appointment") {
    const phone = session?.callerNumber;
    // Utiliser email du prefetch si dispo
    const prefetched = session?.prefetchedClient;
    const email = prefetched?.email || null;
    if (!email) {
      return { found: false, message: "Pas d'email connu pour ce numéro. Demande au client son email pour chercher son rendez-vous." };
    }
    const appt = await lookupUpcomingAppointment(email);
    if (!appt) {
      return { found: false, message: `Aucun rendez-vous à venir trouvé pour ${email}. Le client n'a peut-être pas de RDV ou il est passé.` };
    }
    const dateStr = slotToFrench(appt.start_time);
    logEvent(session?.twilioCallSid, "tool", `RDV existant trouvé: ${dateStr}`);
    return {
      found: true,
      date_heure: dateStr,
      start_time_iso: appt.start_time,
      cancel_url: appt.cancel_url,
      message: appt.cancel_url
        ? `RDV trouvé : ${dateStr}. Dis au client : "Tu as un rendez-vous le ${dateStr}. Pour l'annuler, je t'envoie un lien par texto." Puis si client veut annuler → envoie le lien cancel_url par SMS et dis "Lien envoyé! Une fois annulé, veux-tu prendre un nouveau rendez-vous?" Si client veut modifier → dis "Pour modifier, utilise le lien dans ton texto de confirmation original, ou je te transfère à l'équipe." → transfer_to_agent si pas de lien.`
        : `RDV trouvé : ${dateStr}. Dis : "Tu as un rendez-vous le ${dateStr}. Pour annuler ou modifier, je vais te transférer à l'équipe." → transfer_to_agent.`,
    };
  }

  if (name === "transfer_to_agent") {
    session.shouldTransfer = true;
    // Résultat selon la raison du transfert
    const transferResult = args.raison === "erreur" ? "erreur" : "agent";
    closeCallLog(session?.twilioCallSid, transferResult);
    if (twilioClient && session.twilioCallSid && FALLBACK_NUMBER) {
      setTimeout(async () => {
        try {
          // PAS de <Say> Twilio — Hélène a déjà dit la phrase de transfert vocalement
          // Twilio se contente du <Dial> silencieux
          await twilioClient.calls(session.twilioCallSid)
            .update({
              twiml: `<Response><Dial>${FALLBACK_NUMBER}</Dial></Response>`
            });
          console.log(`[TRANSFER] ✅ Transfert vers ${FALLBACK_NUMBER}`);
        } catch (e) {
          console.error("[TRANSFER] ❌ Erreur:", e.message);
        }
      }, 3500); // 3.5s — Hélène a le temps de terminer sa phrase avant que Twilio prenne la main
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
// ─── Route info Calendly ──────────────────────────────────────────────────────
app.get("/calendly-info", async (req, res) => {
  try {
    const meR = await fetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${CALENDLY_API_TOKEN}` }
    });
    const me = await meR.json();
    const orgUri = me.resource?.current_organization;

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
  } catch(e) {
    res.status(500).send("Erreur: " + e.message);
  }
});

// ─── Dashboard logs par appel ─────────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  const logs = [...callLogs.values()].reverse();

  const badgeColor = r => ({
    "réservation": "#16a34a", "réservation (lien courriel)": "#15803d",
    "agent": "#b45309", "fin normale": "#4f46e5",
    "erreur": "#dc2626", "en cours": "#2563eb",
  }[r] || "#6b7280");

  const fmtTime = iso => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("fr-CA", { timeZone: "America/Toronto",
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const duration = log => {
    if (!log.endedAt) return "en cours...";
    const s = Math.round((new Date(log.endedAt) - new Date(log.startedAt)) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s/60)}m${s%60}s`;
  };

  const eventIcon = t => ({ tool:"🔧", booking:"✅", warn:"⚠️", info:"ℹ️", error:"❌", client:"🙋", helene:"🤖" }[t] || "•");

  // Anonymiser tous les numéros de téléphone dans un texte
  // Couvre: numérique formaté, E.164, 10 chiffres collés, chiffres épelés en mots français
  function anonymizePhone(text) {
    if (!text) return text;
    let s = text;

    // 1. E.164 : +15148945221
    s = s.replace(/\+1?\d{10,11}/g, "###-###-####");
    // 2. 10 chiffres collés : 5148945221
    s = s.replace(/\b\d{10}\b/g, "###-###-####");
    // 3. Groupes numériques séparés : "514, 894, 5221" / "(514) 894-5221" / "514-894-5221"
    s = s.replace(/\(?\d{3}\)?[,\s\.\-]+\d{3}[,\s\.\-]+\d{2,4}(?:[,\s\.\-]+\d{2,4})?/g, "###-###-####");

    // 4. Chiffres épelés en mots français — approche par tokenisation
    //    Détecte 7+ mots-chiffres consécutifs (séparés par tirets, virgules, espaces, points)
    const WORDS = new Set(["zéro","zero","un","une","deux","trois","quatre","cinq","six","sept","huit","neuf"]);
    const parts = s.split(/([-,\.…\s]+)/);
    let run = 0, runStart = -1;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].toLowerCase().trim();
      if (WORDS.has(p)) {
        if (runStart === -1) runStart = i;
        run++;
      } else if (run > 0 && /^[-,\.…\s]+$/.test(parts[i])) {
        // séparateur entre mots-chiffres — continuer
      } else {
        if (run >= 7) {
          for (let j = runStart; j < i; j++) parts[j] = j === runStart ? "###-###-####" : "";
        }
        run = 0; runStart = -1;
      }
    }
    if (run >= 7) {
      for (let j = runStart; j < parts.length; j++) parts[j] = j === runStart ? "###-###-####" : "";
    }
    s = parts.join("");
    // Nettoyer les séparateurs orphelins autour du masque
    s = s.replace(/[-,\.…\s]+###-###-####/g, " ###-###-####");
    s = s.replace(/###-###-####[-,\.…\s]+/g, "###-###-#### ");
    return s.replace(/\s{2,}/g, " ").trim();
  }

  // Agréger domaines et questions non répondues de tous les appels
  const allDomains = [...new Set(logs.flatMap(l => l.domains || []))];
  const allUnanswered = [...new Set(logs.flatMap(l => l.unanswered_questions || []))];
  const allEmailDomains = [...new Set(logs.flatMap(l => l.emailDomains || []))];

  const rows = logs.map(log => `
    <details class="call-card">
      <summary>
        <span class="badge" style="background:${badgeColor(log.result)}">${log.result}</span>

        <span class="time">${fmtTime(log.startedAt)}</span>
        <span class="dur">${duration(log)}</span>
        ${log.clientNom ? `<span class="tag tag-nom">👤 ${log.clientNom}</span>` : ""}
        ${log.clientType === "existant" ? `<span class="tag tag-existant">⭐ Client existant</span>` : log.clientType === "nouveau" ? `<span class="tag tag-nouveau">🆕 Nouveau client</span>` : ""}
        ${log.service ? `<span class="tag tag-svc">✂️ ${log.service}${log.coiffeuse ? " · "+log.coiffeuse : ""}</span>` : ""}
        ${log.slot ? `<span class="tag tag-slot">📅 ${log.slot.replace("T"," ").slice(0,16)}</span>` : ""}
        ${log.demandes?.length ? `<span class="tag tag-dem" title="Mots-clés détectés dans la conversation — aide à identifier les besoins récurrents">🔍 ${log.demandes.join(", ")}</span>` : ""}
      </summary>
      ${log.resumeClient?.length ? `
      <div class="resume">
        <div class="resume-title">🗣️ Transcription client <span style="font-size:.68rem;color:#9ca3af;font-weight:400">(reconnaissance vocale Whisper — peut contenir des erreurs)</span></div>
        ${log.resumeClient.map((t,i) => { const safe = t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/[^\x00-\x7F\u00C0-\u024F\u0080-\u00FF ]/g,""); return `<div class="resume-line"><span class="rnum">${i+1}</span>${anonymizePhone(safe)}</div>`; }).join("")}
      </div>` : ""}
      ${log.unanswered_questions?.length ? `
      <div class="resume resume-warn">
        <div class="resume-title">❓ Questions non répondues</div>
        ${log.unanswered_questions.map((t,i) => { const safe = t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); return `<div class="resume-line"><span class="rnum">${i+1}</span>${anonymizePhone(safe)}</div>`; }).join("")}
      </div>` : ""}
      ${log.domains?.length ? `
      <div class="resume resume-green">
        <div class="resume-title">🏷️ Thèmes abordés</div>
        ${log.domains.map(d => `<div class="resume-line"><span class="rnum">•</span>${d}</div>`).join("")}
      </div>` : ""}
      ${log.emailDomains?.length ? `
      <div class="resume resume-indigo">
        <div class="resume-title">📧 Domaines email</div>
        ${log.emailDomains.map(d => `<div class="resume-line"><span class="rnum">@</span>${d}</div>`).join("")}
      </div>` : ""}
      <div class="events">
        ${log.events.map(e => `
          <div class="event event-${e.type}">
            <span class="ets">${fmtTime(e.ts)}</span>
            <span class="eic">${eventIcon(e.type)}</span>
            <span class="emsg">${anonymizePhone(e.msg)}</span>
          </div>`).join("")}
      </div>

    </details>`).join("") || "<p class='empty'>Aucun appel enregistré.</p>";

  res.type("text/html").send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — ${SALON_NAME}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f5f6fa;color:#1a1a2e;min-height:100vh;padding:24px}
  h1{font-size:1.4rem;font-weight:700;color:#6c47ff;margin-bottom:4px}
  .sub{color:#6b7280;font-size:.85rem;margin-bottom:20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .sub a{color:#6c47ff;text-decoration:none;font-weight:500}
  .sub a:hover{text-decoration:underline}
  .sub a.danger{color:#dc2626}

  /* Tuiles haut de page */
  .tiles{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .tile{background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;padding:14px 20px;text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:4px;min-width:120px;transition:all .15s;cursor:pointer}
  .tile:hover{border-color:#6c47ff;box-shadow:0 2px 8px rgba(108,71,255,.12)}
  .tile-n{font-size:1.6rem;font-weight:700}
  .tile-l{font-size:.75rem;color:#6b7280}
  .tile.active{border-color:#6c47ff;background:#f5f3ff}
  .tile-admin{background:#6c47ff;color:#fff;border-color:#6c47ff}
  .tile-admin:hover{background:#5538d4}
  .tile-admin .tile-l{color:#c4b5fd}
  .tile-questions{border-color:#f59e0b}
  .tile-questions .tile-n{color:#b45309}
  .tile-domains{border-color:#10b981}
  .tile-domains .tile-n{color:#059669}
  .tile-email{border-color:#6366f1}
  .tile-email .tile-n{color:#4338ca}

  /* Panneaux globaux */
  .panel{background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;padding:18px 20px;margin-bottom:16px;display:none}
  .panel.visible{display:block}
  .panel-title{font-size:.85rem;font-weight:700;color:#6c47ff;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px}
  .panel-grid{display:flex;flex-wrap:wrap;gap:8px}
  .panel-tag{background:#f3f0ff;color:#6c47ff;border-radius:8px;padding:4px 12px;font-size:.82rem;border:1px solid #ddd6fe}
  .panel-tag.warn{background:#fffbeb;color:#b45309;border-color:#fde68a}
  .panel-tag.green{background:#ecfdf5;color:#059669;border-color:#a7f3d0}
  .panel-tag.indigo{background:#eef2ff;color:#4338ca;border-color:#c7d2fe}
  .panel-empty{color:#9ca3af;font-size:.85rem}

  /* Stats filtres */
  .stats{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
  .stat{background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;padding:10px 16px;min-width:90px;text-align:center;cursor:pointer;transition:all .15s}
  .stat:hover{border-color:#6c47ff}
  .stat.active{border-color:#6c47ff;background:#f5f3ff}
  .stat-n{font-size:1.5rem;font-weight:700}
  .stat-l{font-size:.72rem;color:#6b7280;margin-top:1px}

  /* Call cards */
  .call-card{background:#fff;border:1.5px solid #e5e7eb;border-radius:10px;margin-bottom:8px;overflow:hidden}
  summary{display:flex;align-items:center;gap:8px;padding:11px 14px;cursor:pointer;flex-wrap:wrap;list-style:none}
  summary:hover{background:#f9fafb}
  .badge{padding:2px 10px;border-radius:20px;font-size:.72rem;font-weight:700;color:#fff;white-space:nowrap}
  .caller{font-weight:600;font-size:.92rem;color:#111}
  .time{color:#9ca3af;font-size:.78rem}
  .dur{color:#6b7280;font-size:.78rem;background:#f3f4f6;padding:1px 7px;border-radius:10px}
  .tag{font-size:.78rem;background:#f3f4f6;color:#374151;padding:2px 8px;border-radius:8px}
  .tag-nom{background:#f5f3ff;color:#6c47ff}
  .tag-existant{background:#fef9c3;color:#854d0e;border:1px solid #fde047}
  .tag-nouveau{background:#ecfdf5;color:#065f46;border:1px solid #6ee7b7}
  .tag-svc{background:#f0fdf4;color:#059669}
  .tag-slot{background:#eff6ff;color:#2563eb}
  .tag-dem{background:#fff7ed;color:#c2410c}

  /* Events */
  .events{padding:10px 14px;border-top:1px solid #f3f4f6;display:flex;flex-direction:column;gap:5px;background:#fafafa}
  .event{display:flex;gap:10px;align-items:flex-start;font-size:.80rem}
  .ets{color:#9ca3af;white-space:nowrap;min-width:105px}
  .eic{min-width:16px}
  .emsg{color:#374151}
  .event-warn .emsg{color:#b45309}
  .event-error .emsg{color:#dc2626}
  .event-booking .emsg{color:#059669;font-weight:600}
  .event-client{padding-left:22px;border-left:2px solid #bfdbfe;margin-left:8px}
  .event-client .emsg{color:#2563eb;font-style:italic}
  .event-helene .emsg{color:#6c47ff;font-weight:500}

  /* Résumés intérieurs */
  .resume{padding:10px 14px;background:#fafafa;border-top:1px solid #f3f4f6}
  .resume-warn{background:#fffbeb;border-top:2px solid #f59e0b}
  .resume-green{background:#ecfdf5;border-top:2px solid #10b981}
  .resume-indigo{background:#eef2ff;border-top:2px solid #6366f1}
  .resume-title{font-size:.72rem;color:#6c47ff;font-weight:700;margin-bottom:5px;text-transform:uppercase;letter-spacing:.05em}
  .resume-warn .resume-title{color:#b45309}
  .resume-green .resume-title{color:#059669}
  .resume-indigo .resume-title{color:#4338ca}
  .resume-line{display:flex;gap:8px;font-size:.80rem;color:#374151;padding:2px 0}
  .rnum{color:#9ca3af;min-width:18px;font-size:.72rem}
  .empty{color:#9ca3af;text-align:center;padding:40px;background:#fff;border-radius:10px;border:1.5px dashed #e5e7eb}
</style>
</head>
<body>
${SALON_LOGO_URL
    ? `<div style="margin-bottom:12px"><img src="${SALON_LOGO_URL}" alt="${SALON_NAME}" style="max-height:52px;max-width:180px;object-fit:contain"></div>`
    : ""}<h1>${SALON_LOGO_URL ? "" : "✂️ "}${SALON_NAME} — Dashboard appels</h1>
  <div style="font-size:.72rem;color:#9ca3af;margin-top:-8px;margin-bottom:4px">v23 · 1 Mar 2026</div>
<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:4px">
  <p class="sub" style="margin-bottom:0">
    Les ${logs.length} derniers appels (max ${MAX_LOGS})
    &nbsp;·&nbsp;<a href="/dashboard">Rafraîchir</a>
    &nbsp;·&nbsp;<a href="#" onclick="openDangerModal('clear')">🗑 Vider</a>
    &nbsp;·&nbsp;<a class="danger" href="#" onclick="openDangerModal('delete')">❌ Supprimer fichier</a>
  </p>
  <a href="/admin/config" style="display:inline-flex;align-items:center;gap:7px;background:#6c47ff;color:#fff;padding:9px 20px;border-radius:9px;font-size:.87rem;font-weight:700;text-decoration:none;white-space:nowrap;box-shadow:0 2px 8px rgba(108,71,255,.18)">⚙️ Config</a>
</div>

<!-- Modal sécurisé pour actions dangereuses -->
<div id="dangerModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;align-items:center;justify-content:center">
  <div style="background:#fff;border-radius:14px;padding:28px 24px;max-width:380px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.2)">
    <h3 id="dangerTitle" style="font-size:1rem;font-weight:700;color:#dc2626;margin-bottom:8px"></h3>
    <p id="dangerDesc" style="font-size:.84rem;color:#6b7280;margin-bottom:16px"></p>
    <input type="password" id="dangerToken" placeholder="ADMIN_TOKEN" autocomplete="new-password"
      style="width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:.9rem;margin-bottom:14px;box-sizing:border-box"
      onkeydown="if(event.key==='Enter')confirmDanger()">
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button onclick="closeDangerModal()" style="padding:8px 18px;border:1.5px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;font-size:.85rem">Annuler</button>
      <button onclick="confirmDanger()" style="padding:8px 20px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:.85rem">Confirmer</button>
    </div>
  </div>
</div>
<script>
var _dangerAction = null;
function openDangerModal(action) {
  _dangerAction = action;
  document.getElementById('dangerTitle').textContent = action === 'clear' ? '🗑 Vider tous les logs?' : '❌ Supprimer le fichier JSON?';
  document.getElementById('dangerDesc').textContent = action === 'clear' ? 'Cette action efface tous les appels en mémoire.' : 'Cette action supprime définitivement le fichier call_logs.json.';
  document.getElementById('dangerToken').value = '';
  var m = document.getElementById('dangerModal'); m.style.display = 'flex';
  setTimeout(function(){ document.getElementById('dangerToken').focus(); }, 50);
}
function closeDangerModal() {
  document.getElementById('dangerModal').style.display = 'none';
  _dangerAction = null;
}
function confirmDanger() {
  var tok = document.getElementById('dangerToken').value.trim();
  if (!tok) { document.getElementById('dangerToken').style.borderColor = '#dc2626'; return; }
  var url = _dangerAction === 'clear' ? '/admin/logs/clear' : '/admin/logs/delete-file';
  fetch(url + '?token=' + encodeURIComponent(tok), { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(j) {
      if (j.ok) { closeDangerModal(); location.reload(); }
      else { document.getElementById('dangerToken').style.borderColor = '#dc2626'; document.getElementById('dangerToken').value = ''; document.getElementById('dangerToken').placeholder = 'Token incorrect'; }
    }).catch(function() { closeDangerModal(); location.reload(); });
}
document.getElementById('dangerModal').addEventListener('click', function(e){ if(e.target===this)closeDangerModal(); });
</script>
<!-- Tuiles principales -->
<div class="tiles">
  <div class="tile active" data-filter="all" onclick="filterCalls(this,'all')">
    <div class="tile-n" style="color:#6c47ff">${logs.length}</div><div class="tile-l">Tous les appels</div>
  </div>
  <div class="tile" data-filter="réservation" onclick="filterCalls(this,'réservation')">
    <div class="tile-n" style="color:#16a34a">${logs.filter(l=>l.result.startsWith("réservation")).length}</div><div class="tile-l">Réservations</div>
  </div>
  <div class="tile" data-filter="agent" onclick="filterCalls(this,'agent')">
    <div class="tile-n" style="color:#b45309">${logs.filter(l=>l.result==="agent").length}</div><div class="tile-l">Agents</div>
  </div>
  <div class="tile" data-filter="en cours" onclick="filterCalls(this,'en cours')">
    <div class="tile-n" style="color:#2563eb">${logs.filter(l=>l.result==="en cours").length}</div><div class="tile-l">En cours</div>
  </div>
  <div class="tile" data-filter="fin normale" onclick="filterCalls(this,'fin normale')">
    <div class="tile-n" style="color:#4f46e5">${logs.filter(l=>l.result==="fin normale").length}</div><div class="tile-l">Fin normale</div>
  </div>
  <div class="tile" data-filter="erreur" onclick="filterCalls(this,'erreur')">
    <div class="tile-n" style="color:#dc2626">${logs.filter(l=>l.result==="erreur").length}</div><div class="tile-l">Erreurs</div>
  </div>
  <div class="tile" data-filter="existant" onclick="filterCalls(this,'existant')">
    <div class="tile-n" style="color:#854d0e">${logs.filter(l=>l.clientType==="existant").length}</div><div class="tile-l">⭐ Clients existants</div>
  </div>
  <div class="tile" data-filter="nouveau" onclick="filterCalls(this,'nouveau')">
    <div class="tile-n" style="color:#065f46">${logs.filter(l=>l.clientType==="nouveau").length}</div><div class="tile-l">🆕 Nouveaux clients</div>
  </div>
  <div class="tile tile-questions" onclick="togglePanel('panel-questions', this)">
    <div class="tile-n">${allUnanswered.length}</div><div class="tile-l">❓ Questions sans réponse</div>
  </div>
  <div class="tile tile-domains" onclick="togglePanel('panel-domains', this)">
    <div class="tile-n">${allDomains.length}</div><div class="tile-l">🏷️ Thèmes abordés</div>
  </div>
  <div class="tile tile-email" onclick="togglePanel('panel-email', this)">
    <div class="tile-n">${allEmailDomains.length}</div><div class="tile-l">📧 Domaines email</div>
  </div>
</div>

<!-- Panneaux dépliables -->
<div class="panel" id="panel-questions">
  <div class="panel-title">❓ Questions auxquelles Hélène n'a pas su répondre (tous appels)</div>
  ${allUnanswered.length ? `<div class="panel-grid">${allUnanswered.map(q=>`<span class="panel-tag warn">${q.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</span>`).join("")}</div>` : `<p class="panel-empty">Aucune question non répondue pour le moment.</p>`}
</div>
<div class="panel" id="panel-domains">
  <div class="panel-title">🏷️ Thèmes abordés par les clients (tous appels)</div>
  ${allDomains.length ? `<div class="panel-grid">${allDomains.map(d=>`<span class="panel-tag green">${d}</span>`).join("")}</div>` : `<p class="panel-empty">Aucun thème détecté pour le moment.</p>`}
</div>
<div class="panel" id="panel-email">
  <div class="panel-title">📧 Domaines email utilisés (tous appels)</div>
  ${allEmailDomains.length ? `<div class="panel-grid">${allEmailDomains.map(d=>`<span class="panel-tag indigo">@${d}</span>`).join("")}</div>` : `<p class="panel-empty">Aucun domaine email détecté pour le moment.</p>`}
</div>

<div id="list">${rows}</div>

<script>
function filterCalls(el, val) {
  document.querySelectorAll('.tile[data-filter]').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.call-card').forEach(card => {
    if (val === 'all') { card.style.display = ''; return; }
    const badge  = card.querySelector('.badge');
    const result = badge ? badge.textContent.trim() : '';
    if (val === 'existant') {
      card.style.display = card.querySelector('.tag-existant') ? '' : 'none';
    } else if (val === 'nouveau') {
      card.style.display = card.querySelector('.tag-nouveau') ? '' : 'none';
    } else {
      card.style.display = (val === 'réservation' ? result.startsWith('réservation') : result === val) ? '' : 'none';
    }
  });
}
function togglePanel(id, tile) {
  const panel = document.getElementById(id);
  const isVisible = panel.classList.contains('visible');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('visible'));
  document.querySelectorAll('.tile:not([data-filter])').forEach(t => t.style.background = '');
  if (!isVisible) {
    panel.classList.add('visible');
    panel.scrollIntoView({behavior:'smooth', block:'nearest'});
  }
}
</script>
</body>
</html>`);
});

// ─── Page admin/config (salon + FAQ en 2 onglets) ───────────────────────────
app.get("/admin/salon", (req, res) => res.redirect("/admin/config?tab=salon"));
app.get("/admin/faq/page", (req, res) => res.redirect("/admin/config?tab=faq"));

app.get("/admin/config", (req, res) => {
  const activeTab = req.query.tab === "faq" ? "faq" : "salon";
  const SALON_VARS = [
    { key: "AGENT_NAME",       label: "Nom de l'agent vocal",  val: AGENT_NAME,       multi: false },
    { key: "SALON_NAME",       label: "Nom du salon",          val: SALON_NAME,       multi: false },
    { key: "SALON_CITY",       label: "Ville",                 val: SALON_CITY,       multi: false },
    { key: "SALON_ADDRESS",    label: "Adresse",               val: SALON_ADDRESS,    multi: false },
    { key: "SALON_HOURS",      label: "Heures d'ouverture",    val: SALON_HOURS,      multi: true  },
    { key: "SALON_PRICE_LIST", label: "Liste de prix",         val: SALON_PRICE_LIST, multi: true  },
    { key: "SALON_PAYMENT",    label: "Modes de paiement",     val: SALON_PAYMENT,    multi: true  },
    { key: "SALON_PARKING",    label: "Stationnement",         val: SALON_PARKING,    multi: true  },
    { key: "SALON_ACCESS",     label: "Accessibilité",         val: SALON_ACCESS,     multi: true  },
    { key: "SALON_LOGO_URL",   label: "URL du logo",           val: SALON_LOGO_URL,   multi: false },
  ];
  const hasRailwayAPI = !!(RAILWAY_API_TOKEN && RAILWAY_SERVICE_ID && RAILWAY_ENVIRONMENT_ID);

  const salonFields = SALON_VARS.map(v => {
    const safe = (v.val || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    if (v.multi) return "<div class=\"field\"><label>"+v.label+" <span class=\"badge-multi\">multiligne</span></label><textarea id=\""+v.key+"\" name=\""+v.key+"\" rows=\"10\">"+safe+"</textarea></div>";
    return "<div class=\"field\"><label>"+v.label+"</label><input type=\"text\" id=\""+v.key+"\" name=\""+v.key+"\" value=\""+safe+"\"></div>";
  }).join("");

  res.type("text/html").send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configuration — ${SALON_NAME}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f6fa;color:#1a1a2e;min-height:100vh;padding:28px 20px}
.page{max-width:740px;margin:0 auto}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.back-link{color:#6c47ff;text-decoration:none;font-size:.85rem;font-weight:600}
.back-link:hover{text-decoration:underline}
h1{font-size:1.25rem;font-weight:800;color:#1a1a2e;margin-bottom:18px}
.tabs{display:flex;border-bottom:2px solid #e5e7eb;margin-bottom:24px}
.tab{padding:11px 28px;font-size:.90rem;font-weight:700;color:#6b7280;border:none;background:none;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px}
.tab:hover{color:#6c47ff}
.tab.active{color:#6c47ff;border-bottom-color:#6c47ff}
.tab-panel{display:none}.tab-panel.active{display:block}
.card{background:#fff;border:1.5px solid #e5e7eb;border-radius:14px;padding:26px 28px}
.field{margin-bottom:16px}
label{display:block;font-size:.82rem;font-weight:600;color:#374151;margin-bottom:5px}
.badge-multi{background:#ede9fe;color:#6c47ff;font-size:.70rem;padding:1px 7px;border-radius:8px;font-weight:600;margin-left:6px}
input[type=text],input[type=password],textarea{width:100%;padding:9px 12px;font-size:.90rem;border:1.5px solid #d1d5db;border-radius:8px;outline:none;font-family:inherit;resize:vertical}
input:focus,textarea:focus{border-color:#6c47ff}
.note{background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:12px 14px;font-size:.82rem;color:#5b21b6;margin-bottom:18px;line-height:1.6}
.note.warn{background:#fffbeb;border-color:#fde68a;color:#92400e}
.note code{background:#ede9fe;padding:1px 5px;border-radius:4px;font-family:monospace;font-size:.78rem}
.btn{display:inline-flex;align-items:center;gap:6px;padding:10px 22px;border-radius:8px;font-size:.88rem;font-weight:700;cursor:pointer;border:none}
.btn-save{background:#6c47ff;color:#fff}.btn-save:hover{background:#5538d4}
.btn-save:disabled{background:#c4b5fd;cursor:not-allowed}
.btn-sec{background:#f3f4f6;color:#374151;border:1.5px solid #e5e7eb}.btn-sec:hover{background:#e5e7eb}
.btn-add{background:#6c47ff;color:#fff;font-size:.85rem;padding:8px 18px;border-radius:8px;cursor:pointer;border:none;font-weight:700;display:inline-flex;align-items:center;gap:6px}.btn-add:hover{background:#5538d4}
.spinner{display:none;width:15px;height:15px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.alert{border-radius:8px;padding:11px 15px;margin-bottom:16px;font-size:.87rem;display:none}
.alert-ok{background:#ecfdf5;border:1.5px solid #6ee7b7;color:#065f46}
.alert-err{background:#fef2f2;border:1.5px solid #fca5a5;color:#991b1b}
.alert-info{background:#eff6ff;border:1.5px solid #93c5fd;color:#1e40af}
hr{border:none;border-top:1.5px solid #f3f4f6;margin:20px 0}
.logo-preview{max-height:44px;max-width:150px;object-fit:contain;margin-top:7px;border-radius:5px;display:none}
.faq-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap}
.tok-input{padding:8px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:.83rem;outline:none;width:200px}
.tok-input:focus{border-color:#6c47ff}
.faq-row{background:#fff;border:1.5px solid #e5e7eb;border-radius:11px;margin-bottom:8px;overflow:hidden}
.faq-head{display:flex;align-items:center;gap:10px;padding:13px 16px;cursor:pointer;user-select:none}
.faq-head:hover{background:#f9f8ff}
.faq-num{background:#ede9fe;color:#6c47ff;border-radius:6px;padding:2px 9px;font-size:.75rem;font-weight:700;min-width:28px;text-align:center}
.faq-q{flex:1;font-size:.88rem;font-weight:600;color:#1a1a2e}
.faq-arrow{color:#9ca3af;font-size:.80rem}
.faq-body{border-top:1.5px solid #f3f4f6;padding:14px 16px;background:#fafafa}
.faq-ans{font-size:.85rem;color:#374151;line-height:1.6;margin-bottom:12px;white-space:pre-wrap}
.faq-actions{display:flex;gap:8px}
.btn-edit{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:7px;padding:5px 14px;font-size:.80rem;cursor:pointer;font-weight:600}.btn-edit:hover{background:#dbeafe}
.btn-del{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:7px;padding:5px 14px;font-size:.80rem;cursor:pointer;font-weight:600}.btn-del:hover{background:#fee2e2}
.empty-faq{color:#9ca3af;text-align:center;padding:32px;font-size:.88rem;background:#fafafa;border-radius:10px;border:1.5px dashed #e5e7eb}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;align-items:center;justify-content:center}
.modal-bg.open{display:flex}
.modal{background:#fff;border-radius:14px;padding:28px 26px;max-width:500px;width:95%;box-shadow:0 8px 40px rgba(0,0,0,.18)}
.modal h3{font-size:1rem;font-weight:700;color:#1a1a2e;margin-bottom:14px}
.modal label{font-size:.82rem;font-weight:600;color:#374151;display:block;margin-bottom:5px;margin-top:12px}
.modal input,.modal textarea{width:100%;padding:9px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:.88rem;outline:none;font-family:inherit}
.modal input:focus,.modal textarea:focus{border-color:#6c47ff}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
.tok-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:300;align-items:center;justify-content:center}
.tok-modal.open{display:flex}
.tok-inner{background:#fff;border-radius:14px;padding:28px 26px;max-width:380px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.2)}
</style>
</head>
<body>
<div class="page">
  <div class="topbar">
    ${SALON_LOGO_URL ? `<img src="${SALON_LOGO_URL}" alt="${SALON_NAME}" style="max-height:40px;object-fit:contain">` : `<strong>${SALON_NAME}</strong>`}
    <a href="/dashboard" class="back-link">← Dashboard</a>
  </div>
  <h1>⚙️ Configuration</h1>
  <div class="tabs">
    <button class="tab ${activeTab==="salon"?"active":""}" onclick="switchTab('salon')">🏢 Entreprise</button>
    <button class="tab ${activeTab==="faq"?"active":""}" onclick="switchTab('faq')">❓ FAQ</button>
  </div>

  <!-- Onglet Entreprise -->
  <div class="tab-panel ${activeTab==="salon"?"active":""}" id="tab-salon">
    <div class="card">
      ${hasRailwayAPI ? "" : `<div class="note warn">⚠️ <strong>Sauvegarde Railway non configurée.</strong><br>Ajoute <code>RAILWAY_API_TOKEN</code>, <code>RAILWAY_SERVICE_ID</code>, <code>RAILWAY_ENVIRONMENT_ID</code>.</div>`}
      <div id="alertOk" class="alert alert-ok"></div>
      <div id="alertErr" class="alert alert-err"></div>
      <div id="alertInfo" class="alert alert-info"></div>
      <form id="salonForm">${salonFields}
        <img id="logoPreview" class="logo-preview" alt="Aperçu logo">
      </form>
      <hr>
      ${hasRailwayAPI ? `<button class="btn btn-save" id="btnSave" onclick="saveToRailway()"><span class="spinner" id="spinner"></span>💾 Sauvegarder &amp; redéployer</button>` : ""}
    </div>
  </div>

  <!-- Onglet FAQ -->
  <div class="tab-panel ${activeTab==="faq"?"active":""}" id="tab-faq">
    <div class="card">
      <div class="faq-toolbar">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:.82rem;color:#6b7280;white-space:nowrap">Token admin :</span>
          <input type="password" id="tok" class="tok-input" placeholder="ADMIN_TOKEN">
        </div>
        <button class="btn-add" onclick="openAddModal()">➕ Ajouter</button>
      </div>
      <div id="alertFaqOk" class="alert alert-ok"></div>
      <div id="alertFaqErr" class="alert alert-err"></div>
      <div id="faqList"><p class="empty-faq">Chargement...</p></div>
    </div>
  </div>
</div>

<!-- Modal FAQ ajout/modif -->
<div class="modal-bg" id="faqModal">
  <div class="modal">
    <h3 id="modalTitle">Ajouter une question</h3>
    <label>Question</label>
    <input type="text" id="modalQ" placeholder="Ex: Acceptez-vous les cartes de crédit?">
    <label>Réponse d'Hélène</label>
    <textarea id="modalA" rows="4" placeholder="Réponse qu'Hélène donnera..."></textarea>
    <input type="hidden" id="modalId">
    <div class="modal-actions">
      <button class="btn btn-sec" onclick="closeFaqModal()">Annuler</button>
      <button class="btn btn-save" onclick="saveModal()">💾 Sauvegarder</button>
    </div>
  </div>
</div>

<!-- Modal token Railway -->
<div class="tok-modal" id="tokModal">
  <div class="tok-inner">
    <h2 style="font-size:1rem;font-weight:700;margin-bottom:8px">🔐 Token administrateur</h2>
    <p style="font-size:.84rem;color:#6b7280;margin-bottom:14px">Entre ton ADMIN_TOKEN pour sauvegarder.</p>
    <input type="password" id="railwayToken" placeholder="ADMIN_TOKEN" autocomplete="off"
      style="width:100%;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:8px;font-size:.92rem;margin-bottom:14px;box-sizing:border-box"
      onkeydown="if(event.key==='Enter')confirmRailwaySave()">
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button onclick="closeTokModal()" style="padding:8px 18px;border:1.5px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer">Annuler</button>
      <button onclick="confirmRailwaySave()" style="padding:8px 20px;background:#059669;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer">Confirmer</button>
    </div>
  </div>
</div>

<script>
function switchTab(t){
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b.textContent.toLowerCase().includes(t==="salon"?"entreprise":"faq")));
  document.querySelectorAll(".tab-panel").forEach(p=>p.classList.toggle("active",p.id==="tab-"+t));
  history.replaceState(null,"","/admin/config?tab="+t);
}

// Aperçu logo
(function(){
  var li=document.getElementById("SALON_LOGO_URL"),lp=document.getElementById("logoPreview");
  if(!li)return;
  li.addEventListener("input",function(){var u=li.value.trim();if(u){lp.src=u;lp.style.display="block";}else lp.style.display="none";});
  if(li.value.trim()){lp.src=li.value.trim();lp.style.display="block";}
})();

// Config salon
var KEYS=${JSON.stringify(SALON_VARS.map(v=>v.key))};
function getValues(){var o={};KEYS.forEach(k=>{var e=document.getElementById(k);if(e)o[k]=e.value;});return o;}
function showAlert(id,msg){["alertOk","alertErr","alertInfo"].forEach(i=>{var e=document.getElementById(i);if(e){e.style.display="none";e.textContent="";}});var e=document.getElementById(id);if(e){e.textContent=msg;e.style.display="block";e.scrollIntoView({behavior:"smooth",block:"nearest"});}}
function saveToRailway(){document.getElementById("tokModal").classList.add("open");setTimeout(()=>document.getElementById("railwayToken").focus(),50);}
function closeTokModal(){document.getElementById("tokModal").classList.remove("open");document.getElementById("railwayToken").value="";}
document.getElementById("tokModal").addEventListener("click",function(e){if(e.target===this)closeTokModal();});
async function confirmRailwaySave(){
  var token=document.getElementById("railwayToken").value.trim();
  if(!token){document.getElementById("railwayToken").style.borderColor="#dc2626";return;}
  closeTokModal();
  var btn=document.getElementById("btnSave"),sp=document.getElementById("spinner");
  if(btn)btn.disabled=true;if(sp)sp.style.display="inline-block";
  showAlert("alertInfo","⏳ Sauvegarde en cours...");
  try{
    var r=await fetch("/admin/salon/save?token="+encodeURIComponent(token),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({variables:getValues()})});
    var j;try{j=await r.json();}catch(pe){throw new Error("Réponse invalide ("+r.status+")");}
    if(!r.ok||!j.ok)throw new Error(j.error||"Erreur HTTP "+r.status);
    if(j.redeployed){
      var sec=60,el=document.getElementById("alertOk");
      showAlert("alertOk","✅ Sauvegardé! Redémarrage...");
      var iv=setInterval(function(){sec--;el.textContent="✅ Rafraîchir dans "+sec+"s...";if(sec<=0){clearInterval(iv);el.textContent="✅ Prêt — rafraîchis la page.";}},1000);
    }else{showAlert("alertOk","✅ Variables sauvegardées."+(j.warning?" Note: "+j.warning:""));}
  }catch(e){showAlert("alertErr","❌ "+e.message);}
  finally{if(btn)btn.disabled=false;if(sp)sp.style.display="none";}
}

// FAQ
var faqData=[];
function gettok(){return document.getElementById("tok").value.trim();}
function showFaqOk(m){var e=document.getElementById("alertFaqOk");e.textContent=m;e.style.display="block";document.getElementById("alertFaqErr").style.display="none";setTimeout(function(){e.style.display="none";},4000);}
function showFaqErr(m){var e=document.getElementById("alertFaqErr");e.textContent=m;e.style.display="block";document.getElementById("alertFaqOk").style.display="none";}

function renderFaq(){
  var list=document.getElementById("faqList");
  if(!faqData.length){list.innerHTML="<p class='empty-faq'>Aucune question. Cliquez sur Ajouter.</p>";return;}
  list.innerHTML=faqData.map(function(f,i){
    return "<div class='faq-row' id='row-"+f.id+"'>"
      +"<div class='faq-head' id='head-"+f.id+"'><span class='faq-num'>"+(i+1)+"</span>"
      +"<span class='faq-q'>"+f.question.replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</span>"
      +"<span class='faq-arrow' id='arrow-"+f.id+"'>▼</span></div>"
      +"<div class='faq-body' id='fbody-"+f.id+"' style='display:none'>"
      +"<div class='faq-ans'>"+f.reponse.replace(/&/g,"&amp;").replace(/</g,"&lt;")+"</div>"
      +"<div class='faq-actions'>"
      +"<button class='btn-edit' id='edit-"+f.id+"'>✏️ Modifier</button>"
      +"<button class='btn-del' id='del-"+f.id+"'>🗑 Supprimer</button>"
      +"</div></div></div>";
  }).join("");
  faqData.forEach(function(f){
    document.getElementById("head-"+f.id).addEventListener("click",function(){toggleFaq(f.id);});
    document.getElementById("edit-"+f.id).addEventListener("click",function(){openEditModal(f.id);});
    document.getElementById("del-"+f.id).addEventListener("click",function(){deleteFaq(f.id);});
  });
}

async function loadFaq(){
  try{
    var r=await fetch("/admin/faq");
    if(!r.ok){throw new Error("HTTP "+r.status+" — "+r.statusText);}
    var j=await r.json();
    faqData=j.items||[];
    renderFaq();
  }catch(e){
    document.getElementById("faqList").innerHTML="<p class='empty-faq'>Erreur chargement FAQ : "+e.message+". Réessayez en rafraîchissant la page.</p>";
    console.error("FAQ load error:",e);
  }
}
loadFaq();

function toggleFaq(id){
  var b=document.getElementById("fbody-"+id),a=document.getElementById("arrow-"+id);
  var open=b.style.display!=="none";b.style.display=open?"none":"block";if(a)a.textContent=open?"▼":"▲";
}
function openAddModal(){
  document.getElementById("modalTitle").textContent="Ajouter une question";
  document.getElementById("modalQ").value="";document.getElementById("modalA").value="";document.getElementById("modalId").value="";
  document.getElementById("faqModal").classList.add("open");setTimeout(function(){document.getElementById("modalQ").focus();},50);
}
function openEditModal(id){
  var item=faqData.find(function(f){return f.id==id;});if(!item)return;
  document.getElementById("modalTitle").textContent="Modifier la question";
  document.getElementById("modalQ").value=item.question;document.getElementById("modalA").value=item.reponse;document.getElementById("modalId").value=id;
  document.getElementById("faqModal").classList.add("open");setTimeout(function(){document.getElementById("modalQ").focus();},50);
}
function closeFaqModal(){document.getElementById("faqModal").classList.remove("open");}
document.getElementById("faqModal").addEventListener("click",function(e){if(e.target===this)closeFaqModal();});

async function saveModal(){
  var tok=gettok();if(!tok){showFaqErr("⚠️ Entre ton token admin d'abord.");return;}
  var q=document.getElementById("modalQ").value.trim(),a=document.getElementById("modalA").value.trim(),id=document.getElementById("modalId").value;
  if(!q||!a){showFaqErr("Question et réponse obligatoires.");return;}
  var isEdit=!!id,url=isEdit?"/admin/faq/"+id:"/admin/faq",method=isEdit?"PUT":"POST";
  try{
    var r=await fetch(url,{method:method,headers:{"Content-Type":"application/json","x-admin-token":tok},body:JSON.stringify({question:q,reponse:a})});
    var j=await r.json();if(!r.ok||!j.ok){showFaqErr("❌ "+(j.error||"Erreur"));return;}
    closeFaqModal();
    if(isEdit){var idx=faqData.findIndex(function(f){return f.id==id;});if(idx>=0)faqData[idx]={id:id,question:q,reponse:a};}
    else{faqData.push(j.item);}
    renderFaq();showFaqOk(isEdit?"✅ Question modifiée.":"✅ Question ajoutée.");
  }catch(e){showFaqErr("❌ "+e.message);}
}

async function deleteFaq(id){
  var tok=gettok();if(!tok){showFaqErr("⚠️ Token admin requis.");return;}
  if(!confirm("Supprimer cette question?"))return;
  try{
    var r=await fetch("/admin/faq/"+id,{method:"DELETE",headers:{"x-admin-token":tok}});
    var j=await r.json();if(!r.ok||!j.ok){showFaqErr("❌ "+(j.error||"Erreur"));return;}
    faqData=faqData.filter(function(f){return f.id!=id;});renderFaq();showFaqOk("🗑 Question supprimée.");
  }catch(e){showFaqErr("❌ "+e.message);}
}
</script>
</body>
</html>`);
});




// ─── Routes FAQ (CRUD) ───────────────────────────────────────────────────────
const checkAdminToken = (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (!token || token !== (process.env.ADMIN_TOKEN || "")) {
    res.status(401).json({ error: "Non autorisé" });
    return false;
  }
  return true;
};

app.get("/admin/faq", (req, res) => {
  res.json({ ok: true, items: faqItems });
});

app.post("/admin/faq", (req, res) => {
  if (!checkAdminToken(req, res)) return;
  const { question, reponse } = req.body;
  if (!question?.trim() || !reponse?.trim()) return res.status(400).json({ error: "question et reponse requis" });
  const item = { id: Date.now().toString(), question: question.trim(), reponse: reponse.trim(), createdAt: new Date().toISOString() };
  faqItems.push(item);
  saveFaq();
  console.log(`[FAQ] ✅ Ajout: ${item.question.substring(0,50)}`);
  res.json({ ok: true, item });
});

app.put("/admin/faq/:id", (req, res) => {
  if (!checkAdminToken(req, res)) return;
  const { question, reponse } = req.body;
  const idx = faqItems.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Introuvable" });
  if (!question?.trim() || !reponse?.trim()) return res.status(400).json({ error: "question et reponse requis" });
  faqItems[idx] = { ...faqItems[idx], question: question.trim(), reponse: reponse.trim() };
  saveFaq();
  console.log(`[FAQ] ✅ Modifié: ${faqItems[idx].question.substring(0,50)}`);
  res.json({ ok: true, item: faqItems[idx] });
});

app.delete("/admin/faq/:id", (req, res) => {
  if (!checkAdminToken(req, res)) return;
  const idx = faqItems.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Introuvable" });
  const [removed] = faqItems.splice(idx, 1);
  saveFaq();
  console.log(`[FAQ] 🗑 Supprimé: ${removed.question.substring(0,50)}`);
  res.json({ ok: true });
});

// ─── Routes admin logs ────────────────────────────────────────────────────────
// Vider tous les logs (garde le fichier vide)
app.post("/admin/logs/clear", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== (process.env.ADMIN_TOKEN || "")) return res.status(401).json({ error: "Non autorisé" });
  callLogs.clear();
  saveLogsToDisk();
  console.log("[LOGS] ✅ Tous les logs vidés par admin");
  res.json({ ok: true, message: "Logs vidés" });
});

// Supprimer le fichier JSON complètement
app.post("/admin/logs/delete-file", (req, res) => {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (token !== (process.env.ADMIN_TOKEN || "")) return res.status(401).json({ error: "Non autorisé" });
  try {
    if (fs.existsSync(LOGS_FILE)) fs.unlinkSync(LOGS_FILE);
    callLogs.clear();
    console.log("[LOGS] ✅ Fichier call_logs.json supprimé par admin");
    res.json({ ok: true, message: "Fichier supprimé" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
  } catch (e) {
    console.error("[GOOGLE] OAuth erreur:", e.message);
    res.status(500).send(`Erreur: ${e.message}`);
  }
});

// ─── Route diagnostic Google Contacts ────────────────────────────────────────
app.get("/debug-google", async (req, res) => {
  const phone = req.query.phone || "+15148945221";
  return res.redirect(`/debug-google/${encodeURIComponent(phone)}`);
});

app.get("/debug-google/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const token = await getGoogleAccessToken();
  if (!token) return res.json({ error: "Pas de token Google — visite /oauth/start" });

  const results = {};

  // ── Test 1 : searchContacts avec readMask complet ──────────────────
  try {
    const r1 = await fetch(
      `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(phone)}&readMask=names,emailAddresses,phoneNumbers,userDefined`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j1 = await r1.json();
    results.test1_searchContacts_fullMask = {
      status: r1.status,
      resultCount: (j1.results || []).length,
      firstPerson: j1.results?.[0]?.person || null,
    };

    // ── Test 2 : people.get sur le resourceName trouvé ───────────────
    const resourceName = j1.results?.[0]?.person?.resourceName;
    if (resourceName) {
      const r2 = await fetch(
        `https://people.googleapis.com/v1/${resourceName}?personFields=names,emailAddresses,phoneNumbers,userDefined`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const j2 = await r2.json();
      results.test2_peopleGet_byResourceName = {
        status: r2.status,
        resourceName,
        userDefined: j2.userDefined || [],
        names: j2.names || [],
        emails: j2.emailAddresses || [],
        phones: j2.phoneNumbers || [],
      };

      // ── Test 3 : people.get avec personFields=userDefined seulement ─
      const r3 = await fetch(
        `https://people.googleapis.com/v1/${resourceName}?personFields=userDefined`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const j3 = await r3.json();
      results.test3_peopleGet_userDefinedOnly = {
        status: r3.status,
        userDefined: j3.userDefined || [],
        rawResponse: j3,
      };
    } else {
      results.test2_peopleGet_byResourceName = { error: "Aucun contact trouvé à l'étape 1" };
      results.test3_peopleGet_userDefinedOnly = { error: "Aucun contact trouvé à l'étape 1" };
    }
  } catch (e) {
    results.error = e.message;
  }

  // ── Test 4 : listContacts avec readMask userDefined (autre endpoint) ─
  try {
    const r4 = await fetch(
      `https://people.googleapis.com/v1/people/me/connections?personFields=names,phoneNumbers,userDefined&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j4 = await r4.json();
    const all = j4.connections || [];
    const match = all.find(p =>
      (p.phoneNumbers || []).some(n => n.value?.replace(/\D/g,"").endsWith(phone.replace(/\D/g,"").slice(-10)))
    );
    results.test4_listConnections_match = {
      status: r4.status,
      totalContacts: all.length,
      matchFound: !!match,
      matchUserDefined: match?.userDefined || [],
      matchName: match?.names?.[0]?.displayName || null,
    };
  } catch (e) {
    results.test4_listConnections_match = { error: e.message };
  }

  res.json({ phone, results });
});

app.get("/debug-railway", (req, res) => {
  // Affiche toutes les variables Railway auto-injectées pour debug
  const railwayVars = Object.entries(process.env)
    .filter(([k]) => k.startsWith("RAILWAY_"))
    .reduce((acc, [k,v]) => ({ ...acc, [k]: k.includes("TOKEN") || k.includes("SECRET") ? "***" : v }), {});
  res.json({ railway_vars: railwayVars, count: Object.keys(railwayVars).length });
});

app.get("/debug-env", async (req, res) => {
  const base = {
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
  };

  // Test Google si ?phone= fourni
  const phone = req.query.phone;
  if (phone) {
    const token = await getGoogleAccessToken();
    if (!token) { return res.json({ ...base, google_test: "pas de token" }); }
    try {
      // Test 1 : searchContacts
      const r1 = await fetch(
        `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(phone)}&readMask=names,emailAddresses,phoneNumbers,userDefined`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const j1 = await r1.json();
      const person0 = j1.results?.[0]?.person;
      const rn = person0?.resourceName;

      // Test 2 : people.get avec personFields
      let peopleGet = null;
      if (rn) {
        const r2 = await fetch(
          `https://people.googleapis.com/v1/${rn}?personFields=names,phoneNumbers,userDefined`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        peopleGet = await r2.json();
      }

      return res.json({
        ...base,
        google_test: {
          phone,
          search_status: r1.status,
          search_resultCount: (j1.results||[]).length,
          search_firstPerson_userDefined: person0?.userDefined || "absent",
          search_resourceName: rn || null,
          peopleGet_userDefined: peopleGet?.userDefined || "absent",
          peopleGet_raw: peopleGet,
        }
      });
    } catch(e) {
      return res.json({ ...base, google_test: { error: e.message } });
    }
  }

  res.json(base);
});

app.post("/voice", (req, res) => {
  const { CallSid, From } = req.body;
  console.log(`[VOICE] CallSid: ${CallSid} — From: ${From}`);

  const callerNorm = normalizePhone(From || "") || From || "";
  sessions.set(CallSid, {
    twilioCallSid:  CallSid,
    callerNumber:   callerNorm,
    openaiWs:       null,
    streamSid:      null,
    shouldTransfer: false,
    callStartTime:  Date.now(),
  });
  startCallLog(CallSid, callerNorm);
  logEvent(CallSid, "info", "Appel entrant");
  const callerMasked = callerNorm ? "######" + callerNorm.replace(/\D/g,"").slice(-4) : "inconnu";

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
      if (oaiWs.readyState === WebSocket.OPEN) {
        oaiWs.ping();
        // Envoyer silence audio pour garder le stream actif
        oaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(160, 0xFF).toString("base64") }));
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
          threshold:           0.85,   // élevé : ignore bruits de fond et mots isolés accidentels
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
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "fr",
          prompt: "Conversation téléphonique en français québécois avec une réceptionniste de salon de coiffure. Vocabulaire fréquent : coupe homme, coupe femme, coloration, mise en plis, coiffeuse, rendez-vous, Calendly, cellulaire. Prénoms possibles : Ariane, Laurie, Sophie, Alexandre, Marie. Numéros de téléphone 10 chiffres format québécois ex: 514 894 5221. Mots typiques : 'c\'est beau', 'correct', 'ouais', 'tantôt', 'tout suite', 'la semaine passée', 'à matin'. Noms de villes : Magog, Sherbrooke, Québec. Le client peut épeler son numéro chiffre par chiffre.",
        },
      },
    }));

    // Lookup déjà lancé dès le start Twilio — prefetchedClient sera disponible
    oaiWs.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message", role: "user",
        content: [{
          type: "input_text",
          text: "PHRASE OBLIGATOIRE — dis mot pour mot, sans rien ajouter ni retrancher : 'Bienvenu au " + SALON_NAME + " à " + SALON_CITY + ", je m\'appelle " + AGENT_NAME + " votre assistante virtuelle! Je peux t\'aider à prendre un rendez-vous, te donner nos heures d\'ouverture, notre liste de prix ou notre adresse. En tout temps, si tu veux parler à un membre de l\'équipe, dis simplement Équipe et je te transfère.' — Dis cette phrase EN ENTIER, mot pour mot, puis SILENCE ABSOLU. Le système va t\'envoyer un message immédiatement après pour te dire quoi dire ensuite selon le dossier du client.",
        }],
      },
    }));
    oaiWs.send(JSON.stringify({ type: "response.create" }));
  }

  oaiWs.on("message", async (raw) => {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }

    switch (ev.type) {

      // Transcription de ce que le CLIENT dit (entrée audio)
      case "conversation.item.input_audio_transcription.completed": {
        const txt = ev.transcript?.trim();
        // Logger UNIQUEMENT les vraies transcriptions — ignorer artefacts/bruits courts
        const isArtefact = !txt || txt.length < 2 || /^[.!?,\s]+$/.test(txt);
        if (txt && !isArtefact && session?.twilioCallSid) {
          logEvent(session.twilioCallSid, "client", txt);
          // transcription client loguée dans events — pas dans serverLog (doublon)
          // Détection de sujets libres dans le texte
          const cl = callLogs.get(session.twilioCallSid);
          if (cl) {
            const t = txt.toLowerCase();
            if ((t.includes("prix") || t.includes("coût") || t.includes("combien") || t.includes("tarif")) && !cl.demandes.includes("prix")) cl.demandes.push("prix");
            if ((t.includes("adresse") || t.includes("situé") || t.includes("où êtes") || t.includes("localisation")) && !cl.demandes.includes("adresse")) cl.demandes.push("adresse");
            if ((t.includes("heure") || t.includes("horaire") || t.includes("ouvert") || t.includes("fermé") || t.includes("quelle heure")) && !cl.demandes.includes("heures")) cl.demandes.push("heures");
            if ((t.includes("annuler") || t.includes("annulation")) && !cl.demandes.includes("annulation")) cl.demandes.push("annulation");
            if ((t.includes("coloration") || t.includes("teinture") || t.includes("balayage") || t.includes("mise en plis")) && !cl.demandes.includes("service spécialisé")) cl.demandes.push("service spécialisé");
            if (!cl.resumeClient) cl.resumeClient = [];
            cl.resumeClient.push(txt);
            // Capturer domaines email mentionnés par le client
            const emailMatch = txt.match(/[a-zA-Z0-9._+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            if (emailMatch) {
              const domain = emailMatch[1].toLowerCase();
              if (!cl.emailDomains) cl.emailDomains = [];
              if (!cl.emailDomains.includes(domain)) cl.emailDomains.push(domain);
            }
            // Capturer domaines thématiques (A2)
            if (!cl.domains) cl.domains = [];
            const domainMap = [
              ["paiement","carte","débit","virement","argent","cash","comptant"],
              ["stationnement","parking","stationner","auto","voiture"],
              ["accessibilité","mobilité réduite","fauteuil","handicap","wheelchair"],
              ["durée","temps","combien de temps","long"],
              ["mariage","mariée","graduation","événement","bal"],
              ["enfant","garçon","fille","mon kid","kid"],
              ["annulation","annuler","modifier","changer","repousser"],
              ["coiffeuse","styliste","changer de","autre coiffeuse"],
            ];
            for (const [theme, ...kws] of domainMap) {
              if (kws.some(k => t.includes(k)) && !cl.domains.includes(theme)) cl.domains.push(theme);
            }
          }
        }
        break;
      }

      // Transcription de ce qu'HÉLÈNE dit (sortie audio)
      case "response.audio_transcript.done": {
        const txt = ev.transcript?.trim();
        if (txt && session?.twilioCallSid) {
          logEvent(session.twilioCallSid, "helene", txt);
          // transcription Hélène loguée dans events — pas dans serverLog (doublon)
          // Détecter si Hélène dit qu'elle ne peut pas répondre → unanswered_questions (A1)
          const tl = txt.toLowerCase();
          if (tl.includes("je ne peux pas répondre") || tl.includes("je ne sais pas") || tl.includes("je peux pas répondre à ça") || tl.includes("je suis désolée, je ne")) {
            const cl = callLogs.get(session.twilioCallSid);
            if (cl) {
              const lastClient = [...(cl.resumeClient || [])].pop() || "?";
              if (!cl.unanswered_questions) cl.unanswered_questions = [];
              if (!cl.unanswered_questions.includes(lastClient)) cl.unanswered_questions.push(lastClient);
            }
          }
        }
        break;
      }

      case "response.done": {
        // Détecter la fin de l'intro (première réponse seulement) et injecter le suivi client
        if (!session?.introPlayed && ev.response?.status === "completed") {
          // MARQUER immédiatement — avant tout async/setTimeout — pour éviter double intro
          if (session) session.introPlayed = true;
          // Ne cancel que si une réponse est potentiellement active (évite l'erreur response_cancel_not_active)
          // On tente le cancel mais on ignore l'erreur côté serveur

          const prefetched = session?.prefetchedClient;

          let followUp = null;

          // Construit le message de suivi selon le profil client
          const buildFollowUp = (p) => {
            if (!p || !p.name) return "Dis EXACTEMENT cette phrase : \"Comment je peux t\'aider?\" puis SILENCE ABSOLU. Attends que le client parle.";
            const prenom = p.name.split(" ")[0];
            if (p.typeCoupe && p.coiffeuse) {
              return `Dis EXACTEMENT : "Salut ${prenom}! Super de t'entendre. Désires-tu prendre rendez-vous pour une ${p.typeCoupe} avec ${p.coiffeuse}?" puis SILENCE ABSOLU — attends la réponse. Si OUI → get_available_slots service="${p.typeCoupe}" coiffeuse="${p.coiffeuse}". Si NON → adapte-toi.`;
            } else if (p.typeCoupe) {
              return `Dis EXACTEMENT : "Salut ${prenom}! Super de t'entendre. Désires-tu prendre rendez-vous pour une ${p.typeCoupe}?" puis SILENCE ABSOLU — attends la réponse. Si OUI → get_available_slots service="${p.typeCoupe}". Si NON → adapte-toi.`;
            } else {
              return `Dis EXACTEMENT : "Salut ${prenom}! Super de t'entendre. Comment je peux t'aider aujourd'hui?" puis SILENCE ABSOLU — attends la réponse.`;
            }
          };

          if (prefetched && prefetched.name) {
            if (cl) cl.clientType = "existant";
            followUp = buildFollowUp(prefetched);
          } else if (prefetched === false) {
            // Nouveau client confirmé
            followUp = "Dis EXACTEMENT cette phrase : \"Comment je peux t\'aider?\" puis SILENCE ABSOLU. Attends que le client parle. Ne génère rien d\'autre.";
          } else {
            // Lookup pas encore terminé — attendre 1.5s puis réessayer
            setTimeout(() => {
              const p2 = session?.prefetchedClient;
              const fu2 = (p2 && p2.name) ? buildFollowUp(p2) : "Dis EXACTEMENT et UNIQUEMENT : 'Comment puis-je t\'aider?' — SILENCE ABSOLU après. Zéro mot de plus.";
              if (oaiWs?.readyState === WebSocket.OPEN) {
                oaiWs.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: { type: "message", role: "user", content: [{ type: "input_text", text: fu2 + " IMPORTANT: après avoir dit cette phrase, SILENCE TOTAL — ne génère aucune autre phrase, attends que le client parle en premier." }] }
                }));
                oaiWs.send(JSON.stringify({
                  type: "response.create",
                  response: { instructions: "Dis UNIQUEMENT la phrase demandée ci-dessus, mot pour mot. Ensuite SILENCE ABSOLU — ne dis rien d'autre, attends que le client réponde." }
                }));
              }
            }, 1500);
            break; // sortir ici — le setTimeout gère la suite
          }

          if (followUp && oaiWs?.readyState === WebSocket.OPEN) {
            // Petit délai pour que response.cancel soit traité avant le followUp
            await new Promise(r => setTimeout(r, 200));
            oaiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message", role: "user",
                content: [{ type: "input_text", text: followUp }],
              }
            }));
            oaiWs.send(JSON.stringify({
              type: "response.create",
              response: {
                // max_output_tokens bas pour forcer UNE SEULE phrase courte
                max_output_tokens: 60,
                instructions: "Dis UNIQUEMENT la phrase ci-dessus, mot pour mot, RIEN d'autre. Une seule phrase. Après : silence complet, attends le client."
              }
            }));
          }
        }
        break;
      }

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
          // Attendre 4s pour laisser Hélène terminer sa phrase avant de transférer
          setTimeout(() => {
            if (twilioWs.readyState === WebSocket.OPEN)
              twilioWs.send(JSON.stringify({ event: "stop", streamSid }));
          }, 4000);
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
        // Ignorer response_cancel_not_active — inoffensif, survient si intro terminée avant le cancel
        if (ev.error?.code === "response_cancel_not_active") {
          console.log("[OAI] Cancel ignoré — aucune réponse active (normal)");
          break;
        }
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
              input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "fr",
          prompt: "Conversation téléphonique en français québécois avec une réceptionniste de salon de coiffure. Vocabulaire fréquent : coupe homme, coupe femme, coloration, mise en plis, coiffeuse, rendez-vous, Calendly, cellulaire. Prénoms possibles : Ariane, Laurie, Sophie, Alexandre, Marie. Numéros de téléphone 10 chiffres format québécois ex: 514 894 5221. Mots typiques : 'c\'est beau', 'correct', 'ouais', 'tantôt', 'tout suite', 'la semaine passée', 'à matin'. Noms de villes : Magog, Sherbrooke, Québec. Le client peut épeler son numéro chiffre par chiffre.",
        },
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
            callStartTime:  Date.now(),
          };
          sessions.set(sid, session);
        }
        session.openaiWs  = oaiWs;
        session.streamSid = streamSid;

        console.log(`[Twilio] Stream — sid: ${sid} — caller: ${session.callerNumber}`);

        // ⚡ Lookup Google immédiat dès réception du stream — avant même que OAI soit prêt
        const _callerNum = session.callerNumber;
        if (_callerNum) {
          lookupClientByPhone(_callerNum).then(info => {
            if (session) session.prefetchedClient = info ?? false; // false = nouveau client confirmé
            console.log(`[LOOKUP] Prefetch terminé: ${info ? info.name : "nouveau client"}`);
          }).catch(() => { if (session) session.prefetchedClient = false; });
        }

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
        // Clore le log si pas déjà clos (client a raccroché)
        if (session?.twilioCallSid) {
          const log = callLogs.get(session.twilioCallSid);
          if (log && log.result === "en cours") {
            closeCallLog(session.twilioCallSid, "fin normale");
          }
        }
        break;
    }
  });

  twilioWs.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(twilioKeepalive);
    oaiWs?.close();
    // Clore le log si pas déjà clos (déconnexion inattendue)
    if (session?.twilioCallSid) {
      const log = callLogs.get(session.twilioCallSid);
      if (log && log.result === "en cours") {
        closeCallLog(session.twilioCallSid, "fin normale");
      }
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

  const { phone, name, service, eventTypeUri, startTimeIso, coiffeuse } = entry.payload;
  const email = (req.body.email || "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return res.status(400).type("text/html").send(htmlForm(name, "Courriel invalide."));

  try {
    // Vérifier que le créneau est encore disponible avant de tenter la réservation
    const checkSlots = await getSlots(eventTypeUri, new Date(startTimeIso), new Date(new Date(startTimeIso).getTime() + 60_000));
    const stillAvailable = checkSlots.some(s => s === startTimeIso || Math.abs(new Date(s) - new Date(startTimeIso)) < 60_000);
    if (!stillAvailable) {
      console.warn(`[EMAIL] ❌ Créneau plus dispo: ${startTimeIso}`);
      return res.status(409).type("text/html").send(htmlSlotTaken(name, slotToFrench(startTimeIso)));
    }
    const result = await createInvitee({ uri: eventTypeUri, startTimeIso, name, email });
    pending.delete(req.params.token);

    const cancelUrl     = result?.resource?.cancel_url     || "";
    const rescheduleUrl = result?.resource?.reschedule_url || "";

    // Sauvegarder dans Google Contacts si nouveau client
    // Si format "Prénom / NomParent" (enfant/conjoint), extraire le nom du titulaire
    const ownerNameCB = name.includes(" / ") ? name.split(" / ").slice(1).join(" ").trim() : null;
    await saveContactToGoogle({ name, email, phone, typeCoupe: entry.payload.service || null, coiffeuse: entry.payload.coiffeuse || null, ownerName: ownerNameCB });

    await sendSms(phone,
      `${SALON_NAME}: RDV confirme
` +
      `${slotToShort(startTimeIso)}${coiffeuse ? " avec " + coiffeuse : ""}
` +
      (rescheduleUrl ? `Modifier: ${rescheduleUrl}
` : "") +
      (cancelUrl     ? `Annuler: ${cancelUrl}`        : "")
    );

    res.type("text/html").send(htmlSuccess(name, slotToFrench(startTimeIso), rescheduleUrl, cancelUrl));
  } catch (e) {
    console.error("[EMAIL]", e);
    // Créneau entre-temps pris par quelqu'un d'autre
    if (e.message?.includes("already_filled")) {
      res.status(409).type("text/html").send(htmlSlotTaken(name, slotToFrench(startTimeIso)));
    } else {
      res.status(500).type("text/html").send(htmlError(e.message));
    }
  }
});

// ─── HTML ─────────────────────────────────────────────────────────────────────
const css = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f5f4ff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#fff;border-radius:16px;padding:36px 32px;max-width:460px;width:100%;box-shadow:0 4px 24px rgba(108,71,255,.12)}.logo{font-size:1.6rem;font-weight:700;color:#6c47ff;margin-bottom:4px}.sub{color:#888;font-size:.9rem;margin-bottom:28px}h1{font-size:1.25rem;color:#1a1a1a;margin-bottom:10px}p{color:#555;font-size:.95rem;line-height:1.5;margin-bottom:20px}label{display:block;font-size:.85rem;font-weight:600;color:#333;margin-bottom:6px}input[type=email]{width:100%;padding:13px 14px;font-size:1rem;border:1.5px solid #ddd;border-radius:10px;outline:none}input[type=email]:focus{border-color:#6c47ff}.btn{display:block;width:100%;margin-top:16px;padding:14px;background:#6c47ff;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer}.btn:hover{background:#5538d4}.err{color:#c0392b;font-size:.88rem;margin-top:8px}.box{background:#f5f4ff;border-radius:10px;padding:16px 18px;margin:20px 0;font-size:.92rem;line-height:1.8}a.lnk{display:block;margin-top:12px;color:#6c47ff;font-size:.9rem;text-decoration:none}.muted{color:#aaa;font-size:.8rem;margin-top:24px}`;

function layout(title, body) {
  const logoHtml = SALON_LOGO_URL
    ? `<img src="${SALON_LOGO_URL}" alt="${SALON_NAME}" style="max-height:60px;max-width:200px;object-fit:contain;margin-bottom:8px">`
    : `<div class="logo">✂️ ${SALON_NAME}</div>`;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — ${SALON_NAME}</title><style>${css}</style></head><body><div class="card">${logoHtml}<div class="sub">Confirmation de rendez-vous</div>${body}</div></body></html>`;
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

function htmlSlotTaken(name, slot) {
  return layout("Créneau non disponible", `
    <h1>😕 Ce créneau vient d'être pris</h1>
    <p>Désolé ${name ? name.split(" ")[0] : ""}, le créneau <strong>${slot}</strong> a été réservé par quelqu'un d'autre pendant que tu confirmais ton courriel.</p>
    <p style="margin-top:16px">Rappelle-nous pour choisir un autre créneau disponible — ça prend moins d'une minute!</p>
    <a href="tel:${TWILIO_CALLER_ID || ""}" class="btn" style="margin-top:20px;text-decoration:none;display:block;text-align:center">📞 Rappeler le salon</a>
    <p class="muted" style="margin-top:20px">Tes informations ont été sauvegardées — tu seras reconnu automatiquement à ton prochain appel.</p>
  `);
}

function htmlError(msg) {
  // Masquer le JSON technique — afficher un message clair
  const isCalendly = msg?.includes("Calendly") || msg?.includes("400") || msg?.includes("500");
  const display = isCalendly
    ? "Une erreur technique est survenue lors de la création du rendez-vous."
    : (msg || "Erreur inconnue");
  return layout("Erreur", `
    <h1>⚠️ Erreur</h1>
    <p>Impossible de créer le rendez-vous. Rappelle le salon pour finaliser ta réservation.</p>
    <p style="font-size:.82rem;color:#999;margin-top:12px">${display}</p>
    <a href="tel:${TWILIO_CALLER_ID || ""}" class="btn" style="margin-top:20px;text-decoration:none;display:block;text-align:center">📞 Rappeler le salon</a>
  `);
}

function html410() {
  return layout("Lien expiré", `<h1>⏰ Lien expiré</h1><p>Ce lien n'est plus valide. Rappelle le salon pour un nouveau lien.</p>`);
}

// ─── Logs colorés ─────────────────────────────────────────────────────────────
const R = "\x1b[31m", G = "\x1b[32m", Y = "\x1b[33m", X = "\x1b[0m";
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);

// Capturer les logs Railway dans le serverLog de l'appel actif
const CALL_LOG_PREFIXES = ["[OAI]","[TOOL]","[SLOTS]","[LOOKUP]","[BOOKING]","[GOOGLE]","[SMS]","[Twilio]","[CALENDLY]","[VOICE]","[TOOL RESULT]"];
function captureToCallLog(line) {
  try {
    if (!CALL_LOG_PREFIXES.some(p => line.includes(p))) return;
    for (const [, sess] of sessions) {
      if (sess?.twilioCallSid && callLogs.has(sess.twilioCallSid)) {
        logRaw(sess.twilioCallSid, line);
        break;
      }
    }
  } catch {}
}
console.log = (...args) => {
  _origLog(...args);
  captureToCallLog(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
};
console.error = (...a) => { _origError(R + "[ERREUR]", ...a, X); captureToCallLog("[ERREUR] " + a.map(x => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" ")); };
console.warn  = (...a) => { _origWarn(Y  + "[AVERT]",  ...a, X); captureToCallLog("[AVERT] " + a.map(x => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" ")); };

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  console.log(G + `✅ ${SALON_NAME} — port ${PORT}` + X);
  loadLogsFromDisk();
  await loadCoiffeuses();
});
