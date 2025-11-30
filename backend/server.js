//backend that connects to the server
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// MAIN AI ROUTE
app.post("/api/gemini", async (req, res) => {
  try {
    const { image, mimeType } = req.body;

    if (!image || !mimeType) {
      return res.status(400).json({ error: "Missing image or mimeType" });
    }

    // Construct request to Google AI Studio
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inlineData: { mimeType: mimeType, data: image } },
                {
                  text: `
You are a multi-agent traffic monitoring system.
Analyze the image, detect vehicles, pedestrians, violations, bounding boxes,
and return JSON exactly as requested.
                  `,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.4,
          },
        }),
      }
    );

    const data = await response.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("Server Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// OPTIONAL — Location route (if needed)
app.post("/api/location", (req, res) => {
  res.json({
    info: "Location API coming soon",
  });
});

app.get("/", (req, res) => {
  res.send("Backend is running ✔");
});

app.listen(3000, () => {
  console.log("Backend running on port 3000");
});
