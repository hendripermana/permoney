import { Controller } from "@hotwired/stimulus";
import consumer from "channels/consumer";

// Real-time AI chat streaming controller
// Handles WebSocket connection and message rendering
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
    if (DEBUG) console.log("ChatStreamingController: Connected", { chatId: this.chatIdValue });

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
    if (DEBUG) console.log("ChatStreamingController: Disconnecting");
    this.subscription?.unsubscribe();
  }

  handleConnected() {
    if (DEBUG) console.log("ChatStreamingController: WebSocket connected");
  }

  handleDisconnected() {
    if (DEBUG) console.log("ChatStreamingController: WebSocket disconnected");
    this.streamingValue = false;
  }

  handleStreamData(data) {
    if (DEBUG) console.log("ChatStreamingController: Received data", data);

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
        if (DEBUG) console.warn("ChatStreamingController: Unknown event type", data.type);
    }
  }

  handleMessageCreated(data) {
    if (DEBUG) console.log("ChatStreamingController: Message created", data.message_id);
    this.streamingValue = true;

    // Show typing indicator
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.remove("hidden");
    }
  }

  appendTextDelta(messageId, content) {
    let messageEl = this.findMessageElement(messageId);

    if (!messageEl) {
      // Create new message element
      messageEl = this.createMessageElement(messageId);

      // Hide typing indicator
      if (this.hasTypingIndicatorTarget) {
        this.typingIndicatorTarget.classList.add("hidden");
      }

      // Insert before typing indicator or append to messages
      if (this.hasTypingIndicatorTarget) {
        this.typingIndicatorTarget.parentElement.insertBefore(
          messageEl,
          this.typingIndicatorTarget
        );
      } else if (this.hasMessagesTarget) {
        this.messagesTarget.appendChild(messageEl);
      }
    }

    // Append content with smooth animation
    const contentEl = messageEl.querySelector("[data-message-content]");
    if (contentEl) {
      contentEl.textContent += content;
    }

    // Auto-scroll
    this.scrollToBottom();
  }

  handleComplete(messageId, data) {
    if (DEBUG) console.log("ChatStreamingController: Streaming complete", { messageId, data });

    this.streamingValue = false;

    // Hide typing indicator
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.add("hidden");
    }

    // Trigger markdown rendering if needed
    const messageEl = this.findMessageElement(messageId);
    if (messageEl) {
      this.renderMarkdown(messageEl);
    }

    // Final scroll
    this.scrollToBottom();
  }

  handleStopped() {
    if (DEBUG) console.log("ChatStreamingController: Generation stopped");
    this.streamingValue = false;

    // Hide typing indicator
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.add("hidden");
    }
  }

  handleError(data) {
    console.error("ChatStreamingController: Error", data);
    this.streamingValue = false;

    // Hide typing indicator
    if (this.hasTypingIndicatorTarget) {
      this.typingIndicatorTarget.classList.add("hidden");
    }

    // Show error message
    const errorEl = document.createElement("div");
    errorEl.className = "p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm";
    errorEl.textContent = `Error: ${data.error || "An error occurred"}`;

    if (this.hasMessagesTarget) {
      this.messagesTarget.appendChild(errorEl);
      this.scrollToBottom();
    }
  }

  stopGeneration(event) {
    event?.preventDefault();
    if (DEBUG) console.log("ChatStreamingController: Stopping generation");

    this.subscription.perform("stop_generation");
    this.streamingValue = false;
  }

  findMessageElement(messageId) {
    if (!this.hasMessagesTarget) return null;
    return this.messagesTarget.querySelector(`[data-message-id="${messageId}"]`);
  }

  createMessageElement(messageId) {
    // Escape messageId to prevent XSS attacks
    // messageId could be manipulated via API, e.g., '" onload="alert('XSS')"
    const escapedId = this.escapeHtml(messageId.toString());

    const template = `
      <div data-message-id="${escapedId}" class="flex gap-3 animate-fadeIn">
        <div class="shrink-0">
          <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
            <svg class="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
            </svg>
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <div data-message-content class="prose prose-sm max-w-none text-primary"></div>
        </div>
      </div>
    `;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = template.trim();
    return wrapper.firstElementChild;
  }

  renderMarkdown(messageEl) {
    // Future enhancement: Add markdown rendering
    // For now, just ensure proper formatting
    const contentEl = messageEl.querySelector("[data-message-content]");
    if (contentEl) {
      // Preserve line breaks
      contentEl.innerHTML = contentEl.textContent
        .split("\n")
        .map((line) => `<p>${this.escapeHtml(line)}</p>`)
        .join("");
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
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  scrollToBottom() {
    if (!this.hasMessagesTarget) return;

    // Smooth scroll to bottom
    this.messagesTarget.scrollTo({
      top: this.messagesTarget.scrollHeight,
      behavior: "smooth",
    });
  }

  streamingValueChanged() {
    if (DEBUG) console.log("ChatStreamingController: Streaming state changed", this.streamingValue);

    // Toggle stop button visibility
    if (this.hasStopButtonTarget) {
      this.stopButtonTarget.classList.toggle("hidden", !this.streamingValue);
    }
  }
}
