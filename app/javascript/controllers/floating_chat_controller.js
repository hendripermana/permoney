import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["panel", "backdrop", "trigger", "badge"];
  static values = {
    open: Boolean,
  };

  connect() {
    // Handle escape key
    this.boundHandleEscape = this.handleEscape.bind(this);
    document.addEventListener("keydown", this.boundHandleEscape);

    // Listen to Turbo navigation for proper cleanup
    this.boundHandleTurboBeforeVisit = this.handleTurboBeforeVisit.bind(this);
    document.addEventListener("turbo:before-visit", this.boundHandleTurboBeforeVisit);
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundHandleEscape);
    document.removeEventListener("turbo:before-visit", this.boundHandleTurboBeforeVisit);
    this.enableBodyScroll();
  }

  toggle(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.openValue = !this.openValue;
  }

  open(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.openValue = true;
  }

  close(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.openValue = false;
  }

  // Close on backdrop click (mobile only)
  closeOnBackdrop(event) {
    // Only close if clicking directly on backdrop
    if (event.target === this.backdropTarget) {
      this.close(event);
    }
  }

  // Prevent closing when clicking inside panel
  preventClose(event) {
    event.stopPropagation();
  }

  openValueChanged() {
    if (this.openValue) {
      this.showPanel();
    } else {
      this.hidePanel();
    }
  }

  showPanel() {
    // Show backdrop on mobile
    if (this.hasBackdropTarget) {
      this.backdropTarget.classList.remove("hidden");

      // Trigger backdrop animation after a frame
      requestAnimationFrame(() => {
        this.backdropTarget.classList.add("opacity-100");
        this.backdropTarget.classList.remove("opacity-0");
      });
    }

    // Show panel with animation
    this.panelTarget.classList.remove("hidden");
    this.panelTarget.classList.add("flex", "flex-col");

    // Trigger animation after a frame
    requestAnimationFrame(() => {
      this.panelTarget.classList.add("opacity-100", "translate-y-0", "lg:scale-100");
      this.panelTarget.classList.remove(
        "opacity-0",
        "translate-y-4",
        "lg:translate-y-0",
        "lg:scale-95"
      );
    });

    // Disable body scroll on mobile
    this.disableBodyScroll();

    // Update trigger button
    this.triggerTarget.setAttribute("aria-expanded", "true");

    // Focus first input in chat after animation
    setTimeout(() => {
      const input = this.panelTarget.querySelector("textarea, input[type='text']");
      if (input && window.innerWidth >= 1024) {
        // Only auto-focus on desktop to prevent keyboard popup on mobile
        input.focus();
      }
    }, 350);
  }

  hidePanel() {
    // Start exit animation
    this.panelTarget.classList.remove("opacity-100", "translate-y-0", "lg:scale-100");
    this.panelTarget.classList.add("opacity-0", "translate-y-4", "lg:translate-y-0", "lg:scale-95");

    // Animate backdrop out
    if (this.hasBackdropTarget) {
      this.backdropTarget.classList.remove("opacity-100");
      this.backdropTarget.classList.add("opacity-0");
    }

    // Hide after animation completes
    setTimeout(() => {
      this.panelTarget.classList.add("hidden");
      this.panelTarget.classList.remove("flex", "flex-col");
      if (this.hasBackdropTarget) {
        this.backdropTarget.classList.add("hidden");
      }
    }, 200);

    // Enable body scroll
    this.enableBodyScroll();

    // Update trigger button
    this.triggerTarget.setAttribute("aria-expanded", "false");
  }

  handleEscape(event) {
    if (event.key === "Escape" && this.openValue) {
      this.close();
    }
  }

  handleTurboBeforeVisit() {
    // Close chat before navigating away
    if (this.openValue) {
      this.close();
    }
  }

  disableBodyScroll() {
    // Only on mobile
    if (window.innerWidth < 1024) {
      document.body.style.overflow = "hidden";
      document.body.style.paddingRight = `${this.getScrollbarWidth()}px`;
      // Add touch-action to prevent pull-to-refresh on mobile
      document.body.style.touchAction = "none";
    }
  }

  enableBodyScroll() {
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
    document.body.style.touchAction = "";
  }

  getScrollbarWidth() {
    return window.innerWidth - document.documentElement.clientWidth;
  }
}
