import { Controller } from "@hotwired/stimulus";

// Auto-expanding textarea controller for chat input
export default class extends Controller {
  static targets = ["textarea", "submitButton", "charCount"];
  static values = {
    maxRows: { type: Number, default: 5 },
    minRows: { type: Number, default: 1 },
    maxLength: { type: Number, default: 5000 },
  };

  connect() {
    // Set initial height
    this.autoResize();
  }

  autoResize() {
    if (!this.hasTextareaTarget) return;

    const textarea = this.textareaTarget;

    // Reset height to get accurate scrollHeight
    textarea.style.height = "auto";

    // Calculate number of rows
    const lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight, 10);
    const rows = Math.min(
      Math.max(this.minRowsValue, Math.ceil(textarea.scrollHeight / lineHeight)),
      this.maxRowsValue
    );

    // Set new height
    textarea.style.height = `${rows * lineHeight}px`;

    // Update character count if target exists
    if (this.hasCharCountTarget) {
      this.updateCharCount();
    }

    // Enable/disable submit button based on content
    if (this.hasSubmitButtonTarget) {
      this.submitButtonTarget.disabled = textarea.value.trim().length === 0;
    }
  }

  updateCharCount() {
    const length = this.textareaTarget.value.length;
    this.charCountTarget.textContent = `${length}/${this.maxLengthValue}`;

    // Warn if approaching limit
    if (length > this.maxLengthValue * 0.9) {
      this.charCountTarget.classList.add("text-yellow-600");
    } else {
      this.charCountTarget.classList.remove("text-yellow-600");
    }
  }

  handleKeydown(event) {
    // Submit on Enter (but Shift+Enter for new line)
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (this.textareaTarget.value.trim().length > 0) {
        // Trigger form submission
        this.element.closest("form")?.requestSubmit();
      }
    }
  }

  insertPrompt(event) {
    event.preventDefault();

    const prompt = event.currentTarget.textContent.trim();
    this.textareaTarget.value = prompt;
    this.autoResize();
    this.textareaTarget.focus();
  }

  clear() {
    this.textareaTarget.value = "";
    this.autoResize();
  }
}
