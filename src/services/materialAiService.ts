const APP_ID = import.meta.env.VITE_APP_ID || 'smartfinhub';
const AI_API_URL = 'https://api-integrations.appmedo.com/app-7wraacwkpcld/api-rLob8RdzAOl9/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse';

export interface MaterialMessage {
  role: 'user' | 'model';
  content: string;
}

// Utility to handle SSE streaming from Gemini
async function streamGeminiContent(
  prompt: string,
  history: MaterialMessage[],
  systemInstruction: string,
  onChunk: (text: string) => void,
  onComplete: () => void,
  onError: (error: string) => void
): Promise<void> {
  try {
    if (!APP_ID) {
      throw new Error('AI service not configured. Please set VITE_APP_ID in your .env file.');
    }

    const contentsPayload = [];

    // Add history if any
    for (const msg of history) {
      contentsPayload.push({
        role: msg.role,
        parts: [{ text: msg.content }]
      });
    }

    // Add current user prompt
    contentsPayload.push({
      role: 'user' as const,
      parts: [{ text: `${systemInstruction}\n\nUser Input: ${prompt}` }]
    });

    const payload = {
      contents: contentsPayload,
    };

    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Id': APP_ID,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.status === 999) {
        throw new Error(errorData.msg || 'API request failed');
      }
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          completed = true;
          onComplete();
          break;
        }

        try {
          const parsedData = JSON.parse(dataStr);
          const text = parsedData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            onChunk(text);
          }

          const finishReason = parsedData.candidates?.[0]?.finishReason;
          if (finishReason === 'STOP' && !completed) {
            completed = true;
            onComplete();
            break;
          }
        } catch (e) {
          console.error('Error parsing SSE line:', e, dataStr);
        }
      }

      if (completed) {
        break;
      }
    }

    if (!completed) {
      onComplete();
    }
  } catch (error) {
    console.error('Material AI Service Error:', error);
    onError(error instanceof Error ? error.message : 'Failed to stream response');
  }
}

/**
 * 1. AI Assistant Chat
 */
export async function streamMaterialAssistantChat(
  prompt: string,
  history: MaterialMessage[],
  onChunk: (text: string) => void,
  onComplete: () => void,
  onError: (error: string) => void
): Promise<void> {
  const systemInstruction = `You are a highly experienced Procurement Manager and Construction/MEP engineer. 
Your goal is to answer queries about construction materials, rates, services, technical specifications, and brand selections. 
Be highly professional, structured, and give detailed commercial and technical insights. 
Use Indian currency (₹/Lakh/Crore) and metric units (sq.ft, bags, tons, running meters, mm, etc.) as the default reference.
Provide concrete pricing ranges, IS specifications, or typical vendor names (e.g. Havells, Kajaria, Somany, Asian Paints, Tata Steel, Ultratech, greenply, Century Ply, Bosch) where relevant.`;

  return streamGeminiContent(prompt, history, systemInstruction, onChunk, onComplete, onError);
}

/**
 * 2. Multi-Input BOQ and Drawing Analyzer
 */
export async function streamBOQDrawingAnalyzer(
  inputData: {
    projectName: string;
    boqFileName?: string;
    boqTextContent: string;
    drawingDescription: string;
    imageDetails?: string;
  },
  onChunk: (text: string) => void,
  onComplete: () => void,
  onError: (error: string) => void
): Promise<void> {
  const prompt = `Project Name: ${inputData.projectName}
Uploaded BOQ/Specs Text Content:
---
${inputData.boqTextContent}
---
Drawing / CAD Plan Description:
---
${inputData.drawingDescription}
---
${inputData.imageDetails ? `Uploaded Site/Sketch Image Details: ${inputData.imageDetails}` : ''}`;

  const systemInstruction = `You are an AI Quantity Surveyor and Estimator.
Analyze the provided BOQ text description, Drawing details, and Image descriptions.
Identify:
1. Required materials, products, brands, or service categories.
2. Estimated quantities from the drawing.
3. Compare the Drawing quantities vs the BOQ quantities.
4. Detect:
   - Missing items (items in drawing but not in BOQ, or vice versa)
   - Duplicate items
   - Quantity mismatches (e.g., Drawing calculates 1200 sq.ft tile, but BOQ lists 1500 sq.ft - excess of 300 sq.ft)
   - Brand inconsistencies or unsupported grades of concrete/steel.

Format your output in professional markdown with:
- An Executive Summary
- A detailed Comparison Table: columns for Item, BOQ Qty, Est. Qty from Drawing, Variance, Unit, Status (Match, Excess, Shortage, Missing in BOQ, Missing in Drawing).
- Critical Discrepancy Warnings (using callouts/warnings).
- Recommendations (Alternative brands, durability suggestions).`;

  return streamGeminiContent(prompt, [], systemInstruction, onChunk, onComplete, onError);
}

/**
 * 3. Brand Alternatives & Recommendations Generator
 */
export async function streamBrandAlternatives(
  productName: string,
  category: string,
  onChunk: (text: string) => void,
  onComplete: () => void,
  onError: (error: string) => void
): Promise<void> {
  const prompt = `Product Name: ${productName}
Category: ${category}`;

  const systemInstruction = `You are a Material Sourcing Specialist.
Generate a structured comparative assessment of product alternatives for the searched material.
For the search term, identify and compare:
1. **Premium Tier**: High-end brand (e.g. Kajaria Eternity, Jaquar Artize, Asian Paints Royale, Legrand Arteor, Hilti, Century Club Prime).
2. **Standard Tier**: Popular mid-market brand (e.g. Somany, Jaquar Select, Asian Paints Apcolite, Havells, Green Gold, Bosch).
3. **Economy Tier**: Economical local/regional brand (e.g. Orientbell, Cera, Tractor Emulsion, Anchor, local plywood, generic tools).

Provide details in a clear markdown structure:
- **Price Range Comparison Table**: showing MRP ranges, current market rate ranges, average rates, and GST rates.
- **Specifications Comparison**: Dimensions, finish, warranty, certifications, and durability ratings.
- **Pros & Cons Analysis** for each tier.
- **AI Recommendation**: Sourcing advice based on different budgets/project types (e.g., luxury villa vs commercial rental).`;

  return streamGeminiContent(prompt, [], systemInstruction, onChunk, onComplete, onError);
}
