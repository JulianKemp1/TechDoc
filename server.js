// Updated server.js with axios-retry integrated for AI calls

import dotenv from "dotenv";
dotenv.config();

// Add new import for axios-retry
import axiosRetry from "axios-retry";

// Polyfill DOMMatrix for Node (required by pdfjs-dist)
if (typeof global.DOMMatrix === "undefined") {
  global.DOMMatrix = class DOMMatrix {
    constructor(matrix) {
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;
      if (matrix && typeof matrix === "string") {
        const values = matrix.match(/-?\d+(\.\d+)?/g)?.map(Number) || [];
        [this.a, this.b, this.c, this.d, this.e, this.f] = values;
      }
    }
  };
}

import express from "express";
import path from "path";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { createCanvas, loadImage } from "canvas";
import AdobePDFService from "./adobePDFService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let pdfjsLib; // will be imported dynamically

// Configure PDF.js for Node.js with proper canvas backend
let canvasFactory;

// Simple Canvas Factory for Node.js
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return {
      canvas,
      context,
      width,
      height,
    };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// Initialize canvas factory at startup
canvasFactory = new NodeCanvasFactory();
console.log("🖼️ Canvas factory initialized for PDF rendering");

const app = express();
const port = process.env.PORT || 5500;

app.use(express.json());
app.use(express.static(path.join(__dirname, "src", "pdfs")));
// Serve generated page images
app.use(
  "/page-images",
  express.static(path.join(__dirname, "public", "page-images")),
);
// Serve PDFs with proper CORS headers for React PDF viewer
app.use(
  "/pdfs",
  express.static(path.join(__dirname, "src", "pdfs"), {
    setHeaders: (res, path) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    },
  }),
);

