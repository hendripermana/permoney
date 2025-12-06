import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Controller } from "@hotwired/stimulus";

/**
 * A "menu" can contain arbitrary content including non-clickable items, links, buttons, and forms.
 *
 * Key features:
 * - Uses floating-ui with flip middleware for smart positioning (avoids overflow)
 * - Moves content to body to avoid overflow:hidden clipping issues
 * - Dispatches custom event to close other open menus (prevents stacking)
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

    // Move content to body to avoid overflow:hidden clipping
    this.moveContentToBody();
    this.startAutoUpdate();
  }

  disconnect() {
    this.removeEventListeners();
    this.stopAutoUpdate();
    this.close();

    // Remove content from body when disconnecting
    this.removeContentFromBody();
  }

  // Move the dropdown content to body to escape overflow:hidden containers
  moveContentToBody() {
    if (this.hasContentTarget && this.contentTarget.parentElement !== document.body) {
      this._originalParent = this.contentTarget.parentElement;
      this._originalNextSibling = this.contentTarget.nextSibling;
      document.body.appendChild(this.contentTarget);
    }
  }

  // Restore content to original position when cleaning up
  removeContentFromBody() {
    if (this.hasContentTarget && this._originalParent) {
      if (this._originalNextSibling) {
        this._originalParent.insertBefore(this.contentTarget, this._originalNextSibling);
      } else {
        this._originalParent.appendChild(this.contentTarget);
      }
      this._originalParent = null;
      this._originalNextSibling = null;
    }
  }

  addEventListeners() {
    this.toggleHandler = this.toggle.bind(this);
    this.keydownHandler = this.handleKeydown.bind(this);
    this.outsideClickHandler = this.handleOutsideClick.bind(this);
    this.turboLoadHandler = this.handleTurboLoad.bind(this);
    this.turboBeforeVisitHandler = this.handleTurboBeforeVisit.bind(this);
    this.closeOtherMenusHandler = this.handleCloseOtherMenus.bind(this);

    this.buttonTarget.addEventListener("click", this.toggleHandler);
    this.element.addEventListener("keydown", this.keydownHandler);
    document.addEventListener("click", this.outsideClickHandler);
    document.addEventListener("turbo:load", this.turboLoadHandler);
    document.addEventListener("turbo:before-visit", this.turboBeforeVisitHandler);
    // Listen for custom event to close other menus
    document.addEventListener("ds:menu:close-others", this.closeOtherMenusHandler);
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
    if (this.closeOtherMenusHandler) {
      document.removeEventListener("ds:menu:close-others", this.closeOtherMenusHandler);
    }
  }

  handleTurboLoad() {
    if (!this.show) this.close();
  }

  handleTurboBeforeVisit() {
    if (this.show) this.close();
  }

  // Handle custom event to close this menu if another menu opened
  handleCloseOtherMenus(event) {
    // Close this menu if the event was dispatched by a different menu
    if (event.detail.sourceElement !== this.element && this.show) {
      this.close();
    }
  }

  handleOutsideClick(event) {
    // Check if click is outside both the button and the content (which is now in body)
    if (
      this.show &&
      !this.element.contains(event.target) &&
      !this.contentTarget.contains(event.target)
    ) {
      this.close();
    }
  }

  closeOnItemClick(_event) {
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
      // Dispatch event to close other open menus (prevents stacking)
      document.dispatchEvent(
        new CustomEvent("ds:menu:close-others", {
          detail: { sourceElement: this.element },
        })
      );

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
    const firstFocusableElement = this.contentTarget.querySelectorAll(focusableElements)[0];
    if (firstFocusableElement) {
      firstFocusableElement.focus();
    }
  }

  startAutoUpdate() {
    if (!this._cleanup) {
      this._cleanup = autoUpdate(this.buttonTarget, this.contentTarget, this.boundUpdate);
    }
  }

  stopAutoUpdate() {
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
  }

  update() {
    if (!this.buttonTarget || !this.contentTarget) return;

    const isSmallScreen = !window.matchMedia("(min-width: 768px)").matches;

    computePosition(this.buttonTarget, this.contentTarget, {
      placement: isSmallScreen ? "bottom" : this.placementValue,
      middleware: [
        offset(this.offsetValue),
        // flip() automatically flips to opposite side when not enough space
        flip({ fallbackPlacements: ["top-end", "top-start", "bottom-start"] }),
        shift({ padding: 8 }),
      ],
      strategy: "fixed",
    }).then(({ x, y }) => {
      if (isSmallScreen) {
        Object.assign(this.contentTarget.style, {
          position: "fixed",
          left: "0px",
          width: "100vw",
          top: `${y}px`,
        });
      } else {
        Object.assign(this.contentTarget.style, {
          position: "fixed",
          left: `${x}px`,
          top: `${y}px`,
          width: "",
        });
      }
    });
  }
}
