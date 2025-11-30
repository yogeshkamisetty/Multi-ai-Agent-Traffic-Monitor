// geminiService.ts — FRONTEND SHOULD NEVER CALL GOOGLE API DIRECTLY

import { FullAnalysisResult, LocationContextData } from "../types";

const BACKEND_URL = "https://multi-ai-backend-ehhj.onrender.com";

// Upload image to backend for AI analysis
export const analyzeTrafficImage = async (
  base64Image: string,
  mimeType: string
): Promise<FullAnalysisResult> => {
  try {
    const response = await fetch(`${BACKEND_URL}/api/gemini`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "traffic-analysis",
        image: base64Image,
        mimeType,
      }),
    });

    if (!response.ok) {
      throw new Error("Analysis failed: " + response.statusText);
    }

    return await response.json();
  } catch (err: any) {
    console.error("Frontend Error:", err);
    throw new Error("Failed to connect to analysis server.");
  }
};

// Get location context from your backend
export const getLocationContext = async (
  lat: number,
  lng: number
): Promise<LocationContextData> => {
  try {
    const response = await fetch(`${BACKEND_URL}/api/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng }),
    });

    if (!response.ok) throw new Error("Location lookup failed.");

    return await response.json();
  } catch (err) {
    console.error("Location context fetch failed:", err);

    return {
      latitude: lat,
      longitude: lng,
      address: "Location Service Unavailable",
      nearbyPlaces: [],
      trafficInfluencers: ["Could not load location context"],
    };
  }
};