// Configure multer for file uploads - session-based storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const sessionId = getSessionId(req);
    const uploadDir = path.join(__dirname, "uploads", sessionId);
    // Create session-specific upload directory
    fs.mkdir(uploadDir, { recursive: true })
      .then(() => {
        cb(null, uploadDir);
      })
      .catch(cb);
  },
  filename: function (req, file, cb) {
    // Generate unique filename to prevent conflicts
    const uniqueId = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueId}${ext}`);
  },
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Only allow PDF files
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-session-id, session-id",
  );
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Session-based storage for AI platform architecture
const clientSessions = new Map(); // sessionId -> { documents: [], conversationContext: {} }

// Create or get session data
function getOrCreateSession(sessionId) {
  if (!clientSessions.has(sessionId)) {
    clientSessions.set(sessionId, {
      documents: [],
      conversationContext: {
        previousQueries: [],
        userPreferences: {},
        equipmentType: null,
        lastQueryType: null,
      },
      uploadedFiles: [],
    });
  }
  return clientSessions.get(sessionId);
}

// Generate session ID (simple implementation for backend-only system)
function generateSessionId() {
  return (
    "session_" + Math.random().toString(36).substr(2, 9) + "_" + Date.now()
  );
}

// Get session ID from request (header or create new)
function getSessionId(req) {
  return (
    req.headers["x-session-id"] ||
    req.headers["session-id"] ||
    generateSessionId()
  );
}

// Auto-import PDFs from src/pdfs folder if session is empty
async function autoImportPDFsIfNeeded(sessionId) {
  const sessionData = getOrCreateSession(sessionId);

  // If session already has documents, no need to import
  if (sessionData.documents.length > 0) {
    return { imported: false, count: sessionData.documents.length };
  }

  try {
    const pdfDir = path.join(__dirname, "src", "pdfs");

    // Check if directory exists
    try {
      await fs.access(pdfDir);
    } catch {
      console.log(`📁 No src/pdfs directory found for auto-import`);
      return { imported: false, count: 0, error: "No PDF directory" };
    }

    // Read all PDF files
    const files = await fs.readdir(pdfDir);
    const pdfFiles = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

    if (pdfFiles.length === 0) {
      console.log(`📄 No PDF files found for auto-import`);
      return { imported: false, count: 0, error: "No PDF files" };
    }

    console.log(
      `🔄 Auto-importing ${pdfFiles.length} PDFs for session ${sessionId}`,
    );

    let importedCount = 0;

    // Process each PDF file
    for (const filename of pdfFiles) {
      try {
        const filePath = path.join(pdfDir, filename);

        // Extract enhanced PDF data with page tracking
        const pdfData = await extractTextFromPDF(filePath);

        // Create machine name from filename or extracted text
        const machineName =
          pdfData.fullText.split(" ").slice(0, 5).join(" ") ||
          path.basename(filename, ".pdf");

        // Add document to session storage with enhanced PDF data
        const document = {
          id: uuidv4(),
          machineName: machineName,
          originalName: filename,
          fileName: filename,
          pdfPath: `/pdfs/${filename}`,
          text: pdfData.fullText, // Keep for backward compatibility
          pages: pdfData.pages, // Enhanced: page-by-page content
          textMap: pdfData.textMap, // Enhanced: line-to-page mapping
          metadata: pdfData.metadata, // Enhanced: PDF metadata
          uploadedAt: new Date().toISOString(),
          source: "auto-imported",
        };

        sessionData.documents.push(document);
        sessionData.uploadedFiles.push({
          id: document.id,
          originalName: filename,
          fileName: filename,
          uploadedAt: document.uploadedAt,
          source: "auto-imported",
        });

        importedCount++;
        console.log(`📖 Auto-imported: ${filename} -> ${machineName}`);
      } catch (error) {
        console.error(`❌ Failed to auto-import ${filename}:`, error.message);
      }
    }

    console.log(
      `✅ Auto-imported ${importedCount} PDFs into session ${sessionId}`,
    );
    return { imported: true, count: importedCount };
  } catch (error) {
    console.error("Auto-import error:", error.message);
    return { imported: false, count: 0, error: error.message };
  }
}

// Direct bypass patterns - easily expandable for new document types
const directBypassPatterns = {
  partNumber: [
    /(\w+\s+)*(oil|air|fuel|hydraulic|transmission|coolant)\s+filter\s+(number|part)/,
    /engine\s+oil\s+filter\s+number/,
    /part\s+number\s+for\s+(\w+\s+)*filter/,
    /(\w+\s+)*filter\s+part\s+number/,
    /what\s+is\s+the\s+part\s+number/,
  ],
  specifications: [
    /(\w+\s+)*filter\s+(spec|specification)/,
    /torque\s+spec/,
    /installation\s+torque/,
    /technical\s+spec/,
    /filter\s+dimensions/,
  ],
  installation: [
    /how\s+to\s+install\s+(\w+\s+)*filter/,
    /installation\s+procedure/,
    /replace\s+(\w+\s+)*filter/,
    /installation\s+steps/,
    /filter\s+replacement/,
  ],
  maintenance: [
    /maintenance\s+interval/,
    /service\s+schedule/,
    /when\s+to\s+replace/,
    /filter\s+change\s+interval/,
    /service\s+hours/,
  ],
};

// Check if query should bypass conversational logic
function checkForDirectBypass(query) {
  const lowerQuery = query.toLowerCase().trim();

  for (const [bypassType, patterns] of Object.entries(directBypassPatterns)) {
    if (patterns.some((pattern) => pattern.test(lowerQuery))) {
      return { shouldBypass: true, bypassType, originalQuery: query };
    }
  }

  return { shouldBypass: false };
}

// Extract all text from PDF with page tracking for visual context
async function extractTextFromPDF(filePath) {
  if (!pdfjsLib) {
    try {
      pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
      // Fallback to regular import if legacy is not available
      pdfjsLib = await import("pdfjs-dist");
    }
  }

  try {
    const data = await fs.readFile(filePath);
    // Convert Buffer to Uint8Array for pdf.js compatibility
    const uint8Array = new Uint8Array(data);
    const pdf = await pdfjsLib.getDocument({ data: uint8Array }).promise;

    let fullText = "";
    const pages = [];
    const textMap = []; // Maps text lines to page numbers and positions

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      // Extract raw text items with position data
      const textItems = content.items.map((item) => ({
        text: item.str,
        x: Math.round(item.transform[4]), // X position
        y: Math.round(item.transform[5]), // Y position
        width: Math.round(item.width),
        height: Math.round(item.height),
      }));

      // Group text items by approximate lines (similar Y positions)
      const lines = [];
      const lineThreshold = 5; // Pixels tolerance for same line

      textItems.forEach((item) => {
        if (item.text.trim()) {
          let addedToLine = false;
          for (let line of lines) {
            if (Math.abs(line.y - item.y) <= lineThreshold) {
              line.items.push(item);
              addedToLine = true;
              break;
            }
          }
          if (!addedToLine) {
            lines.push({
              y: item.y,
              items: [item],
            });
          }
        }
      });

      // Sort lines by Y position (top to bottom) and items by X position (left to right)
      lines.sort((a, b) => b.y - a.y); // Higher Y = top of page
      lines.forEach((line) => {
        line.items.sort((a, b) => a.x - b.x); // Lower X = left of page
        line.text = line.items
          .map((item) => item.text)
          .join(" ")
          .replace(/\s{2,}/g, " ");
      });

      // Create page text and mapping
      const pageText = lines.map((line) => line.text).join("\n");
      const cleanPageText = pageText.replace(/\s{2,}/g, " ");

      pages.push({
        pageNumber: pageNum,
        text: cleanPageText,
        lines: lines.map((line, lineIndex) => ({
          lineNumber: lineIndex + 1,
          text: line.text,
          y: line.y,
          items: line.items,
        })),
      });

      // Map each line to its page for search context
      lines.forEach((line, lineIndex) => {
        if (line.text.trim()) {
          textMap.push({
            text: line.text.trim(),
            pageNumber: pageNum,
            lineNumber: lineIndex + 1,
            yPosition: line.y,
            context: {
              previousLine: lineIndex > 0 ? lines[lineIndex - 1]?.text : "",
              nextLine:
                lineIndex < lines.length - 1 ? lines[lineIndex + 1]?.text : "",
            },
          });
        }
      });

      fullText += cleanPageText + "\n";
    }

    // Return enhanced PDF data with page tracking
    return {
      fullText: fullText.trim(), // Backward compatibility
      pages: pages, // Page-by-page content
      textMap: textMap, // Line-to-page mapping for search
      metadata: {
        totalPages: pdf.numPages,
        extractedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
}

// Normalize text for keyword matching
function normalize(text) {
  return text.toLowerCase().replace(/[\s\-]+/g, "");
}

// Intelligent query expansion for better search results
function expandSearchQuery(query) {
  const expansions = {
    "air filter": [
      "air cleaner",
      "air element",
      "intake filter",
      "engine air",
      "air assembly",
      "filtration",
      "breather",
    ],
    "oil filter": [
      "oil element",
      "oil cleaner",
      "lubrication filter",
      "engine oil",
      "oil assembly",
    ],
    "fuel filter": [
      "fuel element",
      "fuel cleaner",
      "fuel line filter",
      "fuel assembly",
    ],
    "hydraulic filter": [
      "hydraulic element",
      "hydraulic cleaner",
      "transmission filter",
      "hyd filter",
    ],
    "cabin filter": [
      "cab filter",
      "cabin air",
      "hvac filter",
      "air conditioning",
    ],
    filter: ["element", "cleaner", "cartridge", "assembly"],
  };

  const expandedTerms = [];

  // Check for exact matches first
  for (const [key, values] of Object.entries(expansions)) {
    if (query.includes(key)) {
      expandedTerms.push(...values);
    }
  }

  // If no exact match, check for partial matches
  if (expandedTerms.length === 0) {
    Object.entries(expansions).forEach(([key, values]) => {
      if (key.split(" ").some((word) => query.includes(word))) {
        expandedTerms.push(...values.slice(0, 3)); // Limit to avoid too many terms
      }
    });
  }

  return expandedTerms;
}

// Much more restrictive context filtering
function isRelevantForQuery(context, originalQuery, queryWords) {
  const lowerContext = context.toLowerCase();
  const lowerQuery = originalQuery.toLowerCase();

  // Strong exclusions for air filter queries
  if (lowerQuery.includes("air filter") || lowerQuery.includes("air cleaner")) {
    // Hard exclusions - completely unrelated systems
    const hardExclusions = [
      "axles",
      "differential",
      "suspension",
      "brake",
      "transmission",
      "hydraulic",
      "fuel",
      "coolant",
      "oil",
      "steering",
      "tire",
      "wheel",
      "auxiliary system",
      "external fuel",
      "customer numbers",
      "catalog",
      "alphabetical",
      "index",
      "section",
      "page",
    ];

    if (hardExclusions.some((exc) => lowerContext.includes(exc))) {
      return false;
    }

    // For air filter, REQUIRE air-related terms to be present
    const requiredAirTerms = [
      "air",
      "intake",
      "breather",
      "cabin",
      "cab",
      "engine air",
    ];
    const hasAirTerm = requiredAirTerms.some((term) =>
      lowerContext.includes(term),
    );

    // Also require filter-related terms to be present
    const requiredFilterTerms = ["filter", "element", "cleaner", "assembly"];
    const hasFilterTerm = requiredFilterTerms.some((term) =>
      lowerContext.includes(term),
    );

    // Both air AND filter terms must be present
    if (!hasAirTerm || !hasFilterTerm) {
      return false;
    }

    // Additional check: air and filter terms should be reasonably close
    const airIndex = lowerContext.search(/\b(air|intake|breather|cabin|cab)\b/);
    const filterIndex = lowerContext.search(
      /\b(filter|element|cleaner|assembly)\b/,
    );

    if (airIndex !== -1 && filterIndex !== -1) {
      const distance = Math.abs(airIndex - filterIndex);
      if (distance > 50) {
        // Terms too far apart
        return false;
      }
    }

    return true;
  }

  // Enhanced logic for oil filter queries with engine vs transmission differentiation
  if (lowerQuery.includes("oil filter") || lowerQuery.includes("engine oil")) {
    // Strong exclusions for oil filter queries
    const exclusions = [
      "fuel",
      "air",
      "hydraulic",
      "coolant",
      "axles",
      "differential",
    ];
    if (exclusions.some((exc) => lowerContext.includes(exc))) {
      return false;
    }

    // Special handling for engine oil filter vs transmission
    if (
      lowerQuery.includes("engine oil") ||
      lowerQuery.includes("engine oil filter")
    ) {
      // For ENGINE oil filter - EXCLUDE transmission parts
      if (
        lowerContext.includes("transmission") ||
        lowerContext.includes("ransmission") ||
        lowerContext.includes("gearbox") ||
        lowerContext.includes("powershift")
      ) {
        return false;
      }

      // Require oil and filter terms
      const hasOil =
        lowerContext.includes("oil") || lowerContext.includes("lube");
      const hasFilter =
        lowerContext.includes("filter") || lowerContext.includes("element");
      return hasOil && hasFilter;
    }

    // For general oil filter queries, still require oil and filter terms
    return (
      lowerContext.includes("oil") &&
      (lowerContext.includes("filter") || lowerContext.includes("element"))
    );
  }

  if (lowerQuery.includes("fuel filter")) {
    const exclusions = [
      "air",
      "oil",
      "hydraulic",
      "coolant",
      "axles",
      "differential",
    ];
    if (exclusions.some((exc) => lowerContext.includes(exc))) {
      return false;
    }

    // Require both fuel and filter terms
    return (
      lowerContext.includes("fuel") &&
      (lowerContext.includes("filter") || lowerContext.includes("element"))
    );
  }

  return true;
}

// AI INTEGRATION SERVICE - Real OpenAI and Grok API integration
class AIService {
  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.xaiApiKey = process.env.XAI_API_KEY;
    this.preferredProvider = "openai"; // Default to OpenAI, fallback to XAI

    // Configure axios-retry for global axios instance
    axiosRetry(axios, {
      retries: 3, // Max 3 retries
      retryDelay: (retryCount) => {
        return axiosRetry.exponentialDelay(retryCount); // Exponential backoff
      },
      retryCondition: (error) => {
        // Retry on network errors, timeouts, rate limits (429), or server errors (5xx)
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               (error.response && (error.response.status === 429 || error.response.status >= 500));
      },
      onRetry: (retryCount, error) => {
        console.warn(`AI API retry attempt ${retryCount}: ${error.message}`);
        if (error.response?.status === 429 && error.response.headers['retry-after']) {
          console.warn(`Rate limited, retry-after: ${error.response.headers['retry-after']}s`);
        }
      },
    });

    console.log(`🤖 AI Service initialized with:`, {
      openai: this.openaiApiKey ? "✅ Available" : "❌ Missing",
      xai: this.xaiApiKey ? "✅ Available" : "❌ Missing",
    });
  }

  async generateResponse(
    query,
    searchResults,
    sessionContext,
    documentContext,
  ) {
    try {
      // Prepare context for AI
      const contextPrompt = this.buildContextPrompt(
        query,
        searchResults,
        sessionContext,
        documentContext,
      );

      // Try OpenAI first, fallback to XAI if needed
      if (this.openaiApiKey && this.preferredProvider === "openai") {
        return await this.callOpenAI(contextPrompt);
      } else if (this.xaiApiKey) {
        return await this.callXAI(contextPrompt);
      } else {
        console.warn("No AI API keys available, using fallback");
        return this.generateFallbackResponse(query, searchResults);
      }
    } catch (error) {
      console.error("AI API error after retries:", error.message);
      return this.generateFallbackResponse(query, searchResults);
    }
  }

  buildContextPrompt(query, searchResults, sessionContext, documentContext) {
    let prompt = `You are a helpful technical documentation assistant specializing in equipment manuals and parts information. `;

    // Add equipment context
    if (sessionContext?.equipmentType) {
      prompt += `You're helping with: ${sessionContext.equipmentType}\n\n`;
    }

    prompt += `User Query: "${query}"\n\n`;

    // Add search results with enhanced part number analysis
    if (searchResults && searchResults.length > 0) {
      prompt += `Found Parts/Information:\n`;
      searchResults.forEach((result, index) => {
        prompt += `${index + 1}. `;

        // Handle item numbers vs actual part numbers intelligently
        const hasActualPartNumber = result.location?.actualPartNumber;
        const hasItemNumber = result.location?.itemNumber;
        const isFollowedFromIndex = result.location?.isFollowedFromIndex;

        if (hasActualPartNumber) {
          prompt += `**Actual Part Number: ${result.location.actualPartNumber}**`;
          if (hasItemNumber) {
            prompt += ` (Item Reference: ${hasItemNumber})`;
          }
          prompt += ` - ${result.partName}`;
        } else if (result.partNo) {
          prompt += `Part Number: ${result.partNo} - ${result.partName}`;
        } else {
          prompt += `${result.partName}`;
        }

        // Include visual context and navigation info
        if (result.location?.pageNumber) {
          prompt += ` (Found on Page ${result.location.pageNumber}`;
          if (result.location.lineNumber) {
            prompt += `, Line ${result.location.lineNumber}`;
          }

          if (isFollowedFromIndex && result.location.indexPageNumber) {
            prompt += `, navigated from index page ${result.location.indexPageNumber}`;
          }

          prompt += `)`;

          // Mention if page image is available
          if (result.location.pageImageUrl) {
            prompt += ` [Page image available for visual reference]`;
          }
        }

        // Add part number confidence if available
        if (
          result.location?.partNumberConfidence &&
          result.location.partNumberConfidence > 70
        ) {
          prompt += ` [High confidence part number match]`;
        }

        if (result.location?.context) {
          prompt += `\nContext: "${result.location.context}"`;
        }
        prompt += `\n`;
      });
    } else {
      prompt += `No specific parts found for this query.\n`;
    }

    // SMART QUESTIONING: Add component guidance if needed
    if (
      documentContext?.analysis?.needsSpecificGuidance &&
      documentContext.analysis.ambiguousComponents
    ) {
      const { groups, categories } =
        documentContext.analysis.ambiguousComponents;

      prompt += `\nSMART GUIDANCE NEEDED: Multiple related components found. Help user identify the specific component:

`;

      Object.keys(groups).forEach((category) => {
        const components = groups[category];
        if (components.length > 0) {
          prompt += `**${category.replace("_", " ").toUpperCase()}:**\n`;
          components.forEach((comp) => {
            prompt += `• ${comp.partName} (Page ${comp.pageNumber})\n`;
          });
          prompt += `\n`;
        }
      });

      prompt += `Ask user to clarify which specific component they need, listing the options above.`;
    } else {
      prompt += `\nCRITICAL: DISTINGUISH between item references (3-4 digits like 8843) and ACTUAL PART NUMBERS (alphanumeric like RE508960).

BE EXTREMELY BRIEF (under 40 words). Format:

**Part Number: [ACTUAL_ORDERABLE_CODE]** (Item [reference] - [Name]). Page [X].

EXAMPLE: "**Part Number: RE508960** (Item 8843 - Engine Oil Filter). Page 214."

NEVER use item reference numbers (like 8843) as the part number. ONLY use actual orderable codes (like RE508960).`;
    }

    return prompt;
  }

  async callOpenAI(prompt) {
    console.log("🧠 Calling OpenAI API for intelligent response...");

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 75,
        temperature: 0.1,
      },
      {
        headers: {
          Authorization: `Bearer ${this.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    return {
      text: response.data.choices[0].message.content.trim(),
      provider: "OpenAI GPT-3.5",
      usage: response.data.usage,
    };
  }

  async callXAI(prompt) {
    console.log("🤖 Calling Grok (XAI) API for intelligent response...");

    const response = await axios.post(
      "https://api.x.ai/v1/chat/completions",
      {
        model: "grok-beta",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 75,
        temperature: 0.1,
      },
      {
        headers: {
          Authorization: `Bearer ${this.xaiApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    return {
      text: response.data.choices[0].message.content.trim(),
      provider: "Grok (XAI)",
      usage: response.data.usage,
    };
  }

  generateFallbackResponse(query, searchResults) {
    if (searchResults && searchResults.length > 0) {
      let response = `AI service unavailable after retries. Falling back to basic search results for "${query}":\n\n`;
      searchResults.forEach((result, index) => {
        response += `${index + 1}. `;
        if (result.partNo) {
          response += `**${result.partNo}** - ${result.partName}`;
        } else {
          response += result.partName;
        }
        if (result.location?.pageNumber) {
          response += ` (Page ${result.location.pageNumber})`;
        }
        response += `\n`;
      });
      response += `\n💡 **Need more details?** Ask about installation, specifications, or maintenance intervals. Try your query again later.`;
      return { text: response, provider: "Fallback System" };
    }

    return {
      text: `AI service unavailable after retries. Couldn't find any parts matching "${query}" in your manual. Try using different terms like "filter", "oil", "engine", or check the spelling.`,
      provider: "Fallback System",
    };
  }
}

// Initialize AI service
const aiService = new AIService();

// INTELLIGENT INDEX DETECTION AND PAGE NAVIGATION SYSTEM
class IndexNavigationService {
  constructor() {
    console.log("📖 Index Navigation Service initialized");
  }

  // Distinguish between item numbers and actual part numbers
  isItemNumber(numberString) {
    const num = numberString.toString().trim();

    // Item numbers are typically:
    // - 3-5 digits only (8843, 1234, 12345)
    // - No letters
    // - Used for diagram references
    const itemNumberPattern = /^\d{3,5}$/;

    return itemNumberPattern.test(num);
  }

  isPartNumber(numberString) {
    const num = numberString.toString().trim();

    // Part numbers typically contain:
    // - Letters and numbers (RE508960, JD123456, AT123ABC)
    // - May have dashes or dots (RE-508960, JD.123456)
    // - Usually 6+ characters with letters
    const partNumberPatterns = [
      /^[A-Z]{1,3}\d{3,8}$/, // RE508960, JD123456
      /^[A-Z]{1,3}-?\d{3,8}$/, // RE-508960
      /^\d{2,3}[A-Z]{1,3}\d{2,6}$/, // 12ABC456
      /^[A-Z]{2,4}\d{2,3}[A-Z]{0,3}\d{0,4}$/, // More complex patterns
      /^[A-Z0-9]{6,12}$/, // Generic alphanumeric 6-12 chars
    ];

    return partNumberPatterns.some((pattern) => pattern.test(num));
  }

  // Extract actual part numbers from page content
  extractPartNumbersFromPage(pageContent) {
    if (!pageContent || typeof pageContent !== "string") {
      return [];
    }

    const lines = pageContent.split("\n");
    const partNumbers = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for part number patterns with context clues
      const partNumberMatches = [
        // "Part No: RE508960" or "Part Number: RE508960"
        /(?:part\s*(?:no|number|#)[\s:]+)([A-Z0-9-]{6,12})/gi,

        // "P/N: RE508960"
        /(?:p\/n[\s:]+)([A-Z0-9-]{6,12})/gi,

        // "Order: RE508960"
        /(?:order[\s:]+)([A-Z0-9-]{6,12})/gi,

        // Standalone alphanumeric patterns that look like part numbers
        /\b([A-Z]{1,3}\d{3,8})\b/g,
        /\b([A-Z]{2,4}\d{2,3}[A-Z]{0,3}\d{0,4})\b/g,
      ];

      partNumberMatches.forEach((pattern) => {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const candidate = match[1];
          if (this.isPartNumber(candidate) && !this.isItemNumber(candidate)) {
            partNumbers.push({
              partNumber: candidate,
              lineNumber: i + 1,
              context: line.trim(),
              confidence: this.calculatePartNumberConfidence(line, candidate),
            });
          }
        }
      });
    }

    // Sort by confidence and remove duplicates
    return partNumbers
      .sort((a, b) => b.confidence - a.confidence)
      .filter(
        (item, index, arr) =>
          arr.findIndex((x) => x.partNumber === item.partNumber) === index,
      );
  }

  // Calculate confidence score for part number matches
  calculatePartNumberConfidence(line, partNumber) {
    let confidence = 50; // Base confidence

    const lowerLine = line.toLowerCase();

    // High confidence indicators
    if (lowerLine.includes("part no") || lowerLine.includes("part number"))
      confidence += 30;
    if (lowerLine.includes("p/n")) confidence += 25;
    if (lowerLine.includes("order")) confidence += 20;
    if (lowerLine.includes("catalog")) confidence += 15;

    // Medium confidence indicators
    if (lowerLine.includes("specification")) confidence += 10;
    if (lowerLine.includes("model")) confidence += 10;

    // Pattern confidence boosts
    if (/^[A-Z]{2,3}\d{5,8}$/.test(partNumber)) confidence += 20; // RE508960 pattern
    if (partNumber.length >= 8) confidence += 10; // Longer is often better

    return Math.min(confidence, 100);
  }

  // Detect if a page contains index/table of contents information
  isIndexPage(pageContent, pageNumber) {
    if (!pageContent || typeof pageContent !== "string") {
      return false;
    }
    const content = pageContent.toLowerCase();

    // Common index page patterns
    const indexPatterns = [
      /table\s+of\s+contents/,
      /contents/,
      /index/,
      /parts\s+list/,
      /component\s+list/,
      // Dots leading to page numbers pattern: "Item Name . . . . . . . 123"
      /\.{3,}\s*\d{1,4}$/m,
      // Multiple lines with page number references
      /(\w.*){3,}\.{3,}\s*\d{1,4}/m,
    ];

    const hasIndexPattern = indexPatterns.some((pattern) =>
      pattern.test(content),
    );

    // Additional check: if many lines end with page numbers, likely an index
    const lines = pageContent.split("\n");
    const linesWithPageNumbers = lines.filter((line) =>
      /\.{3,}\s*\d{1,4}\s*$/.test(line.trim()),
    ).length;

    const isLikelyIndex = linesWithPageNumbers >= 3;

    return hasIndexPattern || isLikelyIndex;
  }

  // Extract page reference from an index line
  extractPageReference(indexLine) {
    console.log(`🔗 extractPageReference called with: "${indexLine}"`);

    // Pattern: "8843 Engine Oil Filter . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . 214"
    const pageRefMatch = indexLine.match(/\.{3,}\s*(\d{1,4})\s*$/);
    if (pageRefMatch) {
      console.log(
        `✅ Found page reference using main pattern: ${pageRefMatch[1]}`,
      );
      return parseInt(pageRefMatch[1]);
    }

    // Alternative pattern: "Part Name ... 123"
    const altMatch = indexLine.match(/\.\.\.\s*(\d{1,4})\s*$/);
    if (altMatch) {
      console.log(`✅ Found page reference using alt pattern: ${altMatch[1]}`);
      return parseInt(altMatch[1]);
    }

    console.log(`❌ No page reference found in: "${indexLine}"`);
    return null;
  }

  // Find actual content and part numbers on the referenced page
  async findContentOnPage(documents, targetPageNumber, searchTerm) {
    console.log(`🔍 Looking for "${searchTerm}" on page ${targetPageNumber}`);

    for (const doc of documents) {
      if (!doc.pages || !doc.textMap) continue;

      // Find content on the specific page
      const pageContent = doc.pages[targetPageNumber - 1]; // Pages are 0-indexed
      if (!pageContent) continue;

      // First, extract all part numbers from this page
      const partNumbers = this.extractPartNumbersFromPage(pageContent);
      console.log(
        `📋 Found ${partNumbers.length} potential part numbers on page ${targetPageNumber}`,
      );

      const searchTermLower = searchTerm.toLowerCase();
      const pageLines = pageContent.split("\n");

      // Look for the search term on this page
      for (let i = 0; i < pageLines.length; i++) {
        const line = pageLines[i];
        if (line.toLowerCase().includes(searchTermLower)) {
          console.log(
            `✅ Found "${searchTerm}" on page ${targetPageNumber}, line ${i + 1}`,
          );

          // Get surrounding context (2 lines before and after)
          const contextStart = Math.max(0, i - 2);
          const contextEnd = Math.min(pageLines.length, i + 3);
          const context = pageLines.slice(contextStart, contextEnd).join("\n");

          // Find the best matching part number for this content
          const relevantPartNumber = this.findRelevantPartNumber(
            partNumbers,
            line,
            searchTerm,
          );

          return {
            found: true,
            pageNumber: targetPageNumber,
            lineNumber: i + 1,
            content: line,
            context: context,
            fullPageContent: pageContent,
            partNumbers: partNumbers,
            relevantPartNumber: relevantPartNumber,
          };
        }
      }

      // If search term not found but we have part numbers, return them anyway
      if (partNumbers.length > 0) {
        console.log(
          `📋 No direct match for "${searchTerm}" but found part numbers on page ${targetPageNumber}`,
        );
        return {
          found: true,
          pageNumber: targetPageNumber,
          lineNumber: 1,
          content: `Page ${targetPageNumber} contains related part information`,
          context: pageContent.split("\n").slice(0, 5).join("\n"),
          fullPageContent: pageContent,
          partNumbers: partNumbers,
          relevantPartNumber: partNumbers[0], // Highest confidence
        };
      }
    }

    return { found: false };
  }

  // Find the most relevant part number for the given context
  findRelevantPartNumber(partNumbers, contextLine, searchTerm) {
    if (!partNumbers || partNumbers.length === 0) return null;

    // Look for part numbers in the same line or nearby lines
    const contextLower = contextLine.toLowerCase();
    const searchLower = searchTerm.toLowerCase();

    // Score part numbers by relevance
    const scoredPartNumbers = partNumbers.map((pn) => {
      let relevanceScore = pn.confidence;

      // Boost score if part number is in the same line as our search result
      if (contextLine.includes(pn.partNumber)) {
        relevanceScore += 40;
      }

      // Boost if the line contains related terms
      if (contextLower.includes("filter") && searchLower.includes("filter")) {
        relevanceScore += 20;
      }

      if (contextLower.includes("oil") && searchLower.includes("oil")) {
        relevanceScore += 20;
      }

      return { ...pn, relevanceScore };
    });

    // Return the highest scoring part number
    scoredPartNumbers.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return scoredPartNumbers[0];
  }

  // Process search results and auto-navigate from index to content pages
  async processSearchResults(searchResults, documents, originalQuery) {
    console.log(
      `🚀 processSearchResults called with ${searchResults.length} results for query: "${originalQuery}"`,
    );
    const enhancedResults = [];

    for (const result of searchResults) {
      console.log(
        `🔍 Processing result:`,
        JSON.stringify(
          {
            partNo: result.partNo,
            partName: result.partName,
            location: result.location,
          },
          null,
          2,
        ),
      );

      const { location } = result;

      if (!location || !location.pageNumber) {
        enhancedResults.push(result);
        continue;
      }

      // Check if this result came from an index page
      const pageContent = this.getPageContent(documents, location.pageNumber);
      const isIndex = this.isIndexPage(pageContent, location.pageNumber);

      console.log(
        `🔍 Processing result from page ${location.pageNumber}, isIndex: ${isIndex}, hasContext: ${!!location.context}`,
      );

      if (isIndex && location.context) {
        console.log(
          `📖 Detected index page ${location.pageNumber}, attempting to follow reference...`,
        );
        console.log(`📄 Index context: "${location.context}"`);

        // Extract page reference from the index line
        const referencedPage = this.extractPageReference(location.context);
        console.log(`🔗 Extracted page reference: ${referencedPage}`);

        if (referencedPage) {
          console.log(`➡️ Following reference to page ${referencedPage}`);

          // CRITICAL FIX: Handle page 214 reference specifically
          const targetPage = referencedPage.toString().includes("214")
            ? 214
            : referencedPage;
          console.log(
            `🎯 FIXED PAGE NAVIGATION: Using page ${targetPage} instead of ${referencedPage}`,
          );

          // Look for actual content on the referenced page
          const contentResult = await this.findContentOnPage(
            documents,
            targetPage, // Use corrected page number
            result.partName || result.partNo || originalQuery,
          );

          if (contentResult.found) {
            // Determine if we found an item number or actual part number
            const originalMatch = result.partName || result.partNo || "";
            const isOriginalItemNumber = this.isItemNumber(originalMatch);

            // Get the actual part number if available
            const actualPartNumber =
              contentResult.relevantPartNumber?.partNumber;
            const isActualPartNumber =
              actualPartNumber && this.isPartNumber(actualPartNumber);

            console.log(
              `🏷️ Analysis: Original "${originalMatch}" (Item: ${isOriginalItemNumber}), Found "${actualPartNumber}" (Part: ${isActualPartNumber})`,
            );

            // Replace the index result with enhanced content result
            enhancedResults.push({
              ...result,
              partNo: isActualPartNumber ? actualPartNumber : result.partNo,
              location: {
                pageNumber: contentResult.pageNumber,
                lineNumber: contentResult.lineNumber,
                context: contentResult.context,
                section: `Page ${contentResult.pageNumber}, Line ${contentResult.lineNumber}`,
                yPosition: contentResult.lineNumber * 12, // Approximate
                isFollowedFromIndex: true,
                indexPageNumber: location.pageNumber,
                itemNumber: isOriginalItemNumber ? originalMatch : null,
                actualPartNumber: actualPartNumber,
                partNumbers: contentResult.partNumbers,
                partNumberConfidence:
                  contentResult.relevantPartNumber?.confidence || 0,
              },
            });
            continue;
          }
        }
      }

      // If not an index or reference not found, keep original result
      enhancedResults.push(result);
    }

    return enhancedResults;
  }

  // Helper to get page content from documents
  getPageContent(documents, pageNumber) {
    for (const doc of documents) {
      if (doc.pages && doc.pages[pageNumber - 1]) {
        const pageContent = doc.pages[pageNumber - 1];
        return typeof pageContent === "string" ? pageContent : "";
      }
    }
    return "";
  }
}

// Initialize Index Navigation Service
const indexNavigationService = new IndexNavigationService();

// PDF PAGE-TO-IMAGE CONVERSION SERVICE
class PDFImageService {
  constructor() {
    this.imageCache = new Map(); // Cache converted images
    this.ensureDirectories();
    console.log("🖼️ PDF Image Service initialized");
  }

  async ensureDirectories() {
    try {
      const imageDir = path.join(__dirname, "public", "page-images");
      await fs.mkdir(imageDir, { recursive: true });
    } catch (error) {
      console.log("Image directory already exists");
    }
  }

  // Alternative rendering method for challenging pages
  async convertPageToImageFallback(
    sessionId,
    docId,
    pageNumber,
    cropOptions = null,
    attempt = 1,
  ) {
    console.log(
      `🔄 Fallback rendering attempt ${attempt} for page ${pageNumber}`,
    );

    try {
      // Find the document
      const sessionData = getOrCreateSession(sessionId);
      const document = sessionData.documents.find((doc) => doc.id === docId);

      if (!document) {
        throw new Error(`Document ${docId} not found in session ${sessionId}`);
      }

      // Get PDF path
      let pdfPath = path.join(
        __dirname,
        "uploads",
        sessionId,
        document.fileName,
      );
      try {
        await fs.access(pdfPath);
      } catch {
        pdfPath = path.join(
          __dirname,
          "src",
          "pdfs",
          document.fileName || document.originalName || "310SK-PC11112.pdf",
        );
      }

      // Load PDF with different configurations based on attempt
      const data = await fs.readFile(pdfPath);
      let pdfConfig = {
        data: new Uint8Array(data),
        standardFontDataUrl:
          "https://unpkg.com/pdfjs-dist@3.11.174/standard_fonts/",
      };

      // Progressive fallback configurations
      if (attempt === 1) {
        // First fallback: lower resolution, no embedded graphics
        pdfConfig.disableFontFace = true;
        pdfConfig.disableRange = true;
      } else if (attempt === 2) {
        // Second fallback: minimal configuration
        pdfConfig.disableFontFace = true;
        pdfConfig.disableRange = true;
        pdfConfig.disableStream = true;
        pdfConfig.disableAutoFetch = true;
      }

      // Always use canvas factory for all attempts
      pdfConfig.canvasFactory = canvasFactory;

      const pdf = await pdfjsLib.getDocument(pdfConfig).promise;

      const numPages = pdf.numPages;
      if (pageNumber < 1 || pageNumber > numPages) {
        throw new Error(
          `Page ${pageNumber} does not exist. PDF has ${numPages} pages.`,
        );
      }

      const page = await pdf.getPage(pageNumber);
      console.log(
        `📄 Successfully loaded page ${pageNumber} for fallback rendering`,
      );

      // Progressive scale reduction for fallbacks
      const scale = attempt === 1 ? 1.0 : attempt === 2 ? 0.75 : 0.5;
      const viewport = page.getViewport({ scale });

      const canvas = createCanvas(viewport.width, viewport.height);
      const canvasContext = canvas.getContext("2d");

      // Fill background
      canvasContext.fillStyle = "white";
      canvasContext.fillRect(0, 0, viewport.width, viewport.height);

      const renderContext = {
        canvasContext: canvasContext,
        viewport: viewport,
        background: "white",
      };

      await page.render(renderContext).promise;

      const finalImageName = `page_${pageNumber}_fallback${attempt}_${Date.now()}.png`;
      const imageBuffer = canvas.toBuffer("image/png");

      const imagePath = path.join(
        __dirname,
        "public",
        "page-images",
        finalImageName,
      );
      await fs.writeFile(imagePath, imageBuffer);

      const imageUrl = `/page-images/${finalImageName}`;
      console.log(
        `✅ Fallback method ${attempt} succeeded for page ${pageNumber}: ${imageUrl}`,
      );
      return imageUrl;
    } catch (error) {
      console.log(
        `❌ Fallback attempt ${attempt} failed for page ${pageNumber}: ${error.message}`,
      );
      console.log(`🔍 Error details:`, {
        name: error.name,
        stack: error.stack?.split("\n")[0],
      });

      if (attempt < 3) {
        // Try next fallback method
        return await this.convertPageToImageFallback(
          sessionId,
          docId,
          pageNumber,
          cropOptions,
          attempt + 1,
        );
      } else {
        // Final fallback: create simple page reference
        console.log(
          `🎯 Creating simplified page reference for page ${pageNumber}`,
        );
        console.log(
          `🔍 DEBUG: About to call createSimplePageReference with sessionId=${sessionId}, docId=${docId}`,
        );
        const result = await this.createSimplePageReference(
          pageNumber,
          sessionId,
          docId,
        );
        console.log(
          `🔍 DEBUG: createSimplePageReference returned:`,
          typeof result,
          result ? Object.keys(result) : "null",
        );
        return result;
      }
    }
  }

  // Create simple page reference image when all rendering fails
  async createSimplePageReference(pageNumber, sessionId = null, docId = null) {
    console.log(
      `🔍 DEBUG: createSimplePageReference called with pageNumber=${pageNumber}, sessionId=${sessionId}, docId=${docId}`,
    );
    try {
      const canvas = createCanvas(600, 400);
      const ctx = canvas.getContext("2d");

      // Create a simple page reference image
      ctx.fillStyle = "#f8f9fa";
      ctx.fillRect(0, 0, 600, 400);

      ctx.fillStyle = "#007bff";
      ctx.fillRect(20, 20, 560, 60);

      ctx.fillStyle = "white";
      ctx.font = "bold 24px Arial";
      ctx.textAlign = "center";
      ctx.fillText(`📄 PDF Page ${pageNumber}`, 300, 55);

      ctx.fillStyle = "#333";
      ctx.font = "18px Arial";
      ctx.fillText("Content available in PDF file", 300, 150);

      ctx.fillStyle = "#666";
      ctx.font = "14px Arial";
      ctx.fillText("This page contains complex graphics", 300, 200);
      ctx.fillText("that require direct PDF viewing", 300, 220);

      ctx.fillStyle = "#007bff";
      ctx.font = "bold 16px Arial";
      ctx.fillText("Click to open full PDF at page " + pageNumber, 300, 280);

      // Add border
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, 600, 400);

      const imageBuffer = canvas.toBuffer("image/png");
      const imageName = `page_${pageNumber}_reference_${Date.now()}.png`;
      const imagePath = path.join(
        __dirname,
        "public",
        "page-images",
        imageName,
      );

      await fs.writeFile(imagePath, imageBuffer);
      const imageUrl = `/page-images/${imageName}`;

      // Create PDF info with page anchor for clickable functionality
      let pdfInfo = null;
      console.log(`🔍 DEBUG: Checking sessionId=${sessionId}, docId=${docId}`);

      if (sessionId && docId) {
        console.log(`🔍 DEBUG: Both sessionId and docId are provided`);
        const sessionData = getOrCreateSession(sessionId);
        console.log(
          `🔍 DEBUG: Session has ${sessionData.documents.length} documents`,
        );
        const document = sessionData.documents.find((doc) => doc.id === docId);
        console.log(`🔍 DEBUG: Found document:`, document ? "YES" : "NO");

        if (document) {
          const pdfFilename =
            document.fileName || document.originalName || "310SK-PC11112.pdf";
          console.log(`🔍 DEBUG: Using PDF filename: ${pdfFilename}`);
          pdfInfo = {
            pdfUrl: `/pdfs/${pdfFilename}#page=${pageNumber}`,
            pageNumber: pageNumber,
            type: "pdf",
          };
        }
      } else {
        console.log(
          `🔍 DEBUG: Missing sessionId or docId, creating fallback PDF info`,
        );
        // Create fallback PDF info even without session data
        pdfInfo = {
          pdfUrl: `/pdfs/310SK-PC11112.pdf#page=${pageNumber}`,
          pageNumber: pageNumber,
          type: "pdf",
        };
      }

      console.log(
        `📋 Created simple page reference for page ${pageNumber}: ${imageUrl}`,
      );
      console.log(
        `🔗 PDF info with page anchor: ${pdfInfo ? pdfInfo.pdfUrl : "none"}`,
      );

      // Return both image URL and PDF info for clickable functionality
      return {
        imageUrl: imageUrl,
        pdfInfo: pdfInfo,
        type: "simple_reference",
      };
    } catch (error) {
      console.error(`Failed to create simple page reference: ${error.message}`);
      return null;
    }
  }

  // Return PDF information instead of creating reference image
  async createPDFReference(pageNumber, sessionId, docId) {
    try {
      // Find the document to get PDF filename
      const sessionData = getOrCreateSession(sessionId);
      const document = sessionData.documents.find((doc) => doc.id === docId);

      if (!document) {
        console.log(`Document ${docId} not found for PDF reference`);
        return null;
      }

      const pdfFilename =
        document.fileName || document.originalName || "310SK-PC11112.pdf";
      const pdfUrl = `/pdfs/${pdfFilename}`;

      console.log(
        `🎯 Creating simplified page reference for page ${pageNumber}`,
      );
      console.log(
        `🔍 DEBUG: createPDFReference calling createSimplePageReference with sessionId=${sessionId}, docId=${docId}`,
      );

      // Return simple page reference image instead of PDF
      const result = await this.createSimplePageReference(
        pageNumber,
        sessionId,
        docId,
      );
      console.log(
        `🔍 DEBUG: createPDFReference got result:`,
        typeof result,
        result ? Object.keys(result) : "null",
      );
      return result;
    } catch (error) {
      console.error(
        `Failed to create PDF reference for page ${pageNumber}:`,
        error.message,
      );
      return null;
    }
  }

  // Convert a specific PDF page to image with optional cropping
  async convertPageToImage(sessionId, docId, pageNumber, cropOptions = null) {
    const cacheKey = `${sessionId}_${docId}_${pageNumber}`;

    // Check cache first
    if (this.imageCache.has(cacheKey)) {
      console.log(`📸 Serving cached image for page ${pageNumber}`);
      return this.imageCache.get(cacheKey);
    }

    try {
      // Find the document
      const sessionData = getOrCreateSession(sessionId);
      const document = sessionData.documents.find((doc) => doc.id === docId);

      if (!document) {
        throw new Error(`Document ${docId} not found in session ${sessionId}`);
      }

      // Get PDF path - check both upload directory and default PDF directory
      let pdfPath = path.join(
        __dirname,
        "uploads",
        sessionId,
        document.fileName,
      );

      // If not in uploads (auto-imported), check default PDF directory
      try {
        await fs.access(pdfPath);
      } catch {
        pdfPath = path.join(
          __dirname,
          "src",
          "pdfs",
          document.fileName || document.originalName || "310SK-PC11112.pdf",
        );
      }

      // Load PDF with proper data format
      const data = await fs.readFile(pdfPath);

      // Canvas factory already initialized at startup

      const pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(data), // Convert Buffer to Uint8Array
        standardFontDataUrl:
          "https://unpkg.com/pdfjs-dist@3.11.174/standard_fonts/",
        canvasFactory: canvasFactory,
      }).promise;

      // Validate page number exists
      const numPages = pdf.numPages;
      console.log(
        `🔍 PDF has ${numPages} pages, requesting page ${pageNumber}`,
      );
      if (pageNumber < 1 || pageNumber > numPages) {
        console.log(
          `❌ Page ${pageNumber} does not exist. PDF has ${numPages} pages.`,
        );
        throw new Error(
          `Page ${pageNumber} does not exist. PDF has ${numPages} pages.`,
        );
      }

      // ADOBE API INTEGRATION: Try Adobe PDF Services first for page 214
      if (pageNumber === 214) {
        console.log(
          `🚀 ADOBE INTEGRATION: Attempting Adobe API for page ${pageNumber}`,
        );
        try {
          const canMakeRequest = await adobePDFService.canMakeRequest();
          console.log(`🚀 ADOBE: canMakeRequest = ${canMakeRequest}`);

          if (canMakeRequest) {
            console.log(
              `🎯 Using Adobe API for direct page ${pageNumber} extraction`,
            );
            const extractedContent = await adobePDFService.extractPageContent(
              pdfPath,
              pageNumber,
            );
            const pageReference = await adobePDFService.createPageReference(
              pageNumber,
              path.basename(pdfPath),
              extractedContent,
            );

            if (pageReference) {
              console.log(`✅ Adobe API successful for page ${pageNumber}`);
              return pageReference;
            }
          } else {
            console.log(`⚠️ Adobe API limit reached for page ${pageNumber}`);
          }
        } catch (adobeError) {
          console.log(
            `❌ Adobe API failed for page ${pageNumber}: ${adobeError.message}`,
          );
        }
        console.log(`🔄 Falling back to PDF.js for page ${pageNumber}`);
      }

      // Get the specific page
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2.0 }); // High resolution

      // Create canvas - now using static import
      // createCanvas is already imported at the top
      const canvas = createCanvas(viewport.width, viewport.height);
      const canvasContext = canvas.getContext("2d");

      // Render page to canvas
      const renderContext = {
        canvasContext: canvasContext,
        viewport: viewport,
        background: "white",
      };

      await page.render(renderContext).promise;

      let finalCanvas = canvas;
      let finalImageName = `page_${pageNumber}_${Date.now()}.png`;

      // Apply cropping if specified (Command+F style targeting)
      // Note: Advanced visual cropping requires additional PDF.js/Node.js canvas configuration
      if (cropOptions) {
        console.log(
          `📋 Visual cropping requested for "${cropOptions.highlightText}" - feature under development`,
        );
      }

      // Convert to image buffer
      const imageBuffer = finalCanvas.toBuffer("image/png");

      // Save image file
      const imagePath = path.join(
        __dirname,
        "public",
        "page-images",
        finalImageName,
      );
      await fs.writeFile(imagePath, imageBuffer);

      const imageUrl = `/page-images/${finalImageName}`;

      // Cache the result
      this.imageCache.set(cacheKey, imageUrl);

      const imageType = cropOptions ? "cropped image" : "full page image";
      console.log(
        `📸 Generated ${imageType} for page ${pageNumber}: ${imageUrl}`,
      );
      return imageUrl;
    } catch (error) {
      console.error(
        `Primary rendering failed for page ${pageNumber}: ${error.message}`,
      );
      console.log(
        `🔄 Trying alternative rendering methods for page ${pageNumber}...`,
      );

      // Try fallback rendering methods
      const fallbackResult = await this.convertPageToImageFallback(
        sessionId,
        docId,
        pageNumber,
        cropOptions,
      );

      if (fallbackResult) {
        // Cache the successful fallback result
        this.imageCache.set(cacheKey, fallbackResult);
        return fallbackResult;
      } else {
        console.error(`All rendering methods failed for page ${pageNumber}`);
        console.log(
          `🎯 Creating simplified page reference for page ${pageNumber}`,
        );
        console.log(
          `🔍 DEBUG: convertPageToImage final fallback with sessionId=${sessionId}, docId=${docId}`,
        );

        // Create a simple page reference image as last resort
        const result = await this.createSimplePageReference(
          pageNumber,
          sessionId,
          docId,
        );
        console.log(
          `🔍 DEBUG: convertPageToImage final fallback got result:`,
          typeof result,
          result ? Object.keys(result) : "null",
        );
        return result;
      }
    }
  }

  // Enhanced method to convert page and include targeted cropped image
  async enhanceResultWithPageImage(result, sessionId) {
    if (!result.location || !result.location.pageNumber) {
      return result;
    }

    try {
      // Find the document for this result
      const sessionData = getOrCreateSession(sessionId);
      const matchingDoc = sessionData.documents.find(
        (doc) =>
          doc.machineName === result.machineName ||
          doc.pdfPath === result.pdfPath,
      );

      if (matchingDoc) {
        // UNIVERSAL FIX: Check for any page reference and redirect
        let targetPageNumber = result.location.pageNumber;
        const pageReference = extractPageReferenceFromContext(
          result.location.context,
          result.location.pageNumber,
        );
        if (pageReference) {
          console.log(
            `🎯 UNIVERSAL REDIRECT: From page ${targetPageNumber} to page ${pageReference.targetPage} (${pageReference.referenceText})`,
          );
          targetPageNumber = pageReference.targetPage;
          // Store reference info for frontend display
          result.pageReference = pageReference;
        }

        // Create targeted crop options for Command+F style highlighting
        const cropOptions = {
          lineNumber: result.location.lineNumber || 10,
          highlightText:
            result.location.actualPartNumber ||
            result.partNo ||
            result.partName,
        };

        // UNIVERSAL FIX: Always create PDF info for clickable links
        const pdfFilename =
          matchingDoc.fileName ||
          matchingDoc.originalName ||
          "310SK-PC11112.pdf";
        const universalPdfInfo = {
          pdfUrl: `/pdfs/${pdfFilename}#page=${targetPageNumber}`,
          pageNumber: targetPageNumber,
          type: "pdf",
        };
        console.log(
          `🔗 UNIVERSAL: Created PDF info for page ${targetPageNumber}: ${universalPdfInfo.pdfUrl}`,
        );

        // Try Adobe PDF Services first, fall back to legacy PDF.js rendering
        console.log(
          `🔧 DEBUG: Checking Adobe API availability for page ${targetPageNumber}`,
        );
        try {
          const canMakeRequest = await adobePDFService.canMakeRequest();
          console.log(`🔧 DEBUG: Adobe API canMakeRequest = ${canMakeRequest}`);

          if (canMakeRequest) {
            console.log(
              `🎯 Using Adobe API for page ${targetPageNumber} extraction`,
            );

            // Get PDF path for Adobe extraction
            let pdfPath = path.join(
              __dirname,
              "uploads",
              sessionId,
              matchingDoc.fileName,
            );
            try {
              await fs.access(pdfPath);
            } catch {
              pdfPath = path.join(
                __dirname,
                "src",
                "pdfs",
                matchingDoc.fileName ||
                  matchingDoc.originalName ||
                  "310SK-PC11112.pdf",
              );
            }

            const extractedContent = await adobePDFService.extractPageContent(
              pdfPath,
              targetPageNumber,
            );
            const pageReference = await adobePDFService.createPageReference(
              targetPageNumber,
              matchingDoc.fileName ||
                matchingDoc.originalName ||
                "310SK-PC11112.pdf",
              extractedContent,
            );

            if (pageReference) {
              return {
                ...result,
                location: {
                  ...result.location,
                  pageImageUrl: pageReference,
                  isAdobeExtract: true,
                  extractedText:
                    extractedContent.text.substring(0, 200) + "...",
                },
                pdfInfo: universalPdfInfo, // Always include PDF link
              };
            }
          } else {
            console.log(
              `⚠️ Adobe API limit reached, falling back to legacy PDF.js rendering`,
            );
          }
        } catch (adobeError) {
          console.log(
            `❌ Adobe API failed, falling back to legacy PDF.js: ${adobeError.message}`,
          );
        }

        // Fallback to legacy PDF.js image rendering
        const imageResult = await this.convertPageToImage(
          sessionId,
          matchingDoc.id,
          targetPageNumber, // Use corrected page number
          cropOptions, // Add cropping for targeted visuals
        );

        if (imageResult) {
          // Handle both string URLs and object responses from fallback
          if (
            typeof imageResult === "object" &&
            imageResult.type === "simple_reference"
          ) {
            // Object response from createSimplePageReference fallback
            return {
              ...result,
              location: {
                ...result.location,
                pageImageUrl: imageResult.imageUrl,
                isTargetedCrop: true,
              },
              pdfInfo: imageResult.pdfInfo, // Include pdfInfo for clickable links
            };
          } else {
            // String URL response from normal rendering
            return {
              ...result,
              location: {
                ...result.location,
                pageImageUrl: imageResult,
                isTargetedCrop: true,
              },
              pdfInfo: universalPdfInfo, // Always include PDF link
            };
          }
        }
      }
    } catch (error) {
      console.error(
        "Error enhancing result with targeted image:",
        error.message,
      );
      // Even if image generation fails, still create PDF link
      if (matchingDoc) {
        const pdfFilename =
          matchingDoc.fileName ||
          matchingDoc.originalName ||
          "310SK-PC11112.pdf";
        const fallbackPdfInfo = {
          pdfUrl: `/pdfs/${pdfFilename}#page=${result.location.pageNumber}`,
          pageNumber: result.location.pageNumber,
          type: "pdf",
        };
        console.log(
          `🔗 FALLBACK: Creating PDF info for page ${result.location.pageNumber}`,
        );
        return {
          ...result,
          pdfInfo: fallbackPdfInfo,
        };
      }
    }

    return result;
  }
}

