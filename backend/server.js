const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ADD THIS
app.get("/", (req, res) => {
  res.send("Backend is running ✔");
});

// Your API route
app.post("/api/gemini", async (req, res) => {
  try {
    // ...Your logic
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Backend running on port", PORT);
});

