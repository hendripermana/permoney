import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import { Controller } from "@hotwired/stimulus";

/**
 * A "menu" can contain arbitrary content including non-clickable items, links, buttons, and forms.
 */
export default class extends Controller {
  static targets = ["button", "content"];

  static values = {
    show: Boolean,
    placement: { type: String, default: "bottom-end" },
    offset: { type: Number, default: 6 },
  };

  connect() {
    this.show = this.showValue;
    this.boundUpdate = this.update.bind(this);
    this.addEventListeners();
    this.startAutoUpdate();
  }

  disconnect() {
    this.removeEventListeners();
    this.stopAutoUpdate();
    this.close();
  }

  addEventListeners() {
    this.toggleHandler = this.toggle.bind(this);
    this.keydownHandler = this.handleKeydown.bind(this);
    this.outsideClickHandler = this.handleOutsideClick.bind(this);
    this.turboLoadHandler = this.handleTurboLoad.bind(this);
    this.turboBeforeVisitHandler = this.handleTurboBeforeVisit.bind(this);
    
    this.buttonTarget.addEventListener("click", this.toggleHandler);
    this.element.addEventListener("keydown", this.keydownHandler);
    document.addEventListener("click", this.outsideClickHandler);
    document.addEventListener("turbo:load", this.turboLoadHandler);
    // Rails 8.1: Close menu when Turbo navigation starts (before page changes)
    document.addEventListener("turbo:before-visit", this.turboBeforeVisitHandler);
  }

  removeEventListeners() {
    if (this.toggleHandler) {
      this.buttonTarget.removeEventListener("click", this.toggleHandler);
    }
    if (this.keydownHandler) {
      this.element.removeEventListener("keydown", this.keydownHandler);
    }
    if (this.outsideClickHandler) {
      document.removeEventListener("click", this.outsideClickHandler);
    }
    if (this.turboLoadHandler) {
      document.removeEventListener("turbo:load", this.turboLoadHandler);
    }
    if (this.turboBeforeVisitHandler) {
      document.removeEventListener("turbo:before-visit", this.turboBeforeVisitHandler);
    }
  }

  handleTurboLoad() {
    if (!this.show) this.close();
  }

  // Rails 8.1: Close menu when Turbo navigation is about to start
  // This allows links to navigate normally, then menu closes before page transition
  handleTurboBeforeVisit() {
    if (this.show) this.close();
  }

  handleOutsideClick(event) {
    if (this.show && !this.element.contains(event.target)) this.close();
  }

  // Rails 8.1: Close menu when menu item is clicked
  // Called explicitly via data-action on menu items
  closeOnItemClick(_event) {
    // Close menu immediately when item is clicked
    // Don't prevent default - let the link/button work normally
    this.close();
  }

  handleKeydown(event) {
    if (event.key === "Escape") {
      this.close();
      this.buttonTarget.focus();
    }
  }

  toggle(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    
    this.show = !this.show;
    this.contentTarget.classList.toggle("hidden", !this.show);
    if (this.show) {
      this.update();
      this.focusFirstElement();
    }
  }

  close() {
    this.show = false;
    this.contentTarget.classList.add("hidden");
  }

  focusFirstElement() {
    const focusableElements =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const firstFocusableElement =
      this.contentTarget.querySelectorAll(focusableElements)[0];
    if (firstFocusableElement) {
      firstFocusableElement.focus();
    }
  }

  startAutoUpdate() {
    if (!this._cleanup) {
      this._cleanup = autoUpdate(
        this.buttonTarget,
        this.contentTarget,
        this.boundUpdate,
      );
    }
  }

  stopAutoUpdate() {
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
  }

  update() {
    computePosition(this.buttonTarget, this.contentTarget, {
      placement: this.placementValue,
      middleware: [offset(this.offsetValue), flip(), shift({ padding: 5 })],
    }).then(({ x, y }) => {
      Object.assign(this.contentTarget.style, {
        position: "fixed",
        left: `${x}px`,
        top: `${y}px`,
      });
    });
  }
}