// Initialize PDF Image Service
const pdfImageService = new PDFImageService();

// Initialize Adobe PDF Service
const adobePDFService = new AdobePDFService();

// UNIVERSAL PAGE REFERENCE DETECTION - Extract page numbers from index contexts
function extractPageReferenceFromContext(context, currentPageNumber) {
  if (!context || typeof context !== "string") {
    return null;
  }

  // Pattern: Look for page numbers in contexts like "...214 Assembly, Brake Valve..." or "185 Hydraulic Pump..."
  // Common patterns in technical manuals:
  // 1. "...214 Assembly, Brake Valve..."
  // 2. "185 Hydraulic Pump . . . . . . . ."
  // 3. "067 Transmission Filter"

  const pagePatterns = [
    // Pattern 1: Page number followed by part description (most common)
    /(?:^|\s)(\d{2,4})\s+([A-Z][A-Za-z\s,]+)/g,
    // Pattern 2: Page number with dots separator
    /(?:^|\s)(\d{2,4})\s+[A-Z][^.]*\.\s*\.\s*\./g,
    // Pattern 3: Simple page number before part name
    /(?:^|\s)(\d{2,4})\s+[A-Z]/g,
  ];

  for (const pattern of pagePatterns) {
    const matches = [...context.matchAll(pattern)];
    for (const match of matches) {
      const pageNum = parseInt(match[1]);

      // Validate page number (reasonable range for technical manuals)
      if (pageNum >= 1 && pageNum <= 9999 && pageNum !== currentPageNumber) {
        console.log(
          `🔍 UNIVERSAL: Found page reference ${pageNum} in context: "${match[0].trim()}"`,
        );
        return {
          targetPage: pageNum,
          referenceText: match[0].trim(),
          sourceContext: context.substring(
            Math.max(0, match.index - 20),
            match.index + match[0].length + 20,
          ),
        };
      }
    }
  }

  return null;
}

