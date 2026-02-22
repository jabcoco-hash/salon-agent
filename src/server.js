import express from "express";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  FALLBACK_NUMBER,        // ex: +15148945221
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,       // ton numéro Twilio ex: +14389006435
  CALENDLY_LINK,          // ex: https://calendly.com/...
  LANG = "fr-CA",

  OPENAI_API_KEY,
  OPENAI_MODEL,
  SALON_ADDRESS = "Adresse non configurée",
  SALON_HOURS = "Horaires non configurés",
  SALON_PRICES = "Prix non configurés",
} = process.env;

// OpenAI client (si clé présente)
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function isHumanRequest(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("humain") ||
    t.includes("agent") ||
    t.includes("personne") ||
    t.includes("propriétaire") ||
    t.includes("proprietaire") ||
    t.includes("parler à quelqu") ||
    t.includes("parler a quelqu")
  );
}

function isBooking(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("rendez") ||
    t.includes("rdv") ||
    t.includes("réserver") ||
    t.includes("reserver") ||
    t.includes("booking")
  );
}

function isPrice(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("prix") ||
    t.includes("coût") ||
    t.includes("combien") ||
    t.includes("tarif")
  );
}

function isHours(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("horaire") ||
    t.includes("heure") ||
    t.includes("ouvert") ||
    t.includes("fermé")
  );
}

function isAddress(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("adresse") ||
    t.includes("où") ||
    t.includes("ou êtes") ||
    t.includes("situé")
  );
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "salon-agent-mvp-openai", lang: LANG });
});

// Entrée d’appel
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/process",
    method: "POST",
    language: LANG,
    speechTimeout: "auto",
    timeout: 6,
  });

  gather.say(
    { language: LANG },
    "Allô! Je suis l’assistant du salon. Dis: rendez-vous, prix, horaires, adresse, ou humain."
  );

  twiml.redirect({ method: "POST" }, "/voice");
  res.type("text/xml").send(twiml.toString());
});

async function askOpenAI(userText) {
  // Réponse STRICT JSON
  const system = `
Tu es un assistant téléphonique pour un salon au Québec.
Langue: français québécois (fr-CA). Ton: simple, poli, direct.
Tu as accès aux infos suivantes:
- Adresse: ${SALON_ADDRESS}
- Horaires: ${SALON_HOURS}
- Prix: ${SALON_PRICES}

Ta job:
- Si l'intention est "prendre rendez-vous" => action="book"
- Si l'utilisateur veut un humain => action="transfer"
- Si question sur prix/horaire/adresse => action="answer" (réponds avec l'info)
- Si c'est vague => action="clarify" (pose 1 question courte)

Règles:
- Réponses courtes (1 à 2 phrases).
- Pose une seule question à la fois.
- Ne promets jamais un prix/horaire/adresse si ce n'est pas dans les infos.
- Réponds STRICTEMENT en JSON, aucun autre texte.

Format:
{"action":"book|transfer|answer|clarify","say":"..."}
`.trim();

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText }
    ]
  });

  const raw = completion.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return { action: "clarify", say: "Peux-tu préciser si tu veux un rendez-vous, les prix, les horaires, ou l’adresse?" };
  }
}

app.post("/process", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const from = req.body.From; // numéro du client
    const userText = (req.body.SpeechResult || "").trim();

    if (!userText) {
      twiml.say({ language: LANG }, "Je t’ai pas bien entendu. Peux-tu répéter?");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // ✅ Toujours prioriser demande humaine
    if (isHumanRequest(userText)) {
      twiml.say({ language: LANG }, "Parfait, je te transfère.");
      const dial = twiml.dial({ callerId: TWILIO_CALLER_ID });
      dial.number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

      // 3) FAQ locale - PRIX
  if (isPrice(userText)) {
    twiml.say(
      { language: LANG },
      "Voici nos prix. Coupe homme 25 dollars. Coupe femme 45 dollars. Coupe non binaire 250 dollars."
    );
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());
  }
  
  // 4) FAQ locale - HORAIRE
  if (isHours(userText)) {
    twiml.say(
      { language: LANG },
      "Nous sommes ouverts du lundi au vendredi de 9h à 18h. Le samedi de 10h à 14h. Nous sommes fermés le dimanche."
    );
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());
  }
  
  // 5) FAQ locale - ADRESSE
  if (isAddress(userText)) {
    twiml.say(
      { language: LANG },
      "Nous sommes situés au 123 rue des salons test, à Magog."
    );
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());
  }
    
    // ✅ Si OpenAI pas configuré, fallback sur règles simples actuelles
    if (!openai) {
      if (isBooking(userText)) {
        twiml.say({ language: LANG }, "Parfait. Je t’envoie un lien par texto pour choisir ton rendez-vous.");

        if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_CALLER_ID && CALENDLY_LINK && from) {
          const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
          await client.messages.create({
            from: TWILIO_CALLER_ID,
            to: from,
            body: `Voici le lien pour réserver: ${CALENDLY_LINK}`,
          });
        }

        twiml.say({ language: LANG }, "Merci! À bientôt.");
        twiml.hangup();
        return res.type("text/xml").send(twiml.toString());
      }

      twiml.say({ language: LANG }, "OK. Dis: rendez-vous, prix, horaires, adresse, ou humain.");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // ✅ Décision par OpenAI
    const decision = await askOpenAI(userText);
    const action = decision?.action || "clarify";
    const sayText = (decision?.say || "").toString().slice(0, 600);

    if (action === "transfer") {
      twiml.say({ language: LANG }, sayText || "Parfait, je te transfère.");
      const dial = twiml.dial({ callerId: TWILIO_CALLER_ID });
      dial.number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    if (action === "book") {
      twiml.say(
        { language: LANG },
        sayText || "Parfait. Je t’envoie un lien par texto pour choisir ton rendez-vous."
      );

      if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_CALLER_ID && CALENDLY_LINK && from) {
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        await client.messages.create({
          from: TWILIO_CALLER_ID,
          to: from,
          body: `Voici le lien pour réserver: ${CALENDLY_LINK}`,
        });
      }

      twiml.say({ language: LANG }, "Merci! À bientôt.");
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    if (action === "answer") {
      twiml.say({ language: LANG }, sayText || "Voici l’info.");
      twiml.redirect({ method: "POST" }, "/voice");
      return res.type("text/xml").send(twiml.toString());
    }

    // clarify
    twiml.say({ language: LANG }, sayText || "Peux-tu préciser?");
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());

  } catch (e) {
    console.error("process error:", e);
    twiml.say({ language: LANG }, "Oups. Je te transfère.");
    const dial = twiml.dial({ callerId: TWILIO_CALLER_ID });
    dial.number(FALLBACK_NUMBER);
    return res.type("text/xml").send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Salon MVP (OpenAI) running on ${port}`));
