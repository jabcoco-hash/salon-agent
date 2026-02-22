import express from "express";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  FALLBACK_NUMBER,        // ex: +15148945221
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,       // ton numéro Twilio ex: +14389006435
  CALENDLY_LINK,          // ex: https://calendly.com/...
  LANG = "fr-CA",
} = process.env;

function isHumanRequest(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("humain") ||
    t.includes("agent") ||
    t.includes("personne") ||
    t.includes("propriétaire") ||
    t.includes("proprietaire")
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

app.get("/", (req, res) => {
  res.json({ ok: true, service: "salon-agent-mvp", lang: LANG });
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
    "Allô! Je suis l’assistant du salon de coco. Dis: rendez-vous, prix, horaires, ou humain."
  );

  twiml.redirect({ method: "POST" }, "/voice");
  res.type("text/xml").send(twiml.toString());
});

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

    // 1) Demande humain -> transfert
    if (isHumanRequest(userText)) {
      twiml.say({ language: LANG }, "Parfait, je te transfère.");
      const dial = twiml.dial({ callerId: TWILIO_CALLER_ID });
      dial.number(FALLBACK_NUMBER);
      return res.type("text/xml").send(twiml.toString());
    }

    // 2) Demande rendez-vous -> SMS Calendly + fin
    if (isBooking(userText)) {
      twiml.say(
        { language: LANG },
        "Parfait. Je t’envoie un lien par texto pour choisir ton rendez-vous."
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

    // 3) Réponses simples (MVP)
    twiml.say(
      { language: LANG },
      "OK. Pour un rendez-vous dis: rendez-vous. Sinon, dis: humain pour être transféré."
    );
    twiml.redirect({ method: "POST" }, "/voice");
    return res.type("text/xml").send(twiml.toString());

  } catch (e) {
    twiml.say({ language: LANG }, "Oups. Je te transfère.");
    const dial = twiml.dial({ callerId: TWILIO_CALLER_ID });
    dial.number(FALLBACK_NUMBER);
    return res.type("text/xml").send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Salon MVP running on ${port}`));