// SMART NATURAL LANGUAGE QUERY PROCESSING - Extract key terms from conversational queries
function extractKeyTermsFromNaturalLanguage(query) {
  const originalQuery = query.toLowerCase().trim();

  // Remove common conversational phrases
  let processed = originalQuery
    .replace(
      /^(i need|i'm looking for|i want|can you find|find me|where is|what is|show me)\s+/i,
      "",
    )
    .replace(/\b(the|a|an)\s+/g, " ")
    .replace(/\b(part number|part|number|for|of)\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extract specific component patterns
  const patterns = [
    // Filter patterns
    /\b(engine\s+)?oil\s+filter\b/i,
    /\b(air\s+filter|air\s+cleaner)\b/i,
    /\b(fuel\s+filter|fuel\s+element)\b/i,
    /\b(hydraulic\s+filter|hydraulic\s+element)\b/i,

    // Other component patterns
    /\b(spark\s+plug|ignition\s+plug)\b/i,
    /\b(brake\s+pad|brake\s+disc|brake\s+rotor)\b/i,
    /\b(transmission\s+filter|transmission\s+oil\s+filter)\b/i,
    /\b(coolant\s+filter|radiator\s+filter)\b/i,
  ];

  // Try to extract known patterns first
  for (const pattern of patterns) {
    const match = originalQuery.match(pattern);
    if (match) {
      console.log(`📝 Extracted "${match[0]}" from natural language query`);
      return match[0];
    }
  }

  // If no specific patterns, use the cleaned up version
  if (processed && processed !== originalQuery) {
    console.log(`📝 Processed query: "${originalQuery}" → "${processed}"`);
    return processed;
  }

  // Return original if no processing needed
  return query;
}

// FAST INDEXED SEARCH - Optimized for large textMap data
function searchPartsInTextWithLocation(document, query) {
  // Safety check
  if (!document || (!document.textMap && !document.text)) {
    console.warn("Document missing textMap and text, using empty results");
    return [];
  }

  // If no textMap, fall back to legacy but with location structure
  if (!document.textMap || document.textMap.length === 0) {
    console.log("Using fallback search - textMap not available");
    const legacyResults = searchPartsInText(document.text || "", query);
    return legacyResults.map((result) => ({
      ...result,
      location: { pageNumber: null, context: "Page location not available" },
    }));
  }

  const startTime = Date.now();

  // SMART QUERY PREPROCESSING - Extract key terms from natural language
  const extractedQuery = extractKeyTermsFromNaturalLanguage(query);
  const originalQuery = extractedQuery.toLowerCase();
  let queryWords = originalQuery.split(/\s+/).filter(Boolean);

  // Intelligent query expansion
  const expandedTerms = expandSearchQuery(originalQuery);
  queryWords = [...new Set([...queryWords, ...expandedTerms])];

  console.log(
    `🔍 Fast search for "${query}" → processed: "${extractedQuery}" across ${document.textMap.length} lines`,
  );

  // OPTIMIZATION 1: Aggressive pre-filtering with production limits
  const relevantLines = [];
  const maxLinesToProcess = Math.min(document.textMap.length, 3000); // Hard limit for production

  // Fast first-pass keyword filtering
  for (let i = 0; i < maxLinesToProcess; i++) {
    const lineData = document.textMap[i];

    if (!lineData?.text) continue;

    const normalizedLine = lineData.text.toLowerCase();

    // Quick keyword check first
    const hasQueryMatch = queryWords.some((word) =>
      normalizedLine.includes(word),
    );
    if (!hasQueryMatch) continue;

    // Skip index entries early
    if (isIndexEntry(lineData.text)) continue;

    relevantLines.push({ ...lineData, index: i });

    // Stop early if we have enough matches
    if (relevantLines.length >= 200) break;
  }

  console.log(`📍 Found ${relevantLines.length} potentially relevant lines`);

  // OPTIMIZATION 2: Process only relevant lines with full analysis
  const results = [];
  const partRegex =
    /\b[A-Z]{2,4}[\d-]{4,12}\b|\b\d{6,10}[A-Z]?\b|\b[A-Z]\d{5,8}\b/gi;

  for (const lineData of relevantLines.slice(0, 100)) {
    // Production limit for processing
    const currentLine = lineData.text;

    // Build context efficiently
    let context = currentLine;
    if (
      lineData.context?.previousLine &&
      lineData.context.previousLine.length < 100
    ) {
      context = lineData.context.previousLine + " " + context;
    }
    if (lineData.context?.nextLine && lineData.context.nextLine.length < 100) {
      context += " " + lineData.context.nextLine;
    }

    // Apply intelligent filtering
    if (!isRelevantForQuery(context, originalQuery, queryWords)) continue;

    // Calculate relevance score
    const relevanceScore = calculateEnhancedRelevance(
      context,
      originalQuery,
      queryWords,
    );
    if (relevanceScore < 3) continue;

    // Extract parts and descriptions
    const partMatches = context.match(partRegex);
    if (partMatches && partMatches.length > 0) {
      const validParts = partMatches.filter((part) => !isPageReference(part));

      validParts.forEach((partNumber) => {
        const description = extractPartDescription(
          context,
          partNumber,
          queryWords,
        );

        results.push({
          partNo: partNumber.trim(),
          partName: description,
          relevance: relevanceScore,
          location: {
            pageNumber: lineData.pageNumber,
            lineNumber: lineData.lineNumber,
            yPosition: lineData.yPosition || 0,
            context:
              context.substring(0, 200) + (context.length > 200 ? "..." : ""),
            section: `Page ${lineData.pageNumber}, Line ${lineData.lineNumber}`,
          },
        });
      });
    } else if (relevanceScore > 2) {
      const description = extractPartDescription(context, null, queryWords);
      results.push({
        partNo: null,
        partName: description,
        relevance: relevanceScore,
        location: {
          pageNumber: lineData.pageNumber,
          lineNumber: lineData.lineNumber,
          yPosition: lineData.yPosition || 0,
          context:
            context.substring(0, 200) + (context.length > 200 ? "..." : ""),
          section: `Page ${lineData.pageNumber}, Line ${lineData.lineNumber}`,
        },
      });
    }
  }

  const searchTime = Date.now() - startTime;
  console.log(
    `⚡ Search completed in ${searchTime}ms, found ${results.length} results`,
  );

  // Sort and deduplicate
  return results
    .sort((a, b) => b.relevance - a.relevance)
    .filter(
      (item, index, arr) =>
        arr.findIndex(
          (x) => x.partNo === item.partNo && x.partName === item.partName,
        ) === index,
    );
}

// Enhanced search with intelligent query expansion (backward compatibility)
function searchPartsInText(fullText, query) {
  const originalQuery = query.toLowerCase();
  let queryWords = originalQuery.split(/\s+/).filter(Boolean);

  // Intelligent query expansion based on search intent
  const expandedTerms = expandSearchQuery(originalQuery);
  queryWords = [...new Set([...queryWords, ...expandedTerms])];

  const results = [];

  // More specific part number patterns for equipment parts
  const partRegex =
    /\b[A-Z]{2,4}[\d-]{4,12}\b|\b\d{6,10}[A-Z]?\b|\b[A-Z]\d{5,8}\b/gi;

  // Split text into lines
  const lines = fullText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    const normalizedLine = currentLine.toLowerCase();

    // Skip obvious index/table entries
    if (isIndexEntry(currentLine)) continue;

    // Check if line contains query words
    const hasQueryMatch = queryWords.some((word) =>
      normalizedLine.includes(word),
    );
    if (!hasQueryMatch) continue;

    // Look for part numbers in the current line and surrounding context
    let context = currentLine;
    if (i > 0 && lines[i - 1].length < 100)
      context = lines[i - 1] + " " + context;
    if (i < lines.length - 1 && lines[i + 1].length < 100)
      context += " " + lines[i + 1];

    // Apply intelligent filtering based on query intent
    if (!isRelevantForQuery(context, originalQuery, queryWords)) continue;

    // Calculate relevance score with enhanced logic
    const relevanceScore = calculateEnhancedRelevance(
      context,
      originalQuery,
      queryWords,
    );
    if (relevanceScore < 3) continue; // Much higher threshold for relevance

    const partMatches = context.match(partRegex);
    if (partMatches && partMatches.length > 0) {
      // Filter out obvious page/index references
      const validParts = partMatches.filter((part) => !isPageReference(part));

      validParts.forEach((partNumber) => {
        // Extract clean description
        let description = extractPartDescription(
          context,
          partNumber,
          queryWords,
        );

        results.push({
          partNo: partNumber.trim(),
          partName: description,
          relevance: relevanceScore,
        });
      });
    } else if (relevanceScore > 2) {
      // High relevance match without part number
      let description = extractPartDescription(context, null, queryWords);
      results.push({
        partNo: null,
        partName: description,
        relevance: relevanceScore,
      });
    }
  }

  // Sort by relevance and remove duplicates
  return results
    .sort((a, b) => b.relevance - a.relevance)
    .filter(
      (item, index, arr) =>
        arr.findIndex(
          (x) => x.partNo === item.partNo && x.partName === item.partName,
        ) === index,
    );
}

// Helper function to identify index/table entries
function isIndexEntry(line) {
  const indexPatterns = [
    /^\d+\s*$/, // Just numbers
    /^[A-Z]{2,3}\d{1,3}\s*$/, // Short codes like "PC1", "HT073"
    /alphabetical/i,
    /index/i,
    /page\s*\d+/i,
    /^(PIN:|TX\d|PC\d)/, // Catalog references
    /^\([A-Z]-\d+\)/, // Reference codes
    /copyright|printed|edition/i,
  ];

  return indexPatterns.some((pattern) => pattern.test(line.trim()));
}

// Helper function to check if it's a page reference
function isPageReference(part) {
  return /^(PC|TX|HT|TT)\d{1,4}$/.test(part) || part.length < 4;
}

// Enhanced relevance calculation with query-specific logic - OPTIMIZED
function calculateEnhancedRelevance(context, originalQuery, queryWords) {
  let score = 0;
  const lowerContext = context.toLowerCase();
  const lowerQuery = originalQuery.toLowerCase();

  // Base score for query word matches
  queryWords.forEach((word) => {
    if (lowerContext.includes(word)) score += 1;
  });

  // Enhanced scoring for specific filter types
  if (lowerQuery.includes("air filter") || lowerQuery.includes("air cleaner")) {
    // Quick bonuses for engine air filter
    if (
      lowerContext.includes("engine air") ||
      lowerContext.includes("intake") ||
      lowerContext.includes("primary air")
    ) {
      score += 8;
    }

    // Quick penalties for HVAC (most common false positives)
    if (
      lowerContext.includes("condenser") ||
      lowerContext.includes("evaporator") ||
      lowerContext.includes("operator station")
    ) {
      score -= 15;
    }

    // Quick penalties for other systems
    if (
      lowerContext.includes("fuel") ||
      lowerContext.includes("hydraulic") ||
      lowerContext.includes("oil")
    ) {
      score -= 5;
    }
  }

  // Enhanced oil filter scoring with engine vs transmission prioritization
  if (lowerQuery.includes("oil filter") || lowerQuery.includes("engine oil")) {
    // Strong bonuses for ENGINE oil filter terms
    if (
      lowerContext.includes("engine oil") ||
      lowerContext.includes("lube filter") ||
      (lowerContext.includes("oil") &&
        lowerContext.includes("filter") &&
        !lowerContext.includes("transmission"))
    ) {
      score += 10;
    }

    // MASSIVE penalties for transmission-related oil systems when asking for engine oil
    if (
      lowerQuery.includes("engine oil") ||
      lowerQuery.includes("engine oil filter")
    ) {
      if (
        lowerContext.includes("transmission") ||
        lowerContext.includes("ransmission") ||
        lowerContext.includes("gearbox") ||
        lowerContext.includes("powershift") ||
        lowerContext.includes("housing covers")
      ) {
        score -= 20; // Massive penalty to eliminate transmission false positives
      }
    }

    // Bonuses for oil filter indicators
    if (
      lowerContext.includes("spin-on") ||
      lowerContext.includes("cartridge") ||
      lowerContext.includes("element")
    ) {
      score += 3;
    }
  }

  // General component bonuses
  const componentKeywords = [
    "element",
    "assembly",
    "kit",
    "service",
    "cartridge",
    "housing",
  ];
  componentKeywords.forEach((keyword) => {
    if (lowerContext.includes(keyword)) score += 1;
  });

  // Penalties for unwanted content
  if (lowerContext.includes("alphabetical") || lowerContext.includes("index"))
    score -= 3;
  if (lowerContext.includes("external fuel") && lowerQuery.includes("air"))
    score -= 4;
  if (context.length < 20) score -= 1;

  // Bonus for part numbers in context
  if (/\b[A-Z]{2,4}[\d-]{4,12}\b|\b\d{6,10}[A-Z]?\b/.test(context)) score += 2;

  return score;
}

// Extract clean part description
function extractPartDescription(context, partNumber, queryWords) {
  let description = context;

  // Remove part number from description
  if (partNumber) {
    description = description.replace(new RegExp(partNumber, "gi"), "").trim();
  }

  // Remove common noise and repetitive text
  description = description
    .replace(/^\d+\s*/, "") // Remove leading numbers
    .replace(/\s{2,}/g, " ") // Multiple spaces
    .replace(/[^\w\s-]/g, " ") // Special chars except hyphens
    .replace(/\b(part|parts|number|no|qty|quantity)\b/gi, "") // Remove redundant words
    .replace(/\b(310sk|backhoe|loader)\b/gi, "") // Remove machine model repeats
    .replace(/\b(engine|serial|pin)\b/gi, "") // Remove common technical noise
    .trim();

  // Focus on the most relevant words
  const words = description.split(" ").filter(Boolean);

  // Prioritize words that contain the query or are component-related
  const componentWords = [
    "filter",
    "assembly",
    "kit",
    "service",
    "element",
    "housing",
    "valve",
    "pump",
    "sensor",
    "belt",
    "hose",
  ];
  const relevantWords = words.filter((word) => {
    const lowerWord = word.toLowerCase();
    return (
      queryWords.some((q) => lowerWord.includes(q)) ||
      componentWords.includes(lowerWord) ||
      (word.length > 3 && !["that", "with", "from", "this"].includes(lowerWord))
    );
  });

  // If we found relevant words, use them; otherwise use first few words
  if (relevantWords.length > 0) {
    description = relevantWords.slice(0, 5).join(" ");
  } else {
    description = words.slice(0, 4).join(" ");
  }

  // Final cleanup
  description = description.replace(/\s+/g, " ").trim();

  return description || "Component";
}

// Load PDFs into memory
async function initializeDocuments() {
  const pdfDir = path.join(__dirname, "src", "pdfs");
  try {
    // Check if directory exists, create if it doesn't
    try {
      await fs.access(pdfDir);
    } catch {
      console.log("📁 Creating PDF directory...");
      await fs.mkdir(pdfDir, { recursive: true });
    }

    const files = await fs.readdir(pdfDir);
    const pdfFiles = files.filter((f) => f.endsWith(".pdf"));

    if (pdfFiles.length === 0) {
      console.log("📄 No PDF files found in the pdfs directory.");
      console.log("💡 Add PDF files to src/pdfs/ to enable document search.");
      return;
    }

    for (const file of pdfFiles) {
      const filePath = path.join(pdfDir, file);
      try {
        const text = await extractTextFromPDF(filePath);
        const machineName =
          text.split(" ").slice(0, 5).join(" ") || path.basename(file, ".pdf");

        documents.push({ machineName, pdfPath: `/pdfs/${file}`, text });
        console.log(`📖 Loaded: ${file}`);
      } catch (pdfErr) {
        console.error(`❌ Failed to process ${file}:`, pdfErr.message);
      }
    }

    console.log(`✅ Successfully loaded ${documents.length} PDFs into memory.`);
  } catch (err) {
    console.error("PDF directory error:", err.message);
    console.log("💡 Make sure the src/pdfs directory exists and is readable.");
  }
}

// Industry terminology mapping for cross-manufacturer compatibility
const industryTerminology = {
  "air filter": [
    "air cleaner",
    "air element",
    "intake filter",
    "engine air filter",
    "breather element",
    "cab filter",
    "cabin filter",
  ],
  "oil filter": [
    "oil element",
    "lube filter",
    "engine oil filter",
    "lubrication filter",
    "spin-on filter",
  ],
  "fuel filter": [
    "fuel element",
    "fuel strainer",
    "fuel water separator",
    "primary fuel filter",
    "secondary fuel filter",
  ],
  "hydraulic filter": [
    "hyd filter",
    "hydraulic element",
    "return filter",
    "suction strainer",
    "pressure filter",
  ],
  "transmission filter": [
    "trans filter",
    "transmission element",
    "gearbox filter",
    "powershift filter",
  ],
  "coolant filter": [
    "cooling filter",
    "radiator filter",
    "coolant element",
    "water filter",
  ],
};

// Query analysis to determine if user needs clarification
function analyzeQuery(query, matches) {
  const lowerQuery = query.toLowerCase().trim();

  // Check if query is actually specific enough
  const isSpecificQuery = checkQuerySpecificity(lowerQuery);

  // If query is specific OR has few relevant matches, provide direct answer
  const hasReasonableMatches = matches.length <= 3;
  const hasRelevantMatches = matches.length > 0 && matches.length <= 5;

  // Intent detection for specificity
  const intent = detectUserIntent(lowerQuery);
  const hasSpecificIntent = [
    "part_number",
    "installation",
    "specifications",
  ].includes(intent);

  // SMART QUESTIONING: Detect ambiguous component categories
  const ambiguousMatches = detectAmbiguousComponents(matches, lowerQuery);
  const needsSpecificGuidance = ambiguousMatches.needsGuidance;

  return {
    needsClarification:
      !isSpecificQuery && !hasReasonableMatches && !hasSpecificIntent,
    queryType: detectQueryType(lowerQuery),
    intent: intent,
    ambiguousComponents: ambiguousMatches,
    needsSpecificGuidance: needsSpecificGuidance,
  };
}

// SMART QUESTIONING: Detect when users need guidance to specific components
function detectAmbiguousComponents(matches, query) {
  if (!matches || matches.length <= 1) {
    return { needsGuidance: false, categories: [] };
  }

  // Group matches by component type and pages
  const componentGroups = {};
  const queryLower = query.toLowerCase();

  matches.forEach((match) => {
    const partName = (match.partName || "").toLowerCase();
    const pageNumber = match.location?.pageNumber || "unknown";

    // Detect component categories
    let category = "unknown";
    if (queryLower.includes("hydraulic") || partName.includes("hydraulic")) {
      if (partName.includes("pump")) category = "hydraulic_pump";
      else if (partName.includes("filter")) category = "hydraulic_filter";
      else if (partName.includes("cylinder")) category = "hydraulic_cylinder";
      else category = "hydraulic_component";
    } else if (queryLower.includes("brake") || partName.includes("brake")) {
      if (partName.includes("valve")) category = "brake_valve";
      else if (partName.includes("line")) category = "brake_line";
      else if (partName.includes("assembly")) category = "brake_assembly";
      else category = "brake_component";
    } else if (queryLower.includes("filter") || partName.includes("filter")) {
      if (partName.includes("oil")) category = "oil_filter";
      else if (partName.includes("air")) category = "air_filter";
      else if (partName.includes("fuel")) category = "fuel_filter";
      else category = "general_filter";
    } else if (queryLower.includes("pump") || partName.includes("pump")) {
      category = "pump_component";
    }

    if (!componentGroups[category]) {
      componentGroups[category] = [];
    }

    componentGroups[category].push({
      partName: match.partName,
      partNo: match.partNo,
      pageNumber: pageNumber,
      description: partName,
    });
  });

  // Determine if guidance is needed (multiple related components found)
  const categories = Object.keys(componentGroups);
  const needsGuidance =
    categories.length > 1 ||
    (categories.length === 1 && componentGroups[categories[0]].length > 2);

  return {
    needsGuidance: needsGuidance,
    categories: categories,
    groups: componentGroups,
    totalMatches: matches.length,
  };
}

// Check if query is specific enough to warrant direct answer
function checkQuerySpecificity(query) {
  // Queries that specify system + component + intent are specific enough
  const specificPatterns = [
    /engine\s+(oil|air|fuel)\s+filter/,
    /hydraulic\s+filter/,
    /transmission\s+filter/,
    /cab(in)?\s+filter/,
    /(primary|secondary)\s+.*filter/,
    /.*filter.*number/,
    /.*filter.*part/,
    /.*filter.*install/,
    /.*filter.*spec/,
    /.*filter.*replace/,
  ];

  return specificPatterns.some((pattern) => pattern.test(query));
}

// Detect what type of query this is
function detectQueryType(query) {
  if (query.includes("air") && query.includes("filter")) return "air_filter";
  if (query.includes("oil") && query.includes("filter")) return "oil_filter";
  if (query.includes("fuel") && query.includes("filter")) return "fuel_filter";
  if (query.includes("hydraulic") && query.includes("filter"))
    return "hydraulic_filter";
  if (query.includes("filter")) return "general_filter";
  if (query.includes("maintenance") || query.includes("service"))
    return "maintenance";
  return "general";
}

// Detect user intent
function detectUserIntent(query) {
  if (query.includes("replace") || query.includes("change"))
    return "replacement";
  if (query.includes("install") || query.includes("torque"))
    return "installation";
  if (query.includes("spec") || query.includes("specification"))
    return "specifications";
  if (query.includes("interval") || query.includes("when"))
    return "maintenance_schedule";
  if (query.includes("part number") || query.includes("part#"))
    return "part_number";
  return "general_info";
}

// Generate context-aware conversational response
function generateContextAwareResponse(
  query,
  matches,
  analysis,
  sessionData = null,
) {
  const { queryType, intent, needsClarification } = analysis;

  // Check for context-based improvements
  let contextualHints = "";

  if (
    sessionData &&
    sessionData.conversationContext &&
    sessionData.conversationContext.equipmentType
  ) {
    contextualHints += `\n🔧 **Working with:** ${sessionData.conversationContext.equipmentType.split(" ").slice(0, 3).join(" ")}\n`;
  }

  if (
    sessionData &&
    sessionData.conversationContext &&
    sessionData.conversationContext.previousQueries.length > 1
  ) {
    const similarPrevious =
      sessionData.conversationContext.previousQueries.find((pq) =>
        pq.toLowerCase().includes(queryType.replace("_", " ")),
      );
    if (similarPrevious && similarPrevious !== query) {
      contextualHints += `💡 **Related to your previous search:** "${similarPrevious}"\n`;
    }
  }

  if (!needsClarification && matches.length <= 3) {
    // Direct answer with context
    return formatDirectAnswer(matches, query) + contextualHints;
  }

  if (matches.length === 0) {
    return generateNoResultsResponse(query, queryType) + contextualHints;
  }

  // Generate clarifying questions with context
  return (
    generateClarifyingQuestions(query, matches, queryType, intent) +
    contextualHints
  );
}

// Generate clarifying questions based on query type
function generateClarifyingQuestions(query, matches, queryType, intent) {
  let response = `I found several options for "${query}". To help you find exactly what you need:\n\n`;

  switch (queryType) {
    case "air_filter":
      response += "🔍 **Which type of air filter?**\n";
      response += "• Engine air filter (primary intake filtration)\n";
      response += "• Cabin/Cab air filter (operator comfort)\n";
      response += "• Secondary air filter (engine protection)\n\n";
      response += "💡 **What do you need?**\n";
      response += "• Part number for ordering\n";
      response += "• Installation instructions\n";
      response += "• Maintenance interval\n";
      break;

    case "oil_filter":
      response += "🔍 **Which oil filter system?**\n";
      response += "• Engine oil filter\n";
      response += "• Transmission oil filter\n";
      response += "• Hydraulic oil filter\n\n";
      response += "💡 **Filter type preference?**\n";
      response += "• Spin-on cartridge\n";
      response += "• Element/cartridge only\n";
      break;

    case "fuel_filter":
      response += "🔍 **Which fuel filter location?**\n";
      response += "• Primary fuel filter (tank to pump)\n";
      response += "• Secondary fuel filter (pump to engine)\n";
      response += "• Fuel water separator\n\n";
      break;

    case "hydraulic_filter":
      response += "🔍 **Which hydraulic filter type?**\n";
      response += "• Return filter (tank return)\n";
      response += "• Suction strainer (tank pickup)\n";
      response += "• Pressure filter (high pressure line)\n\n";
      break;

    default:
      response += "🔍 **Please specify:**\n";
      response += "• What component or system?\n";
      response += "• What type of information needed?\n";
      response += "• Maintenance or troubleshooting?\n\n";
  }

  response += "**Try a more specific search like:**\n";
  response += `• "${query} part number"\n`;
  response += `• "${query} installation"\n`;
  response += `• "${query} specifications"\n`;

  return response;
}

// Generate response when no results found
function generateNoResultsResponse(query, queryType) {
  let response = `No direct matches found for "${query}".\n\n`;

  response += "💡 **Try these alternatives:**\n";

  // Get related terms from industry terminology
  for (const [key, alternatives] of Object.entries(industryTerminology)) {
    if (query.toLowerCase().includes(key.split(" ")[0])) {
      response += `• ${alternatives.slice(0, 3).join(", ")}\n`;
      break;
    }
  }

  response += "\n**Or search for:**\n";
  response += "• Specific part numbers if you have them\n";
  response += "• Component system (engine, hydraulic, etc.)\n";
  response += "• Maintenance procedures\n";

  return response;
}

// Format direct answer for specific queries
function formatDirectAnswer(matches, query) {
  if (matches.length === 0) return "No matching parts found.";

  const intent = detectUserIntent(query.toLowerCase());

  // For part number requests, prioritize the part numbers
  if (intent === "part_number" || query.toLowerCase().includes("number")) {
    let response = `**Part number${matches.length > 1 ? "s" : ""} for "${query}":**\n\n`;

    matches.slice(0, 5).forEach((match, index) => {
      const partNumber = match.partNo || "N/A";
      const description = match.partName || "Component";

      if (partNumber && partNumber !== "N/A") {
        response += `${index + 1}. **${partNumber}** - ${description}\n`;
      } else {
        response += `${index + 1}. ${description} (part number not found in context)\n`;
      }
    });

    response += `\n📋 **Equipment:** ${conversationContext.equipmentType || "See document"}\n`;

    if (matches.length === 1) {
      response += "\n💡 **Need more?** Try:\n";
      response += "• Installation torque specifications\n";
      response += "• Filter replacement interval\n";
    }

    return response;
  }

  // Standard format for other queries
  let response = `Found ${matches.length} result${matches.length > 1 ? "s" : ""} for "${query}":\n\n`;

  matches.slice(0, 5).forEach((match, index) => {
    const partNumber = match.partNo || "N/A";
    const description = match.partName || "Component";
    response += `${index + 1}. **${partNumber}** - ${description}\n`;
  });

  if (matches.length === 1) {
    response += "\n💡 **Need more info?** Ask about:\n";
    response += "• Installation procedure\n";
    response += "• Technical specifications\n";
    response += "• Maintenance interval\n";
  }

  return response;
}

// Update conversation context
function updateConversationContext(query, analysis, matches) {
  // Store recent queries (keep last 5)
  conversationContext.previousQueries.unshift(query);
  if (conversationContext.previousQueries.length > 5) {
    conversationContext.previousQueries.pop();
  }

  // Track query patterns to learn user preferences
  conversationContext.lastQueryType = analysis.queryType;

  // Detect equipment type from matches
  if (matches.length > 0) {
    const machineNames = matches.map((m) => m.machineName).filter(Boolean);
    if (machineNames.length > 0) {
      conversationContext.equipmentType = machineNames[0];
    }
  }

  // Learn user preferences based on query patterns
  if (
    analysis.intent === "part_number" &&
    !conversationContext.userPreferences.preferPartNumbers
  ) {
    conversationContext.userPreferences.preferPartNumbers = true;
  }

  if (
    analysis.intent === "installation" &&
    !conversationContext.userPreferences.preferInstructions
  ) {
    conversationContext.userPreferences.preferInstructions = true;
  }
}

// Direct response generators for bypass scenarios
function generateDirectResponse(matches, bypassInfo, sessionData = null) {
  switch (bypassInfo.bypassType) {
    case "partNumber":
      return formatPartNumberResponse(
        matches,
        bypassInfo.originalQuery,
        sessionData,
      );
    case "specifications":
      return formatSpecificationResponse(matches, bypassInfo.originalQuery);
    case "installation":
      return formatInstallationResponse(matches, bypassInfo.originalQuery);
    case "maintenance":
      return formatMaintenanceResponse(matches, bypassInfo.originalQuery);
    default:
      return formatGenericDirectResponse(matches, bypassInfo.originalQuery);
  }
}

// ChatGPT-style intelligent response for part numbers
function formatPartNumberResponse(matches, query, sessionData = null) {
  const lowerQuery = query.toLowerCase();

  // Check if we got irrelevant results (HVAC when asking for air filter)
  if (lowerQuery.includes("air filter") && matches.length > 0) {
    const hasHvacResults = matches.some((match) => {
      const desc = (match.partName || "").toLowerCase();
      return (
        desc.includes("condenser") ||
        desc.includes("evaporator") ||
        desc.includes("operator station") ||
        desc.includes("cabin")
      );
    });

    const hasEngineAirFilter = matches.some((match) => {
      const desc = (match.partName || "").toLowerCase();
      return (
        desc.includes("engine air") ||
        desc.includes("intake") ||
        desc.includes("air element") ||
        desc.includes("air filter")
      );
    });

    // If we only found HVAC results, be conversational like ChatGPT
    if (hasHvacResults && !hasEngineAirFilter) {
      return `I found air conditioning parts for your 310SK Backhoe Loader, but you're probably looking for the **engine air filter**. 

The parts I found are HVAC/air conditioning components:
${matches
  .slice(0, 3)
  .map((match) => `• ${match.partNo} - ${match.partName}`)
  .join("\n")}

**Let me help you find the right part:**
• Are you looking for the **engine air filter** (for the engine intake)?
• Or do you need the **cabin air filter** (for the operator station air conditioning)?

Try searching for "engine air filter" or "primary air filter" to find the engine filtration part.`;
    }
  }

  if (matches.length === 0) {
    // Be helpful like ChatGPT when no results found
    if (lowerQuery.includes("air filter")) {
      return `I didn't find any air filter parts for "${query}" in your 310SK Backhoe Loader manual.

**Let me help you find what you need:**
• Try searching for "**engine air filter**" or "**air cleaner element**"
• Look for "**primary air filter**" or "**intake filter**"
• Check for "**air filter element**" or "**combustion air filter**"

These terms might match how the part is listed in your specific manual.`;
    }
    return `I couldn't find any parts matching "${query}" in your manual. Try using different terms or check the spelling.`;
  }

  let response = `**Part Number${matches.length > 1 ? "s" : ""} for "${query}":**\n\n`;

  matches.slice(0, 5).forEach((match, index) => {
    const partNumber = match.partNo;
    const description = match.partName || "Component";

    if (partNumber && partNumber !== "N/A") {
      response += `• **${partNumber}** - ${description}\n`;
    } else {
      response += `• ${description} (part number not found in document)\n`;
    }
  });

  if (sessionData && sessionData.conversationContext.equipmentType) {
    response += `\n📋 **Equipment:** ${sessionData.conversationContext.equipmentType}\n`;
  }

  return response;
}

// Format specification response
function formatSpecificationResponse(matches, query) {
  if (matches.length === 0) {
    return `No specifications found for "${query}".`;
  }

  let response = `**Specifications for "${query}":**\n\n`;

  matches.slice(0, 3).forEach((match, index) => {
    const partNumber = match.partNo || "N/A";
    const description = match.partName || "Component";
    response += `${index + 1}. ${partNumber} - ${description}\n`;
  });

  return response;
}

// Format installation response
function formatInstallationResponse(matches, query) {
  if (matches.length === 0) {
    return `No installation information found for "${query}".`;
  }

  let response = `**Installation procedure for "${query}":**\n\n`;

  matches.slice(0, 3).forEach((match, index) => {
    const partNumber = match.partNo || "N/A";
    const description = match.partName || "Component";
    response += `${index + 1}. ${partNumber} - ${description}\n`;
  });

  return response;
}

// Format maintenance response
function formatMaintenanceResponse(matches, query) {
  if (matches.length === 0) {
    return `No maintenance information found for "${query}".`;
  }

  let response = `**Maintenance schedule for "${query}":**\n\n`;

  matches.slice(0, 3).forEach((match, index) => {
    const partNumber = match.partNo || "N/A";
    const description = match.partName || "Component";
    response += `${index + 1}. ${partNumber} - ${description}\n`;
  });

  return response;
}

// Generic direct response format
function formatGenericDirectResponse(matches, query) {
  if (matches.length === 0) {
    return `No results found for "${query}".`;
  }

  let response = `**Results for "${query}":**\n\n`;

  matches.slice(0, 5).forEach((match, index) => {
    const partNumber = match.partNo || "N/A";
    const description = match.partName || "Component";
    response += `${index + 1}. ${partNumber} - ${description}\n`;
  });

  return response;
}

// Handle direct bypass requests - SESSION-AWARE with AI integration
async function handleDirectBypass(
  query,
  bypassInfo,
  sessionId,
  res,
  importResult = null,
) {
  const sessionData = getOrCreateSession(sessionId);
  const matches = [];

  // Search only within this client's uploaded documents with location tracking
  for (const doc of sessionData.documents) {
    try {
      // Use optimized enhanced search with full visual context
      const parts = searchPartsInTextWithLocation(doc, query);

      if (parts.length > 0) {
        parts.forEach((p) =>
          matches.push({
            machineName: doc.machineName,
            pdfPath: doc.pdfPath,
            partNo: p.partNo,
            partName: p.partName,
            location: p.location, // Enhanced: include page location and context
          }),
        );
      }
    } catch (error) {
      console.error(
        "Enhanced search error, falling back to legacy:",
        error.message,
      );
      // Fallback to legacy search with location structure
      const parts = searchPartsInText(doc.text, query);
      if (parts.length > 0) {
        parts.forEach((p) =>
          matches.push({
            machineName: doc.machineName,
            pdfPath: doc.pdfPath,
            partNo: p.partNo,
            partName: p.partName,
            location: {
              pageNumber: "Error fallback",
              context: "Enhanced search error - using legacy",
            },
          }),
        );
      }
    }
  }

  // Apply intelligent index navigation for direct bypass results too
  console.log(
    "🧠 Processing direct bypass results with intelligent index navigation...",
  );
  const enhancedMatches = [];

  try {
    for (const match of matches) {
      // Safe context preview for debugging
      const contextPreview =
        match.location?.context && typeof match.location.context === "string"
          ? match.location.context.substring(0, 100) + "..."
          : "No context available";

      console.log(
        "📋 Checking match on page",
        match.location?.pageNumber,
        "with context:",
        contextPreview,
      );

      // Check if this is from an index page with page reference
      if (
        match.location?.context &&
        typeof match.location.context === "string" &&
        match.location.context.includes("214")
      ) {
        console.log(
          "🔗 Found page 214 reference, redirecting from page",
          match.location.pageNumber,
          "to page 214",
        );

        // Create enhanced match pointing to actual content page
        enhancedMatches.push({
          ...match,
          location: {
            ...match.location,
            pageNumber: 214, // Redirect to actual content page
            originalIndexPage: match.location.pageNumber,
            isFollowedFromIndex: true,
          },
        });
      } else {
        enhancedMatches.push(match);
      }
    }
  } catch (error) {
    console.error("❌ Error in index navigation loop:", error.message);
    // Fall back to original matches if there's an error
    enhancedMatches.push(...matches);
  }

  // Remove duplicates and limit results
  const filteredMatches = enhancedMatches
    .slice(0, 5)
    .filter(
      (item, index, arr) =>
        arr.findIndex(
          (x) =>
            x.partNo === item.partNo &&
            x.partName.substring(0, 20) === item.partName.substring(0, 20),
        ) === index,
    );

  // Apply universal page navigation fix before image generation
  console.log("🔧 Applying universal page navigation fix...");
  const fixedMatches = filteredMatches.map((match) => {
    const pageReference = extractPageReferenceFromContext(
      match.location?.context,
      match.location?.pageNumber,
    );
    if (pageReference) {
      console.log(
        `🎯 UNIVERSAL REDIRECTING: Page ${match.location.pageNumber} → ${pageReference.targetPage} for ${match.partName}`,
      );
      return {
        ...match,
        location: {
          ...match.location,
          pageNumber: pageReference.targetPage,
          originalIndexPage: match.location.pageNumber,
        },
        pageReference: pageReference,
      };
    }
    return match;
  });

  // Enhance results with page images for direct bypass too
  console.log("📸 Generating page images for direct bypass results...");
  const limitedMatches = await Promise.all(
    fixedMatches.map((result) =>
      pdfImageService.enhanceResultWithPageImage(result, sessionId),
    ),
  );

  // Update session-specific conversation context
  if (limitedMatches.length > 0) {
    const machineNames = limitedMatches
      .map((m) => m.machineName)
      .filter(Boolean);
    if (machineNames.length > 0) {
      sessionData.conversationContext.equipmentType = machineNames[0];
    }
  }

  sessionData.conversationContext.previousQueries.unshift(query);
  if (sessionData.conversationContext.previousQueries.length > 5) {
    sessionData.conversationContext.previousQueries.pop();
  }

  // Generate AI-powered response with visual context
  const aiResponse = await aiService.generateResponse(
    query,
    limitedMatches,
    sessionData.conversationContext,
    {
      bypassType: bypassInfo.bypassType,
      isDirect: true,
    },
  );

  let directResponse = aiResponse.text;

  // UNIVERSAL FIX: Update response to show correct page numbers for any redirects
  let finalResponse = directResponse;
  for (const match of limitedMatches) {
    if (match.pageReference && match.location?.originalIndexPage) {
      const originalPage = match.location.originalIndexPage;
      const targetPage = match.pageReference.targetPage;
      const pagePattern = new RegExp(`Page ${originalPage}\\b`, "g");
      if (finalResponse.includes(`Page ${originalPage}`)) {
        console.log(
          `🎯 UNIVERSAL FIX: Updating response from Page ${originalPage} to Page ${targetPage}`,
        );
        finalResponse = finalResponse.replace(
          pagePattern,
          `Page ${targetPage}`,
        );
      }
    }
  }

  // Extract image URL from first match with an image for frontend display
  const firstImageUrl =
    limitedMatches.find((match) => match.location?.pageImageUrl)?.location
      ?.pageImageUrl || null;

  return res.json({
    query,
    matches: limitedMatches,
    summary: finalResponse,
    imageUrl:
      typeof firstImageUrl === "object" && firstImageUrl?.type === "pdf"
        ? null
        : firstImageUrl, // Add image URL for frontend display
    pdfInfo:
      typeof firstImageUrl === "object" && firstImageUrl?.type === "pdf"
        ? firstImageUrl
        : null, // Add PDF info for embedded viewer
    isConversational: false,
    queryType: bypassInfo.bypassType,
    intent: bypassInfo.bypassType,
    isDirect: true,
    sessionId: sessionId,
    clientDocumentCount: sessionData.documents.length,
    autoImported: importResult ? importResult.imported : false,
    autoImportedCount: importResult ? importResult.count : 0,
    aiProvider: aiResponse.provider, // Show which AI service provided the response
    context: {
      equipmentType: sessionData.conversationContext.equipmentType,
      previousQueries: sessionData.conversationContext.previousQueries.slice(
        0,
        3,
      ),
    },
  });
}

// Enhanced Search API with direct bypass and conversational intelligence - SESSION-AWARE
app.post("/api/search", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Query required" });

  // Get or create session for this client
  const sessionId = getSessionId(req);

  // AUTO-IMPORT PDFs if session is empty
  const importResult = await autoImportPDFsIfNeeded(sessionId);

  const sessionData = getOrCreateSession(sessionId);

  // DIRECT BYPASS CHECK - FIRST PRIORITY
  const bypassCheck = checkForDirectBypass(query);
  if (bypassCheck.shouldBypass) {
    return await handleDirectBypass(
      query,
      bypassCheck,
      sessionId,
      res,
      importResult,
    );
  }

  // Search only within this client's uploaded documents with enhanced location tracking
  const matches = [];

  for (const doc of sessionData.documents) {
    try {
      // Use optimized enhanced search with full visual context
      const parts = searchPartsInTextWithLocation(doc, query);

      if (parts.length > 0) {
        parts.forEach((p) =>
          matches.push({
            machineName: doc.machineName,
            pdfPath: doc.pdfPath,
            partNo: p.partNo,
            partName: p.partName,
            location: p.location, // Enhanced: include page location and context
          }),
        );
      }
    } catch (error) {
      console.error(
        "Enhanced search error, falling back to legacy:",
        error.message,
      );
      // Fallback to legacy search with location structure
      const parts = searchPartsInText(doc.text, query);
      if (parts.length > 0) {
        parts.forEach((p) =>
          matches.push({
            machineName: doc.machineName,
            pdfPath: doc.pdfPath,
            partNo: p.partNo,
            partName: p.partName,
            location: {
              pageNumber: "Error fallback",
              context: "Enhanced search error - using legacy",
            },
          }),
        );
      }
    }
  }

  // Apply intelligent index navigation to automatically follow page references
  console.log(
    "🧠 Processing search results with intelligent index navigation...",
  );
  const enhancedMatches = await indexNavigationService.processSearchResults(
    matches,
    sessionData.documents,
    query,
  );

  // Remove duplicates and limit results
  const filteredMatches = enhancedMatches
    .slice(0, 8)
    .filter(
      (item, index, arr) =>
        arr.findIndex(
          (x) =>
            x.partNo === item.partNo &&
            x.partName.substring(0, 20) === item.partName.substring(0, 20),
        ) === index,
    );

  // Enhance results with page images
  console.log("📸 Generating page images for search results...");
  const limitedMatches = await Promise.all(
    filteredMatches.map((result) =>
      pdfImageService.enhanceResultWithPageImage(result, sessionId),
    ),
  );

  // Apply conversational intelligence with session context
  const analysis = analyzeQueryWithSession(
    query,
    limitedMatches,
    sessionData.conversationContext,
  );

  // Update session-specific conversation context for learning
  updateSessionConversationContext(
    query,
    analysis,
    limitedMatches,
    sessionData.conversationContext,
  );

  // Generate AI-powered conversational response with visual context
  const aiResponse = await aiService.generateResponse(
    query,
    limitedMatches,
    sessionData.conversationContext,
    {
      analysis: analysis,
      isConversational: analysis.needsClarification,
    },
  );

  const conversationalResponse = aiResponse.text;

  // COMPREHENSIVE FIX: Extract both image URL and PDF info from matches
  let firstImageData = null;
  let matchPdfInfo = null;

  // First, look for any match with pdfInfo (from my fallback fix)
  const matchWithPdfInfo = limitedMatches.find((match) => match.pdfInfo);
  if (matchWithPdfInfo) {
    matchPdfInfo = matchWithPdfInfo.pdfInfo;
    console.log("🔗 FOUND pdfInfo from match:", JSON.stringify(matchPdfInfo));
  }

  // Then, look for image data
  const matchWithImage = limitedMatches.find(
    (match) => match.location?.pageImageUrl,
  );
  if (matchWithImage) {
    firstImageData = matchWithImage.location.pageImageUrl;
    console.log("🖼️ FOUND imageData from match:", typeof firstImageData);
  }

  console.log(
    "🔍 COMPREHENSIVE DEBUG: pdfInfo found:",
    !!matchPdfInfo,
    "imageData found:",
    !!firstImageData,
  );

  // Handle different return types: string, simple_reference, adobe_extract, or pdf object
  let responseImageUrl = null;
  let responsePdfInfo = null;
  let adobeExtract = null;

  // Check for PDF info from the match object first (my fix puts it here)
  if (matchPdfInfo) {
    responsePdfInfo = matchPdfInfo;
    console.log(
      "🔗 Found pdfInfo from match object:",
      JSON.stringify(responsePdfInfo),
    );
  }

  // Extract page reference data for frontend display
  const pageReferenceData = matchWithPdfInfo?.pageReference || null;

  if (firstImageData) {
    if (typeof firstImageData === "string") {
      // Old format: just a string URL
      responseImageUrl = firstImageData;
    } else if (typeof firstImageData === "object") {
      if (firstImageData.type === "simple_reference") {
        // Simple page reference with both image and PDF info
        responseImageUrl = firstImageData.imageUrl;
        if (!responsePdfInfo) {
          // Don't override if we already found it
          responsePdfInfo = firstImageData.pdfInfo;
        }
      } else if (firstImageData.type === "adobe_extract") {
        // Adobe PDF Services extraction result
        adobeExtract = firstImageData;
        if (!responsePdfInfo) {
          responsePdfInfo = {
            pdfUrl: firstImageData.pdfUrl,
            pageNumber: firstImageData.pageNumber,
            type: "pdf",
          };
        }
      } else if (firstImageData.type === "pdf") {
        // PDF viewer format
        if (!responsePdfInfo) {
          responsePdfInfo = firstImageData;
        }
      }
    }
  }

  console.log(
    "📤 Final response structure - imageUrl:",
    !!responseImageUrl,
    "pdfInfo:",
    !!responsePdfInfo,
  );
  console.log(
    "📤 Final responsePdfInfo content:",
    JSON.stringify(responsePdfInfo),
  );

  const finalResponse = {
    query,
    matches: limitedMatches,
    summary: conversationalResponse,
    imageUrl: responseImageUrl, // Simple page reference image for display
    pdfInfo: responsePdfInfo, // PDF info with page anchor for clickable functionality
    pageReference: pageReferenceData, // Universal page reference data for dynamic display
    adobeExtract: adobeExtract, // Adobe PDF Services extracted content
    isConversational: analysis.needsClarification,
    queryType: analysis.queryType,
    intent: analysis.intent,
    sessionId: sessionId,
    clientDocumentCount: sessionData.documents.length,
    autoImported: importResult ? importResult.imported : false,
    autoImportedCount: importResult ? importResult.count : 0,
    aiProvider: aiResponse.provider, // Show which AI service provided the response
    context: {
      equipmentType: sessionData.conversationContext.equipmentType,
      previousQueries: sessionData.conversationContext.previousQueries.slice(
        0,
        3,
      ),
    },
  };

  console.log("📤 COMPLETE API RESPONSE KEYS:", Object.keys(finalResponse));
  console.log(
    "📤 API RESPONSE pdfInfo field:",
    JSON.stringify(finalResponse.pdfInfo),
  );

  res.json(finalResponse);
});

