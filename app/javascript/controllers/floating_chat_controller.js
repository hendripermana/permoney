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

    // Prevent body scroll when chat is open on mobile
    this.boundPreventScroll = this.preventScroll.bind(this);
  }

  disconnect() {
    document.removeEventListener("keydown", this.boundHandleEscape);
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
    }

    // Show panel with animation
    this.panelTarget.classList.remove("hidden");
    this.panelTarget.classList.add("flex", "flex-col");

    // Trigger animation after a frame
    requestAnimationFrame(() => {
      this.panelTarget.classList.add(
        "opacity-100",
        "translate-y-0",
        "lg:scale-100",
      );
      this.panelTarget.classList.remove(
        "opacity-0",
        "translate-y-4",
        "lg:translate-y-0",
        "lg:scale-95",
      );
    });

    // Disable body scroll on mobile
    this.disableBodyScroll();

    // Update trigger button
    this.triggerTarget.setAttribute("aria-expanded", "true");

    // Focus first input in chat
    setTimeout(() => {
      const input = this.panelTarget.querySelector("textarea, input");
      if (input) {
        input.focus();
      }
    }, 300);
  }

  hidePanel() {
    // Start exit animation
    this.panelTarget.classList.remove(
      "opacity-100",
      "translate-y-0",
      "lg:scale-100",
    );
    this.panelTarget.classList.add(
      "opacity-0",
      "translate-y-4",
      "lg:translate-y-0",
      "lg:scale-95",
    );

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

  disableBodyScroll() {
    // Only on mobile
    if (window.innerWidth < 1024) {
      document.body.style.overflow = "hidden";
      document.body.style.paddingRight = `${this.getScrollbarWidth()}px`;
    }
  }

  enableBodyScroll() {
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
  }

  preventScroll(event) {
    event.preventDefault();
  }

  getScrollbarWidth() {
    return window.innerWidth - document.documentElement.clientWidth;
  }
}
