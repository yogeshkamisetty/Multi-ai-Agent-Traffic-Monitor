import { GoogleGenAI, Type } from "@google/genai";
import { FullAnalysisResult, LocationContextData } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Extended schema with Bounding Boxes for Tracking
const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    detections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          object: { type: Type.STRING },
          count: { type: Type.INTEGER },
          confidence: { type: Type.NUMBER },
          type: { type: Type.STRING, enum: ["vehicle", "pedestrian", "infrastructure", "other"] },
          box_2d: {
             type: Type.ARRAY,
             description: "Bounding box [ymin, xmin, ymax, xmax] normalized 0-1000",
             items: { type: Type.INTEGER } 
          }
        }
      }
    },
    analysis: {
      type: Type.OBJECT,
      properties: {
        totalVehicles: { type: Type.INTEGER },
        pedestrianCount: { type: Type.INTEGER },
        trafficLights: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              state: { type: Type.STRING, enum: ["Red", "Yellow", "Green", "Off"] },
              count: { type: Type.INTEGER }
            }
          }
        },
        congestionLevel: { type: Type.INTEGER },
        trafficFlowStatus: { type: Type.STRING, enum: ["Free Flow", "Moderate", "Heavy", "Gridlock"] },
        estimatedAverageSpeed: { type: Type.INTEGER, description: "Estimated average speed of traffic flow in km/h based on visual cues." },
        detectedViolations: { 
          type: Type.ARRAY, 
          items: { 
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING, enum: ["Red Light", "Jaywalking", "Wrong Lane", "Speeding", "Other"] },
              description: { type: Type.STRING },
              severity: { type: Type.STRING, enum: ["Low", "Medium", "High"] }
            }
          }
        }
      }
    },
    report: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        recommendations: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        },
        priorityScore: { type: Type.INTEGER }
      }
    }
  },
  required: ["detections", "analysis", "report"]
};

// Helper to translate technical errors into user guidance
const handleGeminiError = (error: any): never => {
  console.error("Gemini API Error details:", error);
  
  const msg = error.message || "";
  
  if (msg.includes("401") || msg.includes("403") || msg.includes("API_KEY")) {
    throw new Error("Authentication Failed: The API Key is missing or invalid. Please check your environment configuration.");
  }
  
  if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
    throw new Error("Traffic Overload: The AI service is experiencing high demand (Rate Limit). Please wait 30 seconds before retrying.");
  }
  
  if (msg.includes("500") || msg.includes("503")) {
    throw new Error("Service Unavailable: Google Gemini is currently down or overloaded. Please try again later.");
  }
  
  if (msg.includes("xhr error") || msg.includes("Rpc failed") || msg.includes("fetch failed")) {
      throw new Error("Connection Error: Unable to reach Google AI services. Please check your internet connection or firewall.");
  }

  if (msg.includes("SAFETY") || msg.includes("blocked")) {
    throw new Error("Content Blocked: The image was flagged by safety filters. Please try a clearer or different image.");
  }
  
  if (msg.includes("valid JSON")) {
    throw new Error("Data Parsing Error: The AI response was malformed. This occasionally happens with complex scenes. Please retry.");
  }

  throw new Error(`Analysis Failed: ${msg.substring(0, 100)}... (See console for details)`);
};

// Helper for linear backoff
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Clean JSON string (remove markdown blocks)
const cleanJsonString = (str: string): string => {
  if (!str) return "";
  let cleanStr = str.trim();
  // Remove markdown json block markers
  if (cleanStr.startsWith("```json")) {
    cleanStr = cleanStr.substring(7);
  }
  if (cleanStr.startsWith("```")) {
    cleanStr = cleanStr.substring(3);
  }
  if (cleanStr.endsWith("```")) {
    cleanStr = cleanStr.substring(0, cleanStr.length - 3);
  }
  return cleanStr.trim();
};