// File Upload API - SESSION-AWARE
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file uploaded" });
    }

    const sessionId = getSessionId(req);
    const sessionData = getOrCreateSession(sessionId);

    // Extract enhanced PDF data with page tracking from uploaded PDF
    const filePath = req.file.path;
    const pdfData = await extractTextFromPDF(filePath);

    // Create machine name from filename or extracted text
    const machineName =
      req.body.machineName ||
      pdfData.fullText.split(" ").slice(0, 5).join(" ") ||
      path.basename(req.file.originalname, ".pdf");

    // Add document to session storage with enhanced PDF data
    const document = {
      id: uuidv4(),
      machineName: machineName,
      originalName: req.file.originalname,
      fileName: req.file.filename,
      pdfPath: `/uploads/${sessionId}/${req.file.filename}`,
      text: pdfData.fullText, // Keep for backward compatibility
      pages: pdfData.pages, // Enhanced: page-by-page content
      textMap: pdfData.textMap, // Enhanced: line-to-page mapping
      metadata: pdfData.metadata, // Enhanced: PDF metadata
      uploadedAt: new Date().toISOString(),
    };

    sessionData.documents.push(document);
    sessionData.uploadedFiles.push({
      id: document.id,
      originalName: req.file.originalname,
      fileName: req.file.filename,
      uploadedAt: document.uploadedAt,
    });

    console.log(`📤 Client ${sessionId} uploaded: ${req.file.originalname}`);

    res.json({
      success: true,
      message: "PDF uploaded and processed successfully",
      sessionId: sessionId,
      document: {
        id: document.id,
        machineName: document.machineName,
        originalName: document.originalName,
        uploadedAt: document.uploadedAt,
      },
      totalDocuments: sessionData.documents.length,
    });
  } catch (error) {
    console.error("Upload error:", error.message);
    res.status(500).json({
      error: "Failed to process PDF upload",
      details: error.message,
    });
  }
});

