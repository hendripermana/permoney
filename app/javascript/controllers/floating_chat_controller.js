import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["panel", "backdrop", "trigger", "badge"];
  static values = {
    open: Boolean,
    isMobile: Boolean,
  };

  connect() {
    // Debug logging
    this.debug = window.location.hostname === "localhost" || 
                 window.location.hostname.includes("ngrok") ||
                 window.location.hostname.includes("127.0.0.1");

    // Detect initial state
    this.updateMobileState();

    // Handle escape key
    this.boundHandleEscape = this.handleEscape.bind(this);
    document.addEventListener("keydown", this.boundHandleEscape);

    // Listen to Turbo navigation for proper cleanup
    this.boundHandleTurboBeforeVisit = this.handleTurboBeforeVisit.bind(this);
    document.addEventListener("turbo:before-visit", this.boundHandleTurboBeforeVisit);

    // Listen for window resize to detect mobile/desktop switch
    this.boundHandleResize = this.handleResize.bind(this);
    window.addEventListener("resize", this.boundHandleResize);

    if (this.debug) {
      console.log("[FloatingChat] Connected - Mobile:", this.isMobileValue);
    }
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundHandleEscape);
    document.removeEventListener("turbo:before-visit", this.boundHandleTurboBeforeVisit);
    window.removeEventListener("resize", this.boundHandleResize);
    this.enableBodyScroll();
  }

  toggle(event) {
    event?.preventDefault();
    this.openValue = !this.openValue;
  }

  open(event) {
    event?.preventDefault();
    this.openValue = true;
  }

  close(event) {
    event?.preventDefault();
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
    event.stopImmediatePropagation();
  }

  openValueChanged() {
    if (this.openValue) {
      this.showPanel();
    } else {
      this.hidePanel();
    }
  }

  isMobileValueChanged() {
    if (this.debug) {
      console.log("[FloatingChat] Mobile state changed:", this.isMobileValue);
    }

    // If switching from desktop to mobile while open, close the panel
    if (this.isMobileValue && this.openValue) {
      this.close();
    }
  }

  showPanel() {
    if (this.debug) {
      console.log("[FloatingChat] Showing panel - Mobile:", this.isMobileValue);
    }

    // Show backdrop on mobile
    if (this.hasBackdropTarget && this.isMobileValue) {
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
    if (this.isMobileValue) {
      this.disableBodyScroll();
    }

    // Update trigger button state
    this.triggerTarget.setAttribute("aria-expanded", "true");
    this.triggerTarget.classList.add("ring-4", "ring-alpha-black-200");

    // Focus first input in chat after animation
    setTimeout(() => {
      const input = this.panelTarget.querySelector("textarea, input[type='text']");
      if (input && !this.isMobileValue) {
        // Only auto-focus on desktop to prevent keyboard popup on mobile
        input.focus();
      }
    }, 300);
  }

  hidePanel() {
    if (this.debug) {
      console.log("[FloatingChat] Hiding panel");
    }

    // Start exit animation
    this.panelTarget.classList.remove("opacity-100", "translate-y-0", "lg:scale-100");
    this.panelTarget.classList.add("opacity-0", "translate-y-4", "lg:translate-y-0", "lg:scale-95");

    // Animate backdrop out
    if (this.hasBackdropTarget && this.isMobileValue) {
      this.backdropTarget.classList.remove("opacity-100");
      this.backdropTarget.classList.add("opacity-0");
    }

    // Hide after animation completes
    setTimeout(() => {
      this.panelTarget.classList.add("hidden");
      this.panelTarget.classList.remove("flex", "flex-col");
      if (this.hasBackdropTarget && this.isMobileValue) {
        this.backdropTarget.classList.add("hidden");
      }
    }, 200);

    // Enable body scroll
    if (this.isMobileValue) {
      this.enableBodyScroll();
    }

    // Update trigger button state
    this.triggerTarget.setAttribute("aria-expanded", "false");
    this.triggerTarget.classList.remove("ring-4", "ring-alpha-black-200");
  }

  handleEscape(event) {
    if (event.key === "Escape" && this.openValue) {
      event.preventDefault();
      this.close();
    }
  }

  handleTurboBeforeVisit() {
    // Close chat before navigating away
    if (this.openValue) {
      this.close();
    }
  }

  handleResize() {
    // Debounce resize events
    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      this.updateMobileState();
    }, 150);
  }

  updateMobileState() {
    const wasKobile = this.isMobileValue;
    const isMobileNow = window.innerWidth < 1024;
    
    if (wasKobile !== isMobileNow) {
      this.isMobileValue = isMobileNow;
    }
  }

  disableBodyScroll() {
    // Only on mobile
    if (window.innerWidth < 1024) {
      document.body.style.overflow = "hidden";
      document.body.style.paddingRight = `${this.getScrollbarWidth()}px`;
      document.body.style.touchAction = "none";
      document.documentElement.style.overflow = "hidden";
    }
  }

  enableBodyScroll() {
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
    document.body.style.touchAction = "";
    document.documentElement.style.overflow = "";
  }

  getScrollbarWidth() {
    return window.innerWidth - document.documentElement.clientWidth;
  }
}

