import { Controller } from "@hotwired/stimulus";
import consumer from "channels/consumer";

// Real-time AI chat streaming controller
// Handles WebSocket connection and message rendering with smooth animations
//
// Debug logging: Enabled in development, disabled in production
// Production detection: Based on hostname (not localhost/ngrok = production)
const DEBUG =
  window.location.hostname === "localhost" ||
  window.location.hostname.includes("ngrok") ||
  window.location.hostname.includes("127.0.0.1");

export default class extends Controller {
  static targets = ["messages", "stopButton", "typingIndicator"];
  static values = {
    chatId: String,
    streaming: { type: Boolean, default: false },
  };

  connect() {
    if (DEBUG) console.log("[ChatStreaming] Connected", { chatId: this.chatIdValue });

    // Subscribe to chat streaming channel
    this.subscription = consumer.subscriptions.create(
      {
        channel: "ChatStreamingChannel",
        chat_id: this.chatIdValue,
      },
      {
        received: this.handleStreamData.bind(this),
        connected: this.handleConnected.bind(this),
        disconnected: this.handleDisconnected.bind(this),
      }
    );
  }

  disconnect() {
    if (DEBUG) console.log("[ChatStreaming] Disconnecting");
    this.subscription?.unsubscribe();
  }

  handleConnected() {
    if (DEBUG) console.log("[ChatStreaming] WebSocket connected");
  }

  handleDisconnected() {
    if (DEBUG) console.log("[ChatStreaming] WebSocket disconnected");
    this.streamingValue = false;
  }

  handleStreamData(data) {
    if (DEBUG) console.log("[ChatStreaming] Received", data.type, data);

    switch (data.type) {
      case "message_created":
        this.handleMessageCreated(data);
        break;
      case "text_delta":
        this.appendTextDelta(data.message_id, data.content);
        break;
      case "complete":
        this.handleComplete(data.message_id, data);
        break;
      case "generation_stopped":
        this.handleStopped();
        break;
      case "error":
        this.handleError(data);
        break;
      default:
        if (DEBUG) console.warn("[ChatStreaming] Unknown event type", data.type);
    }
  }

  handleMessageCreated(data) {
    if (DEBUG) console.log("[ChatStreaming] Message created", data.message_id);
    this.streamingValue = true;

    // Show typing indicator with smooth animation
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.remove("hidden");
      // Force reflow for animation
      this.typingIndicatorTarget.offsetHeight;
    }

    // Ensure we stay at bottom when new message cycle starts
    setTimeout(() => this.scrollToBottom(), 100);
  }

  appendTextDelta(messageId, content) {
    const messageEl = this.findMessageElement(messageId);

    if (!messageEl) {
      // Use MutationObserver to wait for the element to be added by Turbo Streams
      const observer = new MutationObserver((mutationsList, obs) => {
        for (const mutation of mutationsList) {
          if (mutation.type === "childList") {
            const foundEl = this.findMessageElement(messageId);
            if (foundEl) {
              this.appendContent(foundEl, content);
              obs.disconnect(); // Clean up the observer
              return;
            }
          }
        }
      });

      if (this.hasMessagesTarget) {
        observer.observe(this.messagesTarget, { childList: true, subtree: true });
        // Timeout to prevent observer from running indefinitely
        setTimeout(() => observer.disconnect(), 2000);
      }
      return;
    }

    this.appendContent(messageEl, content);
  }

  appendContent(messageEl, content) {
    // Append content with smooth text rendering
    const contentEl = messageEl.querySelector("[data-message-content]");
    if (contentEl) {
      // Clear placeholder if present
      if (contentEl.textContent.trim() === "[generating]") {
        contentEl.textContent = "";
      }

      // Append text smoothly
      contentEl.textContent += content;

      // Trigger subtle animation for new text
      contentEl.classList.add("text-update-pulse");
      setTimeout(() => {
        contentEl.classList.remove("text-update-pulse");
      }, 100);
    }

    // Auto-scroll to latest message
    this.scrollToBottom();
  }

  handleComplete(messageId, data) {
    if (DEBUG) console.log("[ChatStreaming] Complete", { messageId, ...data });

    this.streamingValue = false;

    // Hide typing indicator
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.add("hidden");
    }

    // Trigger markdown rendering if needed
    const messageEl = this.findMessageElement(messageId);
    if (messageEl) {
      this.renderMarkdown(messageEl);
      // Add completion animation
      messageEl.classList.add("message-complete");
    }

    // Final scroll to bottom
    this.scrollToBottom();

    // Focus input for next message
    setTimeout(() => {
      const input = document.querySelector("[data-chat-input-target='textarea']");
      if (input && window.innerWidth >= 1024) {
        input.focus();
      }
    }, 200);
  }

  handleStopped() {
    if (DEBUG) console.log("[ChatStreaming] Generation stopped by user");
    this.streamingValue = false;

    // Hide typing indicator
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.add("hidden");
    }
  }

  handleError(data) {
    console.error("[ChatStreaming] Error", data);
    this.streamingValue = false;

    // Hide typing indicator
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.add("hidden");
    }

    // Show error message with proper styling
    const errorEl = document.createElement("div");
    errorEl.className =
      "p-3 lg:p-4 bg-destructive/10 border border-destructive/30 rounded-lg text-destructive text-sm animate-fadeIn";
    errorEl.innerHTML = `
      <div class="flex gap-2 items-start">
        <svg class="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4v.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <span>${this.escapeHtml(data.error || "An error occurred. Please try again.")}</span>
      </div>
    `;

    if (this.hasMessagesTarget) {
      this.messagesTarget.appendChild(errorEl);
      this.scrollToBottom();
    }
  }

  stopGeneration(event) {
    event?.preventDefault();
    if (DEBUG) console.log("[ChatStreaming] Stopping generation");

    this.subscription.perform("stop_generation");
    this.streamingValue = false;
  }

  findMessageElement(messageId) {
    if (!this.hasMessagesTarget) return null;
    return this.messagesTarget.querySelector(`[data-message-id="${messageId}"]`);
  }

  renderMarkdown(messageEl) {
    // Future enhancement: Add markdown rendering with a library like marked.js
    // For now, ensure proper formatting and line breaks
    const contentEl = messageEl.querySelector("[data-message-content]");
    if (contentEl?.textContent) {
      // Text content is preserved with whitespace, no need to manipulate
      // This allows proper rendering of code blocks, lists, etc.
    }
  }

  escapeHtml(text) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
  }

  scrollToBottom() {
    if (!this.hasMessagesTarget) return;

    // Smooth scroll to bottom with requestAnimationFrame for better performance
    requestAnimationFrame(() => {
      this.messagesTarget.scrollTo({
        top: this.messagesTarget.scrollHeight,
        behavior: "smooth",
      });
    });
  }

  streamingValueChanged() {
    if (DEBUG) console.log("[ChatStreaming] Streaming state changed", this.streamingValue);

    // Toggle stop button visibility with smooth transition
    if (this.hasStopButtonTarget) {
      if (this.streamingValue) {
        this.stopButtonTarget.classList.remove("hidden");
        // Force reflow for animation
        this.stopButtonTarget.offsetHeight;
      } else {
        this.stopButtonTarget.classList.add("hidden");
      }
    }
  }
}