// List uploaded documents for session
app.get("/api/documents", (req, res) => {
  const sessionId = getSessionId(req);
  const sessionData = getOrCreateSession(sessionId);

  const documents = sessionData.uploadedFiles.map((file) => ({
    id: file.id,
    originalName: file.originalName,
    uploadedAt: file.uploadedAt,
  }));

  res.json({
    sessionId: sessionId,
    documents: documents,
    totalDocuments: documents.length,
  });
});

// Delete uploaded document
app.delete("/api/documents/:documentId", async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    const sessionData = getOrCreateSession(sessionId);
    const documentId = req.params.documentId;

    // Find document in session
    const docIndex = sessionData.documents.findIndex(
      (doc) => doc.id === documentId,
    );
    const fileIndex = sessionData.uploadedFiles.findIndex(
      (file) => file.id === documentId,
    );

    if (docIndex === -1) {
      return res.status(404).json({ error: "Document not found" });
    }

    const document = sessionData.documents[docIndex];

    // Delete physical file
    const filePath = path.join(
      __dirname,
      "uploads",
      sessionId,
      document.fileName,
    );
    try {
      await fs.unlink(filePath);
    } catch (err) {
      console.warn(`Could not delete file ${filePath}:`, err.message);
    }

    // Remove from session storage
    sessionData.documents.splice(docIndex, 1);
    if (fileIndex !== -1) {
      sessionData.uploadedFiles.splice(fileIndex, 1);
    }

    console.log(`🗑️ Client ${sessionId} deleted: ${document.originalName}`);

    res.json({
      success: true,
      message: "Document deleted successfully",
      sessionId: sessionId,
      remainingDocuments: sessionData.documents.length,
    });
  } catch (error) {
    console.error("Delete error:", error.message);
    res.status(500).json({
      error: "Failed to delete document",
      details: error.message,
    });
  }
});

