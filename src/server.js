import express from "express";

const app = express();

// Twilio envoie souvent du x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ Health check (ton URL Railway retourne ça)
app.get("/", (req, res) => {
  res.json({ ok: true, service: "salon-agent", lang: "fr-CA" });
});

// ✅ Webhook Twilio: appel entrant
// Twilio va appeler ce endpoint quand quelqu’un appelle ton numéro Twilio
app.post("/twilio/voice", (req, res) => {
  const fallbackNumber = process.env.FALLBACK_NUMBER || "+15148945221";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-CA" voice="alice">Bonjour! Un instant, je vous transfère au salon de coco.</Say>
  <Dial>${fallbackNumber}</Dial>
  <Say language="fr-CA" voice="alice">Désolé, personne ne répond. Laissez un message après le bip.</Say>
  <Record maxLength="60" playBeep="true" />
</Response>`;

  res.type("text/xml").send(twiml);
});

// ✅ (Optionnel) callback de statut Twilio (pour debug)
app.post("/twilio/status", (req, res) => {
  console.log("Twilio status callback:", req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`✅ salon-agent listening on port ${PORT}`);
});
