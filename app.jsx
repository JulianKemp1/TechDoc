// Updated App.jsx with improved error handling for AI fallbacks

import React, { useState, useEffect } from "react";
import PDFViewer from "./components/PDFViewer";

function App() {
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retryMessage, setRetryMessage] = useState(""); // New state for retry feedback

  // Fetch initial welcome message
  useEffect(() => {
    setMessages([
      {
        text: "Welcome to TechDoc. How can we be of service?",
        type: "ai",
      },
    ]);
  }, []);

  const handleSend = async () => {
    if (!query.trim()) {
      setError("Please enter a query.");
      return;
    }

    setError("");
    setLoading(true);
    setRetryMessage(""); // Reset retry message
    const userMessage = { text: query, type: "user" };
    setMessages((prev) => [...prev, userMessage]);
    setQuery("");

    // Add processing message immediately
    setMessages((prev) => [...prev, { text: "Processing...", type: "ai" }]);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();

      if (response.ok) {
        let aiText = data.summary || "No detailed info available.";
        if (data.aiProvider === "Fallback System") {
          setRetryMessage(
            "AI service was unavailable—using fallback response. Please try again later.",
          );
          aiText = `${aiText} (Fallback mode)`;
        }
        const aiMessage = {
          text: aiText,
          type: "ai",
          imageUrl: data.imageUrl || null, // Add image URL from response
          pdfInfo: data.pdfInfo || null, // Add PDF information from response
          adobeExtract: data.adobeExtract || null, // Add Adobe extracted content
        };
        // Replace the "Processing..." message with the actual response
        setMessages((prev) => [...prev.slice(0, -1), aiMessage]);
      } else {
        // Remove processing message and show error
        setMessages((prev) => prev.slice(0, -1));
        setError(data.error || "Something went wrong.");
      }
    } catch (err) {
      // Remove processing message and show error
      setMessages((prev) => prev.slice(0, -1));
      setError("Failed to fetch results. Please check your connection.");
      setRetryMessage("Request failed—retries exhausted.");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      handleSend();
    }
  };

  return (
    <div
      style={{
        fontFamily: "'Arial Black', Tahoma, Geneva, Verdana, sans-serif",
        maxWidth: 600,
        margin: "50px auto",
        padding: 20,
        height: "70vh",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#f9fafb",
        borderRadius: 12,
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
      }}
    >
      <h1 style={{ color: "#333", marginBottom: 20, textAlign: "center" }}>
        TechDoc
      </h1>
      <div
        style={{
          flexGrow: 1,
          overflowY: "auto",
          padding: "0 10px",
          marginBottom: 10,
          borderRadius: 8,
          backgroundColor: "#fff",
        }}
      >
        {messages.map((msg, index) => (
          <div
            key={index}
            style={{
              margin: "10px 0",
              padding: "12px 16px",
              borderRadius: 12,
              maxWidth: "80%",
              alignSelf: msg.type === "user" ? "flex-end" : "flex-start",
              backgroundColor: msg.type === "user" ? "#f0f0f0" : "#4A90E2",
              color: msg.type === "user" ? "#333" : "#fff",
              wordWrap: "break-word",
              whiteSpace: "pre-line",
              fontFamily:
                msg.type === "ai" ? "'Courier New', monospace" : "inherit",
              fontSize: msg.type === "ai" ? "14px" : "16px",
              lineHeight: "1.4",
              boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
            }}
          >
            {msg.text}
            {/* Show Adobe extracted content or image if available */}
            {msg.adobeExtract && (
              <div
                style={{
                  marginTop: "15px",
                  padding: "15px",
                  backgroundColor: "#f8f9fa",
                  borderRadius: "8px",
                  border: "2px solid #28a745",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "10px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "14px",
                      fontWeight: "bold",
                      color: "#28a745",
                    }}
                  >
                    📄 Page {msg.adobeExtract.pageNumber} -{" "}
                    {msg.adobeExtract.summary}
                  </span>
                  <button
                    onClick={() =>
                      window.open(msg.adobeExtract.pdfUrl, "_blank")
                    }
                    style={{
                      padding: "5px 10px",
                      backgroundColor: "#007bff",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      fontSize: "12px",
                      cursor: "pointer",
                    }}
                  >
                    🔗 Open PDF
                  </button>
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#555",
                    maxHeight: "120px",
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {msg.adobeExtract.extractedText ||
                    "Content extracted successfully"}
                </div>
              </div>
            )}

            {msg.pdfInfo && !msg.adobeExtract && (
              <div style={{ marginTop: "15px" }}>
                <div
                  style={{
                    padding: "15px",
                    backgroundColor: "#f0f8ff",
                    borderRadius: "8px",
                    border: "2px solid #007bff",
                    textAlign: "center",
                  }}
                >
                  <h4 style={{ margin: "0 0 10px 0", color: "#007bff" }}>
                    📄 Found in Index → Part Details
                  </h4>
                  <button
                    onClick={() => window.open(msg.pdfInfo.pdfUrl, "_blank")}
                    style={{
                      padding: "10px 20px",
                      backgroundColor: "#007bff",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "14px",
                      cursor: "pointer",
                      fontWeight: "bold",
                    }}
                  >
                    🔗 Open Part Details (Page {msg.pdfInfo.pageNumber})
                  </button>
                  <p
                    style={{
                      margin: "10px 0 0 0",
                      fontSize: "12px",
                      color: "#666",
                    }}
                  >
                    {msg.pageReference && msg.pageReference.originalIndexPage
                      ? `Index reference found on page ${msg.pageReference.originalIndexPage} → Actual part on page ${msg.pdfInfo.pageNumber}`
                      : `Navigate to page ${msg.pdfInfo.pageNumber} for technical details`}
                  </p>
                </div>
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div
            style={{
              margin: "10px 0",
              padding: "10px 15px",
              borderRadius: 10,
              maxWidth: "70%",
              alignSelf: "flex-start",
              backgroundColor: "#4A90E2",
              color: "#fff",
            }}
          >
            ...
          </div>
        )}
        {retryMessage && (
          <p
            style={{
              color: "orange",
              margin: "5px 0",
              textAlign: "center",
              fontStyle: "italic",
            }}
          >
            {retryMessage}
          </p>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <input
          type="text"
          placeholder="Type your query here..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            flexGrow: 1,
            padding: "12px 16px",
            borderRadius: 30,
            border: "1px solid #ddd",
            fontSize: 18,
            outline: "none",
            transition: "border-color 0.3s ease",
            boxShadow: "inset 0 1px 3px rgba(0,0,0,0.1)",
          }}
          onFocus={(e) => (e.target.style.borderColor = "#3b82f6")}
          onBlur={(e) => (e.target.style.borderColor = "#ddd")}
        />
        <button
          onClick={handleSend}
          disabled={loading}
          style={{
            padding: "12px 20px",
            fontSize: 16,
            cursor: loading ? "not-allowed" : "pointer",
            backgroundColor: loading ? "#ccc" : "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 30,
          }}
        >
          {loading ? "Sending..." : "Send"}
        </button>
      </div>
      {error && (
        <p
          style={{
            color: "red",
            marginTop: 10,
            fontWeight: "bold",
            textAlign: "center",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}

export default App;
