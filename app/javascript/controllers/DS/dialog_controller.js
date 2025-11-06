import { Controller } from "@hotwired/stimulus";

// Connects to data-controller="dialog"
export default class extends Controller {
  static targets = ["content"]

  static values = {
    autoOpen: { type: Boolean, default: false },
    reloadOnClose: { type: Boolean, default: false },
  };

  connect() {
    if (this.element.open) return;
    if (this.autoOpenValue) {
      this.element.showModal();
    }

    // CRITICAL FIX: Listen for turbo:before-visit to auto-close modal on redirects
    // This fixes the issue where transaction form modal stays open after submission
    this.boundBeforeVisitHandler = this.handleBeforeVisit.bind(this);
    document.addEventListener("turbo:before-visit", this.boundBeforeVisitHandler);
  }

  disconnect() {
    // Clean up event listener when controller is disconnected
    if (this.boundBeforeVisitHandler) {
      document.removeEventListener("turbo:before-visit", this.boundBeforeVisitHandler);
    }
  }

  handleBeforeVisit(event) {
    // Close dialog before navigation if it's open
    if (this.element.open) {
      this.element.close();
    }
  }
  
  // If the user clicks anywhere outside of the visible content, close the dialog
  clickOutside(e) {
    if (!this.contentTarget.contains(e.target)) {
      this.close();
    }
  }

  close() {
    this.element.close();

    if (this.reloadOnCloseValue) {
      Turbo.visit(window.location.href);
    }
  }
}
