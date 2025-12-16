import { Controller } from "@hotwired/stimulus";
import { createConsumer } from "@rails/actioncable";
import { marked } from "marked";

// Debug flag
const DEBUG = true;

export default class extends Controller {
  static values = {
    chatId: String,
    stream: { type: Boolean, default: true },
  };

  static targets = ["messages", "form", "stopButton", "sendButton"];

  connect() {
    if (DEBUG) console.log("ChatStreamingController connected for chat:", this.chatIdValue);

    // Configure marked for safety
    marked.setOptions({
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
      sanitize: true, // ENABLED per security review (prevents XSS)
    });

    this.subscription = createConsumer().subscriptions.create(
      { channel: "ChatStreamingChannel", chat_id: this.chatIdValue },
      {
        received: this.handleReceived.bind(this),
        connected: () => {
          if (DEBUG) console.log("ActionCable connected");
          this.element.classList.add("connected");
        },
        disconnected: () => {
          if (DEBUG) console.log("ActionCable disconnected");
          this.element.classList.remove("connected");
        },
        rejected: () => {
          console.error("ActionCable subscription rejected");
        },
      }
    );

    this.messageBuffer = {}; // Buffer for accumulating markdown text per message
    this.generationTimeout = null; // Timeout handler
    this.BIND_TIMEOUT_MS = 30000; // 30s timeout for generation
  }

  disconnect() {
    if (DEBUG) console.log("ChatStreamingController disconnected");
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    this.clearGenerationTimeout();
  }

  handleReceived(data) {
    if (DEBUG) console.log("Received data:", data.type, data);

    // Reset timeout on any activity
    this.resetGenerationTimeout();

    switch (data.type) {
      case "message_created":
        this.handleMessageCreated(data);
        break;
      case "text_delta":
        this.appendTextDelta(data);
        break;
      case "complete":
        this.handleComplete(data);
        break;
      case "error":
        this.handleError(data);
        break;
      case "generation_stopped":
        this.handleStopped(data);
        break;
    }
  }

  resetGenerationTimeout() {
    this.clearGenerationTimeout();
    // Reset timeout if we have an active message ID (generation in progress)
    if (this.currentMessageId) {
      this.generationTimeout = setTimeout(() => {
        this.handleTimeout();
      }, this.BIND_TIMEOUT_MS);
    }
  }

  clearGenerationTimeout() {
    if (this.generationTimeout) clearTimeout(this.generationTimeout);
    this.generationTimeout = null;
  }

  handleTimeout() {
    console.error("Chat generation timed out");
    this.stopGeneration();

    // Visually indicate error
    if (this.currentMessageId) {
      const contentEl = this.findContentElement(this.currentMessageId);
      if (contentEl) {
        contentEl.innerHTML +=
          "<br/><br/><em class='text-destructive'>Error: Response timed out.</em>";
      }
    }
    this.handleComplete({ message_id: this.currentMessageId });
  }

  handleMessageCreated(data) {
    if (DEBUG) console.log("Message created:", data.message_id);

    this.currentMessageId = data.message_id;
    this.messageBuffer[data.message_id] = ""; // Init buffer
    this.isGenerating = true;
    this.resetGenerationTimeout();

    this.toggleControls(true);
    this.scrollToBottom();
  }

  appendTextDelta(data) {
    const contentEl = this.findContentElement(data.message_id);

    if (contentEl) {
      // First delta? Clear pending state/skeleton
      if (!this.messageBuffer[data.message_id]) {
        contentEl.innerHTML = "";
        contentEl.parentElement.classList.remove("animate-pulse");
      }

      this.messageBuffer[data.message_id] += data.content;

      // Render markdown
      contentEl.innerHTML = marked.parse(this.messageBuffer[data.message_id]);

      this.scrollToBottom();
    }
  }

  handleComplete(data) {
    if (DEBUG) console.log("Generation complete");
    this.isGenerating = false;
    this.currentMessageId = null; // Clear active message ID
    this.clearGenerationTimeout();
    this.toggleControls(false);

    // Final clean render
    if (data.message_id && this.messageBuffer[data.message_id]) {
      const contentEl = this.findContentElement(data.message_id);
      if (contentEl) {
        contentEl.innerHTML = marked.parse(this.messageBuffer[data.message_id]);
      }
    }
  }

  handleError(data) {
    console.error("Chat Error:", data.error);
    this.isGenerating = false;
    this.currentMessageId = null;
    this.clearGenerationTimeout();
    this.toggleControls(false);

    const contentEl = this.findContentElement(data.message_id);
    if (contentEl) {
      contentEl.innerHTML += `<div class="text-destructive mt-2 text-sm">Error: ${data.message || data.error}</div>`;
    }
  }

  handleStopped(_data) {
    if (DEBUG) console.log("Generation stopped");
    this.isGenerating = false;
    this.currentMessageId = null;
    this.clearGenerationTimeout();
    this.toggleControls(false);
  }

  stopGeneration(event) {
    if (event) event.preventDefault();
    if (DEBUG) console.log("Stopping generation...");

    this.subscription.perform("stop_generation");
    this.toggleControls(false);
  }

  // UI Helpers

  findContentElement(messageId) {
    const messageContainer = document.querySelector(`[data-message-id="${messageId}"]`);
    if (messageContainer) {
      return messageContainer.querySelector("[data-message-content]");
    }
    return null;
  }

  toggleControls(isGenerating) {
    // Simplify toggle logic per PR review
    if (this.hasStopButtonTarget) {
      this.stopButtonTarget.classList.toggle("hidden", !isGenerating);
    }
  }

  scrollToBottom() {
    const messagesEl = this.messagesTarget;
    if (!messagesEl) return;

    // Smart auto-scroll
    const threshold = 100;
    const isNearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;

    if (isNearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }
}