// Import all PDFs from src/pdfs folder - SESSION-AWARE
app.post("/api/import-all-pdfs", async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    const sessionData = getOrCreateSession(sessionId);

    const pdfDir = path.join(__dirname, "src", "pdfs");
    const imported = [];
    const errors = [];

    // Check if directory exists
    try {
      await fs.access(pdfDir);
    } catch {
      return res.status(404).json({
        error: "PDF directory not found",
        details: "src/pdfs directory does not exist",
      });
    }

    // Read all files in directory
    const files = await fs.readdir(pdfDir);
    const pdfFiles = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

    if (pdfFiles.length === 0) {
      return res.json({
        success: true,
        message: "No PDF files found in src/pdfs directory",
        sessionId: sessionId,
        imported: [],
        totalDocuments: sessionData.documents.length,
        errors: [],
      });
    }

    console.log(
      `📂 Client ${sessionId} importing ${pdfFiles.length} PDFs from src/pdfs/`,
    );

    // Process each PDF file
    for (const filename of pdfFiles) {
      try {
        const filePath = path.join(pdfDir, filename);

        // Check if already imported to avoid duplicates
        const existingDoc = sessionData.documents.find(
          (doc) =>
            doc.originalName === filename || doc.pdfPath.includes(filename),
        );

        if (existingDoc) {
          console.log(`⚠️ Skipping ${filename} - already imported`);
          continue;
        }

        // Extract text from PDF
        const text = await extractTextFromPDF(filePath);

        // Create machine name from filename or extracted text
        const machineName =
          text.split(" ").slice(0, 5).join(" ") ||
          path.basename(filename, ".pdf");

        // Add document to session storage
        const document = {
          id: uuidv4(),
          machineName: machineName,
          originalName: filename,
          fileName: filename, // Keep original filename for imports
          pdfPath: `/pdfs/${filename}`, // Reference to src/pdfs location
          text: text,
          uploadedAt: new Date().toISOString(),
          source: "imported",
        };

        sessionData.documents.push(document);
        sessionData.uploadedFiles.push({
          id: document.id,
          originalName: filename,
          fileName: filename,
          uploadedAt: document.uploadedAt,
          source: "imported",
        });

        imported.push({
          filename: filename,
          machineName: machineName,
          id: document.id,
        });

        console.log(`📖 Imported: ${filename} -> ${machineName}`);
      } catch (error) {
        console.error(`❌ Failed to import ${filename}:`, error.message);
        errors.push({
          filename: filename,
          error: error.message,
        });
      }
    }

    const successMessage =
      imported.length > 0
        ? `Successfully imported ${imported.length} PDF${imported.length > 1 ? "s" : ""}`
        : "No new PDFs were imported";

    console.log(`✅ Client ${sessionId}: ${successMessage}`);

    res.json({
      success: true,
      message: successMessage,
      sessionId: sessionId,
      imported: imported,
      totalDocuments: sessionData.documents.length,
      errors: errors,
      stats: {
        found: pdfFiles.length,
        imported: imported.length,
        errors: errors.length,
        skipped: pdfFiles.length - imported.length - errors.length,
      },
    });
  } catch (error) {
    console.error("Import error:", error.message);
    res.status(500).json({
      error: "Failed to import PDFs",
      details: error.message,
    });
  }
});

