import { Controller } from "@hotwired/stimulus";
import { createConsumer } from "@rails/actioncable";
import DOMPurify from "dompurify";
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

    // Configure marked - sanitize handled by DOMPurify
    marked.setOptions({
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
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
    this.resetGenerationTimeout(data);

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

  resetGenerationTimeout(data) {
    this.clearGenerationTimeout();
    // Reset timeout if generation is active.
    // We check either isGenerating flag OR if we are currently receiving a relevant event
    const isActivity =
      this.isGenerating || (data && ["message_created", "text_delta"].includes(data.type));

    if (isActivity) {
      this.generationTimeout = setTimeout(() => {
        this.handleTimeout();
      }, this.BIND_TIMEOUT_MS);
    }
  }

  clearGenerationTimeout() {
    if (this.generationTimeout) {
      clearTimeout(this.generationTimeout);
      this.generationTimeout = null;
    }
  }

  handleTimeout() {
    console.error("Chat generation timed out");

    // Store message ID before stopping/clearing state
    const timedOutMessageId = this.currentMessageId;

    this.stopGeneration();

    // Visually indicate error if we have a valid ID
    if (timedOutMessageId) {
      const contentEl = this.findContentElement(timedOutMessageId);
      if (contentEl) {
        contentEl.innerHTML +=
          "<br/><br/><em class='text-destructive'>Error: Response timed out.</em>";
      }
    }
    // Force completion logic to clean up buffer
    this.handleComplete({ message_id: timedOutMessageId });
  }

  handleMessageCreated(data) {
    if (DEBUG) console.log("Message created:", data.message_id);

    this.currentMessageId = data.message_id;
    this.messageBuffer[data.message_id] = ""; // Init buffer
    this.isGenerating = true;
    this.resetGenerationTimeout(data);

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

      // Render markdown safely
      const rawHtml = marked.parse(this.messageBuffer[data.message_id]);
      contentEl.innerHTML = DOMPurify.sanitize(rawHtml);

      this.scrollToBottom();
    }
  }

  handleComplete(data) {
    if (DEBUG) console.log("Generation complete");

    // Ensure we process the passed message_id or fallback to current
    const messageId = data ? data.message_id : this.currentMessageId;

    this.isGenerating = false;
    this.currentMessageId = null; // Clear active message ID
    this.clearGenerationTimeout();
    this.toggleControls(false);

    // Final clean render
    if (messageId && this.messageBuffer[messageId]) {
      const contentEl = this.findContentElement(messageId);
      if (contentEl) {
        const rawHtml = marked.parse(this.messageBuffer[messageId]);
        contentEl.innerHTML = DOMPurify.sanitize(rawHtml);
      }
      // Clean up buffer
      delete this.messageBuffer[messageId];
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

    // Check for valid subscription before performing
    if (this.subscription && typeof this.subscription.perform === "function") {
      try {
        this.subscription.perform("stop_generation");
      } catch (err) {
        console.error("Failed to stop generation:", err);
      }
    }

    this.toggleControls(false);
    this.isGenerating = false;
    this.clearGenerationTimeout();
  }

  // UI Helpers

  findContentElement(messageId) {
    // Scope search to controller's element to prevent cross-chat contamination
    // (Updated per code review)
    const messageContainer = this.element.querySelector(`[data-message-id="${messageId}"]`);
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
