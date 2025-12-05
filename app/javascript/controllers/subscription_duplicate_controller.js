import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["warning", "serviceInput"];
  static values = {
    checkUrl: String,
    excludeId: String,
  };

  connect() {
    this.observeServiceChanges();
  }

  observeServiceChanges() {
    const combobox = this.element.querySelector('[data-controller*="hw-combobox"]');
    if (!combobox) return;

    const hiddenInput = combobox.querySelector('input[type="hidden"]');
    if (!hiddenInput) return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes" && mutation.attributeName === "value") {
          this.checkDuplicate(hiddenInput.value);
        }
      });
    });

    observer.observe(hiddenInput, { attributes: true });

    hiddenInput.addEventListener("change", () => {
      this.checkDuplicate(hiddenInput.value);
    });
  }

  async checkDuplicate(serviceId) {
    if (!serviceId || !this.checkUrlValue) {
      this.hideWarning();
      return;
    }

    try {
      const url = new URL(this.checkUrlValue, window.location.origin);
      url.searchParams.set("service_id", serviceId);
      if (this.excludeIdValue) {
        url.searchParams.set("exclude_id", this.excludeIdValue);
      }

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      if (!response.ok) return;

      const data = await response.json();

      if (data.duplicate) {
        this.showWarning(data.message);
      } else {
        this.hideWarning();
      }
    } catch (error) {
      console.error("Error checking duplicate:", error);
    }
  }

  showWarning(message) {
    if (!this.hasWarningTarget) return;
    this.warningTarget.textContent = message;
    this.warningTarget.classList.remove("hidden");
  }

  hideWarning() {
    if (!this.hasWarningTarget) return;
    this.warningTarget.classList.add("hidden");
  }
}
