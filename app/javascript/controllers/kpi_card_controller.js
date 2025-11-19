import { Controller } from "@hotwired/stimulus";

// KPI Card Stimulus Controller
// Handles animations, privacy toggle, and live updates for financial KPI cards
//
// Features:
// - Privacy toggle with localStorage persistence
// - Smooth value transitions when data updates
// - Auto-refresh capability via Turbo
// - Count-up animation for numbers
// - Accessibility announcements
//
export default class extends Controller {
  static targets = ["value", "hiddenValue", "toggleButton", "showIcon", "hideIcon"];
  static values = {
    refreshUrl: String,
    refreshInterval: { type: Number, default: 60000 }, // 60 seconds default
    storageKey: String,
  };

  connect() {
    this.startAutoRefresh();
    this.initializePrivacy();
  }

  disconnect() {
    this.stopAutoRefresh();
  }

  // Initialize privacy toggle state from localStorage
  initializePrivacy() {
    if (!this.hasStorageKeyValue) return;

    const isHidden = localStorage.getItem(this.storageKeyValue) === "true";
    this.updatePrivacyState(isHidden, false); // false = don't save to localStorage
  }

  // Toggle privacy on/off
  togglePrivacy() {
    if (!this.hasStorageKeyValue) return;

    const currentlyHidden = this.valueTarget.classList.contains("hidden");
    const newState = !currentlyHidden;

    this.updatePrivacyState(newState, true); // true = save to localStorage
  }

  // Update privacy state (show/hide value)
  updatePrivacyState(isHidden, saveToStorage = true) {
    if (!this.hasValueTarget || !this.hasHiddenValueTarget) return;

    if (isHidden) {
      // Hide actual value, show placeholder
      this.valueTarget.classList.add("hidden");
      this.hiddenValueTarget.classList.remove("hidden");

      // Update icons
      if (this.hasShowIconTarget) this.showIconTarget.classList.remove("hidden");
      if (this.hasHideIconTarget) this.hideIconTarget.classList.add("hidden");
    } else {
      // Show actual value, hide placeholder
      this.valueTarget.classList.remove("hidden");
      this.hiddenValueTarget.classList.add("hidden");

      // Update icons
      if (this.hasShowIconTarget) this.showIconTarget.classList.add("hidden");
      if (this.hasHideIconTarget) this.hideIconTarget.classList.remove("hidden");
    }

    // Save to localStorage if requested
    if (saveToStorage && this.hasStorageKeyValue) {
      localStorage.setItem(this.storageKeyValue, isHidden.toString());
    }
  }

  // Start auto-refresh timer
  startAutoRefresh() {
    if (!this.hasRefreshUrlValue || this.refreshIntervalValue <= 0) return;

    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, this.refreshIntervalValue);
  }

  // Stop auto-refresh timer
  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // Fetch and update KPI data via Turbo
  async refresh() {
    if (!this.hasRefreshUrlValue) return;

    try {
      const response = await fetch(this.refreshUrlValue, {
        headers: {
          Accept: "text/vnd.turbo-stream.html",
        },
      });

      if (response.ok) {
        const html = await response.text();
        Turbo.renderStreamMessage(html);
      }
    } catch (error) {
      console.error("KPI card refresh failed:", error);
    }
  }

  // Animate value changes (called when value target changes)
  valueTargetConnected(element) {
    this.animateValue(element);
  }

  // Simple fade-in animation for new values
  animateValue(element) {
    element.style.opacity = "0";
    element.style.transform = "translateY(-10px)";

    requestAnimationFrame(() => {
      element.style.transition = "all 0.3s ease-out";
      element.style.opacity = "1";
      element.style.transform = "translateY(0)";
    });
  }
}
