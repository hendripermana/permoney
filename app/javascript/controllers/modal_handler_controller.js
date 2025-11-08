import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = {
    closePath: String
  }

  connect() {
    // Find the dialog element within this controller's scope
    const dialog = this.element.querySelector("dialog");
    if (!dialog) return;

    // Auto-open modal on connect
    if (!dialog.open) {
      dialog.showModal();
    }

    // Listen for the dialog close event
    const handleDialogClose = () => {
      // Check if the modal is closed (not just closing)
      // The dialog closes and we should navigate back
      if (!dialog.open) {
        // Wait a moment for any animations to complete
        setTimeout(() => {
          if (this.closePathValue) {
            // Use full page navigation to ensure the layout is loaded
            // This prevents blank pages and ensures proper context
            window.location.href = this.closePathValue;
          }
        }, 100);
      }
    };

    // Watch for when the dialog closes via the close button or ESC key
    dialog.addEventListener("close", handleDialogClose);

    // Also handle the case where Turbo navigates away
    this.boundBeforeVisitHandler = () => {
      if (dialog.open) {
        dialog.close();
      }
    };
    document.addEventListener("turbo:before-visit", this.boundBeforeVisitHandler);
  }

  disconnect() {
    if (this.boundBeforeVisitHandler) {
      document.removeEventListener("turbo:before-visit", this.boundBeforeVisitHandler);
    }
  }
}