export const analyzeTrafficImage = async (base64Image: string, mimeType: string): Promise<FullAnalysisResult> => {
  const modelId = "gemini-2.5-flash"; 
  let lastError: any;

  // Retry loop for robustness against transient 500/Network errors and Rate Limits
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
        const prompt = `
          You are the 'Multi AI Agent' Traffic Monitoring System (Multi-Agent Mode).
          
          **Agent 1: Vision Detector**
          - Detect vehicles, pedestrians, and traffic lights.
          - **CRITICAL**: Return 2D Bounding Boxes ([ymin, xmin, ymax, xmax] 0-1000 scale) for EACH detected vehicle/pedestrian to enable Tracking.
          - Estimate the AVERAGE SPEED of the traffic flow (0 if stopped).

          **Agent 2: Analysis Agent (Strict Violation Detection)**
          - Calculate Congestion Level (0-100).
          - DETECT VIOLATIONS:
            1. **Red Light Violation**: Identify vehicles crossing the stop line when light is RED.
            2. **Jaywalking**: Identify pedestrians on road NOT in crosswalk.
            3. **Wrong Lane**: Vehicles straddling lines or in opposing lanes.
          
          **Agent 3: Report Agent**
          - Summarize findings and suggest improvements.
          - Provide a Priority Score (1-10).
        `;

        const response = await ai.models.generateContent({
          model: modelId,
          contents: {
            parts: [
              { inlineData: { mimeType: mimeType, data: base64Image } },
              { text: prompt }
            ]
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: analysisSchema,
            temperature: 0.4,
          }
        });

        if (!response.text) throw new Error("Empty response received from AI service.");

        try {
            const cleanedText = cleanJsonString(response.text);
            const data = JSON.parse(cleanedText) as FullAnalysisResult;
            data.timestamp = Date.now();
            return data;
        } catch (parseError) {
            console.warn("JSON Parse Error on text:", response.text);
            throw new Error("Failed to parse AI response as valid JSON.");
        }

    } catch (error) {
        lastError = error;
        const msg = (error as any).message || "";
        
        // Retry logic
        const isRateLimit = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota");
        const isTransient = msg.includes("500") || msg.includes("503") || msg.includes("xhr error") || msg.includes("fetch failed") || msg.includes("Overloaded");
        
        if ((isTransient || isRateLimit) && attempt < 3) {
            // Wait longer for rate limits (5s, 10s) vs transient errors (1s, 2s)
            const waitTime = isRateLimit ? attempt * 5000 : attempt * 1000;
            console.warn(`Gemini API Attempt ${attempt} failed. Retrying in ${waitTime}ms... (Reason: ${msg.substring(0, 50)}...)`);
            await delay(waitTime); 
            continue;
        }
        
        // If not retryable or max attempts reached, stop loop
        break;
    }
  }

  // If we exit the loop, handle the last error
  handleGeminiError(lastError);
};

// Google Maps Grounding for Realtime Context
export const getLocationContext = async (lat: number, lng: number): Promise<LocationContextData> => {
  const modelId = "gemini-2.5-flash";
  
  try {
    const prompt = `
      You are a Location Context Agent.
      Using the provided coordinates (${lat}, ${lng}), identify the real-world location and analysis its impact on traffic.
      
      1. Determine the address or area name.
      2. List 3 nearby places (Schools, Stadiums, Hospitals, Malls) that act as traffic generators.
      3. Explain specific traffic influencers (e.g., "School zone limits speed to 20mph", "Stadium event causes gridlock").
      
      Format the output as a concise summary.
    `;

    const response = await ai.models.generateContent({
      model: modelId,
      contents: { text: prompt },
      config: {
        tools: [{ googleMaps: {} }],
        toolConfig: {
            retrievalConfig: {
                latLng: { latitude: lat, longitude: lng }
            }
        }
      }
    });
    
    const text = response.text || "No context available.";
    
    return {
        latitude: lat,
        longitude: lng,
        address: "Detected via Google Maps",
        nearbyPlaces: [
            { name: "See Analysis Details", type: "Area Context", distance: "< 1km" }
        ],
        trafficInfluencers: [text] 
    };

  } catch (error) {
    console.error("Error fetching location context:", error);
    // Non-blocking error for context
    return {
        latitude: lat,
        longitude: lng,
        address: "Location Service Unavailable",
        nearbyPlaces: [],
        trafficInfluencers: ["Unable to retrieve map data at this time."]
    };
  }
};