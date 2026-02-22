import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ ok: true, service: "salon-agent", lang: "fr-CA" });
});

app.post("/twilio/voice", (req, res) => {
  const fallbackNumber = process.env.FALLBACK_NUMBER || "+15148945221";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-CA" voice="alice">Bonjour! Un instant, je vous transfère au salon.</Say>
  <Dial>${fallbackNumber}</Dial>
  <Say language="fr-CA" voice="alice">Désolé, personne ne répond. Laissez un message après le bip.</Say>
  <Record maxLength="60" playBeep="true" />
</Response>`;

  res.type("text/xml").send(twiml);
});

app.listen(PORT, () => console.log("✅ Running on", PORT));