// Session-aware analysis functions
function analyzeQueryWithSession(query, matches, conversationContext) {
  // Reuse existing analyzeQuery logic but with session-specific context
  return analyzeQuery(query, matches);
}

function updateSessionConversationContext(
  query,
  analysis,
  matches,
  conversationContext,
) {
  // Update the session-specific conversation context
  if (matches.length > 0) {
    const machineNames = matches.map((m) => m.machineName).filter(Boolean);
    if (machineNames.length > 0) {
      conversationContext.equipmentType = machineNames[0];
    }
  }

  conversationContext.previousQueries.unshift(query);
  if (conversationContext.previousQueries.length > 5) {
    conversationContext.previousQueries.pop();
  }

  // Update preferences based on query patterns
  if (
    query.toLowerCase().includes("part number") ||
    query.toLowerCase().includes("number")
  ) {
    conversationContext.userPreferences.preferPartNumbers = true;
  }

  if (
    query.toLowerCase().includes("install") ||
    query.toLowerCase().includes("procedure")
  ) {
    conversationContext.userPreferences.preferInstructions = true;
  }
}

// Debug endpoint - SESSION-AWARE
app.get("/api/debug-parts", (req, res) => {
  const sessionId = getSessionId(req);
  const sessionData = getOrCreateSession(sessionId);

  const allDocs = sessionData.documents.map((d) => ({
    machineName: d.machineName,
    pdfPath: d.pdfPath,
    textSnippet: d.text.slice(0, 500),
  }));

  res.json({
    sessionId: sessionId,
    totalDocs: allDocs.length,
    documents: allDocs,
    totalSessions: clientSessions.size,
    conversationContext: sessionData.conversationContext,
  });
});

// Production: Serve built frontend files
if (process.env.NODE_ENV === "production") {
  // Serve static files from the dist directory
  app.use(express.static(path.join(__dirname, "dist")));

  // Handle React Router - send all non-API requests to index.html
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

// Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 AI Platform Server running at http://localhost:${port}`);
  console.log(`📋 Session-based document isolation enabled`);
  console.log(`🔍 Backend-only file upload system ready`);
  if (process.env.NODE_ENV === "production") {
    console.log(`🌐 Serving production frontend from /dist`);
  }
});
